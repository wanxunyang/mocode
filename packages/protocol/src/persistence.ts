export type SessionId = string;
export type CheckpointId = string;
export type Revision = number;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RepositoryResult<T> = T | Promise<T>;

export interface SessionDocument<TMessage = JsonValue, TState = JsonValue> {
  sessionId: SessionId;
  revision: Revision;
  createdAt: string;
  updatedAt: string;
  messages: TMessage[];
  state?: TState;
}

export interface SessionSummary {
  sessionId: SessionId;
  revision: Revision;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  latestCheckpointId?: CheckpointId;
}

export interface CheckpointRecord<TState = JsonValue> {
  checkpointId: CheckpointId;
  sessionId: SessionId;
  revision: Revision;
  createdAt: string;
  state: TState;
  metadata?: Record<string, JsonValue>;
}

export interface SessionRepository<TMessage = JsonValue, TState = JsonValue> {
  createId(): SessionId;
  load(sessionId: SessionId): RepositoryResult<SessionDocument<TMessage, TState> | null>;
  save(document: SessionDocument<TMessage, TState>): RepositoryResult<void>;
  list(): RepositoryResult<SessionSummary[]>;
  delete(sessionId: SessionId): RepositoryResult<boolean>;
}

export interface CheckpointRepository<TState = JsonValue> {
  load(sessionId: SessionId, checkpointId: CheckpointId): RepositoryResult<CheckpointRecord<TState> | null>;
  save(checkpoint: CheckpointRecord<TState>): RepositoryResult<void>;
  list(sessionId: SessionId): RepositoryResult<CheckpointRecord<TState>[]>;
  delete(sessionId: SessionId, checkpointId: CheckpointId): RepositoryResult<boolean>;
}
