import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { ChatUsage } from '../llm/index.js';
import { getCurrentTurnId } from '../rollback/index.js';
import type { ValidationResult } from '../verification/types.js';
import { getCurrentSessionId } from './state.js';

export type TraceEventType =
  | 'turn_start' | 'turn_end' | 'step_start' | 'step_end'
  | 'model_start' | 'model_retry' | 'model_end'
  | 'tool_call_start' | 'tool_retry' | 'tool_call_end' | 'permission'
  | 'validation_start' | 'validation_end' | 'compact' | 'abort' | 'rollback'
  // PROMPT-02 / RETRY-01: hard signal for quality dimensions (QUAL-01).
  // Emitted by core.ts when checklist fires / retry reflection is injected,
  // so reduceTraceMetrics can count without scanning history text (fragile).
  | 'checklist_triggered' | 'retry_reflection' | 'ask_human_call'
  // NARR-01: interstitial narration — assistant prose emitted in the same
  // message as tool_calls. The "stay silent during tool-calling turns" rule is
  // prompt-only; this event makes violations measurable instead of vibes-based.
  | 'narration';

export interface AgentTraceEvent {
  schemaVersion: 1;
  eventId: string;
  ts: string;
  sessionId: string;
  turnId: number;
  type: TraceEventType;
  step?: number;
  stepId?: string;
  toolCallId?: string;
  providerToolCallId?: string;
  data: Record<string, unknown>;
}

export interface AgentTurnTrace {
  ts: string;
  sessionId?: string;
  turnId?: number;
  status: 'completed' | 'aborted' | 'max_steps' | 'error';
  durationMs: number;
  toolCalls: number;
  changedFiles: string[];
  usage?: ChatUsage;
  validation?: ValidationResult;
}

export type TraceEventInput = Omit<AgentTraceEvent, 'schemaVersion' | 'eventId' | 'ts'>;

export function createTraceEvent(input: TraceEventInput): AgentTraceEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    ...input,
  };
}

function appendTraceLine(sessionId: string, value: unknown): void {
  try {
    const dir = path.join(config.sessionDir, sessionId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'trace.jsonl'), `${JSON.stringify(value)}\n`, 'utf8');
  } catch {
    // Observability is best-effort and cannot block coding work.
  }
}

/** Persists a typed event in the current session's append-only black-box log. */
export function appendCurrentSessionTraceEvent(event: AgentTraceEvent): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return;
  appendTraceLine(sessionId, { ...event, sessionId });
}

/** Records events initiated outside runAgentCore, such as Ctrl+C, /compact, and /rollback. */
export function appendCurrentSessionRuntimeEvent(
  type: Extract<TraceEventType, 'compact' | 'abort' | 'rollback'>,
  data: Record<string, unknown>,
  turnId = getCurrentTurnId(),
): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return;
  appendTraceLine(sessionId, createTraceEvent({ sessionId, turnId, type, data }));
}

/** Legacy turn-summary sink retained for API compatibility. New production code writes events. */
export function appendCurrentSessionTrace(trace: AgentTurnTrace): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return;
  const validation = trace.validation
    ? {
        status: trace.validation.status,
        level: trace.validation.level,
        durationMs: trace.validation.durationMs,
        verificationComplete: trace.validation.verificationComplete,
        fingerprint: trace.validation.fingerprint,
      }
    : undefined;
  appendTraceLine(sessionId, { ...trace, sessionId, validation });
}
