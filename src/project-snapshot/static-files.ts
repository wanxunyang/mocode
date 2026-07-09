import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 静态项目文件白名单 + 扫描逻辑。
 * 这些文件通常是项目元信息，变动频率低、体积小、跨 session 稳定。
 */

/** 静态文件白名单（文件名或模式） */
const STATIC_FILE_PATTERNS: (string | RegExp)[] = [
  // 文档
  /^README(\.[a-z]+)?(\.[a-z]+)?$/i, // README, README.md, README.zh-CN.md
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',

  // Node.js
  'package.json',
  'tsconfig.json',
  'jsconfig.json',

  // Python
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',

  // Go
  'go.mod',

  // Rust
  'Cargo.toml',

  // 环境变量模板
  '.env.example',
  '.env.template',
];

export interface StaticFileEntry {
  /** 文件最后修改时间（毫秒） */
  mtime: number;
  /** 文件内容（UTF-8 文本） */
  content: string;
}

/**
 * 判断文件名是否匹配白名单
 */
function matchesPattern(filename: string): boolean {
  for (const p of STATIC_FILE_PATTERNS) {
    if (typeof p === 'string') {
      if (filename === p) return true;
    } else {
      if (p.test(filename)) return true;
    }
  }
  return false;
}

/**
 * 扫描项目根目录，收集匹配白名单的静态文件。
 * 只扫顶层（不递归），避免 node_modules 等大目录。
 * @param root 项目根目录（绝对路径）
 * @returns key = 相对路径（正斜杠），val = { mtime, content }
 */
export function scanStaticFiles(root: string): Record<string, StaticFileEntry> {
  const result: Record<string, StaticFileEntry> = {};

  let items: import('node:fs').Dirent[];
  try {
    items = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const item of items) {
    if (!item.isFile()) continue;
    if (!matchesPattern(item.name)) continue;

    const absPath = path.join(root, item.name);
    try {
      const stat = statSync(absPath);
      // 体积限制：单文件 > 64KB 跳过（避免 README 巨长拖慢快照）
      if (stat.size > 64 * 1024) continue;

      const content = readFileSync(absPath, 'utf8');
      result[item.name] = {
        mtime: stat.mtimeMs,
        content,
      };
    } catch {
      // 读取失败：跳过
    }
  }

  return result;
}
