export type ThreadId = string;
export type RunId = string;
export type TurnId = string;
export type StepId = string;
export type TaskId = string;

export type RunStatus = 'queued' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface RuntimeEvent<T = Record<string, unknown>> {
  type: string;
  runId: RunId;
  threadId?: ThreadId;
  turnId?: TurnId;
  stepId?: StepId;
  timestamp: string;
  data: T;
}

export interface RuntimeState<T = unknown> {
  threadId: ThreadId;
  runId: RunId;
  status: RunStatus;
  input: unknown;
  appState: T;
  version: number;
}
