/**
 * 全局工作空间的发现与会话清单（纯 node:fs，不依赖 electron）。
 *
 * 为什么在 work-app 里自写一份而不是 import core 的 `src/workspace/registry.ts` 与
 * `src/session/store.ts`：Electron 主进程不能 import 仓库根 `src/**`（打包后没有那份源码，
 * 且 `build:electron` 的 boundary 检查会拦）。这里只复刻**读取**两条的最小逻辑：
 *
 *   - `~/.mocode/workspaces.jsonl`：mocode 每进一个目录追加一行（append-only，按 root 折叠）。
 *   - `<root>/.mocode/sessions/`：活会话是目录 + `session.json`；老会话被 retention 压成
 *     `archive/<id>.json.gz` 并在 `archive/index.jsonl` 留摘要行（仍可按 id resume）。
 *
 * 两者都是「读，不改」——写注册表 / 归档会话仍然只有 core 做，避免两份实现打架。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

export interface RegistryEntry {
  root: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  sessions: number;
  sessionsBytes: number;
}

export function workspaceRegistryPath(): string {
  return path.join(os.homedir(), '.mocode', 'workspaces.jsonl');
}

/** 会话目录 / 会话 id 的形态：20260920-224817-585-29c4e832。 */
export const SESSION_DIR_RE = /^\d{8}-\d{6}(?:-\d{3}-[a-f0-9]{8})?$/;

export function sessionsRootOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mocode', 'sessions');
}

/**
 * 读注册表并按 root 折叠（保留 lastSeen 最新的一条），最近访问的在前。
 * 损坏行直接跳过 —— 这是一份可重建的旁路账本，不值得为一行坏数据挡住启动。
 */
export function readWorkspaceRegistry(file = workspaceRegistryPath()): RegistryEntry[] {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const byRoot = new Map<string, RegistryEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<RegistryEntry>;
      if (typeof entry.root !== 'string' || typeof entry.lastSeen !== 'string') continue;
      const resolved = path.resolve(entry.root);
      const key = resolved.toLowerCase();
      const existing = byRoot.get(key);
      if (existing && existing.lastSeen >= entry.lastSeen) continue;
      byRoot.set(key, {
        root: resolved,
        name: entry.name || path.basename(resolved),
        firstSeen: typeof entry.firstSeen === 'string' ? entry.firstSeen : entry.lastSeen,
        lastSeen: entry.lastSeen,
        sessions: typeof entry.sessions === 'number' ? entry.sessions : 0,
        sessionsBytes: typeof entry.sessionsBytes === 'number' ? entry.sessionsBytes : 0,
      });
    } catch { /* 跳过损坏行 */ }
  }
  return [...byRoot.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}

export interface ProjectSessionMeta {
  id: string;
  createdAt: string;
  model: string;
  firstUser: string;
  /**
   * 这条会话最后一次真正被写过的时间（`session.json` 的 mtime）。
   *
   * 与 createdAt 分开：createdAt 是「什么时候开始聊」，这个才是「最后一次聊到哪」。
   * 侧栏「接管」用它当任务排序键 —— 接管只是打开看一眼，不该把一条三个月前的会话
   * 顶成最新活动。
   */
  lastActiveAt?: string;
  /** true = 正文已压进 archive/<id>.json.gz，仍可 resume（core 的 load 会回退到 gz）。 */
  archived?: boolean;
}

interface ArchiveIndexEntry {
  id: string;
  createdAt?: string;
  model?: string;
  firstUser?: string;
  purgedAt?: string;
}

/** 归档索引（archive/index.jsonl）。purged 的行正文已被清除，不能 resume，故不列。 */
function readArchiveIndex(workspaceRoot: string): ArchiveIndexEntry[] {
  const file = path.join(sessionsRootOf(workspaceRoot), 'archive', 'index.jsonl');
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const out: ArchiveIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ArchiveIndexEntry;
      if (entry && typeof entry.id === 'string' && !entry.purgedAt) out.push(entry);
    } catch { /* 跳过损坏行 */ }
  }
  return out;
}

/**
 * 该工作空间里「有历史会话」的条数（活会话 + 未 purge 的归档）。
 *
 * 用这个而不是注册表里的 `sessions` 字段：注册表是**登记那一刻**的快照，之后再没更新过，
 * 而本函数每次现算，所以侧栏的数字不会停在几个月前。
 *
 * 口径是**磁盘条数**，比 `listProjectSessions` 多算那些没有用户发言的空壳会话（实测
 * mocode 284 条里 6 条）。刻意不跟着过滤：判定空壳要逐条 parse session.json，79 个空间
 * 实测 ~350ms，而这个函数在每次状态变化时都会跑；代价（「更多 (N)」偶尔多算几条）
 * 远小于收益。
 */
export function countProjectSessions(workspaceRoot: string): number {
  let live = 0;
  try {
    live = readdirSync(sessionsRootOf(workspaceRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_DIR_RE.test(entry.name)).length;
  } catch { live = 0; }
  const archived = readArchiveIndex(workspaceRoot).length;
  return live + archived;
}

/**
 * 一条 user 消息是不是一次真实的人类发言（有文字或有图片）。
 *
 * 判定看 content 形态而不是 `firstUser` 字段：老会话的 firstUser 可能是空串，也可能被
 * 序列化成了 `[{"type":"text",…}]`，只有 history 能回答「到底聊没聊过」。
 * 只有图片、没有文字的多模态发言算真实发言 —— 用户确实发了东西，只是没打字。
 */
function isRealUserTurn(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const piece = part as { type?: unknown; text?: unknown };
    if (piece.type === 'text') return typeof piece.text === 'string' && piece.text.trim().length > 0;
    return piece.type === 'image_url';
  });
}

/** 这条会话里有没有真实用户发言；没有就是一次「什么都没聊」的空壳。 */
export function hasRealUserTurn(history: unknown): boolean {
  return (
    Array.isArray(history) &&
    history.some(
      (message) =>
        !!message &&
        typeof message === 'object' &&
        (message as { role?: unknown }).role === 'user' &&
        isRealUserTurn(message as Record<string, unknown>),
    )
  );
}

/**
 * 会话标题的人读文本（与 core 的 `src/session/store.ts` firstUserOf 同口径、同步维护）。
 *
 * 多模态 content 直接 `JSON.stringify` 会得到一串 `[{"type":"text","text":"这是？"},…]` ——
 * 早期版本正是那么写 firstUser 的，侧栏就读作一行 JSON。这里现算：取文字段拼接，
 * 只有图片时给 `[图片]` 占位（标题要的是「我第一句说了什么」，不是 base64）。
 */
export function titleFromHistory(history: unknown): string {
  if (!Array.isArray(history)) return '';
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 40);
  for (const message of history) {
    if (!message || typeof message !== 'object') continue;
    if ((message as { role?: unknown }).role !== 'user') continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      const text = oneLine(content);
      if (text) return text;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    let hasImage = false;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const piece = part as { type?: unknown; text?: unknown };
      if (piece.type === 'text' && typeof piece.text === 'string') texts.push(piece.text);
      else if (piece.type === 'image_url') hasImage = true;
    }
    const joined = oneLine(texts.join(' '));
    if (joined) return joined;
    if (hasImage) return '[图片]';
  }
  return '';
}

/**
 * 列某工作空间的历史会话，按时间倒序。
 *
 * 口径与 core 的 `SessionStore.list()` 保持一致：先活会话（读 `session.json` 的头部字段），
 * 再把归档索引里未 purge、且不与活会话重名的条目并进来。
 *
 * 没有真实用户发言的会话（history 只有 system，或留下的测试壳子）**不进列表**：
 * 点开是空的，占着位置只会让人以为「我聊过这个」。标题同样从 history 现算，
 * 修掉老会话被 JSON 序列化的 firstUser。
 *
 * 只读头部几行、按需截断 —— 48 个会话实测 ~50ms，不值得做缓存层。
 */
export function listProjectSessions(workspaceRoot: string, limit = 60): ProjectSessionMeta[] {
  const root = sessionsRootOf(workspaceRoot);
  const out: ProjectSessionMeta[] = [];
  const seen = new Set<string>();
  let ids: string[] = [];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_DIR_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch { ids = []; }
  for (const id of ids.sort().reverse()) {
    if (out.length >= limit) break;
    const file = path.join(root, id, 'session.json');
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as {
        id?: string; createdAt?: string; model?: string; firstUser?: string; history?: unknown;
      };
      // 没有真实用户发言的会话不进列表：history 只有 system（首轮还没发出去就退出）或者
      // 只剩测试壳子。它们点开是空的，留在列表里只会让人以为「我聊过这个」。
      if (!hasRealUserTurn(record.history)) continue;
      // mtime 是「最后一次写这条会话」的时间，接管时用它当排序键 —— 只看一眼的旧会话
      // 不该因为被接管就以 now 顶到最前面。
      let lastActiveAt = '';
      try { lastActiveAt = statSync(file).mtime.toISOString(); } catch { /* 读不到 mtime 就退回 createdAt */ }
      seen.add(id);
      out.push({
        id,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        ...(lastActiveAt ? { lastActiveAt } : {}),
        model: typeof record.model === 'string' ? record.model : '',
        // 标题以 history 现算为准：落盘的 firstUser 可能是老版本序列化出来的 JSON 串。
        firstUser: titleFromHistory(record.history) || (typeof record.firstUser === 'string' ? record.firstUser : ''),
      });
    } catch { /* 目录里还没有 session.json（首轮未结束）或旧布局，跳过 */ }
  }
  for (const entry of readArchiveIndex(workspaceRoot)) {
    if (seen.has(entry.id)) continue;
    const firstUser = typeof entry.firstUser === 'string' ? entry.firstUser : '';
    // 归档会话的正文在 gz 里，逐条解压不可接受（本仓库 206 条归档）；索引里的 firstUser
    // 就是「有没有聊过」的唯一廉价证据 —— 空串说明存档时就没有用户发言。
    if (!firstUser.trim()) continue;
    out.push({
      id: entry.id,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      firstUser,
      archived: true,
    });
  }
  return out
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * 读一条会话的原始 record（history 数组），活会话与归档 gz 都支持。
 *
 * 为什么这里需要 gunzip：用户「接管」的历史会话有相当一部分早就被 retention 压成
 * `archive/<id>.json.gz` 了。host 侧 resume 会自己回退读 gz，但 GUI **回放对话**走的是
 * 主进程的直接文件读 —— 不补这条分支，接管归档会话后聊天区会是空的（看着像没接着上）。
 * 解压只在真正打开某条会话时发生（单条几百 KB），不做批量预读。
 */
export function readSessionHistory(
  workspaceRoot: string,
  sessionId: string,
): Array<Record<string, unknown>> | null {
  const root = sessionsRootOf(workspaceRoot);
  for (const candidate of [path.join(root, sessionId, 'session.json'), path.join(root, `${sessionId}.json`)]) {
    try {
      const record = JSON.parse(readFileSync(candidate, 'utf8')) as { history?: unknown };
      if (Array.isArray(record.history)) return record.history as Array<Record<string, unknown>>;
    } catch { /* 试下一个布局 */ }
  }
  try {
    const raw = gunzipSync(readFileSync(path.join(root, 'archive', `${sessionId}.json.gz`))).toString('utf8');
    const record = JSON.parse(raw) as { history?: unknown };
    if (Array.isArray(record.history)) return record.history as Array<Record<string, unknown>>;
  } catch { /* 未归档 / 已 purge */ }
  return null;
}

/**
 * 一条会话「最后活动时间」的磁盘证据（活会话读 mtime，归档退回 gz 的 mtime）。
 *
 * 只为此单独读一次 stat：侧栏排序键修正（task-order.ts）要拿它跟任务的 updatedAt 对账，
 * 判断这个时间戳是不是被人为写成 now。没有可读文件时返回 null —— 没有证据就不动数据。
 */
export function sessionLastActiveAt(workspaceRoot: string, sessionId: string): string | null {
  const root = sessionsRootOf(workspaceRoot);
  const candidates = [
    path.join(root, sessionId, 'session.json'),
    path.join(root, `${sessionId}.json`),
    path.join(root, 'archive', `${sessionId}.json.gz`),
  ];
  for (const candidate of candidates) {
    try { return statSync(candidate).mtime.toISOString(); } catch { /* 试下一个布局 */ }
  }
  return null;
}

/**
 * 只由 mocode 自己产生、对用户没有意义的临时工作区。
 *
 * 注册表里这类目录占了绝大多数（实测 49 条里 37 条是 temp / worktree / lane 副本）：
 *   `%TEMP%\mocode-ws-xxxx`（测试沙箱）、`.mocode/worktrees/wt-<ts>-<hash>`（sub-agent 工作树）、
 *   `.mocode/lanes/<lane>/task-N/copy`（lane 任务副本）。
 * 它们命中时侧栏会冒出十几个叫 `copy` / `wt-...` 的空间，真正想看的项目被挤到下面。
 */
export function isNoiseWorkspace(workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot);
  const lower = resolved.toLowerCase();
  const sep = path.sep;
  if (lower.startsWith(os.tmpdir().toLowerCase() + sep) || lower === os.tmpdir().toLowerCase()) return true;
  if (lower.includes(`${sep}.mocode${sep}worktrees${sep}`) || lower.includes(`${sep}.mocode${sep}lanes${sep}`)) return true;
  const base = path.basename(resolved);
  return /^mocode-ws-/i.test(base) || /^wt-\d+-[a-f0-9]+$/i.test(base);
}

/**
 * 侧栏是否该为这个目录建一个「空间」：目录还在、不是临时工作区、且至少有一条历史会话。
 * 会话数是现算的（活会话 + 未 purge 的归档），不用注册表里那个登记时的旧快照。
 */
export function isTrackedWorkspace(workspaceRoot: string): boolean {
  return existsSync(workspaceRoot) && !isNoiseWorkspace(workspaceRoot) && countProjectSessions(workspaceRoot) > 0;
}