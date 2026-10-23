import type OpenAI from 'openai';
import {
  estimatePromptTokens,
  estimateTokens,
  isContextLengthError,
  type ChatMessage,
  type ChatResult,
} from '../llm/index.js';
import { imageTurnAgingEnabled, visionBatch, visionKeep } from '../config/index.js';
import { estimateRequestBytes, learnRequestByteLimit, requestByteLimit } from '../context/request-limit.js';
import { createImageDescriber, relieveRequestBytes } from './request-governor.js';
import { countOversizedImagePlaceholders, countOversizedImages } from '../context/vision-window.js';
import type { ContextState } from '../session/compact.js';
import { getActiveSessionStore } from '../session/store.js';
import { getCurrentSessionId } from '../session/state.js';
import { toUsageRecord } from '../session/usage-stats.js';
import type { ReadDedup } from '../tools/read-dedup.js';
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
  /** 本次 run 的步数上限(来自 opts.maxSteps,经 profile cap);用于剩余步数预警。 */
  maxSteps: number;
  readDedup: ReadDedup;
  cacheState: ModelTurnCacheState;
  turnLifecycle: TurnLifecycle;
  cancellationLifecycle: { restore(): void };
  rebuildHistoryIndexes(): void;
}

/**
 * 沿 cause 链(≤3 层)取第一个 errno,供 trace 取证。
 * undici 把底层 errno 挂在 cause 上(`TypeError: fetch failed` → cause `read ECONNRESET`),
 * openai SDK 再包一层 APIConnectionError 后,顶层 code 恒为 undefined;不留这一项,
 * 事后只能看到一个 'Error',无法区分 DNS 失败 / 连接被拒 / TLS 握手失败。
 */
function traceCauseCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth <= 3 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { code?: unknown; cause?: unknown };
    if (typeof e.code === 'string') return e.code;
    cur = e.cause;
  }
  return undefined;
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
    maxSteps,
    readDedup,
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
  // 记录本步实际发送的工具集(policy 收窄后),底栏用量条按它估算 schema,
  // 而不是全量 chatTools(含未路由的 MCP/写工具),避免凭空高估。
  runtimeContextState.activeTools = activeTools;

  let sessionStateText = opts.suppressSessionState ? '' : ctx.buildSessionStateReminder();
  runtimeContextState.ephemeralText = sessionStateText || undefined;
  onContextUpdate?.();

  let historyRebuilt = false;
  let overflowRetried = false;
  // 视觉滑动窗口**必须剪在 trim 之前**:contextTrimmer.trim() 拿的是 historyManager.snapshot(),
  // 若先 trim,预算口径还是未剪的旧数组,80% 压力线照旧被图像撑爆(design-notes/vision-window.md §2.1)。
  // 只在这一个地方剪;下面的 overflow 重试路径读同一个 snapshot,会自动受益。
  runtimeContextState.currentStep = step;
  readDedup.beginStep(step);
  const visionKeepN = visionKeep();
  if (visionKeepN > 0 && historyManager.pruneVisionWindow({ keep: visionKeepN, batch: visionBatch(), step })) {
    rebuildHistoryIndexes();
    onContextUpdate?.();
  }
  // 图片按轮次淘汰:上一个真实用户轮及更早的工具图换成文字卡,当前轮内保留原图。
  // 先于总量预算跑(预算只兜底「当前轮内」仍然过多的图)。同样要通知 readDedup。
  if (imageTurnAgingEnabled() && historyManager.ageToolImages() > 0) {
    rebuildHistoryIndexes();
    readDedup.markContextChanged();
    onContextUpdate?.();
  }
  // 请求体字节预算(上限来源见 context/request-limit.ts,触发线 = 上限 × 0.8):超线且去图即可达标时,
  // 让模型把图描述成文字卡替换原图(卡片带路径,可 read_file 重读)。同样必须在 trim 之前;
  // 被换掉的图要通知 readDedup,否则模型重读同一路径会被去重提示挡回。
  const byteLimit = requestByteLimit(requestBaseURL);
  if (byteLimit > 0) {
    let reliefAnnounced = false;
    const relief = await relieveRequestBytes({
      historyManager,
      tools: activeTools,
      limitBytes: byteLimit,
      extraBytes: sessionStateText ? Buffer.byteLength(sessionStateText, 'utf8') : 0,
      signal,
      describe: createImageDescriber(modelRunner),
      onStart: (info) => {
        reliefAnnounced = true;
        hooks.onImageRelief?.({ phase: 'start', ...info });
      },
    });
    if (reliefAnnounced) {
      hooks.onImageRelief?.({
        phase: 'done',
        replaced: relief.replaced,
        described: relief.described,
        bytesBefore: relief.bytesBefore,
        bytesAfter: relief.bytesAfter,
      });
    }
    if (relief.replaced > 0) {
      emitTrace('compact', {
        source: 'request_bytes',
        reason: 'describe_images',
        compacted: false,
        replaced: relief.replaced,
        described: relief.described,
        estimateBefore: relief.bytesBefore,
        estimateAfter: relief.bytesAfter,
      });
      rebuildHistoryIndexes();
      readDedup.markContextChanged();
      onContextUpdate?.();
    }
  }
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
  if (trimResult.kind === 'rebuild' || trimResult.kind === 'content') readDedup.markContextChanged();
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
    const remainingSteps = maxSteps - step;
    const ephemeralReminder = [
      runPolicy.reminder,
      !opts.suppressOpeningAnalysis && step === 0
        ? '## Opening analysis\nStart your first response of this turn with a brief analysis of the request and approach (1-3 sentences, no filler), then start tool calls. This is the only expected pre-tool prose; afterwards work quietly, no narration between calls.'
        : '',
      remainingSteps <= 3
        ? `## Step budget warning\nOnly ${remainingSteps} step(s) remain before the hard step limit (${maxSteps}). ` +
          'Stop opening new lines of exploration NOW. Wind down: finish the current tool call if any, then use the remaining step(s) to produce your final summary — what you found, key files/evidence, and what remains undone. A terse partial report is far better than being cut off mid-work.'
        : '',
      historyRebuilt
        ? '## Post-compaction recovery\nContext was compacted before this request. Recover first, in this order:\n' +
          '1. Read the session summary at the top of the history: `## Completed` is done — do not redo or re-verify it; `## In Progress` / `## Next Steps` say where work stopped and what is next.\n' +
          '2. Read `## Session state` below (refreshed from notes.md / gui-actions.log): the active plan is authoritative — `[x]` steps are done, resume from the first `[ ]`. `## Compaction Snapshot` is the checkpoint written at this compaction. `## GUI actions` lists every GUI action already performed with its result: do not repeat one that appears there, unless the latest screenshot contradicts it (the screenshot wins — treat that line as attempted but unverified).\n' +
          (sessionStateText
            ? ''
            : '(No active plan or snapshot in notes.md — reconstruct progress from the summary; treat its `## Completed` as ground truth.)\n') +
          '3. Before any file edit, read_file the target fresh for its current hash — never edit from pre-compaction memory.\n' +
          '4. Before re-running a search/read you think you already did, check the summary and notes first; repeat only if the result is genuinely missing or the target changed.'
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
    onRetry: (retry: { attempt: number; nextAttempt: number; waitMs: number; code: string }) => {
      emitTrace('model_retry', {
        model: requestModel,
        provider,
        attempt: retry.attempt,
        nextAttempt: retry.nextAttempt,
        waitMs: retry.waitMs,
        code: retry.code,
      });
      // 退避最长可到 30s、最坏累计数分钟。只写 trace 的话用户看到的就是「卡住不动」,
      // 与「直接报错终止」一样不可解释 —— 所以同时转达给宿主做可见反馈。
      hooks.onModelRetry?.(retry);
    },
  };
  const runChatOnce = async (): Promise<ChatResult> => {
    try {
      return await modelRunner.run({ history: requestHistory, handlers: chatHandlers, tools: activeTools }, signal);
    } catch (error) {
      const errorValue =
        error && typeof error === 'object'
          ? (error as { status?: number; code?: string; name?: string; message?: string; cause?: unknown })
          : undefined;
      emitTrace('model_end', {
        model: requestModel,
        provider,
        status: signal?.aborted ? 'aborted' : 'error',
        code:
          typeof errorValue?.status === 'number'
            ? `HTTP_${errorValue.status}`
            : // 构造器名优先于 `name`:SDK 的 APIError 家族 err.name 恒为 'Error'(无信息量),
              // 构造器名才分得出 APIConnectionError(建连失败)/ APIError(流内报错)。
              (errorValue?.code ??
              (error as { constructor?: { name?: string } } | undefined)?.constructor?.name ??
              errorValue?.name ??
              'MODEL_ERROR'),
        // 取证用:错误文案与 cause 链上的 errno。没有这两项时,trace 只留一个 'Error',
        // 事后无法判断到底是 DNS 失败、连接被拒还是 TLS 握手失败(实测踩过)。
        message: typeof errorValue?.message === 'string' ? errorValue.message.slice(0, 300) : undefined,
        causeCode: traceCauseCode(error),
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
    // 字节拒收的学习 + 描述重试:token 估算远低于窗口却被判超长 → 上游限的是请求体字节数。
    // 记下这次失败请求的字节数作为上限(取历史最小值),再按 0.8 线把图描述成文字卡后重试一次。
    let byteResult: ChatResult | undefined;
    if (!overflowRetried && isContextLengthError(error)) {
      const winTokens = ctx.config.contextWindowTokens;
      const tokenEst = estimatePromptTokens(requestHistory, activeTools);
      if (!(winTokens > 0 && tokenEst >= winTokens * 0.5)) {
        const failingBytes = estimateRequestBytes(requestHistory, activeTools);
        const learned = learnRequestByteLimit(requestBaseURL, failingBytes);
        let reliefAnnounced = false;
        const relief = await relieveRequestBytes({
          historyManager,
          tools: activeTools,
          limitBytes: learned,
          extraBytes:
            requestHistory.length > history.length ? failingBytes - estimateRequestBytes(history, activeTools) : 0,
          signal,
          describe: createImageDescriber(modelRunner),
          onStart: (info) => {
            reliefAnnounced = true;
            hooks.onImageRelief?.({ phase: 'start', ...info });
          },
        });
        if (reliefAnnounced) {
          hooks.onImageRelief?.({
            phase: 'done',
            replaced: relief.replaced,
            described: relief.described,
            bytesBefore: relief.bytesBefore,
            bytesAfter: relief.bytesAfter,
          });
        }
        emitTrace('compact', {
          source: 'overflow_retry',
          reason: 'request_bytes',
          compacted: false,
          limit: learned,
          relief: relief.reason,
          replaced: relief.replaced,
          described: relief.described,
          estimateBefore: failingBytes,
          durationMs: Date.now() - modelStartedAt,
        });
        if (relief.replaced > 0) {
          rebuildHistoryIndexes();
          readDedup.markContextChanged();
          requestHistory = buildRequestHistory();
          stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
          try {
            byteResult = await runChatOnce();
          } catch (retryError) {
            // 去图后仍被判超长:说明还有文本压力,回落到下面的摘要路径(图已换成卡片)。
            if (signal?.aborted || !isContextLengthError(retryError)) throw retryError;
          }
        }
      }
    }
    // 上游按请求体字节数拒收(而非 token):本地估算远低于窗口、history 里却有大图 → 病因是图,
    // 摘要压缩救不了(摘要只会把图剥掉,模型没看过图又会重读,形成「读图→400→压缩」死循环)。
    // 已经摘过 >=2 次仍被拒,直接抛错,不再循环。
    const oversizedImages =
      !byteResult && !overflowRetried && isContextLengthError(error) ? countOversizedImages(history) : 0;
    if (oversizedImages > 0 && countOversizedImagePlaceholders(history) >= 2) throw error;
    const overflowLocalEstimate = oversizedImages > 0 ? estimatePromptTokens(requestHistory, activeTools) : 0;
    const overflowWindow = ctx.config.contextWindowTokens;
    if (byteResult) {
      // 已由上面的字节预算路径重试成功。
      overflowRetried = true;
      result = byteResult;
    } else if (oversizedImages > 0 && !(overflowWindow > 0 && overflowLocalEstimate >= overflowWindow * 0.5)) {
      overflowRetried = true;
      const stripped = historyManager.stripOversizedImages();
      emitTrace('compact', {
        source: 'overflow_retry',
        reason: 'strip_oversized_images',
        compacted: false,
        stripped,
        estimateBefore: overflowLocalEstimate,
        durationMs: Date.now() - modelStartedAt,
      });
      if (stripped === 0) throw error;
      rebuildHistoryIndexes();
      readDedup.markContextChanged();
      requestHistory = buildRequestHistory();
      stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
      result = await runChatOnce();
    } else if (!overflowRetried && isContextLengthError(error)) {
      overflowRetried = true;
      // 第一道:摘要既压不掉保留区里的图,又白花一次 LLM 调用。先把除最新一张外的非屏幕帧图
      // 换成文字卡,直接重试;只有「去图后仍被判超长」才说明是文本本身的问题,再走摘要。
      let reliefResult: ChatResult | undefined;
      const relieved = historyManager.enforceImageBudget({ maxChars: 1 });
      if (relieved > 0) {
        emitTrace('compact', {
          source: 'overflow_retry',
          reason: 'relieve_images',
          compacted: false,
          stripped: relieved,
          durationMs: Date.now() - modelStartedAt,
        });
        rebuildHistoryIndexes();
        readDedup.markContextChanged();
        requestHistory = buildRequestHistory();
        stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
        try {
          reliefResult = await runChatOnce();
        } catch (retryError) {
          if (signal?.aborted || !isContextLengthError(retryError)) throw retryError;
        }
      }
      if (reliefResult) {
        result = reliefResult;
      } else {
        // 跨 step 断路器:runModelTurn 的 overflowRetried 每 step 重置,挡不住「每步 400 → 每步摘要」。
        // 同一用户轮(turnId)内摘要过一次仍被拒,说明摘要救不了,直接抛错,不再循环。
        const breakerTurnId = turnLifecycle.traceTurnId;
        if (breakerTurnId !== undefined) {
          const prior = runtimeContextState.overflowCompaction;
          const count = prior && prior.turnId === breakerTurnId ? prior.count : 0;
          if (count >= 1) {
            emitTrace('compact', {
              source: 'overflow_retry',
              reason: 'breaker_open',
              compacted: false,
              priorCompactions: count,
              durationMs: Date.now() - modelStartedAt,
            });
            throw error;
          }
          runtimeContextState.overflowCompaction = { turnId: breakerTurnId, count: count + 1 };
        }
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
      }
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
  // P1:per-step 用量落盘(失败静默,见 appendUsage)。estimatedTotal 用本次裸估算,
  // 供 /stats 校验估算偏差。
  const record = toUsageRecord(step, 'main', result.usage, stepPromptEst);
  const sessionId = getCurrentSessionId();
  if (record && sessionId) getActiveSessionStore().appendUsage(sessionId, record);
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
    // 钉住底栏用量条:此刻 requestHistory == 真实发出的请求,实测 promptTokens 是它的真实大小。
    // 记录基线裸估算/history 长度/工具集/ephemeral,供底栏对随后增长的消息做精确外推。
    const requestHistoryLen = requestHistory.length;
    runtimeContextState.promptAnchor = {
      measuredPromptTokens: result.usage.promptTokens,
      baseRaw: estimated,
      historyLen: sessionStateText ? requestHistoryLen - 1 : requestHistoryLen,
      tools: activeTools,
      ephemeralText: sessionStateText,
    };
  }
  hooks.onChatDone?.();
  onContextUpdate?.();

  return { kind: 'result', result, stream };
}
