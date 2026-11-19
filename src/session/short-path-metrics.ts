// 短路径效率指标(trace 事件 → 归约结果)。
//
// 与 trace-metrics.ts 的差异:那边测「工具可靠性」,这边测「路径效率」——agent 在
// 信息已经足够的情况下还花了多少探索成本。三个核心问题:
//   1. 首次改代码前烧掉多少个模型请求(readCallsBeforeFirstEdit / requestsBeforeFirstEdit);
//   2. 有多少完全相同的只读调用在重复执行(repeatedIdenticalReadOnlyCalls);
//   3. 改完之后又回头探索了多少(postEditReadOnlyCalls)。
//
// 判定冗余的依据是 tool_call_start 的 argumentHash(参数指纹):相同工具 + 相同参数
// 指纹的只读调用重复出现,除首次外全部计入冗余。trace 做过脱敏(只有指纹没有参数值),
// 所以无法区分「同文件不同 offset 的重读」——那类情况不计入,指标偏保守。
// 已知近似:只读集合内的重复在「目标文件刚被自己改过」时可能是合法重读,但本指标
// 的使用场景(短路径基准)里 mutation 极少发生在重复调用之前,误差可忽略。
import type { AgentTraceEvent } from './trace.js';

/** 只读探索工具:重复执行相同调用视为纯浪费。 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep', 'glob']);

export interface ShortPathEfficiency {
  toolCalls: number;
  mutationCalls: number;
  readOnlyCalls: number;
  modelRequests: number;
  /** 首个 mutation 前完成的模型请求数;整轮无 mutation 时为 null。 */
  requestsBeforeFirstEdit: number | null;
  /** 首个 mutation 前的只读调用数;整轮无 mutation 时为 null。 */
  readCallsBeforeFirstEdit: number | null;
  /** 相同(工具, 参数指纹)只读调用的重复次数(首次不计)。 */
  repeatedIdenticalReadOnlyCalls: number;
  /** 首个 mutation 之后的只读调用数。 */
  postEditReadOnlyCalls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  /** 只统计 edit_file / write_file，避免命令生成日志被当作首次编辑。 */
  firstEdit?: {
    firstAttemptApplied: boolean | null;
    requests: number | null;
    toolOutputTokensEstimate: number | null;
    uncachedInputTokens: number | null;
  };
  /** 旧报告没有分阶段数据。 */
  phases?: {
    routeDurationMs: number | null;
    modelAttempts: number;
    modelDurationMs: number;
    uncachedPromptTokens: number | null;
    postEditCommands: number;
    postEditCommandDurationMs: number;
    finalModelRequests: number;
    finalModelDurationMs: number;
    completion: 'automatic' | 'fallback' | null;
    fallbackReason: string | null;
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function reduceShortPathEfficiency(events: readonly AgentTraceEvent[]): ShortPathEfficiency {
  let toolCalls = 0;
  let mutationCalls = 0;
  let readOnlyCalls = 0;
  let modelRequests = 0;
  let firstEditSeen = false;
  let requestsBeforeFirstEdit: number | null = null;
  let readCallsBeforeFirstEdit: number | null = null;
  let postEditReadOnlyCalls = 0;
  let repeatedIdentical = 0;
  const seenReadOnly = new Map<string, number>();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;
  let hasTokens = false;
  let hasCached = false;
  let durationMs = 0;
  const phases: NonNullable<ShortPathEfficiency['phases']> = {
    routeDurationMs: null,
    modelAttempts: 0,
    modelDurationMs: 0,
    uncachedPromptTokens: null,
    postEditCommands: 0,
    postEditCommandDurationMs: 0,
    finalModelRequests: 0,
    finalModelDurationMs: 0,
    completion: null,
    fallbackReason: null,
  };
  let uncachedPromptTokens = 0;
  let requestsWithCacheUsage = 0;
  const modelDurations = new Map<string | number, number>();
  const firstEdit: NonNullable<ShortPathEfficiency['firstEdit']> = {
    firstAttemptApplied: null,
    requests: null,
    toolOutputTokensEstimate: null,
    uncachedInputTokens: null,
  };
  let firstEditCall: AgentTraceEvent | undefined;
  let exploredToolTokens = 0;
  let completeToolEstimates = true;

  for (const event of events) {
    if (event.type === 'tool_route') {
      phases.routeDurationMs = finiteNumber(event.data.latencyMs);
      continue;
    }
    if (event.type === 'short_path_completion') {
      phases.completion = event.data.status === 'completed' ? 'automatic' : 'fallback';
      phases.fallbackReason = typeof event.data.reason === 'string' ? event.data.reason : null;
      continue;
    }
    if (event.type === 'model_retry') {
      phases.modelAttempts += 1;
      continue;
    }
    if (event.type === 'model_end') {
      phases.modelAttempts += 1;
      // 同一步的 overflow 重试复用起始时钟，取最大累计耗时。
      const step = event.step ?? event.eventId;
      const elapsed = finiteNumber(event.data.durationMs) ?? 0;
      modelDurations.set(step, Math.max(elapsed, modelDurations.get(step) ?? 0));
      if (String(event.data.status ?? '') !== 'success') continue;
      modelRequests += 1;
      if (toolCalls > 0) {
        phases.finalModelRequests += 1;
        phases.finalModelDurationMs += elapsed;
      }
      const prompt = finiteNumber(event.data.promptTokens);
      const completion = finiteNumber(event.data.completionTokens);
      const total = finiteNumber(event.data.totalTokens);
      if (prompt !== null || completion !== null || total !== null) {
        hasTokens = true;
        promptTokens += prompt ?? 0;
        completionTokens += completion ?? 0;
        totalTokens += total ?? (prompt ?? 0) + (completion ?? 0);
      }
      const cached = finiteNumber(event.data.cachedTokens);
      if (cached !== null) {
        hasCached = true;
        cachedTokens += cached;
        if (prompt !== null && cached <= prompt) {
          requestsWithCacheUsage += 1;
          uncachedPromptTokens += prompt - cached;
        }
      }
      continue;
    }
    if (event.type === 'tool_call_start') {
      toolCalls += 1;
      phases.finalModelRequests = 0;
      phases.finalModelDurationMs = 0;
      const tool = typeof event.data.tool === 'string' ? event.data.tool : '';
      if ((tool === 'edit_file' || tool === 'write_file') && !firstEditCall) firstEditCall = event;
      if (!READ_ONLY_TOOLS.has(tool)) continue;
      readOnlyCalls += 1;
      if (firstEditSeen) postEditReadOnlyCalls += 1;
      const fingerprint = typeof event.data.argumentHash === 'string' ? event.data.argumentHash : '';
      const key = `${tool}:${fingerprint}`;
      const seen = seenReadOnly.get(key) ?? 0;
      if (seen > 0) repeatedIdentical += 1;
      seenReadOnly.set(key, seen + 1);
      continue;
    }
    if (event.type === 'tool_call_end') {
      if (firstEditSeen && event.data.tool === 'run_command') {
        phases.postEditCommands += 1;
        phases.postEditCommandDurationMs += finiteNumber(event.data.durationMs) ?? 0;
      }
      const changedFiles = event.data.changedFiles;
      const changed = Array.isArray(changedFiles) && changedFiles.length > 0;
      const tool = event.data.tool;
      const isEdit = tool === 'edit_file' || tool === 'write_file';
      const applied = event.data.status === 'success' && changed;
      if (
        isEdit &&
        firstEdit.firstAttemptApplied === null &&
        (!firstEditCall ||
          (firstEditCall.toolCallId ? firstEditCall.toolCallId === event.toolCallId : firstEditCall.data.tool === tool))
      ) {
        firstEdit.firstAttemptApplied = applied;
      }
      if (firstEdit.requests === null) {
        if (isEdit && applied) {
          firstEdit.requests = modelRequests;
          firstEdit.toolOutputTokensEstimate = completeToolEstimates ? exploredToolTokens : null;
          firstEdit.uncachedInputTokens =
            modelRequests > 0 && requestsWithCacheUsage === modelRequests ? uncachedPromptTokens : null;
        } else {
          const outputTokens = finiteNumber(event.data.outputTokensEstimate);
          if (outputTokens === null) completeToolEstimates = false;
          else exploredToolTokens += outputTokens;
        }
      }
      if (!changed) continue;
      mutationCalls += 1;
      if (!firstEditSeen) {
        firstEditSeen = true;
        requestsBeforeFirstEdit = modelRequests;
        readCallsBeforeFirstEdit = readOnlyCalls;
      }
      continue;
    }
    if (event.type === 'turn_end') {
      durationMs = finiteNumber(event.data.durationMs) ?? durationMs;
    }
  }
  phases.modelDurationMs = [...modelDurations.values()].reduce((total, ms) => total + ms, 0);
  if (modelRequests > 0 && requestsWithCacheUsage === modelRequests) {
    phases.uncachedPromptTokens = uncachedPromptTokens;
  }

  return {
    toolCalls,
    mutationCalls,
    readOnlyCalls,
    modelRequests,
    requestsBeforeFirstEdit,
    readCallsBeforeFirstEdit,
    repeatedIdenticalReadOnlyCalls: repeatedIdentical,
    postEditReadOnlyCalls,
    promptTokens: hasTokens ? promptTokens : null,
    completionTokens: hasTokens ? completionTokens : null,
    cachedTokens: hasCached ? cachedTokens : null,
    totalTokens: hasTokens ? totalTokens : null,
    durationMs,
    firstEdit,
    phases,
  };
}

/** 任意一段 trace(如 warm 预热轮)里的只读调用数,用于判断预热轮是否真的建立了上下文。 */
export function countReadOnlyCalls(events: readonly AgentTraceEvent[]): number {
  return events.filter(
    (event) => event.type === 'tool_call_start' && READ_ONLY_TOOLS.has(String(event.data.tool ?? '')),
  ).length;
}
