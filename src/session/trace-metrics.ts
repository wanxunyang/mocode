import { readFileSync } from 'node:fs';
import type { AgentTraceEvent } from './trace.js';
import type { ChatMessage } from '../llm/index.js';

export interface TraceMetrics {
  toolCalls: number;
  toolFailures: number;
  toolRecovery: boolean;
  firstSuccessRate: number;
  modelRetries: number;
  toolRetries: number;
  retries: number;
  tokens: number | null;
  durationMs: number;
  firstValidationPassed: boolean;
  /** QUAL-01: 反思重试注入次数(RETRY-01,历史中含 `[retry reflection:` 的工具结果)。 */
  reflectionRounds: number;
  /** QUAL-01: ask_human 工具成功调用次数(ASK-01)。 */
  askHumanCount: number;
  /** QUAL-01: PROMPT-02 checklist 触发次数(推入 history 的 [checklist] user 消息计数)。 */
  checklistTriggered: number;
}

/** 把 history 中所有 user/tool/assistant 消息的文本/参数汇总到一个大字符串,便于
 * 用单一正则扫描多个 marker。比逐条消息 join 更稳:LLM 流式 contentPart 数组
 * 与多模态混合时,joinStringField 内部把每个 part 展平成字符串。 */
function joinHistoryForMarkerScan(history: readonly ChatMessage[] | undefined): string {
  if (!history) return '';
  const parts: string[] = [];
  for (const message of history) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === 'string') parts.push(part);
        else if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          parts.push(part.text);
        }
      }
    }
    if ('tool_call_id' in message && typeof message.tool_call_id === 'string') {
      parts.push(message.tool_call_id);
    }
  }
  return parts.join('\n');
}

/** QUAL-01 质量维度:从 history 文本中扫描三种 marker。
 * - `[retry reflection:` → 反思重试注入次数(RETRY-01)
 * - `[checklist]` user 消息 → PROMPT-02 触发次数
 * - ask_human 工具名(从 events 的 tool_call_end.data.name 推断)+ success 状态 → ASK-01 触发次数
 * 三类都给出 fallback 0,确保报告维度永远是 number,不会被 NaN 污染。 */
function reduceQualityDimensions(
  events: readonly AgentTraceEvent[],
  history: readonly ChatMessage[] | undefined,
): Pick<TraceMetrics, 'reflectionRounds' | 'askHumanCount' | 'checklistTriggered'> {
  const historyText = joinHistoryForMarkerScan(history);
  const reflectionRounds = (historyText.match(/\[retry reflection:/g) ?? []).length;
  const checklistTriggered = (historyText.match(/\[checklist\]/g) ?? []).length;
  // ask_human 工具调用次数:从 events 推断,比 history 文本扫描更稳(避免 LLM 在
  // 文本里误引用 "ask_human" 字面量时被误算)。
  let askHumanCount = 0;
  for (const event of events) {
    if (event.type !== 'tool_call_end') continue;
    if (event.data.name === 'ask_human' && event.data.status === 'success') askHumanCount += 1;
  }
  return { reflectionRounds, askHumanCount, checklistTriggered };
}

export function reduceTraceMetrics(
  events: readonly AgentTraceEvent[],
  history?: readonly ChatMessage[],
): TraceMetrics {
  const ends = events.filter((event) => event.type === 'tool_call_end');
  let recovered = false;
  let hadFailure = false;
  let successes = 0;
  let toolRetries = 0;
  let tokens = 0;
  let hasTokens = false;
  for (const event of ends) {
    const status = String(event.data.status ?? 'error');
    const retry = Number(event.data.retry ?? 0);
    toolRetries += Number.isFinite(retry) ? retry : 0;
    if (status === 'success') {
      successes++;
      if (hadFailure) recovered = true;
    } else {
      hadFailure = true;
    }
  }
  for (const event of events) {
    if (event.type !== 'model_end') continue;
    const value = event.data.totalTokens;
    if (typeof value === 'number' && Number.isFinite(value)) {
      tokens += value;
      hasTokens = true;
    }
  }
  const modelRetries = events.filter((event) => event.type === 'model_retry').length;
  const firstValidation = events.find((event) => event.type === 'validation_end');
  const turnEnd = [...events].reverse().find((event) => event.type === 'turn_end');
  const quality = reduceQualityDimensions(events, history);
  return {
    toolCalls: events.filter((event) => event.type === 'tool_call_start').length,
    toolFailures: ends.length - successes,
    toolRecovery: recovered,
    firstSuccessRate: ends.length ? successes / ends.length : 1,
    modelRetries,
    toolRetries,
    retries: modelRetries + toolRetries,
    tokens: hasTokens ? tokens : null,
    durationMs: Number(turnEnd?.data.durationMs ?? 0),
    firstValidationPassed: firstValidation?.data.status === 'passed',
    ...quality,
  };
}

/** Reads event JSONL; malformed/legacy summary lines are ignored. */
export function readTraceEvents(file: string): AgentTraceEvent[] {
  const events: AgentTraceEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<AgentTraceEvent>;
      if (
        value.schemaVersion === 1 && typeof value.type === 'string' &&
        typeof value.sessionId === 'string' && typeof value.turnId === 'number' &&
        value.data && typeof value.data === 'object'
      ) {
        events.push(value as AgentTraceEvent);
      }
    } catch {
      // One corrupt best-effort trace line must not hide the remaining run.
    }
  }
  return events;
}

export function readTraceMetrics(file: string): TraceMetrics {
  return reduceTraceMetrics(readTraceEvents(file));
}
