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
  /** QUAL-01: 反思重试注入次数(RETRY-01,历史中含 `[retry reflection:` 的工具结果)。 */
  reflectionRounds: number;
  /** QUAL-01: ask_human 工具成功调用次数(ASK-01)。 */
  askHumanCount: number;
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

/** QUAL-01 quality dimensions retained after removing the completion gate. */
function reduceQualityDimensions(
  events: readonly AgentTraceEvent[],
  history: readonly ChatMessage[] | undefined,
): Pick<TraceMetrics, 'reflectionRounds' | 'askHumanCount'> {
  let reflectionRounds = 0;
  let askHumanCount = 0;
  let hasHardReflection = false;
  let hasHardAskHuman = false;
  for (const event of events) {
    if (event.type === 'retry_reflection') {
      reflectionRounds += 1;
      hasHardReflection = true;
    } else if (event.type === 'ask_human_call' && event.data.status === 'success') {
      askHumanCount += 1;
      hasHardAskHuman = true;
    }
  }

  if (!hasHardReflection) {
    const historyText = joinHistoryForMarkerScan(history);
    reflectionRounds += (historyText.match(/\[retry reflection:/g) ?? []).length;
  }
  if (!hasHardAskHuman) {
    for (const event of events) {
      if (event.type === 'tool_call_end'
        && event.data.name === 'ask_human'
        && event.data.status === 'success') {
        askHumanCount += 1;
      }
    }
  }
  return { reflectionRounds, askHumanCount };
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
