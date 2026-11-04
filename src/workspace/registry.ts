/**
 * 全局工作区注册表(跨工作空间溯源)。
 *
 * mocode 每进入一个工作区工作(启动或 /cd),就在全局留一条**轻量**基础信息:
 * 路径、首次/最近访问时间、目录名、历史会话数与总用量大小。存 `~/.mocode/workspaces.jsonl`,
 * 供历史 token 回填扫描、以及后续工作区溯源/切换等功能使用。
 *
 * 形态选择:append-only JSONL(与全局 usage 账本同款),每次访问追加一行,
 * 读取时按路径折叠保留最新一条——并发/崩溃安全(无读-改-写),单条 ~150 字节,
 * 普通使用频率下年增不到 100KB,无需主动压缩。静态叶子模块(node:fs/os/path),
 * 可在退出路径安全静态 import。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKSPACE_REGISTRY_PATH = path.join(os.homedir(), '.mocode', 'workspaces.jsonl');

/** 路径覆盖(仅测试用),原因同 global-usage 的 __setGlobalUsagePath。 */
let registryPathOverride: string | undefined;
export function __setWorkspaceRegistryPath(p: string | undefined): void {
  registryPathOverride = p;
}
export function getWorkspaceRegistryPath(): string {
  return registryPathOverride ?? WORKSPACE_REGISTRY_PATH;
}

export interface WorkspaceRegistryEntry {
  /** 绝对路径(Windows 统一为反斜杠原样,path.resolve 口径),去重主键。 */
  root: string;
  /** 目录名(快速辨识用)。 */
  name: string;
  /** 首次见到该工作区的 ISO 时间。 */
  firstSeen: string;
  /** 本次登记的 ISO 时间。 */
  lastSeen: string;
  /** 登记时该工作区 .mocode/sessions 下的历史会话目录数(best-effort)。 */
  sessions: number;
  /** sessions 目录总字节(best-effort,粗略规模)。 */
  sessionsBytes: number;
}

/** 本进程内的登记节流:避免短时间重复启动/切回同目录刷一堆行。 */
const lastAppendAt = new Map<string, number>();
/** 读取时折叠结果内的 firstSeen 要持久,故进程内缓存已知 firstSeen。 */
const knownFirstSeen = new Map<string, string>();
const APPEND_THROTTLE_MS = 60_000;

function sessionsDir(root: string): string {
  return path.join(root, '.mocode', 'sessions');
}

/** 统计会话目录数与总字节(best-effort,浅扫一层,任何异常返回 0)。 */
function scanSessions(root: string): { sessions: number; sessionsBytes: number } {
  const dir = sessionsDir(root);
  let sessions = 0;
  let sessionsBytes = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      sessions++;
      try {
        sessionsBytes += dirSize(path.join(dir, e.name));
      } catch {
        // 单个会话统计失败不影响其余
      }
    }
  } catch {
    return { sessions: 0, sessionsBytes: 0 };
  }
  return { sessions, sessionsBytes };
}

/** 递归目录字节(best-effort);限制深度避免在巨型 sessions 上卡启动。 */
function dirSize(dir: string, depth = 0): number {
  if (depth > 4) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(full, depth + 1);
      else if (e.isFile()) total += fs.statSync(full).size;
    } catch {
      // 忽略不可访问条目
    }
  }
  return total;
}

/**
 * 登记一次工作区访问。best-effort:任何 I/O 失败静默,绝不阻塞启动/切换。
 * 同一路径 60s 内的重复登记跳过(进程级节流)。
 */
export function registerWorkspace(root: string, now: Date = new Date()): void {
  try {
    const abs = path.resolve(root);
    const key = abs.toLowerCase();
    const nowMs = now.getTime();
    // 节流以登记时刻为准(注入时间的调用方可控;生产传 new Date() 即时钟时间):
    // 仅当本次时间晚于上次、且落在同一 60s 窗口内才视为重复访问跳过。
    const prev = lastAppendAt.get(key);
    if (prev != null && nowMs >= prev && nowMs - prev < APPEND_THROTTLE_MS) return;

    let firstSeen = knownFirstSeen.get(key);
    if (!firstSeen) {
      // 从注册表已有行恢复 firstSeen(进程刚启动、该目录此前登记过)。
      firstSeen = readWorkspaceRegistry().find((e) => e.root.toLowerCase() === key)?.firstSeen ?? now.toISOString();
      knownFirstSeen.set(key, firstSeen);
    }
    const { sessions, sessionsBytes } = scanSessions(abs);
    const entry: WorkspaceRegistryEntry = {
      root: abs,
      name: path.basename(abs) || abs,
      firstSeen,
      lastSeen: now.toISOString(),
      sessions,
      sessionsBytes,
    };
    fs.mkdirSync(path.dirname(getWorkspaceRegistryPath()), { recursive: true });
    fs.appendFileSync(getWorkspaceRegistryPath(), `${JSON.stringify(entry)}\n`, 'utf8');
    lastAppendAt.set(key, nowMs);
  } catch {
    // 注册表是增强能力,不能挡住进工作区
  }
}

/**
 * 读注册表并按 root 折叠(保留 lastSeen 最新的一条,firstSeen 取最早)。
 * 按最近访问倒序。损坏行跳过,文件不存在返回空。
 */
export function readWorkspaceRegistry(): WorkspaceRegistryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(getWorkspaceRegistryPath(), 'utf8');
  } catch {
    return [];
  }
  const byRoot = new Map<string, WorkspaceRegistryEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as WorkspaceRegistryEntry;
      if (typeof e.root !== 'string' || typeof e.lastSeen !== 'string') continue;
      const key = e.root.toLowerCase();
      const existing = byRoot.get(key);
      if (!existing || e.lastSeen > existing.lastSeen) {
        const firstSeen =
          existing && existing.firstSeen < e.firstSeen ? existing.firstSeen : (e.firstSeen ?? e.lastSeen);
        byRoot.set(key, { ...e, firstSeen });
      }
    } catch {
      // 跳过损坏行
    }
  }
  return [...byRoot.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}
