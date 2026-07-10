import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';

/**
 * 项目快照：完全由 LLM 生成的项目上下文。
 * 与 Skill 互补：快照 = 事实(what/where)，Skill = 洞察(why/how)。
 *
 * 存储位置：<cwd>/.mocode/projects/<hash(sandboxRoot)>/snapshot.md
 */

export interface ProjectSnapshot {
  /** 快照版本号 */
  version: 1;
  /** sandbox 根目录（绝对路径） */
  root: string;
  /** 构建时间（ISO 8601） */
  builtAt: string;
  /** LLM 生成的完整快照（markdown 格式） */
  content: string;
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
  return path.join(snapshotDir(), 'snapshot.md');
}

/** 从磁盘加载快照（不存在/损坏返 null） */
export function loadSnapshot(): ProjectSnapshot | null {
  if (currentSnapshot) return currentSnapshot;
  const p = snapshotPath();
  if (!existsSync(p)) return null;
  try {
    const content = readFileSync(p, 'utf8');
    // 从 markdown 文件头部的 YAML front matter 提取元数据
    const match = content.match(/^---\nroot: (.+)\nbuiltAt: (.+)\nversion: (\d+)\n---\n\n([\s\S]+)$/);
    if (!match) return null;
    
    const snap: ProjectSnapshot = {
      version: parseInt(match[3]) as 1,
      root: match[1],
      builtAt: match[2],
      content: match[4],
    };
    currentSnapshot = snap;
    return snap;
  } catch {
    return null;
  }
}

/** 获取当前快照（内存缓存优先，然后磁盘） */
export function getSnapshot(): ProjectSnapshot | null {
  return currentSnapshot ?? loadSnapshot();
}

/**
 * 构建/刷新快照：完全由 LLM 生成
 * @param signal AbortSignal
 * @param force 强制重新生成（忽略缓存）
 * @returns 生成的快照和错误信息
 */
export interface BuildSnapshotResult {
  snapshot: ProjectSnapshot | null;
  error?: string;
  transcript?: string;
}

export async function buildSnapshot(signal?: AbortSignal, force: boolean = false): Promise<BuildSnapshotResult> {
  // 检查缓存：已有快照且不强制刷新，直接返回
  if (!force) {
    const cached = getSnapshot();
    if (cached) return { snapshot: cached };
  }

  const root = getSandboxRoot() ?? process.cwd();

  // 动态导入避免循环依赖
  const { generateLLMSnapshot } = await import('./llm-snapshot.js');
  const result = await generateLLMSnapshot(root, signal);

  if (!result.ok || !result.content) {
    return {
      snapshot: null,
      error: result.error || 'LLM 未返回有效结果',
      transcript: result.transcript,
    };
  }

  const snap: ProjectSnapshot = {
    version: 1,
    root,
    builtAt: new Date().toISOString(),
    content: result.content!,
  };

  // 落盘为 markdown 格式，带 YAML front matter
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  const mdContent = `---\nroot: ${snap.root}\nbuiltAt: ${snap.builtAt}\nversion: ${snap.version}\n---\n\n${snap.content}`;
  writeFileSync(snapshotPath(), mdContent, 'utf8');

  currentSnapshot = snap;
  return { snapshot: snap };
}

/** 清除内存缓存（强制下次重新加载） */
export function clearSnapshotCache(): void {
  currentSnapshot = null;
}
