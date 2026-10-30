// proactive.ts —— 前摄通道(R3):让记忆在**踩坑之前**自己出现。
//
// 问题不是"检索不准",是"根本不会去检索"。编程 agent 最贵的错误是重复踩已知的坑,
// 而踩坑那一刻模型恰恰想不到要先 memory_search。pull 通道(主动检索)的实测调用次数
// 至今为 0,所以这里做 push:每次工具调用前用它**规范化后的参数**去匹配既有记忆的
// `trigger` 字段(R1.5 定义),命中就把 `trigger → action` 前置到工具结果里。
//
// 设计取舍(全部为"宁少勿多"服务):
//  - 只用子串/词元交集,不用用户可控正则 —— trigger 是模型写的自由文本,
//    把它编译成 RegExp 既有 ReDoS 风险,也会因为一个笔误正则让整条通道静默失效;
//  - 每次工具调用最多注入 1 条,每进程最多 3 条,同一条命中后不再重复弹;
//  - 只弹 `pitfall`/`decision`/`feedback`(天然是条件-动作式)或 pinned 条目,
//    普通 `fact`/`reference` 有 trigger 也不弹 —— 刷屏会让模型学会忽略提醒。
//
// 叶子依赖:只依赖 store.ts 与 context/text-search.ts 的纯函数,不读 config
// (memory 总开关由调用方判定后经 `enabled` 传入,同 store.ts 的既有约定)。

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenize } from '../context/text-search.js';
import { loadAll, wantsTrigger, type MemoryEntry } from './store.js';
import { evaluateAnchors, toAnchorPath, type EntryAnchorState } from './anchor.js';

/** 每次工具调用最多注入的条数。 */
const MAX_HINTS_PER_CALL = 1;
/**
 * 每**用户轮**最多注入次数。
 *
 * 刻意不按进程计:REPL 进程常驻整天,按进程限 3 次等于几轮之后前摄通道永久静默。
 * 而单轮内反复弹才是"狼来了"的真实来源——一轮 3 次已经足够醒目,再多久会失效。
 * 由调用方在轮末调 `resetProactiveTurn()` 归零。
 */
const MAX_PER_TURN = 3;
/** 注入段硬预算(字符),防止一条长 trigger 挤占工具结果。 */
const HINT_MAX_CHARS = 480;
/** 至少命中的不同词元数。1 个太松(任何含"代码"的 trigger 都会弹)。 */
const MIN_MATCHED_TOKENS = 2;

/**
 * 高频泛化词:单独命中它们不构成"这条记忆相关"的证据。
 * 它们仍计入命中数,但不能作为**唯一**的强信号词。
 */
const GENERIC_TOKENS = new Set([
  'the',
  'a',
  'an',
  'to',
  'is',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'if',
  'when',
  'this',
  'that',
  'with',
  'use',
  'uses',
  'used',
  'file',
  'files',
  'code',
  'tool',
  'tools',
  'call',
  'calls',
  'run',
  'runs',
  'set',
  'get',
  'new',
  'old',
  'not',
  'should',
  'must',
  'before',
  'after',
  'then',
  // CJK 单字/泛化词(分词器会产出 unigram 与 bigram)
  '时',
  '的',
  '了',
  '和',
  '与',
  '在',
  '是',
  '工具',
  '文件',
  '代码',
  '使用',
  '时候',
  '相关',
]);

/** 这些工具自身就是记忆通道,不需要前摄提醒(否则自我循环)。 */
const SKIPPED_TOOL_PREFIXES = ['memory_'];
const SKIPPED_TOOLS = new Set(['ask_human', 'plan_update', 'note_append', 'use_skill']);

/**
 * R3.6:参数里"操作目标文件"的键名白名单。
 *
 * 刻意**不**做启发式全扫:编辑类工具的参数里还有 `old_string`/`content`,那些是
 * **文本内容**,里面出现的路径不是本次操作对象——扫进去会大量误命中,而误报的代价
 * 是整条通道被无视。白名单可枚举、可测试,新工具加参数时补一个键即可。
 */
const PATH_ARG_KEYS = new Set([
  'path',
  'file',
  'files',
  'filename',
  'target',
  'targets',
  'source',
  'sources',
  'from',
  'to',
  'dest',
  'destination',
  'input',
  'output',
  'pattern', // glob 的 pattern 常含路径前缀,只用于粗匹配,不解析通配
]);

/** 单次调用最多看几个路径实参。防止 `files: [50 个]` 把匹配成本放大。 */
const MAX_ANCHOR_PATHS = 8;

/**
 * 前摄通道开关(R3.5)。默认开启,可用 MOCODE_MEMORY_PROACTIVE=0/false/off/no 关闭。
 * 注意:这是**独立开关**,不代替 memory 总开关 —— 调用方仍需先判定 memory 是否启用,
 * 两者是与关系(总开关 veto 优先)。
 */
export function isProactiveEnabled(): boolean {
  const raw = process.env.MOCODE_MEMORY_PROACTIVE;
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

// ── 索引 ──────────────────────────────────────────────────────────────────

interface IndexDoc {
  entry: MemoryEntry;
  tokens: Set<string>;
}

interface ProactiveIndex {
  /** 两个 JSONL 的 mtime+size 指纹;变了才重建。 */
  stamp: string;
  postings: Map<string, number[]>;
  docs: IndexDoc[];
  /**
   * R3.6:锚点弱触发索引 —— 锚点路径 → 条目。
   *
   * 与 `postings`(trigger 词元)刻意分开两套:
   *  - 入池条件不同:trigger 索引要 trigger 非空且类型够“条件式”;锚点索引只看有没有
   *    `anchors`,**不看 trigger**,因为一条 `reference` 型记忆（“resultEvent 是回灌唯一
   *    汇聚点”）通常没有 trigger,却在你要改那个文件时最该出现；
   *  - 匹配信号不同:词元是模糊重合,路径是**确定性相等**——同一个文件就是同一个文件,
   *    不需要阈值,也不该被 GENERIC_TOKENS 那套规则连累。
   */
  anchorDocs: Map<string, MemoryEntry[]>;
}

let cache: ProactiveIndex | null = null;

function memoryFiles(): string[] {
  return [path.join(os.homedir(), '.mocode', 'memory.jsonl'), path.join(process.cwd(), '.mocode', 'memory.jsonl')];
}

/** 廉价指纹:一次 stat 两个文件。读不到就当空(不抛)。 */
function filesStamp(): string {
  return memoryFiles()
    .map((p) => {
      try {
        const s = statSync(p);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return '0:0';
      }
    })
    .join('|');
}

/** 条目是否具备"可前摄"资格(R3.1 + R3.4)。 */
function eligible(e: MemoryEntry): boolean {
  if (e.status !== 'active') return false;
  if (!e.trigger || !e.trigger.trim()) return false;
  // 高价值判定:三类天然条件-动作式的记忆,或用户显式置顶的。
  return e.pinned || wantsTrigger(e.type);
}

function buildIndex(): ProactiveIndex {
  const stamp = filesStamp();
  if (cache && cache.stamp === stamp) return cache;

  const docs: IndexDoc[] = [];
  const postings = new Map<string, number[]>();
  const anchorDocs = new Map<string, MemoryEntry[]>();
  for (const entry of loadAll()) {
    // R3.6:锚点索引独立于 trigger 索引收集(理由见 ProactiveIndex.anchorDocs)。
    // 只收 active:归档/被取代的条目说的是历史,不该在你要改代码时冒出来。
    if (entry.status === 'active' && entry.anchors && entry.anchors.length > 0) {
      for (const a of entry.anchors) {
        const list = anchorDocs.get(a.path);
        if (list) list.push(entry);
        else anchorDocs.set(a.path, [entry]);
      }
    }
    if (!eligible(entry)) continue;
    // trigger 是主键;name/summary 作为弱补充,提高"用户用词与模型措辞不一致"时的召回。
    const text = [entry.trigger ?? '', entry.name, entry.summary].join(' ');
    // 单字(含 CJK unigram / 单个字母)不参与匹配:一个中文词会被分词器同时产出
    // "记"、"忆"、"记忆" 三个 token,拿单字计分会把一个词算成三次命中,阈值形同虚设。
    const tokens = new Set(tokenize(text).filter((t) => t.length >= 2));
    if (tokens.size === 0) continue;
    const docIndex = docs.length;
    docs.push({ entry, tokens });
    for (const t of tokens) {
      const list = postings.get(t);
      if (list) list.push(docIndex);
      else postings.set(t, [docIndex]);
    }
  }
  cache = { stamp, postings, docs, anchorDocs };
  return cache;
}

/** 测试专用:清掉索引缓存与注入计数。 */
export function __resetProactiveForTests(): void {
  cache = null;
  fired.clear();
  turnCount = 0;
}

// ── 参数规范化(R3.2)────────────────────────────────────────────────────────

/**
 * 把工具参数压成一段可匹配的文本。
 *
 * 规范化要点(全部确定性的字符串处理,不碰语义):
 *  - 去引号:JSON 里的转义引号会把 `"path"` 变成 `path`,否则永远匹配不上;
 *  - 路径转工作区相对:`C:\a\b\src\x.ts` 与 `/home/u/p/src/x.ts` 都应匹配 trigger 里的 `src/x.ts`;
 *  - 合并空白、统一小写。
 */
export function normalizeArgsText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => normalizeArgsText(v, depth + 1)).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((v) => normalizeArgsText(v, depth + 1))
      .join(' ');
  }
  return '';
}

/** 文本级规范化:去引号、反斜杠转正斜杠、路径转相对、合并空白、小写。 */
export function canonicalizeContext(raw: string): string {
  let s = String(raw ?? '');
  // 引号去掉(保留内容):"  '  ` 以及中文引号
  s = s.replace(/["'`“”‘’]/g, '');
  s = s.replace(/\\/g, '/');
  // 绝对路径转相对:把工作区前缀剥掉,让 trigger 里写的 `src/x.ts` 能命中。
  const cwd = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '');
  if (cwd) {
    const lower = s.toLowerCase();
    const lcwd = cwd.toLowerCase();
    if (lcwd.length > 1 && lower.includes(lcwd)) {
      // 大小写不敏感地剥前缀:用索引切片,避免正则里塞用户路径
      let out = '';
      let i = 0;
      while (i < s.length) {
        if (lower.startsWith(lcwd, i)) {
          i += lcwd.length;
          out += ' ';
          continue;
        }
        out += s[i];
        i++;
      }
      s = out;
    }
  }
  // home 目录前缀同样剥掉
  const home = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && home !== '/' && s.toLowerCase().includes(home.toLowerCase())) {
    const lower = s.toLowerCase();
    const lhome = home.toLowerCase();
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (lower.startsWith(lhome, i)) {
        i += lhome.length;
        out += ' ~ ';
        continue;
      }
      out += s[i];
      i++;
    }
    s = out;
  }
  // 路径分隔符两侧的空白不该影响匹配
  s = s.replace(/\s*\/\s*/g, '/');
  s = s.replace(/\s+/g, ' ').trim();
  return s.toLowerCase();
}

// ── 匹配 ──────────────────────────────────────────────────────────────────

/** 已注入过的条目 id → 注入次数(冷却 R3.4:同一条在同一进程内只弹一次)。 */
const fired = new Map<string, number>();
let turnCount = 0;

// ── R4.1 度量埋点 ─────────────────────────────────────────────────────────
//
// 只累计内存,轮末/退出时一次性落盘:proactiveHint 挂在**每一次工具调用**上,
// 若像 recall-stats 那样每次读改写一次文件,就把一条纯内存路径变成写放大热点
// (一个 20 步的轮次会写 20 次盘)。代价是崩溃会丢掉当轮计数——可接受,因为
// 这些数字是趋势指标,不是账本。
//
// 首次访问时懒加载既有文件,让计数跨进程累计(REPL 一天开很多次);
// 延迟到真正用到时才读,避免没开记忆的用户也付一次 stat。

export interface ProactiveCounters {
  /** 经过匹配逻辑的工具调用次数(已排除被跳过的工具与已关闭的情形)。 */
  toolCalls: number;
  /** 实际注入了提醒的次数(trigger 通道 + 锚点通道之和)。 */
  injections: number;
  /** 由 trigger 倒排索引命中的次数。 */
  triggerHits: number;
  /** 由锚点(文件路径相等)命中的次数。 */
  anchorHits: number;
  /** 锚点命中里,锚定代码已变更/消失的次数(降权信号:S 类噪音的直接度量)。 */
  staleAnchorHits: number;
  /** 注入过的不同条目数(去重后的 `fired` 大小,反映覆盖广度而非频次)。 */
  distinctEntries: number;
  updatedAt: string | null;
}

const EMPTY_COUNTERS: ProactiveCounters = {
  toolCalls: 0,
  injections: 0,
  triggerHits: 0,
  anchorHits: 0,
  staleAnchorHits: 0,
  distinctEntries: 0,
  updatedAt: null,
};

function statsPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-proactive-stats.json');
}

let counters: ProactiveCounters | null = null;

function readCountersFile(): ProactiveCounters {
  try {
    const raw = readFileSync(statsPath(), 'utf8');
    const o = JSON.parse(raw) as Partial<ProactiveCounters>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return {
      toolCalls: num(o.toolCalls),
      injections: num(o.injections),
      triggerHits: num(o.triggerHits),
      anchorHits: num(o.anchorHits),
      staleAnchorHits: num(o.staleAnchorHits),
      distinctEntries: num(o.distinctEntries),
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    };
  } catch {
    return { ...EMPTY_COUNTERS }; // 缺失/损坏一律当零,埋点绝不抛
  }
}

/** 当前累计值(只读快照;首次调用会懒加载既有文件)。 */
export function proactiveCounters(): ProactiveCounters {
  counters ??= readCountersFile();
  return { ...counters, distinctEntries: fired.size > 0 ? fired.size : counters.distinctEntries };
}

function bump(field: keyof Omit<ProactiveCounters, 'updatedAt' | 'distinctEntries'>): void {
  counters ??= readCountersFile();
  counters[field] += 1;
}

/**
 * 把累计值写入 `.mocode/memory-proactive-stats.json`。幂等、失败静默。
 *
 * `distinctEntries` 只在有注入时更新:进程内 `fired` 为空时不能把文件里的历史值清零,
 * 否则每次重启都把覆盖广度重置成 0。
 */
export function flushProactiveStats(): void {
  if (!counters) return; // 从没匹配过 → 无新数据,零 IO
  const snapshot = { ...counters };
  if (fired.size > 0) snapshot.distinctEntries = fired.size;
  snapshot.updatedAt = new Date().toISOString();
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

/** 测试专用:清计数与落盘缓存(模块级状态,共享进程必须清)。 */
export function __resetProactiveCountersForTests(): void {
  counters = null;
}

/** 新的一轮用户输入开始:重置每轮限额。同一条记忆仍受 `fired` 的进程级冷却约束。 */
export function resetProactiveTurn(): void {
  turnCount = 0;
}

export interface ProactiveMatch {
  entry: MemoryEntry;
  score: number;
}

/**
 * 匹配候选(不做限额,供测试与观测)。返回按分降序、去重。
 *
 * @param contextText 当前用户轮的文本。**不是可选糖**:trigger 写的是自然语言
 *   ("构造工具 schema 发给 dashscope 时"),而工具参数只有 `{"path":"src/llm/tool-schema.ts"}`,
 *   两者可重合的词常常只有 1 个,单靠参数永远达不到阈值——通道会静默失效。
 *   trigger 里的场景词几乎都出现在用户的提问里,所以必须把轮文本并进来才有信号。
 */
export function matchProactive(
  toolName: string,
  args: Record<string, unknown> | null,
  contextText?: string,
): ProactiveMatch[] {
  const ctx = `${toolName} ${normalizeArgsText(args)} ${contextText ?? ''}`;
  const canonical = canonicalizeContext(ctx);
  if (canonical.length < 4) return [];
  const tokens = new Set(tokenize(canonical));
  if (tokens.size === 0) return [];

  const index = buildIndex();
  if (index.docs.length === 0) return [];

  const score = new Map<number, number>();
  const strong = new Map<number, boolean>();
  for (const t of tokens) {
    // 与索引侧同口径:单字不算证据(一个中文词会被分词器拆成单字+bigram,按单字计分等于数三次)。
    if (t.length < 2) continue;
    const hits = index.postings.get(t);
    if (!hits) continue;
    const isGeneric = GENERIC_TOKENS.has(t);
    for (const d of hits) {
      score.set(d, (score.get(d) ?? 0) + 1);
      if (!isGeneric) strong.set(d, true);
    }
  }

  const out: ProactiveMatch[] = [];
  for (const [d, s] of score) {
    if (s < MIN_MATCHED_TOKENS) continue;
    // 必须有至少一个非泛化词命中,否则"含'代码'两个字"就会触发一切。
    if (!strong.get(d)) continue;
    const doc = index.docs[d];
    if (!doc) continue;
    out.push({ entry: doc.entry, score: s });
  }
  out.sort((a, b) => b.score - a.score || Number(b.entry.pinned) - Number(a.entry.pinned));
  return out;
}

/**
 * 生成要前置到工具结果的提醒段。无命中 / 超额 / 冷却中 → 空串(零注入)。
 *
 * @param enabled 由调用方判定:memory 总开关 && isProactiveEnabled()。
 * @param contextText 当前用户轮文本,参与匹配(理由见 matchProactive)。
 */
export function proactiveHint(
  toolName: string,
  args: Record<string, unknown> | null,
  enabled: boolean,
  contextText?: string,
): string {
  if (!enabled) return '';
  if (turnCount >= MAX_PER_TURN) return '';
  if (SKIPPED_TOOLS.has(toolName)) return '';
  if (SKIPPED_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return '';

  // R4.1:只有真正走到匹配的工具调用才计入分母。被开关/冷却/跳过工具挡掉的不算——
  // 否则「命中率」会被大量与记忆无关的几何式调用(如连续 read_file)稀释成无意义的数字。
  bump('toolCalls');

  const matches = matchProactive(toolName, args, contextText);
  const picked: ProactiveMatch[] = [];
  for (const m of matches) {
    if (picked.length >= MAX_HINTS_PER_CALL) break;
    // 冷却:同一条在同一进程内只弹一次。反复弹同一条是"狼来了"的主要来源。
    if (fired.has(m.entry.id)) continue;
    picked.push(m);
  }

  if (picked.length > 0) {
    const lines = picked.map((m) => {
      const e = m.entry;
      const head = `- [${e.id}] ${e.name}`;
      const when = e.trigger ? `\n  when: ${e.trigger}` : '';
      const action = e.action ? `\n  do: ${e.action}` : '';
      const body = !e.action && e.body ? `\n  ${e.body.slice(0, 160)}` : '';
      return head + when + action + body;
    });

    let out = `[proactive memory] 以下记忆的触发条件与你刚刚这次调用相符(按需采用,不是强制):\n${lines.join('\n')}`;
    if (out.length > HINT_MAX_CHARS) out = out.slice(0, HINT_MAX_CHARS) + ' …';

    for (const m of picked) {
      fired.set(m.entry.id, (fired.get(m.entry.id) ?? 0) + 1);
      turnCount++;
    }
    bump('triggerHits');
    bump('injections');
    return out;
  }

  // R3.6:trigger 没命中时的弱通道 —— 这次调用碰到的文件,有没有记忆锚定过它。
  // `read_file` 排除在外:R2.4 已经在它自己的结果尾部直接回注了同样的信息,
  // 两边都弹就是同一句话出现两次,只会教模型忽略这一段。
  if (toolName === 'read_file') return '';
  const anchorHit = anchorHint(args);
  if (!anchorHit) return '';
  turnCount++;
  bump('anchorHits');
  bump('injections');
  if (anchorHit.stale) bump('staleAnchorHits');
  return anchorHit.text;
}

/**
 * R3.6 锚点弱通道:把「这次要动的文件」映射回锚定它的记忆。
 *
 * 为什么值得单独一条通道:锚定 `anchors` 的多是 `reference` 型结构知识
 * (“resultEvent 是 history 回灌的唯一汇聚点”),它们通常**没有 trigger**
 * ——`wantsTrigger` 只认 pitfall/decision/feedback。所以只靠 trigger 索引,
 * 这类记忆在你要改那个文件时永远不会出现。
 *
 * 匹配是**路径相等**,不是模糊重合:同一个文件就是同一个文件,不需要阈值,
 * 也不会被 GENERIC_TOKENS 那套泛化词规则连累。
 */
function anchorHint(args: Record<string, unknown> | null): { text: string; stale: boolean } | null {
  const paths = extractAnchorPaths(args);
  if (paths.length === 0) return null;
  const index = buildIndex();
  if (index.anchorDocs.size === 0) return null;

  const picked: Array<{ entry: MemoryEntry; path: string; stale: boolean }> = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    let p: string;
    try {
      p = toAnchorPath(raw);
    } catch {
      continue;
    }
    for (const entry of index.anchorDocs.get(p) ?? []) {
      if (seen.has(entry.id) || fired.has(entry.id)) continue;
      seen.add(entry.id);
      // R4.1:stale 判定在挑选时就做掉,不再在渲染阶段重复 stat——一条命中要算一次
      // 「这次弹出的是不是已经过期的记忆」,而这个比例是锚点通道最关键的噪音指标。
      const state = evaluateAnchors(entry.anchors);
      picked.push({ entry, path: p, stale: state.stale });
      if (picked.length >= MAX_HINTS_PER_CALL) break;
    }
    if (picked.length >= MAX_HINTS_PER_CALL) break;
  }
  if (picked.length === 0) return null;

  const lines = picked.map(({ entry, path: p, stale }) => {
    // 锚点已失效要说出来:那条记忆描述的是**改写前**的代码,直接照做可能出错。
    // 但也不能因此不弹 —— 用户正要在同一个文件上动手,恰恰是最该知道
    // “这里有过一条记忆,但它已经过期了”的时刻。
    const state = evaluateAnchors(entry.anchors);
    const staleTag = stale ? ` [STALE-CODE: ${describeStale(state)}]` : '';
    const when = entry.trigger ? `\n  when: ${entry.trigger}` : '';
    const action = entry.action ? `\n  do: ${entry.action}` : '';
    const body = !entry.action && entry.body ? `\n  ${entry.body.slice(0, 160)}` : '';
    return `- [${entry.id}] ${entry.name} (锚定 ${p})${staleTag}${when}${action}${body}`;
  });

  let out = `[proactive memory] 有记忆锚定了你即将操作的文件(按需采用,不是强制):\n${lines.join('\n')}`;
  if (out.length > HINT_MAX_CHARS) out = out.slice(0, HINT_MAX_CHARS) + ' …';
  for (const { entry } of picked) fired.set(entry.id, (fired.get(entry.id) ?? 0) + 1);
  return { text: out, stale: picked.some((p) => p.stale) };
}

function describeStale(state: EntryAnchorState): string {
  const parts: string[] = [];
  if (state.changed.length > 0) parts.push(`代码已变更 ${state.changed.join(', ')}`);
  if (state.missing.length > 0) parts.push(`代码已消失 ${state.missing.join(', ')}`);
  return parts.join('; ');
}

/**
 * 从工具参数里抽「文件路径」类实参。
 *
 * 只认**已知的键名**,不做启发式扫描整个参数对象:
 *  - 启发式会把 `content`/`old_string` 里出现的路径当成本次操作目标,而那些是
 *    **文本内容**不是操作对象,会制造大量误命中;
 *  - 键名白名单是可枚举、可测试的,新工具加参数时只需在这里补一个键。
 *
 * 值可以是字符串或字符串数组(`files: [...]`),最多取 MAX_ANCHOR_PATHS 条。
 */
export function extractAnchorPaths(args: Record<string, unknown> | null): string[] {
  if (!args || typeof args !== 'object') return [];
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s || s.length > 512) return;
    if (out.length < MAX_ANCHOR_PATHS) out.push(s);
  };
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_ARG_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const v of value) push(v);
    } else {
      push(value);
    }
  }
  return out;
}

/** 本轮已注入次数(观测用)。 */
export function proactiveTurnCount(): number {
  return turnCount;
}

/** 已注入过的条目 id(观测/测试用)。 */
export function proactiveFiredIds(): string[] {
  return [...fired.keys()];
}
