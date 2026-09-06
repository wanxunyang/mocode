import { AsyncLocalStorage } from 'node:async_hooks';
import { runAgentCore } from '../agent/core.js';
import {
  createAgentRuntimeContext,
  defaultAgentRuntimeContext,
  type AgentRuntimeContext,
  type AgentRuntimeContextInit,
} from '../agent/runtime-context.js';
import type { AgentRunOptions, AgentRunResult, ContentPart } from '../agent/run-contracts.js';
import type { ToolRouteGroupName } from '../config/profiles.js';
import type { ChatMessage, ChatTool } from '../llm/index.js';
import type { RollbackPlan, Turn } from '../rollback/index.js';
import {
  contextState as defaultContextState,
  createContextState,
  manualCompact,
  type ContextState,
  type SchedulerRunLog,
  type SessionMeta,
  type SessionRecord,
} from '../session/index.js';
import type { CompactHistoryDetail } from '../session/scheduler.js';

export type RuntimeTurnPolicy = 'new' | 'inherit' | 'none';

/** Runtime owns the context, cancellation and turn boundary; callers cannot substitute another context per run. */
export type RuntimeRunOptions = Omit<AgentRunOptions, 'runtimeContext'> & {
  /** Main runs default to a new rollback turn. Nested agents must explicitly inherit. */
  turn?: RuntimeTurnPolicy;
  /** Optional rollback-menu label. Defaults to the first line of userInput. */
  turnLabel?: string;
};

export type RuntimeCompactResult = SchedulerRunLog & { compactDetail?: CompactHistoryDetail };

export interface RuntimeCompactOptions {
  focus?: string;
  force?: boolean;
  signal?: AbortSignal;
  contextState?: ContextState;
  activeTools?: readonly ChatTool[];
}

export type RuntimeEventType =
  | 'lifecycle.started'
  | 'lifecycle.closing'
  | 'lifecycle.closed'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancel_requested'
  | 'session.created'
  | 'session.resumed'
  | 'session.saved'
  | 'session.cleared'
  | 'rollback.planned'
  | 'rollback.applied'
  | 'compact.started'
  | 'compact.completed'
  | 'compact.failed';

export interface RuntimeEvent<T = Record<string, unknown>> {
  readonly type: RuntimeEventType;
  readonly timestamp: string;
  readonly data: T;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>;

export interface RuntimeInit extends AgentRuntimeContextInit {
  /** Borrow an existing context and its stores instead of creating new infrastructure. */
  context?: AgentRuntimeContext;
  /** Runtime-owned context accounting. Defaults to a fresh state. */
  contextState?: ContextState;
  onStart?: (runtime: Runtime) => void | Promise<void>;
  onClose?: (runtime: Runtime) => void | Promise<void>;
}

export interface RuntimeSessionFacade {
  create(): string;
  resume(id: string): SessionRecord | null;
  save(
    history: ChatMessage[],
    id?: string,
    queryHistory?: readonly string[],
    lastToolGroups?: readonly ToolRouteGroupName[],
  ): SessionMeta;
  list(limit?: number): SessionMeta[];
  clear(): string;
}

export interface RuntimeRollbackFacade {
  list(): Turn[];
  plan(n: number, history: ChatMessage[]): RollbackPlan;
  apply(
    plan: RollbackPlan,
    history: ChatMessage[],
    revertPaths?: Set<string>,
  ): { deletedMsgs: number; revertedFiles: string[]; conflictedFiles: string[] };
}

const activeRuntimes = new AsyncLocalStorage<Runtime>();

/** Runtime facade active in the current agent async tree, used by nested agents to borrow the parent lifecycle. */
export function getActiveRuntime(): Runtime | undefined {
  return activeRuntimes.getStore();
}

function firstLineOf(input: string | ContentPart[]): string {
  const text = typeof input === 'string' ? input : (input.find((part) => part.type === 'text')?.text ?? '');
  return Array.from(text.split('\n')[0] ?? '')
    .slice(0, 40)
    .join('');
}

function toChatTools(context: AgentRuntimeContext): ChatTool[] {
  return context.toolRuntime.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** High-level owner for one AgentRuntimeContext and all host-facing lifecycle operations. */
export class Runtime {
  readonly context: AgentRuntimeContext;
  readonly contextState: ContextState;
  readonly session: RuntimeSessionFacade;
  readonly rollback: RuntimeRollbackFacade;

  private readonly listeners = new Map<RuntimeEventType | '*', Set<RuntimeEventListener>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeWork = new Set<Promise<void>>();
  private mainRunActive = false;
  private controlOperation: string | null = null;
  private readonly onStart?: RuntimeInit['onStart'];
  private readonly onClose?: RuntimeInit['onClose'];
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(init: RuntimeInit = {}) {
    const { context, contextState, onStart, onClose, ...contextInit } = init;
    this.context = context ?? createAgentRuntimeContext(contextInit);
    this.contextState = contextState ?? createContextState();
    this.onStart = onStart;
    this.onClose = onClose;

    this.session = {
      create: () => this.createSession(false),
      resume: (id) => this.resumeSession(id),
      save: (history, id, queryHistory, lastToolGroups) => this.saveSession(history, id, queryHistory, lastToolGroups),
      list: (limit) => {
        this.assertOpen();
        return this.context.sessionStore.list(limit);
      },
      clear: () => this.createSession(true),
    };
    this.rollback = {
      list: () => {
        this.assertOpen();
        return this.context.rollbackStore.listTurns();
      },
      plan: (n, history) => {
        this.assertIdle('plan rollback');
        const plan = this.context.rollbackStore.planRollback(n, history);
        this.emit('rollback.planned', { cutoffTurnId: plan.cutoffTurnId, retainedTurns: plan.n });
        return plan;
      },
      apply: (plan, history, revertPaths = new Set<string>()) => {
        this.assertIdle('apply rollback');
        const result = this.context.rollbackStore.applyRollback(plan, history, revertPaths);
        this.emit('rollback.applied', {
          cutoffTurnId: plan.cutoffTurnId,
          retainedTurns: plan.n,
          ...result,
        });
        return result;
      },
    };
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Runtime is closed.'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = Promise.resolve(this.onStart?.(this)).then(() => {
      this.emit('lifecycle.started', { sandboxRoot: this.context.sandboxRoot });
    });
    return this.startPromise;
  }

  async run(options: RuntimeRunOptions): Promise<AgentRunResult> {
    await this.start();
    this.assertOpen();
    if (this.controlOperation) {
      throw new Error(`Runtime cannot start a run while ${this.controlOperation} is active.`);
    }

    const { turn = 'new', turnLabel, signal: callerSignal, traceContext, ...coreOptions } = options;
    let turnId = traceContext?.turnId;
    if (turn === 'new') {
      if (this.mainRunActive) {
        throw new Error("A main Runtime turn is already active. Use turn: 'inherit' for nested agents.");
      }
      this.mainRunActive = true;
      try {
        turnId = this.context.beginTurn(turnLabel ?? firstLineOf(options.userInput));
      } catch (cause) {
        this.mainRunActive = false;
        throw cause;
      }
    } else if (turn === 'inherit') {
      turnId = this.context.getCurrentTurnId();
    }

    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) relayAbort();
    else callerSignal?.addEventListener('abort', relayAbort, { once: true });
    this.activeControllers.add(controller);
    const finishWork = this.beginTrackedWork();
    this.emit('run.started', { turn, turnId });

    try {
      const result = await activeRuntimes.run(this, () =>
        runAgentCore({
          ...coreOptions,
          contextState: coreOptions.contextState ?? this.contextState,
          signal: controller.signal,
          traceContext: turnId === undefined ? traceContext : { ...traceContext, turnId },
          runtimeContext: this.context,
        }),
      );
      this.emit('run.completed', {
        turn,
        turnId,
        terminationReason: result.terminationReason,
        completed: result.completed,
      });
      return result;
    } catch (cause) {
      this.emit('run.failed', {
        turn,
        turnId,
        aborted: controller.signal.aborted,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    } finally {
      callerSignal?.removeEventListener('abort', relayAbort);
      this.activeControllers.delete(controller);
      if (turn === 'new') this.mainRunActive = false;
      finishWork();
    }
  }

  cancel(reason?: unknown): number {
    let count = 0;
    for (const controller of this.activeControllers) {
      if (controller.signal.aborted) continue;
      controller.abort(reason);
      count += 1;
    }
    this.emit('run.cancel_requested', { count });
    return count;
  }

  async compact(history: ChatMessage[], options: RuntimeCompactOptions = {}): Promise<RuntimeCompactResult> {
    await this.start();
    this.assertIdle('compact');
    this.controlOperation = 'compact';
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) relayAbort();
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    this.activeControllers.add(controller);
    const finishWork = this.beginTrackedWork();
    this.emit('compact.started', { focus: options.focus, force: options.force === true });
    try {
      const result = await this.context.runInScope(() =>
        manualCompact(history, options.focus, {
          force: options.force,
          signal: controller.signal,
          contextState: options.contextState ?? this.contextState,
          activeTools: options.activeTools ?? toChatTools(this.context),
          runtime: this.context,
        }),
      );
      this.emit('compact.completed', {
        compactHistoryCalled: result.compactHistoryCalled,
        historyMutation: result.historyMutation,
        reason: result.compactDetail?.reason,
      });
      return result;
    } catch (cause) {
      this.emit('compact.failed', { message: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    } finally {
      options.signal?.removeEventListener('abort', relayAbort);
      this.activeControllers.delete(controller);
      this.controlOperation = null;
      finishWork();
    }
  }

  on(type: RuntimeEventType | '*', listener: RuntimeEventListener): () => void {
    const listeners = this.listeners.get(type) ?? new Set<RuntimeEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.emit('lifecycle.closing', {});
    this.closePromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      this.cancel(new DOMException('Runtime closed.', 'AbortError'));
      await Promise.allSettled([...this.activeWork]);
      try {
        await this.onClose?.(this);
      } finally {
        this.emit('lifecycle.closed', {});
        this.listeners.clear();
      }
    })();
    return this.closePromise;
  }

  private createSession(cleared: boolean): string {
    this.assertIdle(cleared ? 'clear session' : 'create session');
    const id = this.context.sessionStore.createId();
    this.context.sessionStore.setCurrentSessionId(id);
    this.context.rollbackStore.resetState();
    this.emit(cleared ? 'session.cleared' : 'session.created', { sessionId: id });
    return id;
  }

  private resumeSession(id: string): SessionRecord | null {
    this.assertIdle('resume session');
    const loaded = this.context.sessionStore.load(id);
    if (!loaded?.history.length) return null;
    this.context.sessionStore.setCurrentSessionId(loaded.id);
    this.context.rollbackStore.resetState();
    const snapshotsLoaded = this.context.rollbackStore.loadSnapshots(loaded.id);
    if (!snapshotsLoaded) this.context.rollbackStore.rebuildFromHistory(loaded.history);
    this.emit('session.resumed', { sessionId: loaded.id, snapshotsLoaded });
    return loaded;
  }

  private saveSession(
    history: ChatMessage[],
    id = this.context.sessionStore.getCurrentSessionId(),
    queryHistory: readonly string[] = [],
    lastToolGroups: readonly ToolRouteGroupName[] = [],
  ): SessionMeta {
    this.assertIdle('save session');
    if (!id) throw new Error('Cannot save without an active session.');
    this.context.sessionStore.setCurrentSessionId(id);
    const meta = this.context.sessionStore.save(history, id, queryHistory, lastToolGroups);
    this.context.rollbackStore.persistSnapshots(id);
    this.emit('session.saved', { sessionId: id });
    return meta;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Runtime is closed.');
  }

  private assertIdle(operation: string): void {
    this.assertOpen();
    if (this.activeControllers.size > 0 || this.controlOperation) {
      const active = this.controlOperation ?? 'an agent run';
      throw new Error(`Runtime cannot ${operation} while ${active} is active.`);
    }
  }

  private beginTrackedWork(): () => void {
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    this.activeWork.add(settled);
    return () => {
      this.activeWork.delete(settled);
      resolve();
    };
  }

  private emit(type: RuntimeEventType, data: Record<string, unknown>): void {
    const event: RuntimeEvent = { type, timestamp: new Date().toISOString(), data };
    for (const key of [type, '*'] as const) {
      for (const listener of this.listeners.get(key) ?? []) {
        try {
          const result = listener(event);
          if (result && typeof result.then === 'function') {
            void Promise.resolve(result).catch(() => undefined);
          }
        } catch {
          // Runtime events are observational and must never affect hooks or lifecycle behavior.
        }
      }
    }
  }
}

export function createRuntime(init: RuntimeInit = {}): Runtime {
  return new Runtime(init);
}

/** Compatibility facade explicitly bound to all historical process-level singletons. */
export const defaultRuntime = new Runtime({ context: defaultAgentRuntimeContext, contextState: defaultContextState });
