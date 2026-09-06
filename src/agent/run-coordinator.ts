// agent 核心循环(纯逻辑,无 TUI 依赖):流式 chat → 工具执行 → 回灌。
// 所有展示副作用经 AgentHooks 注入——主 agent 注入 TUI 渲染(layout + spinner + diff),
// 子 agent 注入静默/摘要 hooks(不写屏)。逻辑层共享,避免重复实现循环 / 分组 / abort 还原。
//
// 与 index.ts 的关系:index.ts 的 runAgent = runAgentCore + TUI hooks 薄封装(行为不变)。
// spawn.ts 的 spawnAgent = runAgentCore + 静默 hooks(子 agent)。

import type OpenAI from 'openai';
import { type ChatMessage, type ToolCallRef } from '../llm/index.js';
import { type ToolOutcome } from '../tools/registry.js';
import { validateToolArguments } from '../tools/validation.js';
import { getPlanDisabledTools, getRuntimeDisabledTools, getSkillRuntimeDisabledTools } from '../tools/constants.js';
import { ADD_TOOL_GROUPS_TOOL_NAME } from '../config/profiles.js';
import { defaultAgentRuntimeContext, type AgentRuntimeContext } from './runtime-context.js';
import type { AgentRunOptions, AgentRunResult } from './run-contracts.js';
import { runModelTurn } from './model-turn.js';
import { runToolTurn } from './tool-turn.js';
import { createTurnLifecycle } from './turn-lifecycle.js';
import {
  parseArgs,
  argumentErrorHint,
  isParallelTool,
  isResourceLockedCall,
  deniedOutcome,
  readDiffContext,
  pushToolResult,
} from './tool-helpers.js';
import { contextState, summarizeToolArguments } from '../session/index.js';
import { createBudgetScheduler } from '../session/scheduler.js';
import { invalidateArtifacts, rehydrateArtifacts } from '../context/index.js';
import { createRelevancePruner } from '../context/relevance.js';
import { t } from '../i18n/index.js';
import { createLifecycleEngine } from '../context/lifecycle.js';
import type { LifecycleEngine } from '../context/lifecycle.js';
import type { BudgetScheduler } from '../session/scheduler.js';
import type { HistoryManager } from './stages/contracts.js';
import type { LegacyStageAdapters } from './stages/legacy-adapters.js';
import { createLegacyModelRunner, createStagedModelRunner } from './stages/model-runner.js';
import { createLegacyContextTrimmer, createStagedContextTrimmer } from './stages/context-trimmer.js';
import { createLegacyToolDispatcher, createStagedToolDispatcher } from './stages/tool-dispatcher.js';
import type { ToolDispatchEvent } from './stages/contracts.js';
import {
  createLegacyCapabilityResolver,
  createLegacyTerminationPolicy,
  createStagedCapabilityResolver,
  createStagedTerminationPolicy,
} from './stages/run-policy.js';

// 工具辅助纯函数(parseArgs / argumentErrorHint / isToolResultsNoise / isParallelTool /
// isResourceLockedTool / isResourceLockedCall / deniedOutcome / readDiffContext / pushToolResult)
// 已提取至 ./tool-helpers.ts——它们不依赖本循环的局部状态,只接受显式参数,故可安全模块化。

/**
 * agent 核心循环(纯逻辑):
 *  流式调 LLM(经 hooks.onText 实时渲染)→ 有 tool_calls 就分组执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由调用方持有。
 *  步前由 session scheduler 检查真实 context pressure；达到 80% 时统一清理并压缩历史。
 *  工具结果正常只经 capToolResultForHistory 的单条 hard safety cap。
 *
 *  中断语义:signal 经 executeTool(name, args, signal) 串进工具;run_command/web_fetch 等 abort 即时杀
 *  (树杀子进程 / 取消 fetch),循环顶 if(signal.aborted) 兜底还原。不会留下未配对的 tool_call_id。
 *  abort 时 history 还原到本 turn 前(savedHistory 浅拷贝),模式还原,调 hooks.onAbort。
 *
 *  所有展示副作用经 hooks 注入;core 自身不直接调 layout / spinner(不依赖 ui/layout.ts)。
 *  但 core 仍依赖 ui/render.ts 的纯函数(summarizeToolCall / truncateDisplay / fmtElapsed)——
 *  这些是纯字符串格式化,无副作用,共享安全。
 */
export async function runAgentCoreLegacy(
  opts: AgentRunOptions,
  historyManager: HistoryManager,
  stages: LegacyStageAdapters,
): Promise<AgentRunResult> {
  const { history, userInput, signal, hooks } = opts;
  const ctx: AgentRuntimeContext = opts.runtimeContext ?? defaultAgentRuntimeContext;
  const runtimeToolSchemas: OpenAI.Chat.Completions.ChatCompletionTool[] = ctx.toolRuntime.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as OpenAI.FunctionParameters,
    },
  }));
  const planDisabledTools = getPlanDisabledTools();
  const runtimePlanToolSchemas = runtimeToolSchemas.filter(
    (tool) => !tool.function.name.startsWith('mcp__') && !planDisabledTools.has(tool.function.name),
  );
  const runtimeContextState = opts.contextState ?? contextState;
  /** 本轮 ask_human 成功调用次数，仅用于 trace 观测，不影响工具执行或模型上下文。 */
  let askHumanCountThisTurn = 0;
  const maxSteps = opts.maxSteps ?? ctx.config.maxSteps;
  // 中断还原:repl 的 /plan / /auto / Shift+Tab 等用户面触发 setAgentMode 中途切了模式,
  // abort 时连同模式一起还原回轮首。模型不再持有 switch_mode 工具,无法自切。
  const savedMode = ctx.getAgentMode();
  const turnLifecycle = createTurnLifecycle(opts, ctx, stages, savedMode);
  const { usageMeter, emitTrace, traceTurnId } = turnLifecycle;
  const toolTurnPlanState = { stepsSincePlanTouch: 0 };
  historyManager.appendUserTurn(userInput);
  // The initial cancellation checkpoint is captured after the user turn and before any model/tool work.
  // Relevance and lifecycle collect provenance during normal work. Neither path
  // rewrites history; exact supersession is applied only by the pressure scheduler.
  const relprune = ctx.config.contextRelprune ? createRelevancePruner() : null;
  let lifecycle: LifecycleEngine | null = ctx.config.contextLifecycle ? createLifecycleEngine(history) : null;
  runtimeContextState.lifecycleStats = lifecycle?.stats();
  rehydrateArtifacts(runtimeContextState, history);
  // The scheduler is the sole automatic history-rewrite entry point. It runs
  // superseded → stale artifact → old logs/search → compact at real pressure.
  // contextBudget=false keeps only the infrastructure compact fallback.
  const scheduler: BudgetScheduler | null =
    ctx.config.contextBudget !== false ? createBudgetScheduler(runtimeContextState, ctx) : null;
  const modelRunner =
    stages.model.implementation === 'staged'
      ? createStagedModelRunner(ctx.modelTransport)
      : createLegacyModelRunner(ctx.modelTransport);
  const dispatcherDependencies = {
    toolRuntime: ctx.toolRuntime,
    checkPermission: ctx.checkPermission,
    jailResolve: ctx.jailResolve,
  };
  const toolDispatcher =
    stages.tools.implementation === 'staged'
      ? createStagedToolDispatcher(dispatcherDependencies)
      : createLegacyToolDispatcher(dispatcherDependencies);
  const capabilityResolver =
    stages.capabilities.implementation === 'staged'
      ? createStagedCapabilityResolver()
      : createLegacyCapabilityResolver();
  const terminationPolicy =
    stages.termination.implementation === 'staged' ? createStagedTerminationPolicy() : createLegacyTerminationPolicy();
  const trimmerInit = { historyManager, scheduler, contextState: runtimeContextState, runtime: ctx };
  const contextTrimmer =
    stages.context.implementation === 'staged'
      ? createStagedContextTrimmer(trimmerInit)
      : createLegacyContextTrimmer(trimmerInit);
  const rebuildHistoryIndexes = (): void => {
    if (lifecycle) {
      lifecycle = createLifecycleEngine(history);
      runtimeContextState.lifecycleStats = lifecycle.stats();
    }
    rehydrateArtifacts(runtimeContextState, history);
  };
  const modelCacheState = { lastStepPromptTokens: 0, providerCacheSeen: false };
  const cancellationLifecycle = turnLifecycle.createCancellation(historyManager, rebuildHistoryIndexes);
  cancellationLifecycle.checkpoint();
  try {
    for (let step = 0; step < maxSteps; step++) {
      turnLifecycle.setCurrentStep(step);
      const stepStartedAt = Date.now();
      emitTrace('step_start', { ordinal: step });
      try {
        // 上一步工具被 abort 杀(run_command/web_fetch 等)→ signal.aborted,直接还原退出,不等 maybeCompact + chat()
        const startDecision = terminationPolicy.decide({
          phase: 'step_start',
          step,
          maxSteps,
          aborted: signal?.aborted === true,
        });
        if (startDecision.kind === 'aborted') {
          cancellationLifecycle.restore();
          turnLifecycle.markAborted();
          return turnLifecycle.buildAbortedResult();
        }
        // 本步只捕获一次不可变 policy snapshot。即便 add_tool_groups 在执行阶段扩容，
        // 本次模型响应仍必须按旧 snapshot 校验；新工具只在下一 step 的 schema 中出现。
        const planMode = ctx.getAgentMode() === 'plan';
        const policySnapshot = opts.toolPolicy?.snapshot(planMode);
        const runPolicy = capabilityResolver.resolve({
          mode: ctx.getAgentMode(),
          toolsOverride: opts.toolsOverride,
          toolPolicy: policySnapshot,
          defaultTools: planMode ? runtimePlanToolSchemas : runtimeToolSchemas,
          runtimeAllowedToolNames: opts.runtimeAllowedToolNames,
          skillDisabledToolNames: getSkillRuntimeDisabledTools(),
          legacyDisabledToolNames: getRuntimeDisabledTools(),
          useLegacyDisabledFallback: !opts.toolPolicy && !opts.runtimeAllowedToolNames,
          reminder: opts.toolPolicy?.reminder(planMode) ?? '',
        });
        // schema、runtime backstop 与后代权限都从同一 effective allow-list 派生。
        // policy snapshot 是本 step 的不可扩张上限；skill deny 可在同批 use_skill 后继续动态收窄。
        const activeTools = runPolicy.tools.slice();
        const stepAllowedNames = runPolicy.allowedToolNames;
        const currentAllowedToolNames = (): string[] => {
          const currentSkillDisabledTools = getSkillRuntimeDisabledTools();
          return [...stepAllowedNames].filter((name) => !currentSkillDisabledTools.has(name));
        };
        const isToolDeniedForStep = (name: string): boolean =>
          !stepAllowedNames.has(name) || getSkillRuntimeDisabledTools().has(name);
        // 委派给编排工具(sub-agent/run_skill)的父前缀快照:去掉历史末尾「产生本次调用的
        // assistant tool_call 消息」(协议上它必须紧跟 tool_result,不能出现在子 history),
        // 只保留其前的主前缀。子 agent 以它为前缀、尾部追加委派消息 → 与主 agent 已发送
        // 前缀逐字节一致,命中前缀缓存。tools 直接用本步 activeTools:子 agent 与主 agent
        // 同权同 schema,不做任何裁剪,也没有额外的执行层禁用集合。
        const delegationForOrchestrator = (): {
          history: ChatMessage[];
          tools: OpenAI.Chat.Completions.ChatCompletionTool[];
        } => {
          let k = history.length - 1;
          while (k > 0) {
            const m = history[k] as { role?: string; tool_calls?: unknown };
            if (m.role === 'assistant' && Array.isArray(m.tool_calls)) break;
            k--;
          }
          return { history: history.slice(0, k > 0 ? k : history.length), tools: activeTools };
        };
        const modelTurn = await runModelTurn({
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
          cacheState: modelCacheState,
          turnLifecycle,
          cancellationLifecycle,
          rebuildHistoryIndexes,
        });
        if (modelTurn.kind === 'aborted') return modelTurn.result;
        const { result, stream } = modelTurn;
        const { mode, gotText, lastChar } = stream;

        const modelDecision = terminationPolicy.decide({
          phase: 'model_result',
          step,
          maxSteps,
          aborted: signal?.aborted === true,
          modelResult: result,
        });
        if (modelDecision.kind === 'continue') {
          await runToolTurn({
            opts,
            ctx,
            historyManager,
            result,
            stream,
            step,
            maxSteps,
            planState: toolTurnPlanState,
            turnLifecycle,
            cancellationLifecycle,
            terminationPolicy,
            rebuildHistoryIndexes,
            dispatch: async (history, modelAttachments) => {
              // 工具分组执行(保 tool_calls 原顺序)：safe parallel 工具照常并发；连续
              // resource-locked mutation 先按序完成权限预检，再按 canonical resource lock 启动。
              // registry 对所有真实资源访问统一持锁，所以不同 Agent 间的 read/write/process 也不会竞态。
              // 串行工具仍是本调用列表内的屏障；渲染/history 回灌始终按原 tool_calls 顺序。
              // executeToolOutcome 永不抛错，失败通过结构化 status/code 返回。
              if (stages.tools.implementation === 'staged') {
                const handleDispatchEvent = (event: ToolDispatchEvent): void => {
                  switch (event.type) {
                    case 'call_start': {
                      const toolCallId = `${traceTurnId}:step:${step}:tool:${event.callIndex}`;
                      emitTrace(
                        'tool_call_start',
                        {
                          tool: event.call.name,
                          argumentHash: event.argumentSummary.sha256,
                          arguments: event.argumentSummary,
                        },
                        {
                          toolCallId,
                          ...(event.call.id ? { providerToolCallId: event.call.id } : {}),
                        },
                      );
                      break;
                    }
                    case 'permission': {
                      const args = summarizeToolArguments(event.call.arguments);
                      emitTrace(
                        'permission',
                        {
                          source: 'agent_tool',
                          tool: event.call.name,
                          decision: event.decision,
                          argumentHash: args.sha256,
                        },
                        {
                          toolCallId: `${traceTurnId}:step:${step}:tool:${event.callIndex}`,
                          ...(event.call.id ? { providerToolCallId: event.call.id } : {}),
                        },
                      );
                      break;
                    }
                    case 'route_expand':
                      emitTrace('tool_route_expand', {
                        policyId: event.expansion.snapshot.id,
                        fromVersion: event.fromVersion,
                        toVersion: event.expansion.snapshot.version,
                        requestedGroups: event.requestedGroups.map(String),
                        addedGroups: event.expansion.added,
                        rejected: event.expansion.rejected,
                        reason: event.reason,
                        status: event.status,
                      });
                      break;
                    case 'header':
                      hooks.onToolHeader?.(event.call);
                      break;
                    case 'start':
                      hooks.onToolStart?.(event.tool);
                      break;
                    case 'done':
                      hooks.onToolDone?.();
                      break;
                    case 'usage':
                      usageMeter.add(event.usage);
                      break;
                    case 'host_outcome':
                      opts.onToolOutcome?.(event.call.name, event.parsed, event.outcome);
                      break;
                    case 'trace_end': {
                      const { outcome, call } = event;
                      emitTrace(
                        'tool_call_end',
                        {
                          tool: call.name,
                          argumentHash: event.argumentSummary.sha256,
                          status: outcome.status,
                          code: outcome.code,
                          retryable: outcome.retryable,
                          durationMs: outcome.durationMs ?? 0,
                          changedFiles: outcome.changedFiles ?? [],
                          staleFiles: outcome.staleFiles ?? [],
                          ...(outcome.changeSet ? { changeSet: outcome.changeSet } : {}),
                          ...(outcome.usage ? { nestedUsage: outcome.usage } : {}),
                        },
                        {
                          toolCallId: `${traceTurnId}:step:${step}:tool:${event.callIndex}`,
                          ...(call.id ? { providerToolCallId: call.id } : {}),
                        },
                      );
                      break;
                    }
                    case 'result':
                      hooks.onToolResult?.(
                        event.call,
                        event.outcome.output,
                        event.parsed,
                        event.diff.preWriteOld,
                        event.diff.editStartLine,
                      );
                      if (event.call.name === 'ask_human' && event.outcome.status === 'success') {
                        askHumanCountThisTurn += 1;
                        emitTrace(
                          'ask_human_call',
                          {
                            tool: event.call.name,
                            status: event.outcome.status,
                            perTurnCount: askHumanCountThisTurn,
                          },
                          event.call.id ? { providerToolCallId: event.call.id } : {},
                        );
                      }
                      if (event.includeContextState) {
                        pushToolResult(
                          history,
                          event.call,
                          event.outcome.output,
                          relprune,
                          lifecycle,
                          scheduler,
                          runtimeContextState,
                          event.succeeded,
                        );
                      } else {
                        pushToolResult(history, event.call, event.outcome.output, relprune, lifecycle, scheduler);
                      }
                      break;
                    case 'invalidate':
                      for (const changedFile of event.files) {
                        relprune?.observeMutation(history, changedFile);
                        lifecycle?.pushMutation(history, history.length - 1, changedFile);
                      }
                      invalidateArtifacts(runtimeContextState, history, event.files);
                      runtimeContextState.lifecycleStats = lifecycle?.stats();
                      break;
                  }
                };
                const dispatchResult = await toolDispatcher.dispatch({
                  calls: result.toolCalls,
                  policy: runPolicy,
                  signal,
                  permissionPrompt: opts.permissionPrompt,
                  isDenied: isToolDeniedForStep,
                  currentAllowedToolNames,
                  delegation: delegationForOrchestrator,
                  argumentErrorHint: (name) => argumentErrorHint(name, runtimeContextState),
                  ...(opts.toolPolicy
                    ? {
                        expandToolGroups: (groups: readonly unknown[], reason: string) =>
                          opts.toolPolicy!.expand(groups, reason),
                      }
                    : {}),
                  onEvent: handleDispatchEvent,
                });
                modelAttachments.push(...dispatchResult.modelAttachments);
              } else {
                const calls = result.toolCalls;
                const tracedCalls = calls.map((tc, index) => ({
                  toolCallId: `${traceTurnId}:step:${step}:tool:${index}`,
                  args: summarizeToolArguments(tc.arguments),
                }));
                for (let index = 0; index < calls.length; index++) {
                  const tc = calls[index];
                  const traceCall = tracedCalls[index];
                  emitTrace(
                    'tool_call_start',
                    {
                      tool: tc.name,
                      argumentHash: traceCall.args.sha256,
                      arguments: traceCall.args,
                    },
                    {
                      toolCallId: traceCall.toolCallId,
                      ...(tc.id ? { providerToolCallId: tc.id } : {}),
                    },
                  );
                }
                const traceToolEnd = (tc: ToolCallRef, index: number, outcome: ToolOutcome): void => {
                  if (outcome.status === 'success' && outcome.modelAttachments?.length) {
                    modelAttachments.push(...outcome.modelAttachments);
                  }
                  const traceCall = tracedCalls[index];
                  emitTrace(
                    'tool_call_end',
                    {
                      tool: tc.name,
                      argumentHash: traceCall.args.sha256,
                      status: outcome.status,
                      code: outcome.code,
                      retryable: outcome.retryable,
                      durationMs: outcome.durationMs ?? 0,
                      changedFiles: outcome.changedFiles ?? [],
                      staleFiles: outcome.staleFiles ?? [],
                      ...(outcome.changeSet ? { changeSet: outcome.changeSet } : {}),
                      ...(outcome.usage ? { nestedUsage: outcome.usage } : {}),
                    },
                    {
                      toolCallId: traceCall.toolCallId,
                      ...(tc.id ? { providerToolCallId: tc.id } : {}),
                    },
                  );
                };
                const hasToolRouteBarrier = calls.some((tc) => tc.name === ADD_TOOL_GROUPS_TOOL_NAME);
                if (hasToolRouteBarrier) {
                  const mixedCall = calls.length !== 1;
                  for (let index = 0; index < calls.length; index++) {
                    const tc = calls[index];
                    hooks.onToolHeader?.(tc);
                    const parsed = parseArgs(tc.arguments);
                    let outcome: ToolOutcome;

                    if (mixedCall) {
                      const isControl = tc.name === ADD_TOOL_GROUPS_TOOL_NAME;
                      outcome = {
                        status: 'denied',
                        code: isControl ? 'INVALID_ARGUMENTS' : 'TOOL_DISABLED',
                        retryable: false,
                        output: isControl
                          ? '错误:add_tool_groups 必须在一个独立的 model step 中单独调用；本次没有扩容。'
                          : `错误:同一响应包含 add_tool_groups，工具 ${tc.name} 未执行。请等待扩容结果后在下一 step 重试。`,
                        changedFiles: [],
                        durationMs: 0,
                      };
                    } else if (isToolDeniedForStep(tc.name)) {
                      outcome = {
                        status: 'denied',
                        code: 'TOOL_DISABLED',
                        retryable: false,
                        output: `错误:当前 tool policy snapshot 不允许调用 ${tc.name}。`,
                        changedFiles: [],
                        durationMs: 0,
                      };
                    } else if (!opts.toolPolicy) {
                      outcome = {
                        status: 'denied',
                        code: 'TOOL_DISABLED',
                        retryable: false,
                        output: '错误:当前 Agent 未启用动态工具策略，无法调用 add_tool_groups。',
                        changedFiles: [],
                        durationMs: 0,
                      };
                    } else if (
                      !parsed ||
                      !Array.isArray(parsed.groups) ||
                      parsed.groups.length === 0 ||
                      typeof parsed.reason !== 'string' ||
                      !parsed.reason.trim()
                    ) {
                      outcome = {
                        status: 'error',
                        code: 'INVALID_ARGUMENTS',
                        retryable: false,
                        output: '错误:add_tool_groups 需要非空 groups 数组和非空 reason。',
                        changedFiles: [],
                        durationMs: 0,
                      };
                    } else {
                      const expansion = opts.toolPolicy.expand(parsed.groups, parsed.reason);
                      const succeeded = expansion.added.length > 0;
                      const details = [
                        succeeded
                          ? `Tool policy expanded to v${expansion.snapshot.version}; added groups: ${expansion.added.join(', ')}.`
                          : `Tool policy was not expanded (still v${expansion.snapshot.version}).`,
                        expansion.rejected.length > 0 ? `Rejected: ${expansion.rejected.join('; ')}.` : '',
                        succeeded ? 'The added tool schemas become available on the next model step.' : '',
                      ]
                        .filter(Boolean)
                        .join('\n');
                      outcome = {
                        status: succeeded ? 'success' : 'error',
                        code: succeeded ? 'OK' : 'INVALID_ARGUMENTS',
                        retryable: false,
                        output: details,
                        changedFiles: [],
                        durationMs: 0,
                      };
                      emitTrace('tool_route_expand', {
                        policyId: expansion.snapshot.id,
                        fromVersion: policySnapshot?.version,
                        toVersion: expansion.snapshot.version,
                        requestedGroups: parsed.groups.map(String),
                        addedGroups: expansion.added,
                        rejected: expansion.rejected,
                        reason: parsed.reason,
                        status: outcome.status,
                      });
                    }

                    opts.onToolOutcome?.(tc.name, parsed ?? {}, outcome);
                    hooks.onToolResult?.(tc, outcome.output, null, null, 1);
                    pushToolResult(
                      history,
                      tc,
                      outcome.output,
                      relprune,
                      lifecycle,
                      scheduler,
                      runtimeContextState,
                      outcome.status === 'success',
                    );
                    traceToolEnd(tc, index, outcome);
                  }
                }

                // add_tool_groups 是 step 屏障：只要本响应出现该控制调用，本批所有普通工具都不执行。
                // 但上面仍为每个 provider tool_call 写入了配对 tool_result，保持 OpenAI 协议完整。
                let i = hasToolRouteBarrier ? calls.length : 0;
                while (i < calls.length) {
                  const currentCall = calls[i];
                  if (isToolDeniedForStep(currentCall.name)) {
                    hooks.onToolHeader?.(currentCall);
                    const error = t('task.disabled');
                    const outcome: ToolOutcome = {
                      status: 'denied',
                      code: 'TOOL_DISABLED',
                      retryable: false,
                      output: error,
                      changedFiles: [],
                      durationMs: 0,
                    };
                    hooks.onToolResult?.(currentCall, error, null, null, 1);
                    pushToolResult(
                      history,
                      currentCall,
                      error,
                      relprune,
                      lifecycle,
                      scheduler,
                      runtimeContextState,
                      false,
                    );
                    traceToolEnd(currentCall, i, outcome);
                    i++;
                    continue;
                  }
                  if (isParallelTool(currentCall.name, ctx.toolRuntime)) {
                    // 收集连续只读组(≥1),并发执行:先渲染所有 header，再一次性启动所有
                    // (executeTool 调用即开始 I/O)，最后按原顺序逐个 await + 回灌。
                    // 必须先 header 后 execute：grep 等同步快速工具会在 executeTool 返回 Promise 前
                    // 已经完成；若先 started.map，用户只能在工具完成后才看到摘要与其前面的换行。
                    // 异步工具(web_fetch 等)并发跑、总耗时 ≈ 最慢一个;同步工具(glob/grep)map 时已顺序跑完,await 即返。
                    let j = i;
                    while (
                      j < calls.length &&
                      isParallelTool(calls[j].name, ctx.toolRuntime) &&
                      !isToolDeniedForStep(calls[j].name)
                    )
                      j++;
                    const batch = calls.slice(i, j);
                    for (const tc of batch) hooks.onToolHeader?.(tc);
                    hooks.onToolStart?.(batch[0].name);
                    const started = batch.map((tc) =>
                      ctx.toolRuntime.executeToolOutcome(tc.name, tc.arguments, signal, {
                        callId: tc.id,
                        allowedToolNames: currentAllowedToolNames(),
                        delegation: delegationForOrchestrator(),
                      }),
                    );
                    for (let k = 0; k < batch.length; k++) {
                      const tc = batch[k];
                      const outcome = await started[k];
                      usageMeter.add(outcome.usage);
                      opts.onToolOutcome?.(tc.name, parseArgs(tc.arguments) ?? {}, outcome);
                      traceToolEnd(tc, i + k, outcome);
                      const output = outcome.output;
                      hooks.onToolResult?.(tc, output, null, null, 1); // 并行工具无 diff
                      if (tc.name === 'ask_human' && outcome.status === 'success') {
                        askHumanCountThisTurn += 1;
                        emitTrace(
                          'ask_human_call',
                          {
                            tool: tc.name,
                            status: outcome.status,
                            perTurnCount: askHumanCountThisTurn,
                          },
                          tc.id ? { providerToolCallId: tc.id } : {},
                        );
                      }
                      pushToolResult(
                        history,
                        tc,
                        output,
                        relprune,
                        lifecycle,
                        scheduler,
                        runtimeContextState,
                        outcome.status === 'success',
                      );
                    }
                    hooks.onToolDone?.();
                    i = j;
                  } else if (
                    isResourceLockedCall(currentCall, ctx.toolRuntime) &&
                    !(ctx.getAgentMode() === 'plan' && planDisabledTools.has(currentCall.name))
                  ) {
                    // 连续文件 mutation：权限确认仍严格按原序进行；全部 preflight 完成后再启动。
                    // 每个执行在 registry 内按 canonical path 获取锁，不同文件可并发，同文件别名会排队。
                    let j = i;
                    while (
                      j < calls.length &&
                      isResourceLockedCall(calls[j], ctx.toolRuntime) &&
                      !isToolDeniedForStep(calls[j].name) &&
                      !(ctx.getAgentMode() === 'plan' && planDisabledTools.has(calls[j].name))
                    )
                      j++;
                    const batch = calls.slice(i, j);
                    const entries: Array<{
                      tc: ToolCallRef;
                      parsed: Record<string, unknown> | null;
                      diff: { preWriteOld: string | null; editStartLine: number };
                      denied?: ToolOutcome;
                    }> = [];

                    for (let k = 0; k < batch.length; k++) {
                      const tc = batch[k];
                      const parsed = parseArgs(tc.arguments);
                      const tool = ctx.toolRuntime.findTool(tc.name);
                      const argumentsValid =
                        tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
                      let denied: ToolOutcome | undefined;
                      if (tool && argumentsValid) {
                        const perm = await ctx.checkPermission(tool, parsed ?? {}, signal, {
                          prompt: opts.permissionPrompt,
                        });
                        emitTrace(
                          'permission',
                          {
                            source: 'agent_tool',
                            tool: tc.name,
                            decision: perm,
                            argumentHash: tracedCalls[i + k].args.sha256,
                          },
                          {
                            toolCallId: tracedCalls[i + k].toolCallId,
                            ...(tc.id ? { providerToolCallId: tc.id } : {}),
                          },
                        );
                        if (perm === 'deny') denied = deniedOutcome(tc.name);
                      }
                      entries.push({
                        tc,
                        parsed,
                        diff: { preWriteOld: null, editStartLine: 1 },
                        ...(denied ? { denied } : {}),
                      });
                    }

                    for (const entry of entries) hooks.onToolHeader?.(entry.tc);
                    const firstAllowed = entries.find((entry) => !entry.denied);
                    if (firstAllowed) hooks.onToolStart?.(firstAllowed.tc.name);
                    const started = entries.map((entry) => {
                      if (entry.denied) return Promise.resolve(entry.denied);
                      const hint = argumentErrorHint(entry.tc.name, runtimeContextState);
                      return ctx.toolRuntime.executeToolOutcome(entry.tc.name, entry.tc.arguments, signal, {
                        callId: entry.tc.id,
                        allowedToolNames: currentAllowedToolNames(),
                        delegation: delegationForOrchestrator(),
                        ...(hint ? { argumentErrorHint: hint } : {}),
                        onLockAcquired: (lockedArgs) => {
                          entry.diff = readDiffContext(entry.tc, lockedArgs, ctx.jailResolve);
                        },
                      });
                    });

                    for (let k = 0; k < entries.length; k++) {
                      const entry = entries[k];
                      const outcome = await started[k];
                      usageMeter.add(outcome.usage);
                      opts.onToolOutcome?.(entry.tc.name, entry.parsed ?? {}, outcome);
                      traceToolEnd(entry.tc, i + k, outcome);
                      hooks.onToolResult?.(
                        entry.tc,
                        outcome.output,
                        entry.denied ? null : entry.parsed,
                        entry.diff.preWriteOld,
                        entry.diff.editStartLine,
                      );
                      pushToolResult(
                        history,
                        entry.tc,
                        outcome.output,
                        relprune,
                        lifecycle,
                        scheduler,
                        runtimeContextState,
                        outcome.status === 'success',
                      );
                      const invalidatedFiles = [
                        ...new Set([...(outcome.changedFiles ?? []), ...(outcome.staleFiles ?? [])]),
                      ];
                      if (invalidatedFiles.length > 0) {
                        for (const changedFile of invalidatedFiles) {
                          relprune?.observeMutation(history, changedFile);
                          lifecycle?.pushMutation(history, history.length - 1, changedFile);
                        }
                        invalidateArtifacts(runtimeContextState, history, invalidatedFiles);
                        runtimeContextState.lifecycleStats = lifecycle?.stats();
                      }
                    }
                    if (firstAllowed) hooks.onToolDone?.();
                    i = j;
                  } else {
                    // 单步串行(mutation / run_command / use_skill)——逐个执行,保快照序
                    const tc = calls[i];
                    // plan 模式防御 backstop:schema 已剔除这些工具,正常不会进这里;防后端幻觉调用——
                    // 不执行,直接返错回灌(让模型看到「plan 模式禁用」并停止),绝不写盘 / 跑命令。
                    if (ctx.getAgentMode() === 'plan' && planDisabledTools.has(tc.name)) {
                      hooks.onToolHeader?.(tc);
                      const err = `错误:计划模式下禁用工具 ${tc.name}(仅读探查,不改动文件 / 不跑命令)`;
                      const outcome: ToolOutcome = {
                        status: 'denied',
                        code: 'MODE_DENIED',
                        retryable: false,
                        output: err,
                        changedFiles: [],
                        durationMs: 0,
                      };
                      hooks.onToolResult?.(tc, err, null, null, 1);
                      pushToolResult(history, tc, err, relprune, lifecycle, scheduler);
                      traceToolEnd(tc, i, outcome);
                      i++;
                      continue;
                    }
                    // 权限预检查:在渲染 ● 头之前弹确认面板(体验:先问再执行,而非执行完再问)。
                    // 拒绝时只渲染拒绝结果,不渲染执行头;放行则继续走 header → start → executeTool 流程。
                    const parsed = parseArgs(tc.arguments);
                    const tool = ctx.toolRuntime.findTool(tc.name);
                    const argumentsValid = tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
                    if (tool && argumentsValid) {
                      const perm = await ctx.checkPermission(tool, parsed ?? {}, signal, {
                        prompt: opts.permissionPrompt,
                      });
                      emitTrace(
                        'permission',
                        {
                          source: 'agent_tool',
                          tool: tc.name,
                          decision: perm,
                          argumentHash: tracedCalls[i].args.sha256,
                        },
                        {
                          toolCallId: tracedCalls[i].toolCallId,
                          ...(tc.id ? { providerToolCallId: tc.id } : {}),
                        },
                      );
                      if (perm === 'deny') {
                        hooks.onToolHeader?.(tc);
                        const outcome = deniedOutcome(tc.name);
                        hooks.onToolResult?.(tc, outcome.output, null, null, 1);
                        pushToolResult(
                          history,
                          tc,
                          outcome.output,
                          relprune,
                          lifecycle,
                          scheduler,
                          runtimeContextState,
                          false,
                        );
                        traceToolEnd(tc, i, outcome);
                        i++;
                        continue;
                      }
                    }
                    hooks.onToolHeader?.(tc);
                    const mutationParsed = ctx.toolRuntime.isFileMutationTool(tc.name) ? parsed : null;
                    let diff = readDiffContext(tc, mutationParsed, ctx.jailResolve);
                    hooks.onToolStart?.(tc.name);
                    const serialHint = argumentErrorHint(tc.name, runtimeContextState);
                    const outcome = await ctx.toolRuntime.executeToolOutcome(tc.name, tc.arguments, signal, {
                      callId: tc.id,
                      allowedToolNames: currentAllowedToolNames(),
                      delegation: delegationForOrchestrator(),
                      ...(serialHint ? { argumentErrorHint: serialHint } : {}),
                      onLockAcquired: (lockedArgs) => {
                        if (mutationParsed) diff = readDiffContext(tc, lockedArgs, ctx.jailResolve);
                      },
                    });
                    usageMeter.add(outcome.usage);
                    opts.onToolOutcome?.(tc.name, parsed ?? {}, outcome);
                    traceToolEnd(tc, i, outcome);
                    const output = outcome.output;
                    hooks.onToolDone?.();
                    hooks.onToolResult?.(tc, output, mutationParsed, diff.preWriteOld, diff.editStartLine);
                    if (tc.name === 'ask_human' && outcome.status === 'success') {
                      askHumanCountThisTurn += 1;
                      emitTrace(
                        'ask_human_call',
                        {
                          tool: tc.name,
                          status: outcome.status,
                          perTurnCount: askHumanCountThisTurn,
                        },
                        tc.id ? { providerToolCallId: tc.id } : {},
                      );
                    }
                    pushToolResult(
                      history,
                      tc,
                      output,
                      relprune,
                      lifecycle,
                      scheduler,
                      runtimeContextState,
                      outcome.status === 'success',
                    );
                    const invalidatedFiles = [
                      ...new Set([...(outcome.changedFiles ?? []), ...(outcome.staleFiles ?? [])]),
                    ];
                    if (invalidatedFiles.length > 0) {
                      for (const changedFile of invalidatedFiles) {
                        relprune?.observeMutation(history, changedFile);
                        lifecycle?.pushMutation(history, history.length - 1, changedFile);
                      }
                      invalidateArtifacts(runtimeContextState, history, invalidatedFiles);
                      runtimeContextState.lifecycleStats = lifecycle?.stats();
                    }
                    i++;
                  }
                }
              }
            },
          });
          continue; // 带着工具结果再调一次 LLM
        }

        if (modelDecision.kind !== 'completed') {
          throw new Error(`Unexpected model termination decision: ${modelDecision.kind}.`);
        }
        if (mode !== 'idle' && lastChar !== '\n') hooks.onTextEnd?.(); // 流式末尾补换行

        // 没有工具调用：接受 agent 的完成判断。框架不自动运行测试、构建或完成门，
        // 也不因缺少验证证据强制追加模型轮次；agent 仍可自行调用工具验证。
        if (!gotText) hooks.onNoReply?.();
        historyManager.appendAssistantTurn({ content: result.content, toolCalls: [] });

        const finalMutation = ctx.getCurrentTurnMutationState();
        turnLifecycle.markCompleted();
        return {
          completed: true,
          terminationReason: 'completed',
          finalText: modelDecision.finalText,
          usage: usageMeter.snapshot(),
          changedFiles: finalMutation.changedFiles.map((item) => item.path),
        };
      } finally {
        emitTrace('step_end', {
          durationMs: Date.now() - stepStartedAt,
          aborted: signal?.aborted === true,
        });
      }
    }

    const exhaustedDecision = terminationPolicy.decide({
      phase: 'loop_exhausted',
      step: maxSteps,
      maxSteps,
      aborted: signal?.aborted === true,
    });
    if (exhaustedDecision.kind !== 'max_steps') {
      throw new Error(`Unexpected loop exhaustion decision: ${exhaustedDecision.kind}.`);
    }
    hooks.onMaxSteps?.();
    turnLifecycle.markMaxSteps();
    const finalMutation = ctx.getCurrentTurnMutationState();
    return {
      completed: false,
      terminationReason: 'max_steps',
      finalText: null,
      usage: usageMeter.snapshot(),
      changedFiles: finalMutation.changedFiles.map((item) => item.path),
    };
  } finally {
    turnLifecycle.finalize();
  }
}
