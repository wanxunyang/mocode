// episodic.ts —— 情节记忆(R6):让新会话知道「最近发生了什么」。
//
// 与 store.ts 里其余五类记忆的根本区别:那些是**语义**(可复用的事实/决策/坑),
// 本文件产出的是**情节**(哪个会话、问了什么、改了什么、还剩什么没做完)。
// 语义记忆回答「这件事该怎么办」,情节记忆回答「我上次干到哪了」——后者是
// 从编码工具变成助手的入口能力。
//
// 内容全部**确定性生成,零 LLM 成本**(设计决策,见 memory.md R6.1):
//  - 退出路径等一次模型请求是不可接受的(用户按 Ctrl+D 就该立刻退);
//  - fire-and-forget 发出去而进程已死,等于白花钱且永远拿不到结果;
//  - 长会话的高质量叙述本来就有:compaction 摘要就是模型自己写的「做了什么/产出/未完成」,
//    直接复用比再问一遍更省且更准。
// 短会话则用「请求列表 + 改动文件」的流水账——它的用途就是接上下文,不需要文采。
//
// 叶子依赖:只依赖 store.ts(纯数据)+ constants.ts + proactive 的路径抽取纯函数,
// 不读 config(开关由调用方判定后传布尔值,同 store.ts/proactive.ts 的既有约定),
// 不 import session/*(session 已经 import memory,反向依赖会成环;notes 文本由调用方传入)。

import type { ChatMessage } from '../llm/index.js';
import { tokenize } from '../context/text-search.js';
import {
  CONSOLIDATE_INPUT_MAX_CHARS,
  CONSOLIDATE_MAX_GROUP_SIZE,
  CONSOLIDATE_MAX_GROUPS,
  CONSOLIDATE_MIN_EPISODES,
  CONSOLIDATE_MIN_SESSIONS,
  CONSOLIDATE_MIN_TOKEN_OVERLAP,
  CONSOLIDATE_SCAN_LIMIT,
  EPISODE_INJECT_LIMIT,
  EPISODE_MAX_REQUESTS,
  EPISODE_REQUEST_MAX_CHARS,
} from '../tools/constants.js';
import { extractAnchorPaths } from './proactive.js';
import { loadAll, saveEntry, updateEntry, type MemoryEntry, type MemoryType } from './store.js';

/** 情节记忆开关(R6)。默认开启;MOCODE_MEMORY_EPISODIC=0/false/off/no 可单独关闭。 */
export function isEpisodicEnabled(): boolean {
  const raw = process.env.MOCODE_MEMORY_EPISODIC;
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/** 会产生工作区改动的工具:只有这些的 path 参数算「本次会话改了什么」。 */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'apply_patch']);

/** 单次情节里最多列出的改动文件数(超过就是噪音,摘要行也会失去可读性)。 */
const MAX_FILES = 20;

/** 压缩摘要正文在 episode body 里的上限:摘要本身可达 6000 字符,全塞进去会挤掉请求列表。 */
const SUMMARY_EXCERPT_MAX = 1200;

/**
 * 从 history 里抽「本次会话改了哪些文件」。
 *
 * 用 assistant 消息的 tool_calls(而不是 rollback 快照)是有意为之:headless / 子 agent
 * 没有 rollback store,runtime 也没有一个跨入口统一的「本轮改过什么」出口;而 history
 * 是所有入口都有的东西,且参数里本来就有 path。代价是它反映**意图**(调用过写工具)
 * 而非**结果**(写是否成功)——对「我上次在动哪些文件」这个用途足够,写失败的文件出现
 * 在列表里也不构成误导。
 */
export function collectChangedFiles(history: readonly ChatMessage[]): string[] {
  const out = new Set<string>();
  for (const m of history) {
    const tcs = (m as { tool_calls?: { function?: { name?: string; arguments?: string } }[] }).tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const name = tc?.function?.name ?? '';
      if (!MUTATING_TOOLS.has(name)) continue;
      let args: unknown;
      try {
        args = JSON.parse(tc?.function?.arguments ?? '');
      } catch {
        continue;
      }
      if (!args || typeof args !== 'object') continue;
      for (const p of extractAnchorPaths(args as Record<string, unknown>)) out.add(p);
      if (out.size >= MAX_FILES) return [...out];
    }
  }
  return [...out];
}

/** 从 history 里取最近的压缩摘要原文(模型自己写的「做了什么」)。无则 null。 */
export function extractCompactionSummary(history: readonly ChatMessage[]): string | null {
  for (let i = history.length - 1; i > 0; i--) {
    const m = history[i];
    if (m.role !== 'system') continue;
    const c = (m as { content?: unknown }).content;
    if (typeof c !== 'string' || !c.startsWith('# 会话摘要')) continue;
    const body = c.slice('# 会话摘要'.length).trim();
    return body || null;
  }
  return null;
}

/**
 * 从 notes.md 正文里抽**未完成**的 plan 步骤。
 *
 * 这是「未完成什么」的确定性来源:notes.md 的 `## Plan:` 段由 plan_update 维护,
 * `- [ ]` 就是没做完的步骤。没有 plan 时返回空(不是所有会话都有计划)。
 * 只取活跃 `## Plan:` 段,`## Done:` 段是已归档的完成项,不该说成未完成。
 */
export function parsePendingSteps(notesText: string | null | undefined): string[] {
  if (!notesText) return [];
  const lines = notesText.replace(/\r\n?/g, '\n').split('\n');
  let inPlan = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^##\s+Plan:/.test(line)) {
      inPlan = true;
      continue;
    }
    if (/^##\s/.test(line)) {
      inPlan = false;
      continue;
    }
    if (!inPlan) continue;
    const m = line.match(/^\s*-\s*\[ \]\s*(.+)$/);
    if (!m) continue;
    // 去掉 `1. ` 序号:那是 plan 段内的**位置**信息,搬进情节后既无意义又会与
    // 「这是第几步」的错觉混淆(情节里的步骤顺序本来就保留了)。
    const text = m[1].trim().replace(/^\d+\.\s*/, '');
    if (text) out.push(text);
    if (out.length >= 10) break;
  }
  return out;
}

export interface EpisodeInput {
  /** 会话 id,唯一标识一条情节,并写进 `source.session` 供追溯。 */
  sessionId: string;
  /** 用户确认提交过的请求(按时间序)。 */
  queries: readonly string[];
  /** 本次会话动过的文件(相对工作区)。 */
  changedFiles?: readonly string[];
  /** 压缩摘要原文(长会话才有)。 */
  summaryText?: string | null;
  /** 未完成的 plan 步骤。 */
  pendingSteps?: readonly string[];
}

export interface EpisodeDraft {
  name: string;
  summary: string;
  body: string;
}

/** 单行压平 + 截断:情节里的每个请求都只留一句话,避免一条 episode 吃掉几千字符。 */
function oneLine(text: string, max: number): string {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * 构造一条情节。内容为空(没有任何请求且没有摘要)时返回 null ——
 * 空会话不该在启动注入里占一个位置。
 */
export function buildEpisode(input: EpisodeInput): EpisodeDraft | null {
  const queries = input.queries.map((q) => oneLine(q, EPISODE_REQUEST_MAX_CHARS)).filter(Boolean);
  const summaryText = input.summaryText ? input.summaryText.trim() : '';
  if (queries.length === 0 && !summaryText) return null;

  const files = [...new Set((input.changedFiles ?? []).map((f) => String(f ?? '').trim()).filter(Boolean))].slice(
    0,
    MAX_FILES,
  );
  const pending = [...new Set((input.pendingSteps ?? []).map((s) => oneLine(s, 160)).filter(Boolean))].slice(0, 10);

  // 摘要行要能在索引里一眼扫完:请求数是主信息,文件数/未完成数是两个最有用的上下文信号。
  const parts = [`${queries.length} 个请求`];
  if (files.length > 0) parts.push(`改动 ${files.length} 个文件`);
  if (pending.length > 0) parts.push(`${pending.length} 项未完成`);
  const summary = parts.join(';');

  const bodyParts: string[] = [];
  if (queries.length > 0) {
    bodyParts.push('## 请求');
    for (const q of queries.slice(-EPISODE_MAX_REQUESTS)) bodyParts.push(`- ${q}`);
  }
  if (files.length > 0) {
    bodyParts.push('', '## 改动');
    for (const f of files) bodyParts.push(`- ${f}`);
  }
  if (pending.length > 0) {
    bodyParts.push('', '## 未完成');
    for (const s of pending) bodyParts.push(`- ${s}`);
  }
  if (summaryText) {
    bodyParts.push('', '## 压缩摘要');
    bodyParts.push(
      summaryText.length > SUMMARY_EXCERPT_MAX ? summaryText.slice(0, SUMMARY_EXCERPT_MAX) + '…' : summaryText,
    );
  }

  return {
    // name 用会话 id 派生(id 由 slugify(name) 得到,天然唯一)、(sessionId) 保证幂等:
    // 同一会话被 finalize 两次(退出 + /resume 切换)不会产生两条。
    name: `session ${input.sessionId}`,
    summary,
    body: bodyParts.join('\n'),
  };
}

export type RecordEpisodeResult =
  | { ok: true; id: string; updated: boolean }
  | { ok: false; reason: 'disabled' | 'empty' | 'no-session' | 'duplicate' };

/**
 * 落地一条情节(幂等:同会话重复调用只会刷新,不会写入第二条)。
 *
 * scope 固定 project:情节是「这个工作区里上次干到哪了」,换项目时看到别的项目的
 * 会话记录既是噪音也是隐私泄漏。
 */
export function recordSessionEpisode(input: EpisodeInput, opts: { memoryEnabled?: boolean } = {}): RecordEpisodeResult {
  if (opts.memoryEnabled === false) return { ok: false, reason: 'disabled' };
  if (!isEpisodicEnabled()) return { ok: false, reason: 'disabled' };
  if (!input.sessionId) return { ok: false, reason: 'no-session' };
  const draft = buildEpisode(input);
  if (!draft) return { ok: false, reason: 'empty' };

  const r = saveEntry({
    name: draft.name,
    summary: draft.summary,
    body: draft.body,
    type: 'episode',
    scope: 'project',
    source: { session: input.sessionId },
  });
  if (r.ok) return { ok: true, id: r.id, updated: false };
  // R8.3/R8.5:写入被总闸拦下不是「已存在」——不能继续走刷新分支(那会把一次被拦的
  // 写入误报成 "updated: true"),如实回报 disabled。
  if ('blocked' in r) return { ok: false, reason: 'disabled' };

  // 已存在(同一会话再次 finalize):刷新内容而非报错。会话在 /resume 之后可能又聊了几轮,
  // 旧情节里的「请求数」已经不准,不刷新就等于把过期数据当"最近发生了什么"喂给下一会话。
  const up = updateEntry(r.exists, {
    summary: draft.summary,
    body: draft.body,
    reason: 'episode refresh on session finalize',
  });
  if (up.ok) return { ok: true, id: r.exists, updated: true };
  return { ok: false, reason: 'empty' };
}

/** 本地时区的 `YYYY-MM-DD HH:mm`;ISO 串无法解析时退化为原串前 16 字符。 */
function stampOf(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime()))
    return String(iso ?? '')
      .slice(0, 16)
      .replace('T', ' ');
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 活跃情节,按创建时间降序(最新在前)。 */
export function listEpisodes(limit = EPISODE_INJECT_LIMIT): MemoryEntry[] {
  return loadAll()
    .filter((e) => e.type === 'episode' && e.status === 'active')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, Math.max(1, limit));
}

/**
 * 启动注入段(R6.3):最近 N 条情节的标题 + 摘要,**独立小节**。
 *
 * 刻意不进 `buildMemoryIndexSection` 也不进 `About you`:
 *  - 主索引是长期知识的稳定清单,情节每天变;
 *  - `About you` 是从知识图谱内化的用户画像,情节是事件流,混进去会让"你是谁"
 *    这句话不断被"你昨天改了 3 个文件"污染。
 * 与 `session_search` 的分工(R6.4):这里只有摘要索引,正文(完整转录)去 `session_search`。
 */
export function buildEpisodeSection(memoryEnabled: boolean = true): string {
  if (!memoryEnabled) return '';
  if (!isEpisodicEnabled()) return '';
  const episodes = listEpisodes(EPISODE_INJECT_LIMIT);
  if (episodes.length === 0) return '';

  const lines: string[] = [];
  for (const e of episodes) {
    const when = stampOf(e.createdAt);
    // summary 已经是「N 个请求;改动 M 个文件;K 项未完成」这种可扫读结构,直接用。
    lines.push(`- ${when} [${e.id}] ${e.summary}`);
    const pendingLine = pendingHintOf(e);
    if (pendingLine) lines.push(`  未完成: ${pendingLine}`);
    const lastReq = lastRequestOf(e);
    if (lastReq) lines.push(`  最近请求: ${lastReq}`);
  }

  return [
    '',
    '',
    '## Recent sessions (episodic memory)',
    `Last ${episodes.length} session(s) in this workspace, newest first. Summaries only — use session_search for transcripts, memory_search for full body.`,
    ...lines,
  ].join('\n');
}

/** 从 body 里取「未完成」段的第一条,用于注入行的补充提示。 */
function pendingHintOf(e: MemoryEntry): string {
  const m = e.body.match(/## 未完成\n([\s\S]*?)(?:\n## |$)/);
  if (!m) return '';
  const first = m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .find(Boolean);
  return first ? oneLine(first, 120) : '';
}

/** 从 body 里取最后一条请求,让「上次干到哪」有具体入口。 */
function lastRequestOf(e: MemoryEntry): string {
  const m = e.body.match(/## 请求\n([\s\S]*?)(?:\n## |$)/);
  if (!m) return '';
  const items = m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  return items.length > 0 ? oneLine(items[items.length - 1], 120) : '';
} // ── R11 情节巩固(episode → 语义)────────────────────────────────────────────
//
// 情节只回答「上次干到哪」,它每会话一条、7 天就衰减。但同一类工作反复出现时
// (连续三周都在调 tool schema 的兼容性),真正该留下来的是**共性结论**,而不是
// 三条各说各话的流水账。这一步就是 Letta sleep-time consolidation 的对应物。
//
// 与 R6 的零 LLM 不同,巩固**需要**一次模型调用:把三条情节压成一句可复用的事实,
// 那正是语言模型的活。但它不在退出路径上跑(R6.1 的取舍不适用于它):
// 巩固结果只影响**下一次**会话能看到什么,晚一天毫无损失,所以只在轮末的后台槽位里跑,
// 与反思共用同一个在飞槽位(drainMemoryBackground 一起等)。

/**
 * 情节巩固开关(R11)。默认开启;`MOCODE_MEMORY_CONSOLIDATE=0/false/off/no` 可单独关闭。
 *
 * 独立开关而不是挂在 `MOCODE_MEMORY_EPISODIC` 下:巩固是唯一会**额外发 LLM 请求**
 * 的情节能力,用户可能想要情节(接上下文)但不想付这份后台成本。
 */
export function isConsolidationEnabled(): boolean {
  const raw = process.env.MOCODE_MEMORY_CONSOLIDATE;
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/** 分组时不算信号的泛化词(与前摄通道同源的判断:它们能把任意两条情节粘起来)。 */
const TOPIC_STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'code',
  'file',
  'files',
  'tool',
  'tools',
  'test',
  'tests',
  'fix',
  'update',
  'add',
  'run',
  'runs',
  'use',
  'uses',
  '工作',
  '文件',
  '代码',
  '工具',
  '修改',
  '实现',
  '问题',
  '需要',
  '可以',
  '这个',
  '我们',
]);

/** 从 body 的某个 `## 标题` 段里取列表项(去掉 `- ` 前缀与空行)。 */
function sectionItems(body: string, heading: string): string[] {
  const m = body.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?:\\n## |$)`));
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

/** 一条情节的可分组特征(从已落库的 body 反解,不额外存字段)。 */
export interface EpisodeFacts {
  entry: MemoryEntry;
  session: string;
  /** 本次会话动过的文件(归一为小写正斜杠,便于跨平台比较)。 */
  files: string[];
  /** 请求文本的 bigram 词元集(用 bigram 而非 unigram,理由见 R15.2:单字噪声太大)。 */
  tokens: Set<string>;
}

/**
 * 从条目反解分组特征。
 *
 * 刻意不新增存储字段:body 里的 `## 请求` / `## 改动` 已经是 R6 定下的稳定格式
 * (测试也在盯它),再加一份结构化副本会带来「body 改了副本没改」的永久负担。
 */
export function episodeFactsOf(entry: MemoryEntry): EpisodeFacts {
  const files = sectionItems(entry.body, '改动').map((f) => f.replace(/\\/g, '/').toLowerCase());
  const requests = [...sectionItems(entry.body, '请求'), ...sectionItems(entry.body, '未完成')];
  const tokens = new Set<string>();
  for (const t of tokenize(requests.join(' '), 'bigram')) {
    if (t.length < 2 || TOPIC_STOP_TOKENS.has(t)) continue;
    tokens.add(t);
  }
  return {
    entry,
    session: entry.source?.session ?? entry.id,
    files,
    tokens,
  };
}

export interface ConsolidationGroup {
  members: EpisodeFacts[];
  /** 组内共享的显著文件(`src/llm/tool-schema.ts` 这类),给模型看的主题锚点。 */
  sharedFiles: string[];
  /** 组内共享的高频词元,文件为空时充当主题锚点。 */
  sharedTokens: string[];
  /** 组内涉及的不同会话数。 */
  sessions: number;
  /** 序列化后的提示词输入(已封顶,超预算的组不会出现在结果里)。 */
  input: string;
}

/** 两条情节是否同主题:共享一个显著文件,或共享足够多的请求词元。 */
function relatedEpisode(a: EpisodeFacts, b: EpisodeFacts, distinctive: (f: string) => boolean): boolean {
  for (const f of a.files) {
    if (distinctive(f) && b.files.includes(f)) return true;
  }
  let shared = 0;
  for (const t of a.tokens) {
    if (b.tokens.has(t)) shared++;
    if (shared >= CONSOLIDATE_MIN_TOKEN_OVERLAP) return true;
  }
  return false;
}

/** 把一组成员序列化成给巩固模型的输入。 */
function formatGroup(members: readonly EpisodeFacts[]): string {
  const lines: string[] = [];
  for (const m of members) {
    const e = m.entry;
    lines.push(`### [${e.id}] ${stampOf(e.createdAt)} (session ${m.session})`);
    const requests = sectionItems(e.body, '请求').slice(-3);
    for (const r of requests) lines.push(`- 请求: ${oneLine(r, 100)}`);
    if (m.files.length > 0) lines.push(`- 改动: ${m.files.slice(0, 6).join(', ')}`);
    const pending = sectionItems(e.body, '未完成').slice(0, 2);
    for (const p of pending) lines.push(`- 未完成: ${oneLine(p, 100)}`);
  }
  return lines.join('\n');
}

/**
 * 找出值得巩固的组(R11.2 的确定性部分)。
 *
 * 为什么分组不用 LLM:分组是**聚类**,不是理解。用模型分组会让"哪些情节算一类"
 * 变成不可复现的黑盒,同一批数据两次运行能得到不同结果,巩固就会反复重写同一批情节。
 * 确定性聚类 + 一次调用做归纳,职责切得干净:聚类管"哪些",模型管"说成什么"。
 *
 * 聚类形态是**星形而非连通分量**:以未分配的最早一条为种子,把它能直接关联上的
 * 情节收进来。连通分量会把 A-B、B-C 关联但 A、C 无关的情节粘成一组(传递闭包爆炸),
 * 在"所有情节都改过 src/index.ts"这种仓库里一天就退化成一锅粥。
 */
export function findConsolidationGroups(): ConsolidationGroup[] {
  const scanned = loadAll()
    .filter((e) => e.type === 'episode' && e.status === 'active' && !e.derivedInto)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, CONSOLIDATE_SCAN_LIMIT);
  if (scanned.length < CONSOLIDATE_MIN_EPISODES) return [];

  const facts = scanned.map(episodeFactsOf);

  // 显著文件:出现过半的情节都在改的文件不构成"同主题"证据(典型是入口文件/配置)。
  // 只在样本足够大时才启用这条约束——3 条情节全都改同一个文件,那正是最强的信号。
  const fileCount = new Map<string, number>();
  for (const f of facts) for (const p of f.files) fileCount.set(p, (fileCount.get(p) ?? 0) + 1);
  const commonCut = Math.max(3, Math.ceil(facts.length * 0.6));
  const distinctive = (file: string): boolean => (fileCount.get(file) ?? 0) <= commonCut;

  const assigned = new Set<string>();
  const groups: ConsolidationGroup[] = [];
  for (const seed of facts) {
    if (assigned.has(seed.entry.id)) continue;
    const members: EpisodeFacts[] = [seed];
    for (const other of facts) {
      if (other === seed || assigned.has(other.entry.id)) continue;
      if (!relatedEpisode(seed, other, distinctive)) continue;
      members.push(other);
      if (members.length >= CONSOLIDATE_MAX_GROUP_SIZE) break;
    }
    if (members.length < CONSOLIDATE_MIN_EPISODES) continue;
    const sessions = new Set(members.map((m) => m.session)).size;
    if (sessions < CONSOLIDATE_MIN_SESSIONS) continue;

    const input = formatGroup(members);
    // 超预算整组丢弃而不是中截:残缺的组会被归纳成一条更窄、更错的结论。
    if (input.length > CONSOLIDATE_INPUT_MAX_CHARS) continue;

    const fileHits = new Map<string, number>();
    for (const m of members) for (const f of m.files) if (distinctive(f)) fileHits.set(f, (fileHits.get(f) ?? 0) + 1);
    const tokenHits = new Map<string, number>();
    for (const t of seed.tokens) {
      let n = 0;
      for (const m of members) if (m.tokens.has(t)) n++;
      if (n >= 2) tokenHits.set(t, n);
    }

    for (const m of members) assigned.add(m.entry.id);
    groups.push({
      members,
      sharedFiles: [...fileHits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([f]) => f),
      sharedTokens: [...tokenHits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([t]) => t),
      sessions,
      input,
    });
    if (groups.length >= CONSOLIDATE_MAX_GROUPS) break;
  }
  return groups;
}

/** 巩固产物(由 LLM 给出,类型受限)。 */
export interface ConsolidationDraft {
  type?: MemoryType;
  name: string;
  summary: string;
  body: string;
  trigger?: string;
  action?: string;
}

export type ConsolidationApplyResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; reason: 'empty' | 'no-members' }
  // R8.3/R8.5:写入被总闸拦下。单独一支而不并进 reason,因为调用方要区分
  // 「内容不合格,重试无用」与「暂时写不进去,恢复后应重跑」。
  | { ok: false; reason: 'blocked'; blocked: 'paused' | 'disabled'; id: '' };

/** 巩固产物允许的类型:不能是 episode(巩固的产物就是语义,不是又一条情节)。 */
const CONSOLIDATED_TYPES = new Set<MemoryType>(['fact', 'decision', 'pitfall', 'reference', 'feedback']);

/**
 * 落库一条巩固结果,并把成员情节标成已巩固(R11.1 / R11.3)。
 *
 * 两处刻意的顺序选择:
 *  ① **先写语义条目,成功后才标成员**:标了 derivedInto 的情节不会再进分组,
 *     若反过来(先标后写)一旦写库失败,这批情节就永久退出巩固队列,而它们
 *     产出的结论并不存在——静默丢失,且无任何痕迹。
 *  ② **saveEntry 返回 exists 时仍标成员**,指向那个已存在的 id:说明同一条抽象
 *     已经写过了(同 id 或同 dedupKey),再标一次只是把来源补齐,不会制造重复条目。
 */
export function applyConsolidation(group: ConsolidationGroup, draft: ConsolidationDraft): ConsolidationApplyResult {
  if (group.members.length === 0) return { ok: false, reason: 'no-members' };
  const name = String(draft.name ?? '').trim();
  const summary = String(draft.summary ?? '').trim();
  const body = String(draft.body ?? '').trim();
  if (!name || !summary || !body) return { ok: false, reason: 'empty' };

  const type = draft.type && CONSOLIDATED_TYPES.has(draft.type) ? draft.type : 'fact';
  const ids = group.members.map((m) => m.entry.id);
  const save = saveEntry({
    type,
    name,
    summary,
    body,
    trigger: draft.trigger,
    action: draft.action,
    scope: group.members[0].entry.scope,
    derivedFrom: ids,
  });
  // 写入被总闸拦下时既没有新 id 也没有既有 id——不能当作 exists 继续标成员,
  // 否则会给一批情节打上指向 undefined 的 derivedInto。
  if ('blocked' in save) return { ok: false, reason: 'blocked', blocked: save.blocked, id: '' };
  const targetId = save.ok ? save.id : save.exists;
  for (const id of ids) {
    // 幂等:已经指向同一个目标就跳过,避免每次巩固都把整批 updatedAt 顶一遍
    // (那会让它们看起来"刚被动过",干扰按时间读的审计)。
    const cur = group.members.find((m) => m.entry.id === id)?.entry.derivedInto;
    if (cur === targetId) continue;
    updateEntry(id, { derivedInto: targetId, reason: `consolidated into ${targetId}` });
  }
  return { ok: true, id: targetId, created: save.ok };
}

/** 巩固后语义条目的命名前缀,便于 `memory_list` 一眼看出它是归纳产物。 */
export const CONSOLIDATED_NAME_SUFFIX = '(recurring)';
