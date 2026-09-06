import {
  chat,
  chatTools,
  type ChatMessage,
  type ChatTool,
  type ChatTransport,
  type ChatUsage,
  correctTokenEstimate,
  estimatePromptTokens,
  estimateTokens,
} from '../llm/index.js';
import { config, type Config } from '../config/index.js';
import {
  MAX_HISTORY_RESULT,
  MAX_MEMORY_RESULT,
  MAX_OLD_TOOL_STUB,
  MAX_SKILL_RESULT,
  SUMMARY_KEYFACTS_MAX_CHARS,
  SUMMARY_KEYFACTS_MIN_CHARS,
  SUMMARY_KEYFACTS_WINDOW_RATIO,
  SUMMARY_MSG_MAX_CHARS,
  SUMMARY_OUTPUT_MAX_CHARS,
  SUMMARY_TRANSCRIPT_WINDOW_RATIO,
} from '../tools/constants.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import * as layout from '../ui/layout.js';
import { defaultRollbackStore, type RollbackStore } from '../rollback/index.js';
import { toText } from '../context/utils.js';
import { DEFAULT_BUDGET_POLICY } from '../context/budget.js';
import { collectArtifactRefs } from '../context/artifacts.js';
import { writeCompactionSnapshot } from './notes.js';

/**
 * 上下文压缩子系统:
 *  三层 —— ① push-time 单条上限(见 capToolResultForHistory,在 agent push 时调用)
 *          ② 摘要(主层):旧区原始内容由一次 chat() 压成一条 role:'system' 摘要(index 1)。
 *             触发压缩时旧区 ≤80% 窗口、与摘要器共享窗口,封顶后即装得下——
 *             不预截断,否则等于把摘要模型弄瞎。
 *          ③ 微压缩(兜底):仅在摘要失败后对旧区原地截短(保 tool_call_id,无 LLM 调用)。
 *
 *  不变量:
 *  - 原地修改:用 history.length=0; push(...) 重建,repl 持有同一引用。
 *  - tool_call_id 配对:按完整 group(assistant+其后连续 tool)切,永不劈开;
 *    微压缩只改 .content 不删消息。
 *  - history[0] 永远是当前 systemPrompt;摘要插 index 1(恒单条)。
 *  - 已有摘要不再进摘要器(见 splitSummaryText / mergeKeyFacts):只钉 `## Key Facts`,
 *    叙述段随旧区照常滚动压缩——否则每代压缩都对上一代摘要再摘要一遍(递归衰减)。
 */

export interface CompactionRuntime {
  readonly config: Pick<
    Config,
    'contextWindowTokens' | 'autoCompact' | 'contextBudget' | 'contextRelprune' | 'contextOptimize'
  >;
  readonly modelTransport: ChatTransport;
  readonly rollbackStore?: Pick<RollbackStore, 'pruneAfterCompaction'>;
}

/** 默认兼容依赖：旧调用方继续读取进程级 config/chat。 */
export const defaultCompactionRuntime: CompactionRuntime = {
  config,
  modelTransport: chat,
  rollbackStore: defaultRollbackStore,
};

export interface CompactOptions {
  window: number;
  threshold: number;
  /** 手动 /compact 的聚焦指令,会拼进摘要 prompt。 */
  focus?: string;
  /** 可注入的摘要器(测试用);缺省调 chat()。第三参是 abort signal,必须透传给底层
   *  chat(),否则 Ctrl+C 掐不断摘要请求。 */
  summarize?: (older: ChatMessage[], focus?: string, signal?: AbortSignal) => Promise<string | null>;
  /** 手动触发(repl /compact)开关:强制走 microcompact/summarize,绕过 autoCompact 阈。
   *  设为 true 后,即便无 ROI 触发(history 不超/totalOver=false)也压——对齐用户拍板的"真·强制"。
   *  force:在 manual 基础上再绕过「oldGroups 空 → 直接 noop」的硬边界,允许降 keepBudget 强压。
   *  默认 manual=false / force=false(自动路径行为完全不变)。 */
  manual?: boolean;
  force?: boolean;
  /** 本次主请求实际发送的工具集合；缺省使用调用方的兼容工具集合。 */
  tools?: readonly ChatTool[];
  /** 本次 agent 运行独享的上下文统计状态；缺省使用主 agent 全局状态。 */
  contextState?: ContextState;
  /** 压缩所用的 config/model transport；缺省保持进程级兼容行为。 */
  runtime?: CompactionRuntime;
  /** 主 agent 的 abort signal(Ctrl+C)。摘要是几十秒的 LLM 调用,不串进来 Ctrl+C 就
   *  只能干等到它跑完——用户视角就是「压缩中取消不了」。abort 时 compactHistory 会
   *  把 AbortError 冒泡给 runAgentCore 走 abortRestore,而不是降级成微压缩继续干活。 */
  signal?: AbortSignal;
}

export interface CompactResult {
  compacted: boolean;
  summarized: boolean;
  estimateBefore: number;
  estimateAfter: number;
  reason:
    | 'noop-empty' // 整段 history 太短(<2 message)→ 真无旧区
    | 'noop-protected' // 全在保护区(系统 + 当前轮)→ 无可压
    | 'noop-ml-only' // LLM 摘要失败 + 无超大单条可微压
    | 'noop-shrunk-too-large' // 微压缩后仍超阈,且 LLM 不可用 → /clear
    | 'noop-noold-noop' // 既不在 manual 又不在 force + 无 ROI 触发(自动 noop)
    | 'microcompact' // 只跑了 C1 中截超大
    | 'summarize'; // 跑了 LLM 摘要
  /** 是否用新消息数组原地重建了 history；持有 history index 的调用方必须据此 rehydrate。 */
  historyRebuilt?: boolean;
  /** 调试字段:保护区占比(0-1),供 /compact 显示"为什么没压"。force 时降 keepBudget 后可能更小。 */
  protectedRatio?: number;
  /** 调试字段:旧区可压组数,供 UI 显示。 */
  oldGroupCount?: number;
}

/** 跨模块共享的上下文状态:agent 写 lastUsage,compact 写 lastEstimate,repl 的 /context 读。
 * scheduler.ts 写最近一次调度日志(可选,repl 可读不到时 no-op)。
 * correction 是按 provider/model/tool-set 持久化的 EWMA；压缩或清空 history 不应重置。 */
export interface ContextState {
  lastUsage?: ChatUsage;
  lastEstimate: number;
  /** API 实测 / 估算 的 EWMA 校正系数；1 表示尚未校准。 */
  correction: number;
  /** 当前校准 profile 已吸收的真实 usage 样本数。 */
  calibrationSamples: number;
  schedulerLog?: import('./scheduler.js').SchedulerRunLog;
  /** 最近一次 agent 生命周期图快照；/context 用于展示 observation 衰减状态。 */
  lifecycleStats?: {
    live: number;
    referenced: number;
    digested: number;
    obsolete: number;
    stubbed: number;
  };
  /** File-backed facts and their token provenance for /context. */
  artifactStats?: {
    fresh: number;
    stale: number;
    stubbed: number;
    tokensBySource: Partial<Record<'read' | 'search' | 'diagnostic' | 'summary', number>>;
  };
  /** agent/core 每步拼到 requestHistory 末尾的 ephemeral 注入文本(notes.md / 开场分析 /
   * 压缩恢复段),供 repl 状态栏算「与触发器同口径」的全 prompt token。不写回 history、
   * 不跨 step 残留(每步 core 都会重建)。 */
  ephemeralText?: string;
}

export function createContextState(): ContextState {
  return { lastEstimate: 0, correction: 1, calibrationSamples: 0 };
}

export const contextState: ContextState = createContextState();

/** 中截:text 太长时保 head + 标记 + tail,总长 ≤ max。 */
export function truncateMid(text: string, max: number): string {
  if (text.length <= max) return text;
  const removed = text.length - max;
  const marker = `…[已截断 ${removed} 字符]…`;
  const remain = max - marker.length;
  if (remain <= 0) return marker.slice(0, Math.max(0, max));
  const head = Math.ceil(remain * 0.6);
  const tail = remain - head;
  const out = text.slice(0, head) + marker + text.slice(text.length - tail);
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * Provenance 压缩:旧 tool_calls.arguments 超长时,把大字符串字段替换为 "<N 字符,已省略>" stub,
 * 保留 path(/rollback planRollback 靠 JSON.parse(arguments).path 找文件,见 rollback/index.ts)+ 其余短字段。
 * 比 truncateMid 的 head+tail 片段更短且更易读:LLM/摘要器看到 "<5000 字符,已省略>" 即知"写过 5000 字符",
 * 而非混乱的 head+tail 片段。
 *
 * 保:JSON 合法(parse/stringify 失败均原样返回)+ tool_call_id 配对不动(只改 arguments 内容,不改
 * tool_calls 数组结构)+ path 永不省(rollback 依赖)。永不抛错(对齐「调度器永不抛错」契约)。
 *
 * 触发:整体 arguments > MAX_OLD_TOOL_STUB 才进(同原 truncateMid 门槛);字段级也 > MAX_OLD_TOOL_STUB 才 stub。
 */
function stubToolCallArguments(argsRaw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    return argsRaw; // 非合法 JSON(模型偶发):不碰
  }
  if (!parsed || typeof parsed !== 'object') return argsRaw;
  const obj = parsed as Record<string, unknown>;
  let changed = false;
  for (const k of Object.keys(obj)) {
    if (k === 'path') continue; // path 永不省:/rollback planRollback 靠它定位文件
    const v = obj[k];
    if (typeof v === 'string' && v.length > MAX_OLD_TOOL_STUB) {
      obj[k] = `<${v.length} 字符,已省略>`;
      changed = true;
    }
  }
  if (!changed) return argsRaw;
  try {
    return JSON.stringify(obj);
  } catch {
    return argsRaw; // stringify 失败(理论不会):不碰
  }
}

/**
 * push-time 第一层:工具结果进 history 前裁到 MAX_HISTORY_RESULT。
 * 显示层(summarizeToolResult)仍用原 output,不受影响。
 */
export function capToolResultForHistory(name: string, output: string): string {
  if (name === 'use_skill') {
    // skill 正文是指令,须尽量完整;超长才截断。用尾截(保头部指令、弃尾部),
    // 不用 truncateMid 的中截——中截会劈断指令流、丢失开头步骤。
    if (output.length <= MAX_SKILL_RESULT) return output;
    const removed = output.length - MAX_SKILL_RESULT;
    const marker = `…[skill 正文过长,已截断尾部 ${removed} 字符]…`;
    const remain = MAX_SKILL_RESULT - marker.length;
    if (remain <= 0) return marker.slice(0, MAX_SKILL_RESULT);
    return output.slice(0, remain) + marker;
  }
  if (name === 'memory_search') {
    // 召回的记忆正文是高价值事实/指令,中截会劈断语义;同 use_skill 走尾截(保头部、弃尾部)。
    if (output.length <= MAX_MEMORY_RESULT) return output;
    const removed = output.length - MAX_MEMORY_RESULT;
    const marker = `…[记忆结果过长,已截断尾部 ${removed} 字符]…`;
    const remain = MAX_MEMORY_RESULT - marker.length;
    if (remain <= 0) return marker.slice(0, MAX_MEMORY_RESULT);
    return output.slice(0, remain) + marker;
  }
  if (output.length <= MAX_HISTORY_RESULT) return output;
  return truncateMid(output, MAX_HISTORY_RESULT);
}

// ── 内部:group 划分(toText 已移至 context/utils.ts 统一维护) ────────────

/**
 * 把多模态 content 拍平成纯文本(供摘要 transcript 用):text parts 拼接;image_url parts
 * 替换为 `[图片已剥离: <mime>]` stub,避免 base64 进摘要 prompt(LLM 看到也无意义,反而撑爆 token)。
 * 其它情况(string / 其它形状)原样返回。
 */
export function stripImagesForSummary(m: ChatMessage): ChatMessage {
  const c = (m as { content?: unknown }).content;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    let imageCount = 0;
    for (const p of c) {
      if (p && typeof p === 'object') {
        const part = p as { type?: string; text?: string; image_url?: { url?: string } };
        if (part.type === 'text') parts.push(part.text ?? '');
        else if (part.type === 'image_url') {
          imageCount++;
          const mime = part.image_url?.url?.startsWith('data:')
            ? part.image_url.url.slice(5, part.image_url.url.indexOf(';'))
            : 'image';
          parts.push(`[图片已剥离: ${mime}]`);
        }
      }
    }
    if (imageCount > 0) {
      return { ...m, content: parts.join('') };
    }
  }
  return m;
}

interface Group {
  assistant: ChatMessage | null; // user / 纯 assistant / 带 tool_calls 的 assistant;孤儿 tool 时 null
  tools: ChatMessage[]; // 该 assistant 后紧跟的 tool 消息(可能空)
}

// ── 摘要钉住:Key Facts 跨代累积,叙述段照常滚动压缩 ──────────────────────
//
// 为什么需要:摘要写在 history[1](role:'system'),而 groupFromEnd 只排除 history[0],
// 于是它被当成普通 group 排到最老位置 → 下次压缩进 oldGroups → 被喂给摘要器再摘要一遍。
// 每代压缩都对上一代摘要做一次有损再压缩,首轮的用户约束经 2-3 代即糊掉。堵住这个衰减
// 源比设计任何打分模型都划算。
//
// 为什么只钉 Key Facts:钉整段(含 Objective/Completed/Next Steps)会线性膨胀——那些
// 叙述重跑一遍命令、重读一次文件就能拿回来;Key Facts 才是不在就真没了的东西(路径、
// 约束、失败结论),且每代只增加几十字符。

/** 摘要消息头。budget.ts 用同一前缀识别摘要层,勿改。 */
export const SUMMARY_MARKER = '# 会话摘要';
/** `## Key Facts` 段标题(model 按 prompt 输出,可能带 "— 说明" 后缀)。 */
const KEY_FACTS_HEADING_RE = /^ {0,3}##\s*key facts\b/i;
/** 任意 `## ` 级标题:Key Facts 段到此为止。 */
const ANY_HEADING_RE = /^ {0,3}##\s+\S/;
/** 上一代叙述段进 transcript 时的标注:告诉摘要器这是已压过一遍的内容,合并而非抄录。 */
const PRIOR_NARRATIVE_LABEL = '[prior summary — 上一代摘要的叙述部分:与下方新内容合并压缩,不要重复罗列细节]';
/** 尾部 provenance 块:解析时剥掉,重建时按当次 older 重算(否则跨代累积并重复)。 */
const ARTIFACT_REFS_RE = /\n*\[artifact refs:[^\]]*\]\s*$/;

/** Key Facts 累计预算(字符):窗口比例换算 + 上下限——小窗口留得住初始约束,
 *  大窗口也不会让索引段膨胀成正文。 */
export function keyFactsBudgetChars(window: number): number {
  const byWindow = Math.floor(Math.max(0, window) * SUMMARY_KEYFACTS_WINDOW_RATIO);
  return Math.max(SUMMARY_KEYFACTS_MIN_CHARS, Math.min(SUMMARY_KEYFACTS_MAX_CHARS, byWindow));
}

/**
 * 拆摘要成「Key Facts 段」+「叙述段」。
 * 顺带剥掉 `# 会话摘要` 头与尾部 `[artifact refs: …]` provenance——后者每次压缩按当次
 * older 重算,不该跨代累积。无 Key Facts 段时 rest 为全文、keyFacts 为空。
 */
export function splitSummaryText(raw: string): { keyFacts: string; rest: string } {
  let text = (raw ?? '').replace(ARTIFACT_REFS_RE, '').trim();
  if (text.startsWith(SUMMARY_MARKER)) {
    const nl = text.indexOf('\n');
    text = (nl < 0 ? '' : text.slice(nl + 1)).trim();
  }
  const lines = text.split('\n');
  const headIdx = lines.findIndex((l) => KEY_FACTS_HEADING_RE.test(l));
  if (headIdx < 0) return { keyFacts: '', rest: text };
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (ANY_HEADING_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const keyFacts = lines
    .slice(headIdx + 1, endIdx)
    .join('\n')
    .trim();
  const rest = [...lines.slice(0, headIdx), ...lines.slice(endIdx)].join('\n').trim();
  return { keyFacts, rest };
}

/**
 * 中断判定:signal 已 abort,或错误本身是 AbortError / APIUserAbortError。
 * 与 llm 层、core 层的判定保持同一套(两处 name + signal 双判),避免各写各的漏判。
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  // 鸭子类型判定而非 instanceof Error:DOMException / SDK 的 APIUserAbortError 在
  // 不同 Node 版本下 instanceof Error 的结果不一致,认 name 更稳。
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/** 归一化一行事实用于去重:去项目符号/空白/句末标点后小写。 */
function factKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[-*•]\s*/, '')
    .replace(/[。.,;；:：]+$/, '')
    .trim();
}

/**
 * 从摘要正文提取「当前进度快照」段:Objective / In Progress / Next Steps。
 * 这是压缩后最该被记住的「做到哪了」,固结到 notes.md 供恢复步骤注入。
 * 只识别 `## ` 级标题(摘要器固定输出此结构);一个都没有时返 null(不写空快照)。
 */
export function extractProgressSnapshot(summaryRest: string): string | null {
  const WANT = new Set(['objective', 'in progress', 'next steps']);
  const lines = summaryRest.split('\n');
  const out: string[] = [];
  let taking = false;
  for (const line of lines) {
    const m = line.match(/^ {0,3}##\s+(.+?)\s*$/);
    if (m) {
      const name = m[1]
        .replace(/\s*[—–-].*$/, '')
        .trim()
        .toLowerCase();
      taking = WANT.has(name);
    }
    if (taking) out.push(line);
  }
  const text = out.join('\n').trim();
  return text ? text : null;
}

/**
 * 合并跨代 Key Facts:按行去重(老 → 新),超预算时丢较新条目。
 *
 * 丢新不丢旧的理由:最老那几条通常是首轮用户约束(不可重建,丢了就永远没了);
 * 较新的事实通常在本代叙述段或保留区里还有副本。
 */
export function mergeKeyFacts(prev: string | undefined, next: string | undefined, maxChars: number): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const block of [prev ?? '', next ?? '']) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const key = factKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  const cap = Math.max(0, Math.floor(maxChars));
  const text = lines.join('\n');
  if (text.length <= cap) return text;
  const kept: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > cap) break;
    kept.push(line);
    len += line.length + 1;
  }
  return `${kept.join('\n')}\n…[Key Facts 超预算,已省略较新条目]`;
}

/**
 * 非空 user group 判定。LLM API(OpenAI / Anthropic)要求 messages 至少含一条**非空**
 * user 消息,llm/chatOnce 入口有 hasNonEmptyUser 守卫,缺则直接抛。压缩重建 history 后
 * 必须仍有这样一条,否则下一步 chat() 当场失败——见下方 user 保留兜底。
 */
function isUserGroup(g: Group): boolean {
  const a = g.assistant as { role?: string; content?: unknown } | null;
  return !!a && a.role === 'user' && toText(a.content).trim().length > 0;
}

/** 摘要 group 判定:非 history[0] 的 system 消息,以 `# 会话摘要` 开头,且不带 tool_calls。 */
function isSummaryGroup(g: Group): boolean {
  const a = g.assistant as { role?: string; content?: unknown } | null;
  return !!a && a.role === 'system' && g.tools.length === 0 && toText(a.content).startsWith(SUMMARY_MARKER);
}

/** 从尾向头划分 group;history[0](system)排除。连续 tool 归到前导 assistant。 */
function groupFromEnd(history: ChatMessage[]): Group[] {
  const groups: Group[] = [];
  let i = history.length - 1;
  while (i >= 1) {
    const m = history[i];
    if (m.role === 'tool') {
      const tools: ChatMessage[] = [];
      while (i >= 1 && history[i].role === 'tool') {
        tools.unshift(history[i]);
        i--;
      }
      if (i >= 1 && history[i].role === 'assistant' && (history[i] as any).tool_calls) {
        groups.unshift({ assistant: history[i], tools });
        i--;
      } else {
        // 孤儿 tool(正常不应出现):各自成组,不丢
        for (const t of tools) groups.unshift({ assistant: null, tools: [t] });
      }
    } else {
      groups.unshift({ assistant: m, tools: [] });
      i--;
    }
  }
  return groups;
}

function groupTokens(g: Group): number {
  let t = 0;
  if (g.assistant) {
    const body = toText((g.assistant as any).content);
    const tcs = (g.assistant as any).tool_calls;
    let extra = body;
    if (tcs) for (const tc of tcs) extra += tc?.function?.arguments ?? '';
    t += 4 + estimateTokens(extra);
  }
  for (const tool of g.tools) {
    t += 6 + estimateTokens(toText((tool as any).content));
  }
  return t;
}

function flattenGroups(groups: Group[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const g of groups) {
    if (g.assistant) out.push(g.assistant);
    for (const t of g.tools) out.push(t);
  }
  return out;
}

/** 微压缩单个 group(原地):① tool 结果 content ② assistant tool_calls.arguments(provenance stub)
 * ③ assistant 正文。只裁模型/工具产物,不动 user 原话;保 tool_call_id 配对。返回是否有改动。 */
function microcompactGroup(g: Group): boolean {
  let done = false;
  for (const t of g.tools) {
    const c = (t as any).content;
    if (typeof c === 'string' && c.length > MAX_OLD_TOOL_STUB) {
      (t as any).content = truncateMid(c, MAX_OLD_TOOL_STUB);
      done = true;
    }
  }
  const as = g.assistant as any;
  if (as && as.role === 'assistant') {
    if (typeof as.content === 'string' && as.content.length > MAX_OLD_TOOL_STUB) {
      as.content = truncateMid(as.content, MAX_OLD_TOOL_STUB);
      done = true;
    }
    // tool_calls 参数:整体超长才进,provenance stub 大字段(保 path + JSON 合法)。
    if (Array.isArray(as.tool_calls)) {
      for (const tc of as.tool_calls) {
        const args = tc?.function?.arguments;
        if (typeof args !== 'string' || args.length <= MAX_OLD_TOOL_STUB) continue;
        const stubbed = stubToolCallArguments(args);
        if (stubbed !== args) {
          tc.function.arguments = stubbed;
          done = true;
        }
      }
    }
  }
  return done;
}

// ── 默认摘要器:复用 chat(),空 handlers 不打印 ──────────────────────────

/** 单条消息封顶:中间段省略、保头 + 尾(头有路径/意图,尾有结论/报错),总长 ≤ max。 */
function capMessageText(text: string, max: number): string {
  if (text.length <= max) return text;
  const removed = text.length - max;
  const marker = `\n…[中间 ${removed} 字符已省略]…\n`;
  const remain = max - marker.length;
  if (remain <= 0) return text.slice(0, Math.max(0, max)) + marker;
  const head = Math.ceil(remain * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (remain - head));
}

/** tool_call 参数封顶:只保头(路径/目标等关键信息在开头,长正文对摘要无信息量)。 */
function capArgsHead(args: string, max: number): string {
  if (args.length <= max) return args;
  return args.slice(0, max) + ` …[另有 ${args.length - max} 字符已省略]`;
}

/** 摘要输出硬上限:按最后换行处裁断(不留半句),防模型不听话产出巨长摘要撑大 history。 */
function capSummaryOutput(summary: string): string {
  if (summary.length <= SUMMARY_OUTPUT_MAX_CHARS) return summary;
  const cut = summary.lastIndexOf('\n', SUMMARY_OUTPUT_MAX_CHARS);
  const at = cut > SUMMARY_OUTPUT_MAX_CHARS * 0.5 ? cut : SUMMARY_OUTPUT_MAX_CHARS;
  return summary.slice(0, at) + '\n[摘要输出超长,已截断]';
}

/** 按封顶配额拼转录。scale ∈ (0,1] 等比缩小各角色配额(总预算不足时用)。 */
function buildTranscript(stripped: ChatMessage[], scale: number): string {
  const caps = SUMMARY_MSG_MAX_CHARS;
  const capFor = (role: string): number =>
    Math.max(
      200,
      Math.floor(
        scale *
          (role === 'user'
            ? caps.user
            : role === 'assistant'
              ? caps.assistant
              : role === 'tool'
                ? caps.tool
                : caps.other),
      ),
    );
  return stripped
    .map((m) => {
      const cap = capFor(m.role);
      let line = `${m.role}: ${capMessageText(toText((m as any).content), cap)}`;
      const tcs = (m as any).tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          const args = tc?.function?.arguments ?? '';
          line += `\n  [tool_call ${tc?.function?.name}] ${capArgsHead(args, Math.max(200, Math.floor(scale * caps.tool)))}`;
        }
      }
      return line;
    })
    .join('\n');
}

async function defaultSummarize(
  older: ChatMessage[],
  focus?: string,
  signal?: AbortSignal,
  runtime: CompactionRuntime = defaultCompactionRuntime,
): Promise<string | null> {
  // 已中断就别白拼转录了(几千 token 的字符串拼接 + 一去不回的 LLM 请求)。
  if (signal?.aborted) {
    throw new DOMException('This operation was aborted', 'AbortError');
  }
  // 摘要前剥离多模态 user 消息里的图片(base64 会撑爆摘要 prompt;image 对摘要无信息量)。
  const stripped = older.map(stripImagesForSummary);

  // 触发压缩时旧区约占窗口 50-60%,摘要器共享同一窗口——逐条封顶后旧区原文即可装入,
  // 不需要"先压一遍再摘要"。封顶策略:先按满额封顶;总量仍超窗口 55% 预算时等比缩小
  // 配额重拼(优先保条数/每轮都有代表,其次保单条长度);再超才整段中截兜底(罕见)。
  let transcript = buildTranscript(stripped, 1);
  const tokenBudget = Math.floor(runtime.config.contextWindowTokens * SUMMARY_TRANSCRIPT_WINDOW_RATIO);
  let tokens = estimateTokens(transcript);
  if (tokens > tokenBudget) {
    transcript = buildTranscript(stripped, tokenBudget / tokens);
    tokens = estimateTokens(transcript);
    if (tokens > Math.floor(runtime.config.contextWindowTokens * 0.6)) {
      transcript = truncateMid(transcript, Math.floor(runtime.config.contextWindowTokens * 0.5));
    }
  }

  const sysMsg = {
    role: 'system' as const,
    content:
      'You are an aggressive session compressor writing a handoff note for an agent that lost its context. ' +
      'The agent will continue the task with ONLY your summary plus a few most-recent messages, so your summary is the sole memory of everything older.\n' +
      'Output ONLY the summary body in this exact structure (omit empty sections):\n' +
      "## Objective — the user's core request(s); cover EVERY distinct user request in the transcript, in order, noting which are completed vs pending.\n" +
      '## Completed — what is already done: files created/modified (exact paths), key change per file, commands run and their outcomes (pass/fail, key numbers), decisions made and why.\n' +
      '## In Progress — what is being worked on right now and exactly where it stopped (e.g. "edit applied to foo.ts, test not yet run").\n' +
      '## Next Steps — the concrete next actions in order.\n' +
      '## Key Facts — only what later steps cannot work without: exact paths, symbols/API shapes, artifact IDs/hashes, constraints, open questions, failed approaches and errors to avoid repeating.\n' +
      'What counts as important (keep): user requests and constraints; final state of each modified file; conclusions and results, not the steps that led there; decisions with reasons; precise references (paths, symbols, hashes, commands) that later steps must cite; failures and what was tried, so mistakes are not repeated.\n' +
      'What to drop: verbatim file contents and tool-output dumps, step-by-step recaps, exploration dead-ends that led nowhere, polite chatter, anything re-derivable by re-reading files.\n' +
      'Rules: total ≤ 400 words. State conclusions and locations (path:line where useful), never paste content. ' +
      'The Key Facts section is carried forward verbatim into future summaries: write each fact as one self-contained line ' +
      '(no pronouns, no "as above", no cross-references), so it still reads correctly after later compactions. ' +
      'Never invent facts, paths, or results that are not in the transcript; if unsure whether something happened, omit it.',
  } as ChatMessage;
  const userMsg = {
    role: 'user' as const,
    content: focus
      ? `请将以下会话历史压缩成交接摘要,重点保留与「${focus}」相关的事实/决策/文件改动:\n\n${transcript}\n\n摘要:`
      : `请将以下会话历史压缩成交接摘要:\n\n${transcript}\n\n摘要:`,
  } as ChatMessage;

  const spinner = new Spinner((msg, frame) => layout.setStatus(msg, frame ?? undefined));
  spinner.start(signal ? '压缩中(Ctrl+C 取消)' : '压缩中');
  try {
    // signal 必须透传:摘要是几十秒的 LLM 调用,不串进来 Ctrl+C 只能干等它跑完。
    // 空 handlers:不打印、不外显流式;tools=[] 不带工具表——摘要纯文本任务,
    // 全量工具 schema 白占几千 token 窗口,还诱导幻觉工具调用。
    const r = await runtime.modelTransport([sysMsg, userMsg], {}, signal, []);
    // 推理模型可能只返 reasoning_content(content 为 null),或幻觉出 tool_calls → 视为失败
    if (r.toolCalls.length > 0 || !r.content) return null;
    return capSummaryOutput(r.content);
  } finally {
    spinner.stop();
  }
}

// ── 对外:compactHistory / maybeCompact ───────────────────────────────────

/**
 * 压缩 history(原地)。手动 /compact 与自动 maybeCompact 都走这里。
 * 不检查阈值——调用方(maybeCompact)决定是否调;/compact 直接调以强制压缩。
 */
export async function compactHistory(history: ChatMessage[], opts: CompactOptions): Promise<CompactResult> {
  const state = opts.contextState ?? contextState;
  const activeTools = opts.tools ?? chatTools;
  const estimateBefore = estimatePromptTokens(history, activeTools, state.correction);
  state.lastEstimate = estimateBefore;

  // 调用前就已中断(用户在上一步末尾按的 Ctrl+C):一步都别做,直接冒泡。
  // 不做完再抛是为了保证 history 完全未被触碰——abortRestore 才还原得干净。
  if (opts.signal?.aborted) {
    throw new DOMException('This operation was aborted', 'AbortError');
  }

  const allGroups = groupFromEnd(history);
  // 摘要钉住:把已有摘要从 group 序列里摘出来,永不送进摘要器(否则每代再摘要一次 →
  // 递归衰减)。它的 Key Facts 段跨代累积,叙述段则并入下方转录照常滚动压缩。
  const pinnedGroups = allGroups.filter(isSummaryGroup);
  const groups = pinnedGroups.length > 0 ? allGroups.filter((g) => !isSummaryGroup(g)) : allGroups;
  const pinned =
    pinnedGroups.length > 0
      ? splitSummaryText(
          pinnedGroups.map((g) => toText((g.assistant as { content?: unknown } | null)?.content)).join('\n\n'),
        )
      : null;

  // 保近期:按策略中的 token 比例累积(至少保 1 组),永不劈开 group。
  // force(手动 /compact 默认、硬闸触发)用更激进的保留比例;再加绝对上限,
  // 防大窗口(如 256k)下保留区按比例仍过大——压缩目标 = 摘要 + 最小续工上下文。
  const keepRatio = opts.force ? DEFAULT_BUDGET_POLICY.compactForceKeepRatio : DEFAULT_BUDGET_POLICY.compactKeepRatio;
  const keepBudget = Math.min(Math.floor(opts.window * keepRatio), DEFAULT_BUDGET_POLICY.compactKeepMaxTokens);
  const kept: Group[] = [];
  let keptTokens = 0;
  for (let k = groups.length - 1; k >= 0; k--) {
    const g = groups[k];
    const nextTokens = keptTokens + groupTokens(g);
    if (kept.length >= 1 && correctTokenEstimate(nextTokens, state.correction) > keepBudget) break;
    kept.unshift(g);
    keptTokens = nextTokens;
  }
  let oldGroups = groups.slice(0, groups.length - kept.length);

  // 非空 user 兜底:保留区从尾部累积,长回合里最近的若干组常常全是 assistant+tool,
  // 一个 8000 字符的工具结果就能吃满小窗口的 keepBudget → user 全落进旧区被摘要掉 →
  // 重建后 history 无 user → 下一步 chat() 被 hasNonEmptyUser 守卫直接拒(整轮中断)。
  // 把紧邻保留区之前的那条 user 移进保留区:它是当前任务的原始请求,且 user 消息本身极小。
  // 放这里(而非重建后补 stub)是因为:原文保留,不造新消息形状,也不必进摘要器。
  if (!kept.some(isUserGroup)) {
    for (let i = oldGroups.length - 1; i >= 0; i--) {
      if (!isUserGroup(oldGroups[i])) continue;
      kept.unshift(oldGroups[i]);
      oldGroups.splice(i, 1);
      break;
    }
  }

  // force(硬闸/手动强压):保护区不豁免——常规切分无旧区时只保最后一组,
  // 其余全部进可压区(首轮/当前轮也一样)。仍按 group 边界切,不破坏 tool_call 配对。
  // **必须保留最早 user 所在 group**:LLM API(OpenAI / Anthropic)要求 messages 至少
  //  含一条非空 user 消息,否则 400。force 旧实现把所有 user 丢进摘要 → 重建后 history
  //  无 user → 下一轮 chat() 被后端拒绝。保最早 user(而非最后一个)因为它是最原始的
  //  请求上下文,摘要器已覆盖后续交互。用 isUserGroup(非空判定)而非只看 role:
  //  空 content 的 user 同样过不了 hasNonEmptyUser 守卫。
  if (oldGroups.length === 0 && opts.force && groups.length >= 2) {
    kept.length = 0;
    const lastIdx = groups.length - 1;
    const firstUserIdx = groups.findIndex(isUserGroup);
    if (firstUserIdx >= 0 && firstUserIdx !== lastIdx) {
      kept.push(groups[firstUserIdx], groups[lastIdx]);
      oldGroups = groups.filter((_, i) => i !== firstUserIdx && i !== lastIdx);
    } else {
      kept.push(groups[lastIdx]);
      oldGroups = groups.slice(0, groups.length - 1);
    }
  }

  const noop: CompactResult = {
    compacted: false,
    summarized: false,
    estimateBefore,
    estimateAfter: estimateBefore,
    reason: 'noop-noold-noop' as CompactResult['reason'],
    protectedRatio: history.length > 0 ? kept.length / history.length : 0,
    oldGroupCount: oldGroups.length,
  };

  if (oldGroups.length === 0) {
    // 没有旧区可压缩
    const protectedRatio = history.length > 0 ? kept.length / history.length : 0;
    if (opts.force && groups.length === 1) {
      // force 但只剩单组(如首轮的单个 assistant+tools 组):原地微压缩、不动结构。
      // 纯 user 原话组无可压项(不能毁掉用户请求),落到下方 noop 提示。
      const single = groups[0];
      const userOnly = single.tools.length === 0 && (single.assistant as { role?: string } | null)?.role === 'user';
      if (!userOnly && microcompactGroup(single)) {
        const estimateAfter = estimatePromptTokens(history, activeTools, state.correction);
        state.lastEstimate = estimateAfter;
        state.lastUsage = undefined;
        if (!layout.isLastContentRowBlank()) layout.contentWrite('\n');
        layout.contentWrite(
          `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.accent}强制微压缩(单组)${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`,
        );
        return {
          compacted: true,
          summarized: false,
          estimateBefore,
          estimateAfter,
          reason: 'microcompact',
          protectedRatio,
          oldGroupCount: 0,
        };
      }
    }
    // 细分 noop 类型,供 repl 文案
    const isEmpty = history.length <= 1; // 只有 system 提示
    if (isEmpty) {
      // 整段 history 太短,没有可压内容
      return { ...noop, reason: 'noop-empty', protectedRatio };
    }
    // history 有内容但全在保护区(系统 + 当前轮)
    if (estimateBefore >= opts.threshold * opts.window) {
      if (!layout.isLastContentRowBlank()) layout.contentWrite('\n');
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}上下文已超阈但无可压缩项(全在保护区),建议 /clear 或缩短输入。${ui.reset}\n`,
      );
      return { ...noop, reason: 'noop-shrunk-too-large', protectedRatio };
    }
    return { ...noop, reason: 'noop-protected', protectedRatio };
  }

  // 主层:摘要——把旧区【原始内容】压成一条 system 摘要。
  // 触发压缩时旧区约占窗口 50-60%,摘要请求与摘要器共享窗口,逐条封顶后即装得下;
  // 不在这里预跑微压缩——预截断会让摘要模型看到 600 字符残片,等于弄瞎它,
  // 且摘要成功后旧区整体丢弃,预截断本身也无收益。
  // 上一代摘要的叙述段并入转录:它压的就是更早的轮次,不并进来等于把那些轮次整段丢弃;
  // 并进来则由本代摘要统一重压(可重建内容,磨掉不心疼)。Key Facts 不并——它已被钉住。
  let older = flattenGroups(oldGroups);
  if (pinned?.rest) {
    older = [
      {
        role: 'system' as const,
        content: `${PRIOR_NARRATIVE_LABEL}\n${pinned.rest}`,
      } as ChatMessage,
      ...older,
    ];
  }
  const summarizeFn =
    opts.summarize ??
    ((older: ChatMessage[], focus?: string, signal?: AbortSignal) =>
      defaultSummarize(older, focus, signal, opts.runtime ?? defaultCompactionRuntime));
  let summary: string | null = null;
  try {
    summary = await summarizeFn(older, opts.focus, opts.signal);
  } catch (err) {
    // **中断必须冒泡,不能降级成微压缩**:用户按了 Ctrl+C 是要立刻停,不是"换个姿势继续压"。
    // 冒泡后由 runAgentCore 步骤 catch 里的 abort 分支走 abortRestore(还原 history + 模式)。
    // 此处 history 尚未被改动(重建在摘要成功之后),所以直接抛是安全的。
    if (isAbortError(err, opts.signal)) throw err;
    summary = null; // 真·摘要失败 → 回退微压缩兜底,不崩
  }

  if (summary) {
    const artifactRefs = collectArtifactRefs(older);
    const provenance = artifactRefs.length > 0 ? `\n\n[artifact refs: ${artifactRefs.join(', ')}]` : '';
    // 钉住的 Key Facts 拼在段尾:单条 system 消息里尾部注意力最强,老事实不会被"读漏"。
    // 恒为单条——并排多条 system 摘要会触发近因效应,早期摘要形同虚设。
    const parsed = splitSummaryText(summary);
    const pinnedFacts = mergeKeyFacts(pinned?.keyFacts, parsed.keyFacts, keyFactsBudgetChars(opts.window));
    // P2:把 Objective/In Progress/Next Steps 固结到 notes.md——压缩那一刻
    // notes.md 就有当前进度的权威副本,压缩后恢复提示据此续工,不再只依赖
    // 模型自觉 plan_update。仅主 agent(共享 contextState)写;子 agent 独立
    // contextState 不应污染主会话笔记。无活跃 plan 时写入(有则权威计划仍在)。
    if (state === contextState) {
      const snapshot = extractProgressSnapshot(parsed.rest);
      if (snapshot) writeCompactionSnapshot(snapshot);
    }
    const body = [parsed.rest, pinnedFacts ? `## Key Facts\n${pinnedFacts}` : ''].filter(Boolean).join('\n\n');
    const summaryMsg = {
      role: 'system' as const,
      content: `${SUMMARY_MARKER}\n${body}${provenance}`,
    } as ChatMessage;
    // 原地重建:[systemPrompt, summaryMsg, ...kept]
    const systemMsg = history[0];
    const rebuilt: ChatMessage[] = [systemMsg, summaryMsg, ...flattenGroups(kept)];
    history.length = 0;
    history.push(...rebuilt);
    (opts.runtime?.rollbackStore ?? defaultRollbackStore).pruneAfterCompaction(history);
    const estimateAfter = estimatePromptTokens(history, activeTools, state.correction);
    state.lastEstimate = estimateAfter;
    state.lastUsage = undefined; // 压缩后旧 usage 失效,/context 改用校正估算
    // 压缩行与上一个工具批次摘要行之间补空行分隔(compact 在 core step 循环顶部触发,
    // 上一步的 batch 可能尚未 flush,缓冲末行仍是 ● 工具摘要行 → 两行黏在一起)。
    if (!layout.isLastContentRowBlank()) layout.contentWrite('\n');
    layout.contentWrite(
      `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.accent}压缩上下文${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`,
    );
    // 抖动保护:压缩后仍超阈 → 提示 /clear,不死循环
    if (estimateAfter >= opts.threshold * opts.window) {
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}压缩后仍超阈,可能存在超大单条;建议 /clear。${ui.reset}\n`,
      );
    }
    return {
      compacted: true,
      summarized: true,
      historyRebuilt: true,
      estimateBefore,
      estimateAfter,
      reason: 'summarize',
    };
  }

  // 摘要失败兜底:微压缩——旧区原地截短(保 tool_call_id,无 LLM 调用),结构不动。
  // 覆盖三类大字段,均只裁模型/工具产物,不动 user 原话与 system:
  //   ① tool 结果 content;② 旧 assistant 的 tool_calls.arguments(provenance stub,
  //     整体超长才进,大字段替换为 "<N 字符,已省略>",保 path + JSON 合法);③ 旧 assistant 正文。
  let microcompactDone = false;
  for (const g of oldGroups) {
    if (microcompactGroup(g)) microcompactDone = true;
  }
  const estimateAfter = estimatePromptTokens(history, activeTools, state.correction);
  state.lastEstimate = estimateAfter;
  state.lastUsage = undefined; // token 数已变,旧 usage 失效
  if (microcompactDone) {
    if (!layout.isLastContentRowBlank()) layout.contentWrite('\n');
    layout.contentWrite(
      `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.accent}微压缩旧工具结果${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`,
    );
    return {
      compacted: true,
      summarized: false,
      estimateBefore,
      estimateAfter,
      reason: 'microcompact',
      protectedRatio: history.length > 0 ? kept.length / history.length : 0,
      oldGroupCount: oldGroups.length,
    };
  }
  // 摘要失败 + 无超大单条可微压 = 真 noop
  return {
    ...noop,
    reason: 'noop-ml-only',
    protectedRatio: history.length > 0 ? kept.length / history.length : 0,
    oldGroupCount: oldGroups.length,
  };
}

/**
 * 自动压缩门槛:agent 每步调 chat() 前调用。
 * 用全量启发式估算(始终可用、安全侧、无 stale-usage 问题);超阈则压缩。
 *
 * The shared 80% pressure threshold is the only automatic trigger. Raw estimates
 * participate so correction<1 cannot hide an oversized provider request.
 *
 * Budget Scheduler 模式在同一次 80% pressure 事件中先完成已启用的
 * superseded / stale artifact / logs-search 清理，然后无条件继续压缩历史。
 *
 * 不传 report 时使用同一个共享阈值，供子 agent 和关闭 scheduler 时 fallback；
 * 不再维护独立的自动压缩触发线。
 *
 * manual 选项(repl /compact 用):true 时旁路 autoCompact 开关与 ROI 阈,
 * 强制走 compactHistory(manual/force 参数透传)。返 CompactResult 给 caller 文案展示。
 * 默认 manual=false 自动路径完全不变。
 */
export async function maybeCompact(
  history: ChatMessage[],
  report?: {
    layers: { history: { overBudget: boolean } };
    totalOver: boolean;
    /** 硬闸输入:裸估算总量(不乘 correction)与窗口;两者齐备才参与硬闸判断。 */
    rawTotal?: number;
    window?: number;
  },
  manualOpts?: { manual?: boolean; force?: boolean; focus?: string },
  state: ContextState = contextState,
  activeTools: readonly ChatTool[] = chatTools,
  /** 主 agent 的 abort signal;透传给 compactHistory → 摘要器 → model transport。 */
  signal?: AbortSignal,
  runtime: CompactionRuntime = defaultCompactionRuntime,
): Promise<CompactResult | void> {
  const est = estimatePromptTokens(history, activeTools, state.correction);
  state.lastEstimate = est;
  const isManual = manualOpts?.manual === true;

  // Hard guard: the scheduler has already attempted pressure cleanup; if raw
  // content remains near the provider limit, compact even when correction < 1.
  let hardCap =
    typeof report?.rawTotal === 'number' &&
    typeof report?.window === 'number' &&
    report.rawTotal >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * report.window;

  // 手动路径:旁路 autoCompact / report / 总阈三重门
  if (!isManual) {
    if (!hardCap && !runtime.config.autoCompact) return;
    if (report) {
      // Scheduler mode: the shared pressure report is the sole automatic trigger.
      const needsCompact = hardCap || report.totalOver;
      if (!needsCompact) return;
    } else {
      // Fallback mode uses the same threshold; there is no second compact gate.
      const raw = estimatePromptTokens(history, activeTools, 1);
      hardCap = raw >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * runtime.config.contextWindowTokens;
      const pressureLine = DEFAULT_BUDGET_POLICY.pressureTriggerRatio * runtime.config.contextWindowTokens;
      if (!hardCap && est < pressureLine) return;
    }
  }

  const r = await compactHistory(history, {
    window: runtime.config.contextWindowTokens,
    threshold: DEFAULT_BUDGET_POLICY.pressureTriggerRatio,
    focus: manualOpts?.focus,
    manual: isManual,
    // 硬闸触发时 force 直通保护区:首轮/当前轮不豁免。
    force: manualOpts?.force === true || hardCap,
    tools: activeTools,
    contextState: state,
    runtime,
    signal,
  });
  return r;
}
