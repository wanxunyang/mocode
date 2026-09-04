// memory 工具库(Tier-2):JSONL 存储 + CRUD + 遗忘 GC + 索引段。
// 叶子模块:仅依赖 node 标准库 + tools/constants(常量叶子),不反向依赖 agent/llm/skills/config/ui,
// 避免环(反思 pass 要调 LLM,单独放 reflect.ts,同 session/ 模式)。
//
// 约定:一行一条 JSON(JSONL)。突变统一走「整文件读改写 + tmp+rename 原子落盘」(对齐
// discover.ts/persist.ts 的同步 fs 风格)。所有读写全同步(无 await),单 tick 原子——反思里唯一让出
// 事件循环的是 chat(),其前后的 store 读写不会与 agent 的 store 调用交错(单线程 + await 间不重叠)→ 无竞态、无锁。
//
// 两文件:全局 ~/.mocode/memory.jsonl + 项目 <cwd>/.mocode/memory.jsonl(镜像 resolveMemoryFiles
// 的 global+cwd 与 sessionDir 的 cwd 习惯)。条目带 scope 字段标识归属,loadAll 时按文件归一化。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_ACTIVE, MAX_INDEX_ENTRIES, MAX_MEMORY_ENTRY, DECAY_DAYS, GC_DAYS } from '../tools/constants.js';

export type MemoryType = 'decision' | 'fact' | 'pitfall' | 'reference' | 'feedback';
export type MemoryStatus = 'active' | 'superseded' | 'archived';
export type MemoryScope = 'project' | 'global';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  name: string;
  summary: string;
  body: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  lastRecalledAt: string | null;
  recallCount: number;
  status: MemoryStatus;
  supersededBy: string | null;
  pinned: boolean;
  scope: MemoryScope;
  source: { session?: string; turn?: number } | null;
  lastUpdateReason?: string;
}

/** 索引项(无 body,不进 history 也不占 token)。 */
export interface MemoryIndexItem {
  id: string;
  name: string;
  summary: string;
  type: MemoryType;
  status: MemoryStatus;
}

// ── 路径 ──────────────────────────────────────────────────────────────────
function globalPath(): string {
  return path.join(os.homedir(), '.mocode', 'memory.jsonl');
}
function projectPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory.jsonl');
}
function pathForScope(scope: MemoryScope): string {
  return scope === 'global' ? globalPath() : projectPath();
}
function ensureDir(p: string): void {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── 原子写 / 同步读 ───────────────────────────────────────────────────────
/** 整文件原子落盘:写 tmp 再 rename(POSIX 原子;Windows rename 覆盖既有文件)。空数组写空文件。 */
function writeAtomic(p: string, entries: MemoryEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  const tmp = p + '.tmp';
  writeFileSync(tmp, lines, 'utf8');
  renameSync(tmp, p);
}

/** 读一个文件的条目(静默容错:不存在 / 读失败 / 行非法 → 跳过,不抛)。 */
function readFileEntries(p: string): MemoryEntry[] {
  if (!existsSync(p)) return [];
  let content: string;
  try {
    content = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];
  const out: MemoryEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as MemoryEntry;
      if (e && typeof e.id === 'string') out.push(e);
    } catch {
      continue; // 单行损坏跳过,不连累全文件
    }
  }
  return out;
}

/** 加载全部(global + project),按文件归一化 scope(防旧条目缺字段 / 字段错)。 */
export function loadAll(): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const scope of ['global', 'project'] as const) {
    for (const e of readFileEntries(pathForScope(scope))) {
      e.scope = scope; // 归一化:以实际所在文件为准
      out.push(e);
    }
  }
  return out;
}

/** 按 scope 分组写回:仅写有条目或文件已存在的 scope(避免凭空建空文件)。 */
function writeBackByScope(all: MemoryEntry[]): void {
  for (const scope of ['global', 'project'] as const) {
    const entries = all.filter((e) => e.scope === scope);
    const p = pathForScope(scope);
    if (entries.length === 0 && !existsSync(p)) continue;
    ensureDir(p);
    writeAtomic(p, entries);
  }
}

// ── 工具:slugify / 截断 ───────────────────────────────────────────────────
let slugCounter = 0;
/** name → ASCII slug;空(纯 CJK 等)则 m+时间戳+计数防同毫秒碰撞。 */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s) return s;
  slugCounter++;
  return 'm' + Date.now().toString(36) + slugCounter.toString(36);
}

function truncateBody(body: string): string {
  if (body.length <= MAX_MEMORY_ENTRY) return body;
  const removed = body.length - MAX_MEMORY_ENTRY;
  const marker = `…[已截断 ${removed} 字符]…`;
  return body.slice(0, Math.max(0, MAX_MEMORY_ENTRY - marker.length)) + marker;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── CRUD ──────────────────────────────────────────────────────────────────
export interface SaveInput {
  name: string;
  summary: string;
  body: string;
  type?: MemoryType;
  pinned?: boolean;
  scope?: MemoryScope;
  source?: { session?: string; turn?: number } | null;
}

export type SaveResult = { ok: true; id: string } | { ok: false; exists: string };

/** 新建:id 全局唯一(跨两文件),撞库返 exists 让工具层提示用 memory_update。 */
export function saveEntry(input: SaveInput): SaveResult {
  const id = slugify(input.name);
  const all = loadAll();
  if (all.some((e) => e.id === id)) return { ok: false, exists: id };
  const scope: MemoryScope = input.scope === 'global' ? 'global' : 'project';
  const now = nowIso();
  const entry: MemoryEntry = {
    id,
    type: input.type ?? 'fact',
    name: input.name,
    summary: input.summary,
    body: truncateBody(input.body),
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    status: 'active',
    supersededBy: null,
    pinned: !!input.pinned,
    scope,
    source: input.source ?? null,
  };
  const p = pathForScope(scope);
  const fileEntries = readFileEntries(p);
  fileEntries.push(entry);
  ensureDir(p);
  writeAtomic(p, fileEntries);
  return { ok: true, id };
}

export interface SearchOpts {
  type?: MemoryType;
  status?: MemoryStatus | 'any';
  limit?: number;
}

function scoreEntry(e: MemoryEntry, terms: string[]): number {
  if (terms.length === 0) return 1; // 无关键词:全命中(取前 limit)
  const id = e.id.toLowerCase();
  const name = e.name.toLowerCase();
  const summary = e.summary.toLowerCase();
  const body = e.body.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (id.includes(t)) s += 8; // 含 id 匹配:模型常按索引里的 id 取详情(slug 带连字符,名字带空格,不单独匹配 id 会漏)
    if (name.includes(t)) s += 10;
    if (summary.includes(t)) s += 5;
    if (body.includes(t)) s += 1;
  }
  return s;
}

/** 关键词搜索:多词子串匹配(name 权重最高)。命中即 bump recallCount/lastRecalledAt 写回(遗忘衰减依据)。 */
export function searchEntries(query: string, opts: SearchOpts = {}): MemoryEntry[] {
  const all = loadAll();
  const status = opts.status ?? 'active';
  const pool = all
    .filter((e) => (status === 'any' ? true : e.status === status))
    .filter((e) => (opts.type ? e.type === opts.type : true));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = pool.map((e) => ({ e, s: scoreEntry(e, terms) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const top = scored.slice(0, limit);
  if (top.length === 0) return [];
  // bump recall:只写有命中的 scope 文件
  const now = nowIso();
  const hitIds = new Set(top.map((x) => x.e.id));
  for (const e of all) {
    if (hitIds.has(e.id)) {
      e.recallCount++;
      e.lastRecalledAt = now;
    }
  }
  const hitScopes = new Set(top.map((x) => x.e.scope));
  for (const scope of hitScopes) {
    const p = pathForScope(scope);
    const entries = all.filter((e) => e.scope === scope);
    ensureDir(p);
    writeAtomic(p, entries);
  }
  return top.map((x) => x.e);
}

/** 索引(无 body、不 bump recall)。 */
export function listEntries(opts: { type?: MemoryType; status?: MemoryStatus | 'any' } = {}): MemoryIndexItem[] {
  const status = opts.status ?? 'active';
  return loadAll()
    .filter((e) => (status === 'any' ? true : e.status === status))
    .filter((e) => (opts.type ? e.type === opts.type : true))
    .map((e) => ({ id: e.id, name: e.name, summary: e.summary, type: e.type, status: e.status }));
}

export interface UpdatePatch {
  name?: string;
  summary?: string;
  body?: string;
  reason?: string;
  pinned?: boolean;
}
export type UpdateResult = { ok: true } | { ok: false; notFound: true };

/** 原地改:id 不变(name 可改 → 但 id 仍是旧 slug,故 name 改不会触发重 slug);记 lastUpdateReason;pinned 可切换。 */
export function updateEntry(id: string, patch: UpdatePatch): UpdateResult {
  const all = loadAll();
  const e = all.find((x) => x.id === id);
  if (!e) return { ok: false, notFound: true };
  if (patch.name) e.name = patch.name;
  if (patch.summary) e.summary = patch.summary;
  if (patch.body) e.body = truncateBody(patch.body);
  if (patch.reason) e.lastUpdateReason = patch.reason;
  if (patch.pinned !== undefined) e.pinned = patch.pinned;
  e.updatedAt = nowIso();
  const p = pathForScope(e.scope);
  const entries = all.filter((x) => x.scope === e.scope);
  ensureDir(p);
  writeAtomic(p, entries);
  return { ok: true };
}

export type ForgetResult = { ok: true; mode: string } | { ok: false; notFound: true } | { ok: false; pinned: true };

/** 归档(默认,可复活)/ 硬删;pinned 拒删。 */
export function forgetEntry(id: string, mode: 'archive' | 'delete' = 'archive'): ForgetResult {
  const all = loadAll();
  const e = all.find((x) => x.id === id);
  if (!e) return { ok: false, notFound: true };
  if (e.pinned) return { ok: false, pinned: true };
  const p = pathForScope(e.scope);
  let entries = all.filter((x) => x.scope === e.scope);
  if (mode === 'delete') {
    entries = entries.filter((x) => x.id !== id);
  } else {
    const t = entries.find((x) => x.id === id);
    if (t) {
      t.status = 'archived';
      t.updatedAt = nowIso();
    }
  }
  ensureDir(p);
  writeAtomic(p, entries);
  return { ok: true, mode };
}

// ── 遗忘 GC(纯数据,不调 LLM)─────────────────────────────────────────────
const DAY_MS = 86400000;

export interface GcResult {
  decayed: number;
  capped: number;
  gced: number;
}

/**
 * 遗忘策略(全同步,后台调):
 *  ① archived 超 GC_DAYS → 硬删;
 *  ② active + !pinned + (lastRecalledAt|createdAt) 早于 DECAY_DAYS → archived;
 *  ③ active 数 > MAX_ACTIVE → 按 recallCount 低 × 最近未召回久 淘汰到 archived。
 * pinned 豁免一切自动衰减。写回两文件(均按 scope 过滤)。
 */
export function gcMemories(): GcResult {
  const all = loadAll();
  if (all.length === 0) return { decayed: 0, capped: 0, gced: 0 };
  const now = Date.now();
  const decayMs = DECAY_DAYS * DAY_MS;
  const gcMs = GC_DAYS * DAY_MS;
  const result: GcResult = { decayed: 0, capped: 0, gced: 0 };

  const refTs = (e: MemoryEntry): number => {
    const r = e.lastRecalledAt ? Date.parse(e.lastRecalledAt) : Date.parse(e.createdAt);
    return Number.isFinite(r) ? r : now;
  };

  // ① archived GC
  for (const e of all) {
    if (e.status !== 'archived') continue;
    const u = Date.parse(e.updatedAt || e.createdAt);
    if (Number.isFinite(u) && now - u > gcMs) {
      e.status = '__DELETE__' as MemoryStatus; // 标记硬删(下方过滤)
      result.gced++;
    }
  }

  // ② decay
  for (const e of all) {
    if (e.status !== 'active' || e.pinned) continue;
    if (now - refTs(e) > decayMs) {
      e.status = 'archived';
      e.updatedAt = nowIso();
      result.decayed++;
    }
  }

  // ③ cap active
  const active = all
    .filter((e) => e.status === 'active')
    .sort((a, b) => a.recallCount - b.recallCount || refTs(a) - refTs(b));
  const excess = active.length - MAX_ACTIVE;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      const e = active[i];
      if (e.pinned) continue; // 双保险:排序后仍跳过 pinned
      e.status = 'archived';
      e.updatedAt = nowIso();
      result.capped++;
    }
  }

  // 写回:剔除 __DELETE__ 标记
  const survivors = all.filter((e) => e.status !== ('__DELETE__' as MemoryStatus));
  // 仅当确有变化才写(避免每次 gc 都重写)
  if (result.gced === 0 && result.decayed === 0 && result.capped === 0) return result;
  writeBackByScope(survivors);
  return result;
}

// ── 启动索引段(注入 systemPrompt,同步)────────────────────────────────────
/**
 * active 条目按 updatedAt 降序,封顶 MAX_INDEX_ENTRIES,只注 id/name/summary/type。
 * 无 active 返空串(零行为变化)。body 不注入——按需 memory_search 取。
 *
 * 索引策略(省 token):不全量塞进每轮 systemPrompt。
 *  - pinned 永远包含(pinned = 用户明确想长期保留)
 *  - recallCount ≥ 1 包含(被引用过,价值已验证)
 *  - 否则仅当 (lastRecalledAt|createdAt) 近 RECENT_MS(=DECAY_DAYS×2) 内
 * 排序:pinned 先 → recallCount 降 → updatedAt 降。
 * 封顶 MAX_INDEX_ENTRIES;尾部标 hidden 数量,引导用 memory_list/memory_search 兜底。
 * 真正「陈旧」被滤掉时也明示(让 LLM 知道有内容存在但被策略隐藏,而不是误以为空)。
 *
 * memoryEnabled=false 时(记忆子系统总开关关闭)直接返空串:Memory Index 段
 * 不进系统提示,LLM 看不到工具使用提示;配合 tools/builtins 屏蔽 memory_* 工具,
 * 实现「关闭时零侵入」(默认行为)。传参由 repl 的 buildSystemMessage 在拼装前调
 * isMemoryEnabled() 注入(本文件是叶子,避免直接引 config 起环)。
 */
export function buildMemoryIndexSection(memoryEnabled: boolean = true): string {
  if (!memoryEnabled) return '';
  const all = loadAll();
  const active = all.filter((e) => e.status === 'active');
  if (active.length === 0) return '';
  const now = Date.now();
  // DECAY_DAYS×2 = 60 天(常量在下方定义,同模块作用域内可见)
  const recentCutoff = now - DECAY_DAYS * 2 * DAY_MS;
  const refTs = (e: MemoryEntry): number => {
    const r = e.lastRecalledAt ? Date.parse(e.lastRecalledAt) : Date.parse(e.createdAt);
    return Number.isFinite(r) ? r : now;
  };
  // 过滤:只保留"近 60 天有动静 / 有 recall / pinned"的三类。其它 active 视为陈旧。
  const eligible = active.filter((e) => {
    if (e.pinned) return true;
    if (e.recallCount >= 1) return true;
    return refTs(e) >= recentCutoff;
  });
  eligible.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.recallCount !== b.recallCount) return b.recallCount - a.recallCount;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  const staleCount = active.length - eligible.length;
  const shown = eligible.slice(0, MAX_INDEX_ENTRIES);
  const lines = shown.map((e) => `- ${e.id}: ${e.name} — ${e.summary} (${e.type})`);
  const capOmitted = Math.max(0, eligible.length - shown.length);
  const tailParts: string[] = [];
  if (capOmitted > 0)
    tailParts.push(`${capOmitted} additional active entries omitted by cap (${shown.length}/${eligible.length} shown)`);
  if (staleCount > 0)
    tailParts.push(
      `${staleCount} stale active entries hidden by index policy (no recall + older than ${DECAY_DAYS * 2}d; use memory_list to see all)`,
    );
  const tail = tailParts.length > 0 ? `\n\n…(${tailParts.join('; ')})` : '';
  return [
    '',
    '',
    '## Memory Index (retrieve full body via memory_search)',
    'The following are saved memory entries (title/summary only). Retrieve full body via memory_search (pass id or keyword); use memory_list to see all,' +
      ' memory_update to modify, memory_forget to archive. This list is a startup snapshot; entries added during the session are not listed here — use memory_list/memory_search to find them.' +
      ' Index policy: pinned + recently-recalled always shown; long-untouched active entries are hidden to keep this section lean.',
    ...lines,
    tail,
  ].join('\n');
}
