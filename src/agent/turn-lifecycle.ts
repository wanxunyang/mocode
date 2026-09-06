import { createTraceEvent } from '../session/index.js';
import type { AgentTraceEvent, AgentTurnTrace, TraceEventType } from '../session/trace.js';
import type { AgentRunOptions, AgentRunResult } from './run-contracts.js';
import type { AgentRuntimeContext } from './runtime-context.js';
import type { HistoryManager, UsageMeter } from './stages/contracts.js';
import type { LegacyStageAdapters } from './stages/legacy-adapters.js';
import {
  createLegacyCancellationLifecycle,
  createLegacyTraceSink,
  createLegacyUsageMeter,
  createStagedCancellationLifecycle,
  createStagedTraceSink,
  createStagedUsageMeter,
} from './trace-state.js';

export type EmitTrace = (
  type: TraceEventType,
  data?: Record<string, unknown>,
  ids?: Partial<Pick<AgentTraceEvent, 'step' | 'stepId' | 'toolCallId' | 'providerToolCallId'>>,
) => void;

export interface TurnLifecycle {
  readonly usageMeter: UsageMeter;
  readonly traceSessionId: string;
  readonly traceTurnId: number | undefined;
  readonly startedAt: number;
  emitTrace: EmitTrace;
  setCurrentStep(step: number | undefined): void;
  addToolCalls(count: number): void;
  markCompleted(): void;
  markAborted(): void;
  markMaxSteps(): void;
  createCancellation(
    historyManager: HistoryManager,
    rebuildHistoryIndexes: () => void,
  ): {
    checkpoint(): void;
    restore(): void;
  };
  buildAbortedResult(): AgentRunResult;
  finalize(): void;
}

/** Owns turn-scoped trace, usage, cancellation and outer-finally state without changing their observable order. */
export function createTurnLifecycle(
  opts: AgentRunOptions,
  ctx: AgentRuntimeContext,
  stages: LegacyStageAdapters,
  savedMode: ReturnType<AgentRuntimeContext['getAgentMode']>,
): TurnLifecycle {
  const startedAt = Date.now();
  const traceSessionId = opts.traceContext?.sessionId ?? ctx.getCurrentSessionId() ?? `ephemeral-${process.pid}`;
  const traceTurnId = opts.traceContext?.turnId ?? ctx.getCurrentTurnId();
  const traceSink =
    stages.trace.implementation === 'staged'
      ? createStagedTraceSink({ onTraceEvent: opts.onTraceEvent })
      : createLegacyTraceSink({ onTraceEvent: opts.onTraceEvent });
  const usageMeter = stages.usage.implementation === 'staged' ? createStagedUsageMeter() : createLegacyUsageMeter();
  let currentTraceStep: number | undefined;
  let toolCallCount = 0;
  let done = false;
  let traceStatus: AgentTurnTrace['status'] = 'error';

  const emitTrace: EmitTrace = (type, data = {}, ids = {}) => {
    if (traceTurnId === undefined) return;
    traceSink.emit(
      createTraceEvent({
        sessionId: traceSessionId,
        turnId: traceTurnId,
        type,
        ...(currentTraceStep === undefined
          ? {}
          : {
              step: currentTraceStep,
              stepId: `${traceTurnId}:step:${currentTraceStep}`,
            }),
        ...ids,
        data,
      }),
    );
  };

  emitTrace('turn_start', { mode: ctx.getAgentMode() });
  if (opts.initialToolRoute) emitTrace('tool_route', opts.initialToolRoute);

  return {
    usageMeter,
    traceSessionId,
    traceTurnId,
    startedAt,
    emitTrace,
    setCurrentStep: (step) => {
      currentTraceStep = step;
    },
    addToolCalls: (count) => {
      toolCallCount += count;
    },
    markCompleted: () => {
      done = true;
      traceStatus = 'completed';
    },
    markAborted: () => {
      traceStatus = 'aborted';
    },
    markMaxSteps: () => {
      done = true;
      traceStatus = 'max_steps';
    },
    createCancellation: (historyManager, rebuildHistoryIndexes) => {
      const init = {
        historyManager,
        onObserved: () => emitTrace('abort', { phase: 'observed', reason: 'signal' }),
        onAbort: () => opts.hooks.onAbort?.(),
        onHistoryRestored: rebuildHistoryIndexes,
        restoreMode: () => ctx.setAgentMode(savedMode),
      };
      return stages.cancellation.implementation === 'staged'
        ? createStagedCancellationLifecycle(init)
        : createLegacyCancellationLifecycle(init);
    },
    buildAbortedResult: () => {
      const mutation = ctx.getCurrentTurnMutationState();
      return {
        completed: false,
        terminationReason: 'aborted',
        finalText: null,
        usage: usageMeter.snapshot(),
        changedFiles: mutation.changedFiles.map((item) => item.path),
      };
    },
    finalize: () => {
      const finalMutation = ctx.getCurrentTurnMutationState();
      currentTraceStep = undefined;
      emitTrace('turn_end', {
        status: traceStatus,
        durationMs: Date.now() - startedAt,
        toolCalls: toolCallCount,
        changedFiles: finalMutation.changedFiles.map((item) => item.path),
        totalTokens: usageMeter.snapshot()?.totalTokens,
      });
      try {
        opts.onTrace?.({
          ts: new Date().toISOString(),
          sessionId: traceSessionId,
          turnId: traceTurnId,
          status: traceStatus,
          durationMs: Date.now() - startedAt,
          toolCalls: toolCallCount,
          changedFiles: finalMutation.changedFiles.map((item) => item.path),
          usage: usageMeter.snapshot(),
        });
      } catch {
        // Trace is best-effort and must not change the turn result.
      }
      if (done) opts.hooks.onDone?.(Date.now() - startedAt, usageMeter.snapshot());
    },
  };
}
