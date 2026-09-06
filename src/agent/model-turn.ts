import type OpenAI from 'openai';
import {
  estimatePromptTokens,
  estimateTokens,
  isContextLengthError,
  type ChatMessage,
  type ChatResult,
} from '../llm/index.js';
import type { ContextState } from '../session/compact.js';
import type { BudgetScheduler } from '../session/scheduler.js';
import type { AgentRunOptions, AgentRunResult } from './run-contracts.js';
import type { AgentRuntimeContext } from './runtime-context.js';
import type { ContextTrimmer, HistoryManager, ModelRunner, RunPolicySnapshot } from './stages/contracts.js';
import type { TurnLifecycle } from './turn-lifecycle.js';

export interface ModelTurnCacheState {
  lastStepPromptTokens: number;
  providerCacheSeen: boolean;
}

export interface ModelStreamState {
  mode: 'idle' | 'text';
  gotText: boolean;
  lastChar: string;
}

export type ModelTurnOutcome =
  | { kind: 'aborted'; result: AgentRunResult }
  | { kind: 'result'; result: ChatResult; stream: ModelStreamState };

export interface ModelTurnInput {
  opts: AgentRunOptions;
  ctx: AgentRuntimeContext;
  history: ChatMessage[];
  historyManager: HistoryManager;
  runtimeContextState: ContextState;
  scheduler: BudgetScheduler | null;
  contextTrimmer: ContextTrimmer;
  modelRunner: ModelRunner;
  activeTools: OpenAI.Chat.Completions.ChatCompletionTool[];
  runPolicy: RunPolicySnapshot;
  step: number;
  cacheState: ModelTurnCacheState;
  turnLifecycle: TurnLifecycle;
  cancellationLifecycle: { restore(): void };
  rebuildHistoryIndexes(): void;
}

/** Executes context preparation plus exactly one model step, including the single overflow retry path. */
export async function runModelTurn(input: ModelTurnInput): Promise<ModelTurnOutcome> {
  const {
    opts,
    ctx,
    history,
    historyManager,
    runtimeContextState,
    scheduler,
    contextTrimmer,
    modelRunner,
    activeTools,
    runPolicy,
    step,
    cacheState,
    turnLifecycle,
    cancellationLifecycle,
    rebuildHistoryIndexes,
  } = input;
  const { signal, onContextUpdate, hooks } = opts;
  const { usageMeter, emitTrace } = turnLifecycle;
  const requestBaseURL = ctx.config.baseURL;
  const requestModel = ctx.getActiveModel();
  const storedCalibration = ctx.getTokenCalibration(requestBaseURL, requestModel, activeTools);
  runtimeContextState.correction = storedCalibration.correction;
  runtimeContextState.calibrationSamples = storedCalibration.samples;

  let sessionStateText = opts.suppressSessionState ? '' : ctx.buildSessionStateReminder();
  runtimeContextState.ephemeralText = sessionStateText || undefined;
  onContextUpdate?.();

  let historyRebuilt = false;
  let overflowRetried = false;
  const compactStartedAt = Date.now();
  const trimResult = await contextTrimmer.trim({
    mode: scheduler ? 'scheduled' : 'fallback',
    history: historyManager.snapshot(),
    step,
    tools: activeTools,
    ephemeralTokens: sessionStateText ? estimateTokens(sessionStateText) : 0,
    signal,
  });
  historyRebuilt = trimResult.kind === 'rebuild';
  const trimStats = trimResult.kind === 'aborted' ? {} : trimResult.stats;
  if (scheduler && trimStats.compactHistoryCalled) {
    emitTrace('compact', {
      source: 'automatic',
      reason: 'scheduled',
      historyRebuilt,
      durationMs: Date.now() - compactStartedAt,
    });
  } else if (!scheduler && trimResult.kind !== 'aborted' && trimStats.reason) {
    emitTrace('compact', {
      source: 'automatic_fallback',
      reason: trimStats.reason,
      compacted: trimStats.compacted,
      historyRebuilt,
      estimateBefore: trimStats.estimateBefore,
      estimateAfter: trimStats.estimateAfter,
      durationMs: Date.now() - compactStartedAt,
    });
  }
  if (historyRebuilt) {
    rebuildHistoryIndexes();
    if (!opts.suppressSessionState) sessionStateText = ctx.buildSessionStateReminder();
  }

  hooks.onStepStart?.();
  const stream: ModelStreamState = { mode: 'idle', gotText: false, lastChar: '' };
  const onText = (text: string): void => {
    hooks.onText?.(text);
    stream.mode = 'text';
    stream.gotText = true;
    if (text) stream.lastChar = text[text.length - 1];
  };
  const onToolCall = (name: string): void => {
    if (stream.lastChar && stream.lastChar !== '\n') {
      hooks.onTextEnd?.();
      stream.lastChar = '\n';
    }
    hooks.onToolCall?.(name);
  };

  let result: ChatResult;
  const modelStartedAt = Date.now();
  const provider = ctx.safeProviderId(requestBaseURL);
  emitTrace('model_start', { model: requestModel, provider });

  const buildRequestHistory = (): ChatMessage[] => {
    const ephemeralReminder = [
      runPolicy.reminder,
      !opts.suppressOpeningAnalysis && step === 0
        ? '## Opening analysis\nBegin your FIRST response of this turn with a brief analysis of the request and your planned approach (1-3 sentences, no filler), THEN start tool calls. This opening is the only place where pre-tool prose is expected; after it, work quietly with no narration between tool calls.'
        : '',
      historyRebuilt
        ? '## Post-compaction recovery\n' +
          'Context was compacted before this request. Recover before doing anything else, in this order:\n' +
          '1. Read the session summary at the top of the history: `## Completed` is already done — do not redo or re-verify it. `## In Progress` / `## Next Steps` tell you exactly where work stopped and what is next.\n' +
          '2. Read `## Session state` below (from notes.md, refreshed every step): the active plan is authoritative — `[x]` steps are finished, resume from the first `[ ]`. A `## Compaction Snapshot` section there is the progress checkpoint written at this compaction.\n' +
          (sessionStateText
            ? ''
            : '(No active plan or snapshot was found in notes.md — reconstruct what is done purely from the summary and treat its `## Completed` as ground truth.)\n') +
          '3. Before any file edit, read_file the target fresh to get the current content hash — never edit from memory of pre-compaction content.\n' +
          '4. Before re-running a search/read you think you already did, check the summary and notes first: only repeat it if the result is genuinely missing or the target has changed.'
        : '',
      sessionStateText,
    ]
      .filter(Boolean)
      .join('\n\n');
    return ephemeralReminder ? [...history, { role: 'system', content: ephemeralReminder } as ChatMessage] : history;
  };
  let requestHistory = buildRequestHistory();
  onContextUpdate?.();

  let stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
  const reportLive = (progress: { completionTokens: number; promptTokens?: number; cachedTokens?: number }): void => {
    const completedUsage = usageMeter.snapshot();
    const curPrompt = progress.promptTokens ?? stepPromptEst;
    const curCached =
      progress.cachedTokens ??
      (cacheState.providerCacheSeen ? Math.min(cacheState.lastStepPromptTokens, curPrompt) : 0);
    hooks.onLiveUsage?.({
      promptTokens: (completedUsage?.promptTokens ?? 0) + curPrompt,
      completionTokens: (completedUsage?.completionTokens ?? 0) + progress.completionTokens,
      totalTokens: (completedUsage?.totalTokens ?? 0) + curPrompt + progress.completionTokens,
      cachedTokens: (completedUsage?.cachedTokens ?? 0) + curCached,
    });
  };
  reportLive({ completionTokens: 0 });
  const chatHandlers = {
    onText,
    onToolCall,
    onProgress: reportLive,
    onRetry: (retry: { attempt: number; nextAttempt: number; waitMs: number; code: string }) =>
      emitTrace('model_retry', {
        model: requestModel,
        provider,
        attempt: retry.attempt,
        nextAttempt: retry.nextAttempt,
        waitMs: retry.waitMs,
        code: retry.code,
      }),
  };
  const runChatOnce = async (): Promise<ChatResult> => {
    try {
      return await modelRunner.run({ history: requestHistory, handlers: chatHandlers, tools: activeTools }, signal);
    } catch (error) {
      const errorValue =
        error && typeof error === 'object' ? (error as { status?: number; code?: string; name?: string }) : undefined;
      emitTrace('model_end', {
        model: requestModel,
        provider,
        status: signal?.aborted ? 'aborted' : 'error',
        code:
          typeof errorValue?.status === 'number'
            ? `HTTP_${errorValue.status}`
            : (errorValue?.code ?? errorValue?.name ?? 'MODEL_ERROR'),
        durationMs: Date.now() - modelStartedAt,
      });
      throw error;
    }
  };

  try {
    result = await runChatOnce();
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError'))
    ) {
      cancellationLifecycle.restore();
      turnLifecycle.markAborted();
      return { kind: 'aborted', result: turnLifecycle.buildAbortedResult() };
    }
    if (!overflowRetried && isContextLengthError(error)) {
      overflowRetried = true;
      const rawEstimate = estimatePromptTokens(requestHistory, activeTools);
      if (rawEstimate > 1_000) {
        const calibration = ctx.updateTokenCalibration(
          requestBaseURL,
          requestModel,
          activeTools,
          rawEstimate,
          ctx.config.contextWindowTokens,
        );
        runtimeContextState.correction = calibration.correction;
        runtimeContextState.calibrationSamples = calibration.samples;
      }
      const overflowResult = await contextTrimmer.trim({
        mode: 'overflow',
        history: historyManager.snapshot(),
        step,
        tools: activeTools,
        ephemeralTokens: sessionStateText ? estimateTokens(sessionStateText) : 0,
        signal,
      });
      const overflowStats = overflowResult.kind === 'aborted' ? {} : overflowResult.stats;
      emitTrace('compact', {
        source: 'overflow_retry',
        reason: overflowStats.reason ?? 'noop',
        compacted: overflowStats.compacted === true,
        estimateBefore: overflowStats.estimateBefore,
        estimateAfter: overflowStats.estimateAfter,
        durationMs: Date.now() - modelStartedAt,
      });
      if (overflowResult.kind === 'none' || overflowResult.kind === 'aborted') throw error;
      if (overflowResult.kind === 'rebuild') {
        historyRebuilt = true;
        rebuildHistoryIndexes();
      }
      requestHistory = buildRequestHistory();
      stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
      result = await runChatOnce();
    } else {
      throw error;
    }
  }

  emitTrace('model_end', {
    model: requestModel,
    provider,
    status: 'success',
    durationMs: Date.now() - modelStartedAt,
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    cachedTokens: result.usage?.cachedTokens,
    reasoningTokens: result.usage?.reasoningTokens,
  });
  runtimeContextState.lastUsage = result.usage;
  usageMeter.add(result.usage);
  if (result.usage) {
    cacheState.lastStepPromptTokens = result.usage.promptTokens;
    if (result.usage.cachedTokens > 0) cacheState.providerCacheSeen = true;
  }
  if (result.usage?.promptTokens && result.usage.promptTokens > 100) {
    const estimated = estimatePromptTokens(requestHistory, activeTools);
    const updated = ctx.updateTokenCalibration(
      requestBaseURL,
      requestModel,
      activeTools,
      estimated,
      result.usage.promptTokens,
    );
    runtimeContextState.correction = updated.correction;
    runtimeContextState.calibrationSamples = updated.samples;
  }
  hooks.onChatDone?.();
  onContextUpdate?.();

  return { kind: 'result', result, stream };
}
