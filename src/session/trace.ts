import { randomUUID } from 'node:crypto';
import type { ChatUsage } from '../llm/index.js';
import { getCurrentTurnId } from '../rollback/index.js';
import { getActiveSessionStore } from './store.js';

export type TraceEventType =
  | 'turn_start'
  | 'turn_end'
  | 'step_start'
  | 'step_end'
  | 'model_start'
  | 'model_retry'
  | 'model_end'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'tool_route'
  | 'tool_route_expand'
  | 'permission'
  | 'compact'
  | 'abort'
  | 'rollback'
  | 'ask_human_call'
  // Interstitial narration is observation-only; it never feeds instructions back to the model.
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
  getActiveSessionStore().appendTrace(sessionId, value);
}

/** Persists a typed event in the current session's append-only black-box log. */
export function appendCurrentSessionTraceEvent(event: AgentTraceEvent): void {
  const sessionId = getActiveSessionStore().getCurrentSessionId();
  if (!sessionId) return;
  appendTraceLine(sessionId, { ...event, sessionId });
}

/** Records events initiated outside runAgentCore, such as Ctrl+C, /compact, and /rollback. */
export function appendCurrentSessionRuntimeEvent(
  type: Extract<TraceEventType, 'compact' | 'abort' | 'rollback' | 'tool_route' | 'tool_route_expand'>,
  data: Record<string, unknown>,
  turnId = getCurrentTurnId(),
): void {
  const sessionId = getActiveSessionStore().getCurrentSessionId();
  if (!sessionId) return;
  appendTraceLine(sessionId, createTraceEvent({ sessionId, turnId, type, data }));
}

/** Legacy turn-summary sink retained for API compatibility. New production code writes events. */
export function appendCurrentSessionTrace(trace: AgentTurnTrace): void {
  const sessionId = getActiveSessionStore().getCurrentSessionId();
  if (!sessionId) return;
  appendTraceLine(sessionId, { ...trace, sessionId });
}
