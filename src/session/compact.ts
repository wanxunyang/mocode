import {
  chat,
  type ChatMessage,
  type ChatUsage,
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  estimateTokens,
} from '../llm/index.js';
import { config } from '../config/index.js';
import { MAX_HISTORY_RESULT, MAX_OLD_TOOL_STUB, MAX_SKILL_RESULT } from '../tools/constants.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import * as layout from '../ui/layout.js';
import { pruneAfterCompaction } from '../rollback/index.js';

/**
 * 上下文压缩子系统(参考 Claude Code 的 auto-compact):
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
}

export interface CompactResult {
  compacted: boolean;
  summarized: boolean;
  estimateBefore: number;
  estimateAfter: number;
  reason: 'noop' | 'microcompact' | 'summarize' | 'too-large';
}

/** 跨模块共享的上下文状态:agent 写 lastUsage,compact 写 lastEstimate,repl 的 /context 读。 */
export const contextState: { lastUsage?: ChatUsage; lastEstimate: number } = {
  lastEstimate: 0,
};

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
  if (output.length <= MAX_HISTORY_RESULT) return output;
  return truncateMid(output, MAX_HISTORY_RESULT);
}

// ── 内部:消息内容拍平 / group 划分 ──────────────────────────────────────

function toText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
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

// ── 默认摘要器:复用 chat(),空 handlers 不打印 ──────────────────────────

async function defaultSummarize(
  older: ChatMessage[],
  focus?: string
): Promise<string | null> {
  let transcript = older
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
      '你是会话摘要器。只输出摘要正文,不超过 300 字,保留:用户核心请求、已读写/改动的文件及关键变更、执行过的关键命令及结果要点、已做决策、当前任务进度与下一步、未决问题。不要复述全部细节。',
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
  const schemaTokens = estimateToolSchemaTokens();
  const estimateBefore = estimateMessagesTokens(history) + schemaTokens;
  contextState.lastEstimate = estimateBefore;

  const groups = groupFromEnd(history);

  // 保近期:从尾向前累积直到预算花完(至少保 1 组),永不劈开 group。
  const keepBudget = Math.floor(opts.window * 0.4);
  const kept: Group[] = [];
  let keptTokens = 0;
  for (let k = groups.length - 1; k >= 0; k--) {
    const g = groups[k];
    if (kept.length >= 1 && keptTokens + groupTokens(g) > keepBudget) break;
    kept.unshift(g);
    keptTokens += groupTokens(g);
  }
  const oldGroups = groups.slice(0, groups.length - kept.length);

  const noop: CompactResult = {
    compacted: false,
    summarized: false,
    estimateBefore,
    estimateAfter: estimateBefore,
    reason: 'noop',
  };

  if (oldGroups.length === 0) {
    // 没有旧区可压缩
    if (estimateBefore >= opts.threshold * opts.window) {
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}上下文已超阈但无可压缩项,建议 /clear 或缩短输入。${ui.reset}\n`
      );
      return { ...noop, reason: 'too-large' };
    }
    return noop;
  }

  // 第一层:微压缩——旧区 tool 结果原地截短(保 tool_call_id,无 LLM 调用)
  let microcompactDone = false;
  for (const g of oldGroups) {
    for (const t of g.tools) {
      const c = (t as any).content;
      if (typeof c === 'string' && c.length > MAX_OLD_TOOL_STUB) {
        (t as any).content = truncateMid(c, MAX_OLD_TOOL_STUB);
        microcompactDone = true;
      }
    }
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
    const summaryMsg = {
      role: 'system' as const,
      content: `# 会话摘要\n${summary}`,
    } as ChatMessage;
    // 原地重建:[systemPrompt, summaryMsg, ...kept]
    const systemMsg = history[0];
    const rebuilt: ChatMessage[] = [systemMsg, summaryMsg, ...flattenGroups(kept)];
    history.length = 0;
    history.push(...rebuilt);
    pruneAfterCompaction(history); // 摘要删了旧轮次 → 按存活轮次裁剪回滚日志
    const estimateAfter = estimateMessagesTokens(history) + schemaTokens;
    contextState.lastEstimate = estimateAfter;
    contextState.lastUsage = undefined; // 压缩后旧 usage 失效,/context 改用估算
    layout.contentWrite(
      `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}压缩上下文${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`
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
      estimateBefore,
      estimateAfter,
      reason: 'summarize',
    };
  }

  // 摘要失败:回退仅微压缩(tool content 已原地改),结构不动
  const estimateAfter = estimateMessagesTokens(history) + schemaTokens;
  contextState.lastEstimate = estimateAfter;
  contextState.lastUsage = undefined; // 结构虽未变,但 token 数已变,旧 usage 失效
  if (microcompactDone) {
    layout.contentWrite(
      `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}微压缩旧工具结果${ui.reset}  ${ui.dim}${estimateBefore} → ${estimateAfter} tokens${ui.reset}\n`
    );
    return {
      compacted: true,
      summarized: false,
      estimateBefore,
      estimateAfter,
      reason: 'microcompact',
    };
  }
  return noop;
}

/**
 * 自动压缩门槛:agent 每步调 chat() 前调用。
 * 用全量启发式估算(始终可用、安全侧、无 stale-usage 问题);超阈则压缩。
 */
export async function maybeCompact(history: ChatMessage[]): Promise<void> {
  const schemaTokens = estimateToolSchemaTokens();
  const est = estimateMessagesTokens(history) + schemaTokens;
  contextState.lastEstimate = est;
  if (!config.autoCompact) return;
  if (est < config.compactThreshold * config.contextWindowTokens) return;
  await compactHistory(history, {
    window: config.contextWindowTokens,
    threshold: config.compactThreshold,
  });
}
