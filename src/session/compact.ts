import {
  chat,
  chatTools,
  type ChatMessage,
  type ChatTool,
  type ChatUsage,
  correctTokenEstimate,
  estimatePromptTokens,
  estimateTokens,
} from '../llm/index.js';
import { config } from '../config/index.js';
import { MAX_HISTORY_RESULT, MAX_MEMORY_RESULT, MAX_OLD_TOOL_STUB, MAX_SKILL_RESULT } from '../tools/constants.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import * as layout from '../ui/layout.js';
import { pruneAfterCompaction } from '../rollback/index.js';
import { toText } from '../context/utils.js';
import { DEFAULT_BUDGET_POLICY } from '../context/budget.js';
import { collectArtifactRefs } from '../context/artifacts.js';

/**
 * 上下文压缩子系统:
 *  三层 —— ① push-time 单条上限(见 capToolResultForHistory,在 agent push 时调用)
 *          ② 微压缩:旧工具结果原地截短(保 tool_call_id,无 LLM 调用)
 *          ③ 摘要:旧的非工具消息由一次 chat() 压成一条 role:'system' 摘要(index 1)
 *
 *  不变量:
 *  - 原地修改:用 history.length=0; push(...) 重建,repl 持有同一引用。
 *  - tool_call_id 配对:按完整 group(assistant+其后连续 tool)切,永不劈开;
 *    微压缩只改 .content 不删消息。
 *  - history[0] 永远是当前 systemPrompt;摘要插 index 1。
 */

export interface CompactOptions {
  window: number;
  threshold: number;
  /** 手动 /compact 的聚焦指令,会拼进摘要 prompt。 */
  focus?: string;
  /** 可注入的摘要器(测试用);缺省调 chat()。 */
  summarize?: (older: ChatMessage[], focus?: string) => Promise<string | null>;
  /** 手动触发(repl /compact)开关:强制走 microcompact/summarize,绕过 autoCompact 阈。
   *  设为 true 后,即便无 ROI 触发(history 不超/totalOver=false)也压——对齐用户拍板的"真·强制"。
   *  force:在 manual 基础上再绕过「oldGroups 空 → 直接 noop」的硬边界,允许降 keepBudget 强压。
   *  默认 manual=false / force=false(自动路径行为完全不变)。 */
  manual?: boolean;
  force?: boolean;
  /** 本次主请求实际发送的工具集合；缺省为全量工具。 */
  tools?: readonly ChatTool[];
  /** 本次 agent 运行独享的上下文统计状态；缺省使用主 agent 全局状态。 */
  contextState?: ContextState;
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
  let remain = max - marker.length;
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
      if (
        i >= 1 &&
        history[i].role === 'assistant' &&
        (history[i] as any).tool_calls
      ) {
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

async function defaultSummarize(
  older: ChatMessage[],
  focus?: string
): Promise<string | null> {
  // 摘要前剥离多模态 user 消息里的图片(base64 会撑爆摘要 prompt;image 对摘要无信息量)。
  const stripped = older.map(stripImagesForSummary);
  let transcript = stripped
    .map((m) => {
      const role = m.role;
      let line = `${role}: ${toText((m as any).content)}`;
      const tcs = (m as any).tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          line += `\n  [tool_call ${tc?.function?.name}] ${tc?.function?.arguments ?? ''}`;
        }
      }
      return line;
    })
    .join('\n');

  // 防摘要提示本身溢出:超 60% 窗口就先中截到 50%
  if (
    estimateTokens(transcript) >
    Math.floor(config.contextWindowTokens * 0.6)
  ) {
    transcript = truncateMid(
      transcript,
      Math.floor(config.contextWindowTokens * 0.5)
    );
  }

  const sysMsg = {
    role: 'system' as const,
    content:
      'You are a session summarizer. Output only the summary body, max 300 words, preserving: the user\'s core request; files read/written/modified and key changes; source artifact IDs/hashes; key commands run and their result highlights; decisions made; current task progress and next step; open questions. Do not recap every detail.',
  } as ChatMessage;
  const userMsg = {
    role: 'user' as const,
    content: focus
      ? `请将以下会话历史压缩成摘要,重点保留与「${focus}」相关的事实/决策/文件改动:\n\n${transcript}\n\n摘要:`
      : `请将以下会话历史压缩成摘要:\n\n${transcript}\n\n摘要:`,
  } as ChatMessage;

  const spinner = new Spinner((msg, frame) =>
    layout.setStatus(msg, frame ?? undefined)
  );
  spinner.start('压缩中');
  try {
    const r = await chat([sysMsg, userMsg], {}); // 空 handlers:不打印、不外显流式
    // 推理模型可能只返 reasoning_content(content 为 null),或幻觉出 tool_calls → 视为失败
    if (r.toolCalls.length > 0 || !r.content) return null;
    return r.content;
  } finally {
    spinner.stop();
  }
}

// ── 对外:compactHistory / maybeCompact ───────────────────────────────────

/**
 * 压缩 history(原地)。手动 /compact 与自动 maybeCompact 都走这里。
 * 不检查阈值——调用方(maybeCompact)决定是否调;/compact 直接调以强制压缩。
 */
export async function compactHistory(
  history: ChatMessage[],
  opts: CompactOptions
): Promise<CompactResult> {
  const state = opts.contextState ?? contextState;
  const activeTools = opts.tools ?? chatTools;
  const estimateBefore = estimatePromptTokens(history, activeTools, state.correction);
  state.lastEstimate = estimateBefore;

  const groups = groupFromEnd(history);

  // 保近期:按策略中的 token 比例累积(至少保 1 组),永不劈开 group。
  const keepBudget = Math.floor(
    opts.window * DEFAULT_BUDGET_POLICY.compactKeepRatio,
  );
  const kept: Group[] = [];
  let keptTokens = 0;
  for (let k = groups.length - 1; k >= 0; k--) {
    const g = groups[k];
    const nextTokens = keptTokens + groupTokens(g);
    if (
      kept.length >= 1
      && correctTokenEstimate(nextTokens, state.correction) > keepBudget
    ) break;
    kept.unshift(g);
    keptTokens = nextTokens;
  }
  let oldGroups = groups.slice(0, groups.length - kept.length);

  // force(硬闸/手动强压):保护区不豁免——常规切分无旧区时只保最后一组,
  // 其余全部进可压区(首轮/当前轮也一样)。仍按 group 边界切,不破坏 tool_call 配对。
  if (oldGroups.length === 0 && opts.force && groups.length >= 2) {
    kept.length = 0;
    kept.push(groups[groups.length - 1]);
    oldGroups = groups.slice(0, groups.length - 1);
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
      const userOnly = single.tools.length === 0
        && (single.assistant as { role?: string } | null)?.role === 'user';
      if (!userOnly && microcompactGroup(single)) {
        const estimateAfter = estimatePromptTokens(history, activeTools, state.correction);
        state.lastEstimate = estimateAfter;
        state.lastUsage = undefined;
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
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}上下文已超阈但无可压缩项(全在保护区),建议 /clear 或缩短输入。${ui.reset}\n`,
      );
      return { ...noop, reason: 'noop-shrunk-too-large', protectedRatio };
    }
    return { ...noop, reason: 'noop-protected', protectedRatio };
  }

  // 第一层:微压缩——旧区原地截短(保 tool_call_id,无 LLM 调用)
  // 覆盖三类大字段,均只裁模型/工具产物,不动 user 原话与 system(摘要):
  //   ① tool 结果 content;
  //   ② 旧 assistant 的 tool_calls.arguments —— provenance stub:整体超长才进,大字段
  //     替换为 "<N 字符,已省略>"(保 path + JSON 合法,见 stubToolCallArguments);
  //   ③ 旧 assistant 正文 content(模型长解释,回看价值低)。
  let microcompactDone = false;
  for (const g of oldGroups) {
    if (microcompactGroup(g)) microcompactDone = true;
  }

  // 第二层:摘要——把旧区(微压缩后)压成一条 system 摘要
  const older = flattenGroups(oldGroups);
  const summarizeFn = opts.summarize ?? defaultSummarize;
  let summary: string | null = null;
  try {
    summary = await summarizeFn(older, opts.focus);
  } catch {
    summary = null; // 摘要失败 → 回退仅微压缩,不崩
  }

  if (summary) {
    const artifactRefs = collectArtifactRefs(older);
    const provenance = artifactRefs.length > 0
      ? `\n\n[artifact refs: ${artifactRefs.join(', ')}]`
      : '';
    const summaryMsg = {
      role: 'system' as const,
      content: `# 会话摘要\n${summary}${provenance}`,
    } as ChatMessage;
    // 原地重建:[systemPrompt, summaryMsg, ...kept]
    const systemMsg = history[0];
    const rebuilt: ChatMessage[] = [systemMsg, summaryMsg, ...flattenGroups(kept)];
    history.length = 0;
    history.push(...rebuilt);
    pruneAfterCompaction(history); // 摘要删了旧轮次 → 按存活轮次裁剪回滚日志
    const estimateAfter = estimatePromptTokens(history, activeTools, state.correction);
    state.lastEstimate = estimateAfter;
    state.lastUsage = undefined; // 压缩后旧 usage 失效,/context 改用校正估算
    layout.contentWrite(
      `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.accent}压缩上下文${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`
    );
    // 抖动保护:压缩后仍超阈 → 提示 /clear,不死循环
    if (estimateAfter >= opts.threshold * opts.window) {
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}压缩后仍超阈,可能存在超大单条;建议 /clear。${ui.reset}\n`
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

  // 摘要失败:回退仅微压缩(tool content 已原地改),结构不动
  const estimateAfter = estimatePromptTokens(history, activeTools, state.correction);
  state.lastEstimate = estimateAfter;
  state.lastUsage = undefined; // token 数已变,旧 usage 失效
  if (microcompactDone) {
    layout.contentWrite(
      `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.accent}微压缩旧工具结果${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`
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
): Promise<CompactResult | void> {
  const est = estimatePromptTokens(history, activeTools, state.correction);
  state.lastEstimate = est;
  const isManual = manualOpts?.manual === true;

  // Hard guard: the scheduler has already attempted pressure cleanup; if raw
  // content remains near the provider limit, compact even when correction < 1.
  let hardCap = typeof report?.rawTotal === 'number'
    && typeof report?.window === 'number'
    && report.rawTotal >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * report.window;

  // 手动路径:旁路 autoCompact / report / 总阈三重门
  if (!isManual) {
    if (!hardCap && !config.autoCompact) return;
    if (report) {
      // Scheduler mode: the shared pressure report is the sole automatic trigger.
      const needsCompact = hardCap || report.totalOver;
      if (!needsCompact) return;
    } else {
      // Fallback mode uses the same threshold; there is no second compact gate.
      const raw = estimatePromptTokens(history, activeTools, 1);
      hardCap = raw >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * config.contextWindowTokens;
      const pressureLine = DEFAULT_BUDGET_POLICY.pressureTriggerRatio * config.contextWindowTokens;
      if (!hardCap && est < pressureLine) return;
    }
  }

  const r = await compactHistory(history, {
    window: config.contextWindowTokens,
    threshold: DEFAULT_BUDGET_POLICY.pressureTriggerRatio,
    focus: manualOpts?.focus,
    manual: isManual,
    // 硬闸触发时 force 直通保护区:首轮/当前轮不豁免。
    force: manualOpts?.force === true || hardCap,
    tools: activeTools,
    contextState: state,
  });
  return r;
}
