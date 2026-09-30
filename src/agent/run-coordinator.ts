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
  isParallelOrchestrationCall,
  isResourceLockedCall,
  deniedOutcome,
  readDiffContext,
  pushToolResult,
} from './tool-helpers.js';
import { contextState, summarizeToolArguments } from '../session/index.js';
import { createReadDedup } from '../tools/read-dedup.js';
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
  if (!opts.continueFromHistory) historyManager.appendUserTurn(userInput);
  // P2:每用户 turn 一个重复读 scope,经 dispatcher → ToolContext 透传给 read_file。
  const readDedup = createReadDedup();
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
          maxSteps,
          readDedup,
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
                  readDedup,
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
                const controlIndexes: number[] = [];
                const otherIndexes: number[] = [];
                calls.forEach((tc, index) =>
                  (tc.name === ADD_TOOL_GROUPS_TOOL_NAME ? controlIndexes : otherIndexes).push(index),
                );
                const hasToolRouteBarrier = controlIndexes.length > 0;
                if (hasToolRouteBarrier) {
                  // add_tool_groups 混批语义 = 部分执行:同批所有「未被禁用的并行安全(只读)」调用
                  // 本 step 照常并发执行,控制调用照常应用扩容(只改下一 step 的 schema);仅写/执行
                  // 等非并行调用被配对拒绝并提示下一 step 重试——单个违规调用不再让整批陪葬。
                  for (let index = 0; index < calls.length; index++) {
                    hooks.onToolHeader?.(calls[index]);
                  }
                  // 只读调用先并发启动(执行序不变);发布(history 回灌/事件)按 provider
                  // 声明序交错进行:批校验按 assistant tool_calls 逐位配对 id,若按执行序
                  // 发布(只读先、扩容后),add_tool_groups 排在只读之前时必然 id 错位,整轮 rollback。
                  // 非并行(写/执行/串行)调用不启动:它们与扩容同批时被拒绝,下一 step 重试。
                  const startedReadonly: Array<Promise<ToolOutcome> | undefined> = new Array(calls.length);
                  const eligibleReadonly = otherIndexes.filter(
                    (index) =>
                      isParallelTool(calls[index].name, ctx.toolRuntime) && !isToolDeniedForStep(calls[index].name),
                  );
                  if (eligibleReadonly.length > 0) {
                    hooks.onToolStart?.(calls[eligibleReadonly[0]].name);
                    for (const index of eligibleReadonly) {
                      startedReadonly[index] = ctx.toolRuntime.executeToolOutcome(
                        calls[index].name,
                        calls[index].arguments,
                        signal,
                        {
                          callId: calls[index].id,
                          allowedToolNames: currentAllowedToolNames(),
                          delegation: delegationForOrchestrator(),
                        },
                      );
                    }
                  }
                  const lastReadonlyIndex =
                    eligibleReadonly.length > 0 ? eligibleReadonly[eligibleReadonly.length - 1] : -1;

                  for (let index = 0; index < calls.length; index++) {
                    const readonlyPromise = startedReadonly[index];
                    if (readonlyPromise) {
                      const tc = calls[index];
                      const outcome = await readonlyPromise;
                      usageMeter.add(outcome.usage);
                      opts.onToolOutcome?.(tc.name, parseArgs(tc.arguments) ?? {}, outcome);
                      traceToolEnd(tc, index, outcome);
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
                      // done 紧跟最后一个只读结果(控制调用在尾部时与旧事件序完全一致)。
                      if (index === lastReadonlyIndex) hooks.onToolDone?.();
                      continue;
                    }

                    if (calls[index].name !== ADD_TOOL_GROUPS_TOOL_NAME) {
                      // 非并行(写/执行/串行)或被禁用的普通调用:与扩容同批时不执行,
                      // 配对拒绝并提示下一 step 重试;控制调用与只读不受其影响照常处理。
                      const tc = calls[index];
                      const outcome: ToolOutcome = {
                        status: 'denied',
                        code: 'TOOL_DISABLED',
                        retryable: false,
                        output: isToolDeniedForStep(tc.name)
                          ? `错误:当前 tool policy snapshot 不允许调用 ${tc.name}。`
                          : `错误:add_tool_groups 不能与写/执行工具 ${tc.name} 同批执行，本 step 已跳过该调用（其余只读调用与扩容已正常处理）；请在下一 step 重试 ${tc.name}。`,
                        changedFiles: [],
                        durationMs: 0,
                      };
                      opts.onToolOutcome?.(tc.name, parseArgs(tc.arguments) ?? {}, outcome);
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
                      traceToolEnd(tc, index, outcome);
                      continue;
                    }

                    // 控制调用(header 已发):校验并应用扩容。扩容只改下一 step 的 schema,
                    // 本批只读执行都走 step 快照,与执行的先后无行为差。
                    const tc = calls[index];
                    const parsed = parseArgs(tc.arguments);
                    let outcome: ToolOutcome;

                    if (isToolDeniedForStep(tc.name)) {
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
                        expansion.implied.length > 0
                          ? `Implied groups also activated: ${expansion.implied.join(', ')}.`
                          : '',
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
                        impliedGroups: expansion.implied,
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
                // (部分执行语义:并行安全只读与扩容照常,写/执行调用跳过待下一 step 重试。)
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
                    // 完成即发:usage/onToolOutcome/trace 在各 outcome 落地瞬间发出(1s 的
                    // grep 不再被 60s 的 web_fetch 卡住可见性);history 回灌严格按原序。
                    await Promise.all(
                      started.map(async (pending, k) => {
                        const outcome = await pending;
                        usageMeter.add(outcome.usage);
                        opts.onToolOutcome?.(batch[k].name, parseArgs(batch[k].arguments) ?? {}, outcome);
                        traceToolEnd(batch[k], i + k, outcome);
                      }),
                    );
                    for (let k = 0; k < batch.length; k++) {
                      const tc = batch[k];
                      const outcome = await started[k];
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
                    isParallelOrchestrationCall(currentCall.name, ctx.toolRuntime) &&
                    !(ctx.getAgentMode() === 'plan' && planDisabledTools.has(currentCall.name))
                  ) {
                    // 连续编排调用(sub-agent)：按 subAgentConcurrency 分块,块内并发。
                    // 权限确认仍严格按原序进行；全部 header 必须先于首个 execute 发出——渲染侧
                    // 靠 header 建「组容器批」并逐条追加 └─ 子 agent 行,若边启动边发 header,
                    // 先完成的 entry 会让组提前收口,后续 header 会另起一个新组。
                    let j = i;
                    while (
                      j < calls.length &&
                      isParallelOrchestrationCall(calls[j].name, ctx.toolRuntime) &&
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

                    // 动态补位池:启动上限 concurrency,任意一个完成立即补位——静态分块时
                    // 「7 个任务、1 个跑 10 分钟」会让第 5 分钟起槽位空转而 6/7 号干等,
                    // 总耗时≈最慢链;补位后≈最满调度。与 staged dispatcher 同构。
                    // 完成即发:usage/onToolOutcome/trace 在各 outcome 落地瞬间发出(快调用
                    // 不再被批内慢调用卡住可见性),history 回灌(pushToolResult)仍严格原序。
                    // 实现用 worker 循环而非「补位回调 + outcomes.map」:outcomes 是稀疏数组,
                    // Array.prototype.map 会跳过未启动槽位的洞,补位链条会在第 N+1 个断掉。
                    const concurrency = Math.max(1, ctx.config.subAgentConcurrency);
                    const outcomes: Array<Promise<ToolOutcome>> = new Array(entries.length);
                    let cursor = 0;
                    const runWorker = async (): Promise<void> => {
                      while (cursor < entries.length) {
                        const position = cursor++;
                        const entry = entries[position];
                        const hint = argumentErrorHint(entry.tc.name, runtimeContextState);
                        const outcome = entry.denied
                          ? entry.denied
                          : await ctx.toolRuntime.executeToolOutcome(entry.tc.name, entry.tc.arguments, signal, {
                              callId: entry.tc.id,
                              allowedToolNames: currentAllowedToolNames(),
                              delegation: delegationForOrchestrator(),
                              ...(hint ? { argumentErrorHint: hint } : {}),
                              onLockAcquired: (lockedArgs) => {
                                entry.diff = readDiffContext(entry.tc, lockedArgs, ctx.jailResolve);
                              },
                            });
                        outcomes[position] = Promise.resolve(outcome);
                        usageMeter.add(outcome.usage);
                        opts.onToolOutcome?.(entry.tc.name, entry.parsed ?? {}, outcome);
                        traceToolEnd(entry.tc, i + position, outcome);
                      }
                    };
                    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => runWorker()));

                    for (let offset = 0; offset < entries.length; offset++) {
                      const entry = entries[offset];
                      const outcome = await outcomes[offset];
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

                    // 完成即发:usage/onToolOutcome/trace 落地瞬间发出;history 回灌严格原序——
                    // 同文件排队由 canonical file 锁保证,异文件并发不受影响。
                    await Promise.all(
                      started.map(async (pending, k) => {
                        const outcome = await pending;
                        usageMeter.add(outcome.usage);
                        opts.onToolOutcome?.(entries[k].tc.name, entries[k].parsed ?? {}, outcome);
                        traceToolEnd(entries[k].tc, i + k, outcome);
                      }),
                    );
                    for (let k = 0; k < entries.length; k++) {
                      const entry = entries[k];
                      const outcome = await started[k];
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

    // ── 撞限 salvage:最后一次不带工具的收尾请求 ──
    // 撞步数上限时 history 里往往已有几十步探索/实现成果,直接返回会把它们整体丢掉
    // (调用方只拿到 finalText=null →「子 agent 被中断」,token 白花还得重新探索)。
    // 这里多发一步无工具(tools=[])的请求,ephemeral system 指示立即输出最终摘要;
    // 成功则把它作为 finalText 带回(terminationReason/completed 语义不变,诚实反映撞限),
    // 请求失败或中止则静默回退旧行为。跳过条件:本来就无工具调用(纯闲聊撞限,无成果可捞)
    // 或已 abort(用户主动取消,不应再花钱)。
    let salvageText: string | null = null;
    const hasToolHistory = history.some((m) => m.role === 'tool');
    if (hasToolHistory && !signal?.aborted) {
      const salvageInstruction =
        '## Step limit reached — final summary required\n' +
        `The hard step limit (${maxSteps}) has been reached and no further tool calls are possible. ` +
        'Write your final report NOW as plain text (no tool calls): what you accomplished, key findings with file paths / evidence, decisions made, and what remains undone. Be concise but complete — this text is the only thing the caller will receive.';
      try {
        const salvage = await modelRunner.run(
          {
            history: [...history, { role: 'system', content: salvageInstruction } as ChatMessage],
            handlers: {},
            tools: [],
          },
          signal,
        );
        if (salvage.content?.trim()) salvageText = salvage.content.trim();
        if (salvage.usage) usageMeter.add(salvage.usage);
        emitTrace('max_steps_salvage', {
          recovered: !!salvageText,
          tokens: salvage.usage?.totalTokens,
        });
      } catch (error) {
        // salvage 是 best-effort:失败不改变撞限终止语义,静默回退;但留一条 trace 取证
        // (否则事后只看到 finalText=null,无法区分「无事可捞」与「收尾请求本身失败」)。
        emitTrace('max_steps_salvage', {
          recovered: false,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
    }

    return {
      completed: false,
      terminationReason: 'max_steps',
      finalText: salvageText,
      usage: usageMeter.snapshot(),
      changedFiles: finalMutation.changedFiles.map((item) => item.path),
    };
  } finally {
    turnLifecycle.finalize();
  }
}
