import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';
import { scanStaticFiles, type StaticFileEntry } from './static-files.js';

/**
 * 项目快照缓存：跨 session 持久化静态项目文件 + 项目结构摘要。
 * 与 session 内 LRU cache (任务 29) 不冲突：
 *   - 29: session 内任意 tool output，key = tool+args
 *   - 36: 跨 session 静态文件，key = path+mtime
 *
 * 存储位置：<cwd>/.mocode/projects/<hash(sandboxRoot)>/snapshot.json
 */

export interface ProjectSnapshot {
  /** 快照版本号，便于未来升级格式 */
  version: 1;
  /** sandbox 根目录（绝对路径） */
  root: string;
  /** 构建时间（ISO 8601） */
  builtAt: string;
  /** 静态文件缓存：key = 相对路径，val = { mtime, content } */
  files: Record<string, StaticFileEntry>;
  /** 项目结构摘要：模块/入口/配置文件列表 */
  structure: {
    /** 顶层目录（模块） */
    modules: string[];
    /** 入口文件（package.json 的 main/bin 等） */
    entries: string[];
    /** 配置文件（tsconfig.json, .eslintrc 等） */
    configFiles: string[];
  };
}

/** 内存缓存：当前 session 的快照（避免重复 IO） */
let currentSnapshot: ProjectSnapshot | null = null;

/** 计算 sandboxRoot 的 hash，用作目录名（避免路径特殊字符） */
export function hashRoot(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

/** 快照存储目录 */
function snapshotDir(): string {
  const root = getSandboxRoot() ?? process.cwd();
  return path.join(process.cwd(), '.mocode', 'projects', hashRoot(root));
}

/** 快照文件路径 */
function snapshotPath(): string {
  return path.join(snapshotDir(), 'snapshot.json');
}

/** 从磁盘加载快照（不存在/损坏返 null） */
export function loadSnapshot(): ProjectSnapshot | null {
  if (currentSnapshot) return currentSnapshot;
  const p = snapshotPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const snap = JSON.parse(raw) as ProjectSnapshot;
    if (!snap || snap.version !== 1 || !snap.files) return null;
    currentSnapshot = snap;
    return snap;
  } catch {
    return null;
  }
}

/** 构建/刷新快照：扫描静态文件 + 提取结构摘要 */
export function buildSnapshot(): ProjectSnapshot {
  const root = getSandboxRoot() ?? process.cwd();
  const files = scanStaticFiles(root);
  const structure = extractStructure(root, files);

  const snap: ProjectSnapshot = {
    version: 1,
    root,
    builtAt: new Date().toISOString(),
    files,
    structure,
  };

  // 落盘
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(), JSON.stringify(snap, null, 2), 'utf8');

  currentSnapshot = snap;
  return snap;
}

/** 获取当前快照（优先内存 → 磁盘 → 构建） */
export function getSnapshot(): ProjectSnapshot {
  return loadSnapshot() ?? buildSnapshot();
}

/** 清空内存缓存（调试/测试用） */
export function clearSnapshotCache(): void {
  currentSnapshot = null;
}

/**
 * 从快照中查找文件（带 mtime 校验）。
 * 返回 null 表示：文件不在快照中 / mtime 已变 / 快照不存在。
 * 调用方应 fallback 到真实 readFile。
 */
export function lookupSnapshotFile(
  absPath: string,
): { content: string; mtime: number } | null {
  const snap = loadSnapshot();
  if (!snap) return null;

  // 转成相对路径（快照 key 是相对路径）
  const root = snap.root;
  if (!absPath.startsWith(root)) return null;
  const relPath = path.relative(root, absPath).replace(/\\/g, '/');

  const entry = snap.files[relPath];
  if (!entry) return null;

  // mtime 校验：磁盘上的 mtime 必须与快照一致
  try {
    const st = statSync(absPath);
    if (st.mtimeMs !== entry.mtime) return null;
  } catch {
    return null;
  }

  return { content: entry.content, mtime: entry.mtime };
}

/** 提取项目结构摘要（从静态文件 + 目录扫描） */
function extractStructure(
  root: string,
  files: Record<string, StaticFileEntry>,
): ProjectSnapshot['structure'] {
  const modules: string[] = [];
  const entries: string[] = [];
  const configFiles: string[] = [];

  // 配置文件：直接看 files keys
  for (const relPath of Object.keys(files)) {
    if (isConfigFile(relPath)) {
      configFiles.push(relPath);
    }
  }

  // 入口文件：从 package.json 提取
  const pkgEntry = files['package.json'];
  if (pkgEntry) {
    try {
      const pkg = JSON.parse(pkgEntry.content);
      if (typeof pkg.main === 'string') entries.push(pkg.main);
      if (typeof pkg.module === 'string') entries.push(pkg.module);
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') entries.push(pkg.bin);
        else if (typeof pkg.bin === 'object') {
          for (const v of Object.values(pkg.bin)) {
            if (typeof v === 'string') entries.push(v);
          }
        }
      }
    } catch {
      // package.json 解析失败，跳过
    }
  }

  // 模块：扫描顶层目录（排除 node_modules, .git 等）
  try {
    const items = readdirSync(root, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name.startsWith('.')) continue;
      if (item.name === 'node_modules') continue;
      if (item.name === 'dist' || item.name === 'build') continue;
      modules.push(item.name);
    }
  } catch {
    // 目录扫描失败，留空
  }

  return { modules, entries, configFiles };
}

/** 判断是否为配置文件 */
function isConfigFile(relPath: string): boolean {
  const configPatterns = [
    'tsconfig.json',
    'jsconfig.json',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.json',
    '.env.example',
    'jest.config.js',
    'jest.config.ts',
    'vitest.config.ts',
    'vite.config.ts',
    'next.config.js',
    'next.config.ts',
    'webpack.config.js',
    'rollup.config.js',
    'pyproject.toml',
    'setup.py',
    'go.mod',
    'Cargo.toml',
  ];
  return configPatterns.some((p) => relPath === p || relPath.endsWith('/' + p));
}
