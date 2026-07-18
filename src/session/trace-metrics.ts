import { readFileSync } from 'node:fs';
import type { AgentTraceEvent } from './trace.js';

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
}

export function reduceTraceMetrics(events: readonly AgentTraceEvent[]): TraceMetrics {
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
