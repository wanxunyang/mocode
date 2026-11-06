// turn-recall.ts —— 每轮静默召回(R18):按本轮用户问题把相关旧记忆送进 ephemeral 段。
//
// 为什么需要它:记忆有两条投递路径,此前都覆盖不到「这一轮问的这个话题」——
//   ① 启动注入:buildMemoryIndexSection 只在 history[0] 出现一次,整场会话不刷新;
//   ② R17 尾注:只播「本会话内新增/变更」的条目,回答的是"刚学了什么",不是"这轮该想起什么";
//   ③ R3 前摄:只在**工具调用**那一刻按参数命中 trigger,而 40 条 active 里只有 13 条有 trigger。
// 于是用户问一个和旧记忆高度相关的问题时,模型只能靠自己去 memory_search —— 实测这条路
// 走不通(上线很久后 searches 仍是个位数)。这里补上第三条:问题进来就先静默取一次。
//
// 为什么走 ephemeral 尾部而不是重建 history[0]:重建 history[0] 会让整段对话的 KV 前缀
// 缓存每轮失效(每轮按全价重算 prompt)。附在末尾则前缀逐字节不变,与 sessionStateText /
// memoryTail 同一手法。
//
// 三条硬约束(全部为"宁少勿多"服务):
//  - ≤3 条、单条 body ≤300 字符:真实库索引段已 6010 字符,每轮再灌正文会失控;
//  - 走 R15.5 的「证据词元命中数 ≥2」下限:BM25 只要有一个 token 重合就返回,
//    没有下限时无关问题也会被"召回"一堆东西——那正是模型学会无视记忆的开始;
//  - 不 bump recallCount:静默注入 ≠ 模型采用。而索引 policy 把 `recallCount>=1` 当作
//    「近期活跃」永久展示,静默注入过的条目会被永久钉在索引顶部,反而让「真的被主动
//    检索过」这个信号失去意义。计数另走 turnRecallCounters(只作观测)。
//
// 叶子依赖:只依赖 store(读)、text-search(纯函数)、anchor(读时判定)。
// 开关与排除集由调用方传入,本模块不读 config —— 与 store.ts / tail.ts 的既有约定一致。

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TextSearchIndex } from '../context/text-search.js';
import { MEMORY_SEARCH_MIN_EVIDENCE } from '../tools/constants.js';
import { evaluateAnchors } from './anchor.js';
import { recordMemoryDelivery } from './adoption.js';
import { loadAll, type MemoryEntry } from './store.js';

/**
 * 每轮静默召回开关。默认开启,可用 MOCODE_MEMORY_TURN_RECALL=0/false/off/no 关闭。
 *
 * 与 R3 的 MOCODE_MEMORY_PROACTIVE 各自独立:两者都是 push 通道,但判据完全不同
 * (一个看本轮问题,一个看工具参数),用户可能只想留其中一条。
 */
export function isTurnRecallEnabled(): boolean {
  const raw = process.env.MOCODE_MEMORY_TURN_RECALL;
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/** 每轮最多送几条。3 与 R17 尾注、R2.4 锚点回注同口径。 */
const MAX_TURN_RECALL = 3;
/** 单条 body 截断。只留「结论 + 一条理由」,砍掉长表格与代码块。 */
const MAX_RECALL_BODY_CHARS = 300;
/**
 * 查询侧最短长度。低于此值不检索:短查询(「好」「改」)没有证据词元,
 * 下限会退化成不过滤,把整库当结果返回。
 */
const MIN_QUERY_CHARS = 4;

export interface TurnRecallOptions {
  /** 由调用方判定(enabled 与 isMemoryEnabled() 求与),本模块不读 config。 */
  enabled?: boolean;
  limit?: number;
  /**
   * 本会话内已变更的条目 id。R17 尾注会逐条播报这批条目,这里再送一遍等于
   * 同一轮把同一条记忆说两次——模型会当成两件不同的事,还白烧 token。
   */
  excludeIds?: ReadonlySet<string>;
}

/**
 * 生成「可能与本轮相关」的记忆段。无命中 / 开关关闭 / 查询过短 → 空串(零注入)。
 *
 * 与 `searchEntries` 的关键差异:纯读。不改 recallCount,不写任何文件。
 */
export function buildTurnRecallSection(query: string, opts: TurnRecallOptions = {}): string {
  if (opts.enabled === false) return '';
  const q = (query ?? '').trim();
  if (q.length < MIN_QUERY_CHARS) return '';

  const pool = loadAll().filter(
    (e) => e.status === 'active' && e.type !== 'episode' && !(opts.excludeIds?.has(e.id) ?? false),
  );
  if (pool.length === 0) return '';

  // 计「检索过」而不是「命中过」:否则 turns === hits 恒成立,分母失去意义。
  // 真正想知道的是"每轮召回到底有多少轮能拿东西",所以两者必须分开计。
  countTurn();

  // 字段权重必须与 store.ts:searchEntries 逐字一致(name 10 / id 8 / summary 5 / body 1)。
  // 两处各写一份是刻意的:任何一方漂移都会让「静默召回」与「显式 memory_search」
  // 排出不同顺序,而模型会以为其中一个是坏的。
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
    { minEvidenceMatched: MEMORY_SEARCH_MIN_EVIDENCE },
  );
  const byId = new Map(pool.map((e) => [e.id, e]));
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_TURN_RECALL, MAX_TURN_RECALL));
  const hits = index
    .search(q, limit)
    .map((hit) => byId.get(hit.id))
    .filter((e): e is MemoryEntry => e !== undefined);
  if (hits.length === 0) return '';

  countHits(hits.length);
  for (const entry of hits) recordMemoryDelivery(entry.id, 'turn_recall');
  const lines = hits.map(formatEntry);
  return [
    '## Possibly relevant memory (recalled for this turn)',
    'Retrieved by keyword match against the current question, not by your own request — open the full body with memory_search(id) when you act on one. If an entry contradicts what the code now says, the code wins.',
    ...lines,
  ].join('\n');
}

/** 单条渲染。stale 打标沿用 R2/R14 的口径:两类失效对模型的要求不同。 */
function formatEntry(e: MemoryEntry): string {
  const tags: string[] = [];
  if (e.pinned) tags.push('pinned');
  const anchorState = evaluateAnchors(e.anchors);
  if (anchorState.stale) tags.push('STALE-CODE');
  const suffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const body = (e.body ?? '').replace(/\s+/g, ' ').trim();
  const clipped = body.length > MAX_RECALL_BODY_CHARS ? `${body.slice(0, MAX_RECALL_BODY_CHARS)}…` : body;
  const head = `- [${e.type}] ${e.id}: ${e.name} — ${e.summary}${suffix}`;
  return clipped ? `${head}\n  ${clipped}` : head;
}

// ── 观测(R4.1 同型:内存累计 + 轮末落盘)────────────────────────────────────

export interface TurnRecallCounters {
  /** 发生检索的轮数(查询足够长、库非空)。 */
  turns: number;
  /** 其中真送出条目的轮数。 */
  hits: number;
  /** 累计送出的条目数。 */
  entries: number;
  updatedAt: string | null;
}

const EMPTY_COUNTERS: TurnRecallCounters = { turns: 0, hits: 0, entries: 0, updatedAt: null };
let counters: TurnRecallCounters | null = null;

function countTurn(): void {
  counters ??= { ...EMPTY_COUNTERS };
  counters.turns += 1;
}

/** 与 countTurn 分开:同一轮不能既在"检索过"又在"命中过"里各加一次 turns。 */
function countHits(entryCount: number): void {
  counters ??= { ...EMPTY_COUNTERS };
  counters.hits += 1;
  counters.entries += entryCount;
}

/** 只读快照(供 /memory health 展示)。 */
export function turnRecallCounters(): TurnRecallCounters {
  return { ...(counters ?? EMPTY_COUNTERS) };
}

function statsPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-turn-recall-stats.json');
}

/** 落盘。与 flushProactiveStats 同一时机调用;失败静默。 */
export function flushTurnRecallStats(): void {
  if (!counters) return; // 从未检索过 → 无新数据,零 IO
  const snapshot = { ...counters, updatedAt: new Date().toISOString() };
  try {
    const p = statsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, p);
    counters = snapshot;
  } catch {
    // 静默:埋点不可写不影响功能
  }
}

/** 仅供测试:清掉内存计数,避免共享进程里上一个用例的数字串味。 */
export function __resetTurnRecallForTests(): void {
  counters = null;
}
