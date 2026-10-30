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
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_ACTIVE,
  MAX_INDEX_ENTRIES,
  MAX_MEMORY_ENTRY,
  DECAY_DAYS,
  GC_DAYS,
  EPISODE_DECAY_DAYS,
  EPISODE_GC_DAYS,
  EPISODE_CONSOLIDATED_DECAY_DAYS,
  MEMORY_SEARCH_MIN_EVIDENCE,
} from '../tools/constants.js';
import { TextSearchIndex } from '../context/text-search.js';
import { buildAnchors, evaluateAnchors, type AnchorInput, type EntryAnchorState, type MemoryAnchor } from './anchor.js';
import { memoryWriteBlockReason, type MemoryWriteBlocked } from './write-gate.js';
import { appendAudit } from './audit.js';

// 写入总闸放在独立叶子模块(store/graph/pending 三处共用),这里转出,
// 让既有 `import { … } from '../memory/store.js'` 的调用方无需改动。
export {
  setMemoryWritesPaused,
  isMemoryWritesPaused,
  memoryWriteBlockReason,
  memoryWriteBlockedMessage,
  __resetMemoryPauseForTests,
  type MemoryWriteBlocked,
} from './write-gate.js';

/**
 * 记忆类型。
 *
 * `episode`(R6)与其余五类的性质不同:它是**情节**("这次会话做了什么"),不是
 * 可复用的事实。因此它在三处走独立通路,别把它当第六种普通类型:
 *  ① GC:7 天衰减 / 30 天硬删(远短于事实的 30/90,见 constants.ts 的注释);
 *  ② 注入:不进 Memory Index 主列表,单独一个小节、只取最近 N 条;
 *  ③ `MAX_ACTIVE` 封顶:episode 不占事实记忆的名额,否则每个会话一条会在两个月内
 *    把长期知识全部挤出去。
 */
export type MemoryType = 'decision' | 'fact' | 'pitfall' | 'reference' | 'feedback' | 'episode';
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
  /**
   * 内容等价键:归一化 summary+body 的哈希(见 computeDedupKey)。
   * 旧条目无此字段时按当前 summary/body 惰性补算,不做回写迁移。
   */
  dedupKey?: string;
  /**
   * R1.5 条件-动作形态:**何时**这条记忆适用(触发条件)。
   *
   * 刻意与 summary/body 分开存放:`summary` 是"这条讲什么"(给人读的索引),
   * `trigger` 是"什么情况下该想起它"(给前摄通道匹配的键)。描述式事实
   * ("kimi-k3 收 uniqueItems 会 400")要求模型自己判断当前是否相关;写成条件式
   * ("构造工具 schema 且后端是 dashscope compatible-mode 时")则前摄匹配即可命中。
   *
   * 可空:首次写入时往往还不知道将来会在什么场景用到它,强行要求只会得到
   * "涉及代码修改时"这类泛化废话,污染倒排索引比空 trigger 更有害(R1.5.3)。
   */
  trigger?: string;
  /** R1.5 条件-动作形态:**该做什么**。条件成立时的具体动作,而不是现象描述。 */
  action?: string;
  /** trigger 何时被填/改(用于观测"事后补 trigger"是否真的发生)。 */
  triggerUpdatedAt?: string;
  /**
   * R14 派生关系:本条是由哪些条目归纳/巩固而来(源条目 id)。
   *
   * 为什么是**读时**判定失效而不是写时打 status:派生出来的往往是更抽象的结论,
   * 恰恰最不该被藏起来。若新增一个 `stale-derived` 状态,它会立刻掉出
   * `status === 'active'` 的默认检索池——等于因为源条目过期就藏掉一条可能仍然
   * 正确的抽象结论,与"降权且带提示"的原意相反。改为读时现算:
   *  - 零写放大,不需要级联重写(源条目失效时不必去扫全库改派生条目);
   *  - 源条目被复活(un-archive)后派生条目自动恢复,不会留下永久脏标记;
   *  - GC 语义不变,`MemoryStatus` 仍是三种。
   *
   * 可选字段,旧条目读入即无(惰性迁移);硬删的源由 `computeStaleness` 判为 missing。
   */
  derivedFrom?: string[];
  /**
   * R11 巩固关系:**本条情节已被归纳进哪条语义条目**。
   *
   * 与 `derivedFrom` 恰好是反向的同一根链:语义条目用 `derivedFrom` 指向源情节,
   * 源情节用 `derivedInto` 指回语义条目。两者分开存而不是只留一边,因为用途不同——
   * `derivedFrom` 供 R14 读时判失效(源没了这条抽象可能过期),`derivedInto` 供
   * R11 的分组器**排除已巩固过的情节**(否则同一批情节会被反复归纳,每轮都写出一条
   * 新的重复语义条目),同时作为 GC 降权的依据。
   *
   * 可选字段,未巩固的情节没有它。空串等同于"未巩固"(updateEntry 传空串即清除)。
   */
  derivedInto?: string;
  /**
   * R2 代码锚点:这条记忆讨论的代码位置及其写入时的内容哈希。
   *
   * 解决的是 R14 覆盖不到的那一半失效——不是「源记忆过期」,而是**代码本身变了**。
   * 一条「`tool-dispatcher.ts` 的 resultEvent 是回灌唯一汇聚点」的记忆在两次重构后
   * 依然会被原样注入,而且看起来完全可信。
   *
   * 与 `stale`(R14)同样是**读时**判定:`store.ts` 不存 stale 布尔值,由
   * `evaluateAnchors()` 在召回时重读文件现算。理由同 derivedFrom——代码改回来
   * (revert / 分支切换)时记忆应当自动恢复 fresh,落盘状态会留下永久脏标记;
   * 而且 stale 的判定成本是一次 stat + 一次读,不应变成每次保存都要扫全库的写放大。
   *
   * 可选字段,旧条目读入即无(惰性迁移)。
   */
  anchors?: MemoryAnchor[];
}

/** 这三类记忆天然是条件-动作式的;fact/reference 是纯陈述,可无 trigger。 */
export const TRIGGER_REQUIRED_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(['pitfall', 'decision', 'feedback']);

/** 该类型是否建议带 trigger(用于提示词与观测,不做硬拦截)。 */
export function wantsTrigger(type: MemoryType): boolean {
  return TRIGGER_REQUIRED_TYPES.has(type);
}

/** 索引项(无 body,不进 history 也不占 token)。 */
export interface MemoryIndexItem {
  id: string;
  name: string;
  summary: string;
  type: MemoryType;
  status: MemoryStatus;
  /**
   * 是否已有 trigger(R3 前摄索引的唯一来源)。
   *
   * 暴露在索引里的原因:向前摄通道供料是**模型的自助动作**,而模型只有在
   * `memory_list` 里看得见「这条缺 trigger」时才会去补。实测真实库 trigger 覆盖率为 0,
   * 若不显式暴露,缺口永远是隐形的,通道就是个空索引。
   */
  hasTrigger: boolean;
  /**
   * R14:本条派生自的源条目当前是否已失效。只有 `derivedFrom` 非空的条目会有意义。
   *
   * 列表里必须暴露:模型只有看得见「这条的根据已经变了」,才会去复核而不是直接引用。
   * 隐藏 stale 反而更危险——抽象结论看起来永远成立,恰恰是它最容易悄悄过期。
   */
  stale?: boolean;
  /**
   * R2:本条锚定的代码是否已与写入时不一致。只有 `anchors` 非空的条目会有意义。
   *
   * 与 `stale`(R14)分开一个字段而不是合并:两者的失效原因不同(源记忆过期 vs
   * 代码变了),模型应采取的动作也不同——前者是"别引用这条结论",后者是"结论可能
   * 仍对,但代码位置/细节要重新核对"。
   */
  anchorStale?: boolean;
  /** R2:锚点数量(0 或未设置时不输出),供 `/memory` 概览与列表观测覆盖率。 */
  anchorCount?: number;
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
function loadAllRaw(): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const scope of ['global', 'project'] as const) {
    for (const e of readFileEntries(pathForScope(scope))) {
      e.scope = scope; // 归一化:以实际所在文件为准
      out.push(e);
    }
  }
  return out;
}

// ── 召回计数脏集(R0.2)────────────────────────────────────────────────────
// 每次 memory_search 都整文件读改写会让纯读操作付出写盘代价,并把并发检索串行化。
// 改为:命中只累加到内存 dirty 集,读路径(loadAll)应用增量保证计数可见,
// 轮末 / 退出 / 任一写操作前统一 flush 落盘。
interface PendingRecall {
  scope: MemoryScope;
  count: number;
  at: string;
}
const pendingRecall = new Map<string, PendingRecall>();
/**
 * 脏集阈值:达此条数就在 searchEntries 内就地 flush。
 * 存在的理由是**非 REPL 入口**(headless / 单次工具调用)走不到轮末 flush,
 * 脏集随进程退出就丢了。设得比典型一次搜索的命中数大,REPL 场景实际不会触发。
 */
const PENDING_RECALL_FLUSH_THRESHOLD = 64;

/** 把未落盘的召回增量应用到条目上(不修改 pending)。 */
function applyPendingRecall(entries: MemoryEntry[]): MemoryEntry[] {
  if (pendingRecall.size === 0) return entries;
  for (const e of entries) {
    const p = pendingRecall.get(e.id);
    if (!p) continue;
    e.recallCount += p.count;
    e.lastRecalledAt = p.at;
  }
  return entries;
}

/** 加载全部并应用未落盘的召回增量(读路径统一入口)。 */
export function loadAll(): MemoryEntry[] {
  return applyPendingRecall(loadAllRaw());
}

/**
 * 落盘所有未写入的召回增量。幂等:无 pending 时零 IO。
 * 由轮末、退出、以及每个写操作的开头调用(写操作自己会整文件重写,
 * 先 flush 可保证不会与待写增量重复累加)。返回落盘的条目数。
 */
export function flushRecallStats(): number {
  if (pendingRecall.size === 0) return 0;
  // 写入被拦时不落盘也**不清**脏集:清掉就丢了召回计数(R0.2 的统计口径),而刷新
  // 计数不是用户可见的内容写入,恢复后仍应补上。返回 0 让调用方知道没写。
  if (memoryWriteBlockReason()) return 0;
  const entries = applyPendingRecall(loadAllRaw());
  const touched = new Set<MemoryScope>();
  for (const p of pendingRecall.values()) touched.add(p.scope);
  for (const scope of touched) {
    const p = pathForScope(scope);
    ensureDir(p);
    writeAtomic(
      p,
      entries.filter((e) => e.scope === scope),
    );
  }
  const n = pendingRecall.size;
  pendingRecall.clear();
  return n;
}

/**
 * 写回某 scope 之后调用:清除该 scope 的待落盘增量。
 *
 * 增量此时已烘进刚写的文件(调用方拿到的条目来自 loadAll,已含增量),
 * 不清除会在下次读时再加一遍 → 重复累加;只清该 scope 才不会丢掉
 * 另一次写不会覆盖的那个 scope 的增量。
 */
function clearPendingScope(scope: MemoryScope): void {
  for (const [id, p] of pendingRecall) {
    if (p.scope === scope) pendingRecall.delete(id);
  }
}

/** 待落盘增量条数(超过阈值时 searchEntries 自动 flush,给非 REPL 入口兜底)。 */
export function pendingRecallCount(): number {
  return pendingRecall.size;
}

/**
 * 退出兜底:SIGINT / 未捕获异常不保证经过 REPL 收尾,脏集若只靠轮末 flush
 * 会随进程退出丢失。这里自注册一个 exit 钩子——store 是叶子模块,不能反向
 * 依赖 index.ts 的退出编排,只能自带兜底。flush 幂等且无 pending 时零 IO,
 * 与轮末 flush 并存不会重复写。unref 不适用(exit 钩子本身不需要句柄)。
 */
let exitHookInstalled = false;
function installExitFlush(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    try {
      flushRecallStats();
    } catch {
      // 退出路径绝不抛错
    }
  });
}

/** 仅供测试:清空未落盘增量(避免用例间串味)。 */
export function __resetPendingRecallForTests(): void {
  pendingRecall.clear();
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

// ── 工具:slugify / 去重键 / 截断 ─────────────────────────────────────────
/**
 * 名称归一:小写、去首尾空白、内部空白压成单空格、全角空格同化。
 * 只做确定性变换,不做同义词/编辑距离——模糊匹配属于检索层,不属于身份层。
 */
function normalizeName(raw: string): string {
  return String(raw ?? '')
    .replace(/\u3000/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * name → id。
 *
 * ASCII 名走可读 slug;**纯 CJK 名(及其它无 ASCII 音节的名)走名称哈希**——
 * 历史实现用 `m+Date.now()+counter` 兜底,导致同一个中文名每次保存都得到不同 id,
 * 于是 saveEntry 的「同 id 即已存在」检查对中文名完全失效,同一件事可无限重复入库。
 * 改用 sha256(归一化名) 前缀后,同一名称恒定映射到同一 id,与英文名行为对齐。
 * 原 `slugCounter` 随旧兜底一起删掉:哈希已保证确定性,再保留一个永不读的计数器
 * 只会让 lint 报错。
 */
function slugify(name: string): string {
  const s = normalizeName(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s) return s;
  const h = createHash('sha256').update(normalizeName(name)).digest('hex').slice(0, 12);
  return 'm-' + h;
}

/**
 * 去重键:归一化 **summary + body** 的哈希(不含 name)。
 *
 * 为什么不含 name——id 由归一化 name 派生,若 dedupKey 也含 name,则「同 key」
 * 必然「同 name」必然「同 id」,命中集合是 id 检查的子集,等于死代码。
 * 去重键要解决的是 id 检查覆盖不到的另一半:**不同名、同一件事**。
 * 反思很容易把同一结论写成不同标题(`user-language-chinese-replies`
 * vs `万偏好中文`),只有抛开 name 比较内容才拦得住。
 *
 * 为什么不含 body 之外的其它字段——type/pinned/scope 是元数据,不影响
 * "说的是不是同一件事"的判断;scope 另在 saveEntry 内按 scope 隔离比较。
 */
export function computeDedupKey(summary: string, body: string): string {
  const norm = (raw: string): string =>
    String(raw ?? '')
      .replace(/\u3000/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const s = norm(summary);
  const b = norm(body);
  return createHash('sha256')
    .update(s + '\u0000' + b)
    .digest('hex')
    .slice(0, 16);
}

/** 条目去重键(旧条目无该字段时惰性按 summary+body 补算,不回写——读路径保持只读)。 */
function dedupKeyOf(e: MemoryEntry): string {
  return e.dedupKey || computeDedupKey(e.summary, e.body);
}

/**
 * 派生关系上限。一条记忆归纳自太多源时,「任一源失效即 stale」会退化成恒 stale,
 * 提示也就失去了指向性。8 条足够覆盖「同类情节归纳成语义」的典型规模。
 */
const MAX_DERIVED_FROM = 8;

/** 归一 derivedFrom:去空、去自引用、去重、封顶。自引用必须滤掉,否则该条永远 stale。 */
function normalizeDerivedFrom(input: readonly string[] | undefined, selfId: string): string[] {
  if (!input || input.length === 0) return [];
  const out: string[] = [];
  for (const raw of input) {
    const id = String(raw ?? '').trim();
    if (!id || id === selfId || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_DERIVED_FROM) break;
  }
  return out;
}

/** R14:一条派生条目的失效判定结果。 */
export interface EntryStaleness {
  /** 任一源条目已失效/不存在。 */
  stale: boolean;
  /** 源条目已不存在(被硬删)的 id。 */
  missing: string[];
  /** 源条目存在但已 non-active(superseded / archived)的 id。 */
  inactive: string[];
}

const NOT_STALE: EntryStaleness = { stale: false, missing: [], inactive: [] };

/**
 * R14 读时级联:按源条目**当前**状态判定本条是否 stale。
 *
 * 只判**直接**源,不递归传播:A 被取代 → 派生自 A 的 B 变 stale;B 自己仍是 active,
 * 所以派生自 B 的 C 不受影响。递归会让一次取代波及整条抽象链,而越抽象的上层结论
 * 越可能依然成立——那正是「不能因为源失效就删掉派生结论」的原意。
 */
export function computeStaleness(entry: MemoryEntry, byId: ReadonlyMap<string, MemoryEntry>): EntryStaleness {
  const src = entry.derivedFrom ?? [];
  if (src.length === 0) return NOT_STALE;
  const missing: string[] = [];
  const inactive: string[] = [];
  for (const id of src) {
    const s = byId.get(id);
    if (!s) missing.push(id);
    else if (s.status !== 'active') inactive.push(id);
  }
  if (missing.length === 0 && inactive.length === 0) return NOT_STALE;
  return { stale: true, missing, inactive };
}

/**
 * 一次算出全库派生条目的失效表(只含 derivedFrom 非空的条目)。
 *
 * 集中在这里而不是散落在各读路径:检索、列表、概览三处都要同一套判定,
 * 各算一遍迟早漂移成三种口径。调用方可传入已有的 loadAll() 结果以省一次读盘。
 */
export function loadStalenessMap(all: MemoryEntry[] = loadAll()): Map<string, EntryStaleness> {
  const byId = new Map(all.map((e) => [e.id, e]));
  const out = new Map<string, EntryStaleness>();
  for (const e of all) {
    if (!e.derivedFrom || e.derivedFrom.length === 0) continue;
    out.set(e.id, computeStaleness(e, byId));
  }
  return out;
}

/**
 * R2 一次算出全库**锚点**失效表(只含 anchors 非空的条目)。
 *
 * 与 `loadStalenessMap` 并列而非合并:两者数据源完全不同(一条查条目状态,一条读文件),
 * 合并会让「只有派生关系、没有锚点」的绝大多数条目去背一次文件系统遍历。
 *
 * 每个锚点都要 stat(命中 mtime 缓存则免读),所以这里按条目惰性判定、不预读全部文件。
 */
export function loadAnchorStaleMap(all: MemoryEntry[] = loadAll()): Map<string, EntryAnchorState> {
  const out = new Map<string, EntryAnchorState>();
  for (const e of all) {
    if (!e.anchors || e.anchors.length === 0) continue;
    out.set(e.id, evaluateAnchors(e.anchors));
  }
  return out;
}

/**
 * R2.4 反向查询:哪些记忆锚定了这个文件。
 *
 * 供 `read_file` 在结果尾部回注用——读到某个文件时,顺带告诉模型「关于这个文件,
 * 你以前记过这些」。这是 R2 唯一不需要模型主动检索就能生效的一段(push 侧),
 * 而 pull 侧(memory_search)实测调用次数为 0。
 *
 * 只返回 **active** 条目:归档/被取代的条目说的是历史,不该在写代码时冒出来。
 * 调用方再按 `evaluateAnchors` 过滤 fresh——刚读到的文件内容与记忆里的一致,
 * 这条记忆才有资格当场提示;对不上就说明它已经过期,此时提示反而误导。
 */
export function entriesAnchoredTo(
  anchorPath: string,
  opts: { limit?: number; activeOnly?: boolean } = {},
): MemoryEntry[] {
  const limit = Math.max(1, opts.limit ?? 3);
  const activeOnly = opts.activeOnly ?? true;
  const out: MemoryEntry[] = [];
  for (const e of loadAll()) {
    if (!e.anchors || e.anchors.length === 0) continue;
    if (activeOnly && e.status !== 'active') continue;
    if (!e.anchors.some((a) => a.path === anchorPath)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
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
  /** R1.5:适用条件(可空,允许事后补)。 */
  trigger?: string;
  /** R1.5:条件成立时该做什么。 */
  action?: string;
  /** R14:本条由哪些条目归纳而来(源条目 id)。自引用与重复会被滤掉。 */
  derivedFrom?: readonly string[];
  /**
   * R2:要锚定的代码位置。**传意图(path/symbol),不传 hash** —— hash 由 store 在
   * 写入时现算,调用方给一份 hash 只会带来"抄错一个字符就永远 stale"的故障模式。
   * 文件不存在/符号找不到的锚点会被静默丢弃(见 buildAnchors)。
   */
  anchors?: readonly AnchorInput[];
}

export type SaveResult = { ok: true; id: string } | { ok: false; exists: string } | MemoryWriteBlocked;

/**
 * 新建。两道确定性去重,任一命中都返 exists 引导调用方改走 memory_update:
 *  ① **同 id**(同一归一化名字)——跨两文件,历史行为;
 *  ② **同 dedupKey**(归一化 summary+body 的哈希,不含名字)——拦住「同一件事换个写法的标题」。
 *     只在 scope 内比较:global 与 project 允许各存一份同内容条目,那是刻意的
 *     可见性差异,不算重复。已归档/被取代的条目也参与比较,避免复活同一件事。
 */
export function saveEntry(input: SaveInput): SaveResult {
  const blocked = memoryWriteBlockReason();
  if (blocked) return { ok: false, blocked };
  const id = slugify(input.name);
  const all = loadAll();
  if (all.some((e) => e.id === id)) return { ok: false, exists: id };
  const scope: MemoryScope = input.scope === 'global' ? 'global' : 'project';
  // 先截断再算 key:stored entry 的 body 是截断后的版本,dedupKeyOf 也按截断后的算,
  // 两边口径必须一致,否则长正文条目每次都算作"新内容"。
  const body = truncateBody(input.body);
  const dedupKey = computeDedupKey(input.summary, body);
  const dup = all.find((e) => e.scope === scope && dedupKeyOf(e) === dedupKey);
  if (dup) return { ok: false, exists: dup.id };
  const now = nowIso();
  // R1.5:trigger/action 归一为空串即视为"未填",不写空字段(避免 JSONL 里全是空键)。
  const trigger = input.trigger?.trim() || undefined;
  const action = input.action?.trim() || undefined;
  // R14:派生来源。滤掉自引用(模型偶尔把新 id 自己写进 derivedFrom)与空串,
  // 否则一条派生条目会因为"源是自己"而永远算作 stale。
  const derivedFrom = normalizeDerivedFrom(input.derivedFrom, id);
  // R2:锚点在**写入时**现算 hash(调用方只给 path/symbol)。算不出来的(文件不存在、
  // 符号找不到)静默丢弃——存一条锚不住任何东西的锚点只会制造永久 unknown 噪音。
  const anchors = buildAnchors(input.anchors);
  const entry: MemoryEntry = {
    id,
    type: input.type ?? 'fact',
    name: input.name,
    summary: input.summary,
    body,
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    status: 'active',
    supersededBy: null,
    pinned: !!input.pinned,
    scope,
    source: input.source ?? null,
    dedupKey,
    ...(trigger ? { trigger } : {}),
    ...(action ? { action } : {}),
    ...(trigger ? { triggerUpdatedAt: now } : {}),
    ...(derivedFrom.length > 0 ? { derivedFrom } : {}),
    ...(anchors.length > 0 ? { anchors } : {}),
  };
  const p = pathForScope(scope);
  // 用 all(已含未落盘召回增量)而非裸读文件:否则写回会把这些增量的实体版本覆盖掉。
  const fileEntries = all.filter((e) => e.scope === scope);
  fileEntries.push(entry);
  ensureDir(p);
  writeAtomic(p, fileEntries);
  clearPendingScope(scope); // 增量已烘进文件,清掉避免下次读重复累加
  return { ok: true, id };
}

export interface SearchOpts {
  type?: MemoryType;
  status?: MemoryStatus | 'any';
  limit?: number;
}

/**
 * 关键词搜索:CJK 感知 BM25(共享 context/text-search),字段权重 name 10 > id 8 >
 * summary 5 > body 1。命中即 bump recallCount/lastRecalledAt 写回(遗忘衰减依据)。
 * 空查询:按旧行为返回前 limit 条(全命中)。
 */
export function searchEntries(query: string, opts: SearchOpts = {}): MemoryEntry[] {
  const all = loadAll();
  const status = opts.status ?? 'active';
  const pool = all
    .filter((e) => (status === 'any' ? true : e.status === status))
    .filter((e) => (opts.type ? e.type === opts.type : true));
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const top: MemoryEntry[] = [];
  // R14.3:status='any' 时先多取候选再排序截断。
  //
  // 为什么不能只排序已取回的 limit 条:实测真实库 query="mocode" 时前 4 条全是
  // archived(标题匹配得分高),limit=5 就会把 active 的那条彻底挤出去——排序再对
  // 也排不出一个根本没被取回的条目。多取一截、排完再截,才能保证「active 优先」
  // 在结果条数受限时也成立。
  const searchN = status === 'any' ? Math.min(pool.length, Math.max(limit * 4, limit + 10)) : limit;
  if (terms.length === 0) {
    top.push(...pool.slice(0, searchN));
  } else {
    const index = new TextSearchIndex(
      pool.map((e) => ({
        id: e.id,
        fields: [
          { text: e.name, weight: 10 },
          { text: e.id, weight: 8 },
          { text: e.summary, weight: 5 },
          { text: e.body, weight: 1 },
        ],
      })),
      // R15.5:相关性下限。BM25 只排序、不判「相关与否」,任何 token 重合都返回;
      // 实测 6 条无关查询(红烧肉/签证/kubernetes…)全部被召回,误报率 100%。
      // 加下限后误报 0、正例 recall@1 仍 98%(代价见 constants.ts 该常量注释)。
      // 用「证据词元命中数」而非分数阈值:分数随 N/idf 漂移(同一份探针在
      // fixture 最优 31.94、真实库 40.60),写死哪个都会在另一套数据上失效。
      { minEvidenceMatched: MEMORY_SEARCH_MIN_EVIDENCE },
    );
    const byId = new Map(pool.map((e) => [e.id, e]));
    for (const hit of index.search(query, searchN)) {
      const e = byId.get(hit.id);
      if (e) top.push(e);
    }
  }
  if (status === 'any' && top.length > 0) {
    // 稳定排序:同组内保持 BM25 分数序,只是把 active 整体提到非 active 之前。
    const rank = (e: MemoryEntry): number => (e.status === 'active' ? 0 : 1);
    top.sort((a, b) => rank(a) - rank(b));
    top.length = Math.min(top.length, limit);
  }
  if (top.length === 0) return [];
  // bump recall:只累加到内存脏集,不落盘(R0.2)。搜索是纯读语义,不该让每次
  // memory_search 都整文件重写;增量由 loadAll 即时体现(计数立刻可见),
  // 落盘交给轮末 / 退出 / 下一个写操作。同一条目多次命中在脏集内累加。
  const now = nowIso();
  installExitFlush(); // 脏集出现即保障退出兜底(幂等)
  for (const e of top) {
    const prev = pendingRecall.get(e.id);
    pendingRecall.set(e.id, {
      scope: e.scope,
      count: (prev?.count ?? 0) + 1,
      at: now,
    });
    e.recallCount++;
    e.lastRecalledAt = now;
  }
  // 兜底:非 REPL 入口(headless / 单次工具调用)不会走到轮末 flush,
  // 脏集长期不落盘会随进程退出丢失。攒够阈值就地刷一次。
  if (pendingRecall.size >= PENDING_RECALL_FLUSH_THRESHOLD) flushRecallStats();
  return top;
}

/** 索引(无 body、不 bump recall)。 */
export function listEntries(opts: { type?: MemoryType; status?: MemoryStatus | 'any' } = {}): MemoryIndexItem[] {
  const status = opts.status ?? 'active';
  const all = loadAll();
  const stale = loadStalenessMap(all);
  const anchorStale = loadAnchorStaleMap(all);
  return all
    .filter((e) => (status === 'any' ? true : e.status === status))
    .filter((e) => (opts.type ? e.type === opts.type : true))
    .map((e) => {
      const s = stale.get(e.id);
      const a = anchorStale.get(e.id);
      const anchorCount = e.anchors?.length ?? 0;
      return {
        id: e.id,
        name: e.name,
        summary: e.summary,
        type: e.type,
        status: e.status,
        hasTrigger: !!e.trigger,
        // 只在确实是派生条目且确实失效时才带该字段:非派生条目占绝大多数,
        // 一律写 `stale: false` 会把可选字段变成噪音。
        ...(s?.stale ? { stale: true } : {}),
        ...(a?.stale ? { anchorStale: true } : {}),
        ...(anchorCount > 0 ? { anchorCount } : {}),
      };
    });
}

export interface UpdatePatch {
  name?: string;
  summary?: string;
  body?: string;
  reason?: string;
  pinned?: boolean;
  /** R1.5:改适用条件。传空串表示清空。 */
  trigger?: string;
  /** R1.5:改条件动作。传空串表示清空。 */
  action?: string;
  /**
   * R2:整体替换锚点集(同样只给 path/symbol,hash 现算)。
   *
   * 语义是**替换**不是合并:模型说得出新锚点集时,旧的那套已被它重新确认过一遍,
   * 合并会让"去掉一个过时锚点"变成不可能的操作。传空数组 = 清空锚点。
   */
  anchors?: readonly AnchorInput[];
  /**
   * R11:把一条情节标记为「已巩固进 <id>」。
   *
   * 只由巩固任务内部写入,不对模型暴露(`memory_update` 的 schema 里没有这个字段)——
   * 手工声明"我这条已经被归纳了"没有可信来源,而巩固器知道确切的分组结果。
   * 传空串表示清除(重新参与分组,用于撤销一次错误的巩固)。
   */
  derivedInto?: string;
}
export type UpdateResult = { ok: true } | { ok: false; notFound: true } | MemoryWriteBlocked;

/** 原地改:id 不变(name 可改 → 但 id 仍是旧 slug,故 name 改不会触发重 slug);记 lastUpdateReason;pinned 可切换。 */
export function updateEntry(id: string, patch: UpdatePatch): UpdateResult {
  const blocked = memoryWriteBlockReason();
  if (blocked) return { ok: false, blocked };
  const all = loadAll();
  const e = all.find((x) => x.id === id);
  if (!e) return { ok: false, notFound: true };
  if (patch.name) e.name = patch.name;
  if (patch.summary) e.summary = patch.summary;
  if (patch.body) e.body = truncateBody(patch.body);
  // dedupKey 必须随内容一起重算。它缓存在条目上,只在 saveEntry 时算过一次;
  // 若这里不更新,改完内容后两次判重都会错:
  //  ① 用**新内容**再 saveEntry 不被拦 → 同一件事重复入库(dedupKey 本该拦的正是这个);
  //  ② 用**更新前**的旧内容再 saveEntry 反而被拦 → 已经改掉的结论复活不了。
  // 比较放在赋值之后、写盘之前:两条 dedupKey 都按截断后的 body 算,口径与 saveEntry 一致。
  if (patch.summary !== undefined || patch.body !== undefined) {
    e.dedupKey = computeDedupKey(e.summary, e.body);
  }
  if (patch.reason) e.lastUpdateReason = patch.reason;
  if (patch.pinned !== undefined) e.pinned = patch.pinned;
  // trigger/action 用 `!== undefined` 判定:空串是合法的"清空"意图,
  // 不能用真值判断(否则用户永远删不掉一条写错的 trigger)。
  if (patch.trigger !== undefined) {
    const t = patch.trigger.trim();
    if (t) {
      e.trigger = t;
      e.triggerUpdatedAt = nowIso();
    } else {
      delete e.trigger;
      delete e.triggerUpdatedAt;
    }
  }
  if (patch.action !== undefined) {
    const a = patch.action.trim();
    if (a) e.action = a;
    else delete e.action;
  }
  // R2:锚点整体替换(空数组 = 清空)。hash 现算,算不出来的静默丢弃。
  if (patch.anchors !== undefined) {
    const anchors = buildAnchors(patch.anchors);
    if (anchors.length > 0) e.anchors = anchors;
    else delete e.anchors;
  }
  // R11:巩固标记。空串 = 清除(撤销一次错误巩固);不校验 id 是否存在——
  // 目标条目被硬删后这里会留下悬空指针,但它只被分组器用来"排除已巩固的情节",
  // 悬空指针的语义(巩固过)仍然正确,强行校验只会让巩固写入多一次失败路径。
  if (patch.derivedInto !== undefined) {
    const t = patch.derivedInto.trim();
    if (t) e.derivedInto = t;
    else delete e.derivedInto;
  }
  e.updatedAt = nowIso();
  const p = pathForScope(e.scope);
  // all 来自 loadAll,已含未落盘的召回增量;写回即把增量烘进文件,故随后清该 scope 的 pending。
  const entries = all.filter((x) => x.scope === e.scope);
  ensureDir(p);
  writeAtomic(p, entries);
  clearPendingScope(e.scope);
  return { ok: true };
}

/**
 * 把旧条目标记为被新条目取代(status=superseded + supersededBy 链,不删除可审计)。
 * 与 forgetEntry 的区别:这是 belief-revision 语义——"旧信念被新事实取代",
 * 而不是"过期清理"。pinned 条目同样允许被取代(取代链是显式修正,不是自动遗忘)。
 */
export function supersedeEntry(
  oldId: string,
  newId: string,
  reason?: string,
): { ok: true } | { ok: false; notFound: true } | MemoryWriteBlocked {
  const blocked = memoryWriteBlockReason();
  if (blocked) return { ok: false, blocked };
  const all = loadAll();
  const oldE = all.find((x) => x.id === oldId);
  if (!oldE) return { ok: false, notFound: true };
  oldE.status = 'superseded';
  oldE.supersededBy = newId;
  oldE.updatedAt = nowIso();
  if (reason) oldE.lastUpdateReason = reason;
  const p = pathForScope(oldE.scope);
  writeAtomic(
    p,
    all.filter((x) => x.scope === oldE.scope),
  );
  clearPendingScope(oldE.scope);
  return { ok: true };
}

export type ForgetResult =
  | { ok: true; mode: string }
  | { ok: false; notFound: true }
  | { ok: false; pinned: true }
  | MemoryWriteBlocked;

/** 归档(默认,可复活)/ 硬删;pinned 拒删。 */
export function forgetEntry(id: string, mode: 'archive' | 'delete' = 'archive'): ForgetResult {
  const blocked = memoryWriteBlockReason();
  if (blocked) return { ok: false, blocked };
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
  clearPendingScope(e.scope);
  return { ok: true, mode };
}

// ── R8.2 批量遗忘 ─────────────────────────────────────────────────────────
export interface PurgeOptions {
  /** 清空(仍需给 scope 或全局开关;不传 scope 则两库都清)。 */
  all?: boolean;
  scope?: MemoryScope;
  /** 只删 **createdAt 不早于**此刻的条目(ISO 或 `YYYY-MM-DD`)。 */
  since?: string;
  /** 名字/摘要/正文/id 里含该子串(大小写无关)。 */
  match?: string;
  /** 只列名单不落盘。 */
  dryRun?: boolean;
}

export interface PurgeResult {
  ok: true;
  /** 真正(或将)被删的 id。dryRun 时是"将要删的"。 */
  ids: string[];
  /** 命中但因 pinned 被保留的条数。 */
  pinned: number;
  dryRun: boolean;
}

/**
 * 批量**真删**(不是 archived)。
 *
 * 与 `forgetEntry(id, 'delete')` 的关系:那个是单条、给模型用的;这个是给用户批量用的。
 * 三处刻意设计:
 *  ① **pinned 永不删**——pinned 的语义就是"用户明确要长期留着",批量操作不该推翻它;
 *  ② **必须至少给一个条件**:全空调用返回空结果而不是清库,防手滑(要清库就 --all);
 *  ③ **先算名单再落盘**:dryRun 与真删走同一段筛选,预览与执行不可能不一致。
 */
export function purgeEntries(opts: PurgeOptions = {}): PurgeResult | MemoryWriteBlocked {
  const dryRun = opts.dryRun === true;
  // dryRun 只是预演,不写盘,因此不受暂停闸限制——被 pause 的用户更需要能先看看会删什么。
  if (!dryRun) {
    const blocked = memoryWriteBlockReason();
    if (blocked) return { ok: false, blocked };
  }
  const all = loadAll();
  const match = opts.match?.trim().toLowerCase() ?? '';
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const hasCond = opts.all === true || Boolean(match) || Number.isFinite(sinceMs);
  // 无任何条件 → 什么都不做。返回成功但空名单,调用方据此提示用法,而不是悄悄清库。
  if (!hasCond) return { ok: true, ids: [], pinned: 0, dryRun };

  const hit = all.filter((e) => {
    if (opts.scope && e.scope !== opts.scope) return false;
    if (match) {
      const hay = `${e.id}\n${e.name}\n${e.summary}\n${e.body}`.toLowerCase();
      if (!hay.includes(match)) return false;
    }
    if (Number.isFinite(sinceMs)) {
      const t = Date.parse(e.createdAt);
      if (!Number.isFinite(t) || t < sinceMs) return false;
    }
    return true;
  });
  const ids = hit.filter((e) => !e.pinned).map((e) => e.id);
  const pinned = hit.length - ids.length;
  if (dryRun || ids.length === 0) return { ok: true, ids, pinned, dryRun };

  const drop = new Set(ids);
  for (const scope of ['global', 'project'] as const) {
    if (opts.scope && scope !== opts.scope) continue;
    const p = pathForScope(scope);
    const kept = all.filter((e) => e.scope === scope && !drop.has(e.id));
    // 该 scope 本来就没有文件、也没有要删的条目 → 不要凭空建空文件(R8.5 同口径)。
    if (kept.length === 0 && !existsSync(p)) continue;
    ensureDir(p);
    writeAtomic(p, kept);
    clearPendingScope(scope);
  }
  // 审计行写在落盘**之后**:只有真的删成了才记「已删」,否则日志会撒谎。
  // 只记 id 与条件,**不记正文**——审计文件同样躺在磁盘上,删掉的隐私不该换个文件继续存。
  const cond = [
    opts.all ? '--all' : '',
    opts.scope ? `--scope ${opts.scope}` : '',
    opts.since ? `--since ${opts.since}` : '',
    match ? `--match ${match}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  appendAudit({
    at: nowIso(),
    action: 'purge',
    detail: `批量删除 ${ids.length} 条${pinned ? `(保留 pinned ${pinned} 条)` : ''} ${cond}`.trim(),
    ids,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  return { ok: true, ids, pinned, dryRun };
}

// ── R8.1/R9.2 导入 ────────────────────────────────────────────────────────
export interface ImportEntriesResult {
  ok: true;
  added: number;
  updated: number;
  skipped: number;
}

/**
 * 按 id 合并导入条目(R8.1 导出文件的还原端)。
 *
 * 冲突策略是**时序而非覆盖**(R9.2 的验收口径):同 id 时比 `updatedAt`,
 * 新的胜出;相等则保留本地(本地是用户此刻真实看到的,不该被一个更早导出
 * 的文件顶掉)。这不是"最后写入者胜",而是"更近的事实胜"——两台机器来回同步时,
 * 单看写入顺序会把较早但被编辑过的那份覆盖掉。
 *
 * 刻意**不做 schema 迁移**:旧包的缺字段由各处读路径的惰性迁移兜住(与
 * `dedupKey` / `trigger` / `anchors` 的既有约定一致),这里补一遍只会制造第二份真相。
 */
export function importEntries(incoming: readonly MemoryEntry[]): ImportEntriesResult | MemoryWriteBlocked {
  const blocked = memoryWriteBlockReason();
  if (blocked) return { ok: false, blocked };
  const all = loadAll();
  const byId = new Map(all.map((e) => [e.id, e] as const));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) {
      skipped++;
      continue;
    }
    const cur = byId.get(raw.id);
    if (!cur) {
      // scope 以包内为准;缺失时保守落 project(不把别人的条目擅自升成全局)。
      const e: MemoryEntry = { ...raw, scope: raw.scope === 'global' ? 'global' : 'project' };
      all.push(e);
      byId.set(e.id, e);
      added++;
      continue;
    }
    const curTs = Date.parse(cur.updatedAt || cur.createdAt) || 0;
    const inTs = Date.parse(raw.updatedAt || raw.createdAt) || 0;
    if (inTs <= curTs) {
      skipped++;
      continue;
    }
    const idx = all.findIndex((e) => e.id === raw.id);
    if (idx >= 0) {
      all[idx] = { ...raw, scope: cur.scope };
      byId.set(raw.id, all[idx]);
      updated++;
    } else {
      skipped++;
    }
  }
  if (added > 0 || updated > 0) {
    writeBackByScope(all);
    clearPendingScope('global');
    clearPendingScope('project');
  }
  return { ok: true, added, updated, skipped };
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
 *  ① archived 超 GC_DAYS → 硬删(**情节用 EPISODE_GC_DAYS**);
 *  ② active + !pinned + (lastRecalledAt|createdAt) 早于 DECAY_DAYS → archived
 *     (**情节用 EPISODE_DECAY_DAYS**);
 *  ③ active 数 > MAX_ACTIVE → 按 recallCount 低 × 最近未召回久 淘汰到 archived
 *     (**情节不参与**:它有自己的 ① ②,若再占事实记忆的名额,每个会话一条会在
 *     两个月内把长期知识全部挤出封顶)。
 * pinned 豁免一切自动衰减。写回两文件(均按 scope 过滤)。
 */
export function gcMemories(): GcResult {
  // 暂停/关闭期间不跑 GC:GC 会归档与硬删条目,那是比「写入」更重的破坏性动作。
  // 返回全零让调用方(启动/轮末/反思)无感跳过。
  if (memoryWriteBlockReason()) return { decayed: 0, capped: 0, gced: 0 };
  const all = loadAll();
  if (all.length === 0) return { decayed: 0, capped: 0, gced: 0 };
  const now = Date.now();
  const result: GcResult = { decayed: 0, capped: 0, gced: 0 };

  /**
   * 该条目适用的衰减/清除周期(R6:情节远比事实短命)。
   *
   * R11 起分三档:情节 7 天、**已巩固的情节 3 天**(内容已进语义条目,只剩追溯价值)、
   * 事实 30 天。降权刻意只动衰减周期而不动 status:`archived` 会让它掉出
   * `computeStaleness` 的 active 判定,反过来把依赖它的语义条目判成 stale——
   * 巩固完成立刻让结论显示"根据已失效",恰好是反的。让它自然衰减即可。
   */
  const decayMsOf = (e: MemoryEntry): number => {
    if (e.type !== 'episode') return DECAY_DAYS * DAY_MS;
    return (e.derivedInto ? EPISODE_CONSOLIDATED_DECAY_DAYS : EPISODE_DECAY_DAYS) * DAY_MS;
  };
  const gcMsOf = (e: MemoryEntry): number => (e.type === 'episode' ? EPISODE_GC_DAYS : GC_DAYS) * DAY_MS;

  const refTs = (e: MemoryEntry): number => {
    const r = e.lastRecalledAt ? Date.parse(e.lastRecalledAt) : Date.parse(e.createdAt);
    return Number.isFinite(r) ? r : now;
  };

  // ① archived GC
  for (const e of all) {
    if (e.status !== 'archived') continue;
    const u = Date.parse(e.updatedAt || e.createdAt);
    if (Number.isFinite(u) && now - u > gcMsOf(e)) {
      e.status = '__DELETE__' as MemoryStatus; // 标记硬删(下方过滤)
      result.gced++;
    }
  }

  // ② decay
  for (const e of all) {
    if (e.status !== 'active' || e.pinned) continue;
    if (now - refTs(e) > decayMsOf(e)) {
      e.status = 'archived';
      e.updatedAt = nowIso();
      result.decayed++;
    }
  }

  // ③ cap active —— 情节不计入(它已在 ② 走完自己的短周期)
  const active = all
    .filter((e) => e.status === 'active' && e.type !== 'episode')
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
  clearPendingScope('global'); // 两个 scope 的文件都刚被重写,增量已烘入
  clearPendingScope('project');
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
 * memoryEnabled=false 时直接返空串，使 Memory Index 零注入；memory 工具仍在 registry 中，
 * 但官方主 Agent 是否看见它们由独立的 per-turn ToolPolicy route gate 决定。传参由 repl
 * 在拼装 system message 前调用 isMemoryEnabled() 得到(本文件保持叶子依赖)。
 */
export function buildMemoryIndexSection(memoryEnabled: boolean = true): string {
  if (!memoryEnabled) return '';
  const all = loadAll();
  // R6.3:episode 走 `buildEpisodeSection` 的独立小节,不进这张主索引。
  // 混排会让「最近三次会话做了什么」在索引里反复刷存在感,而索引的价值是
  // 长期知识的稳定清单;两者只是都借用 JSONL 存储,生命周期差一个数量级。
  const active = all.filter((e) => e.status === 'active' && e.type !== 'episode');
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
