// agent 核心循环(纯逻辑,无 TUI 依赖):流式 chat → 工具执行 → 回灌。
// 所有展示副作用经 AgentHooks 注入——主 agent 注入 TUI 渲染(layout + spinner + diff),
// 子 agent 注入静默/摘要 hooks(不写屏)。逻辑层共享,避免重复实现循环 / 分组 / abort 还原。
//
// 与 index.ts 的关系:index.ts 的 runAgent = runAgentCore + TUI hooks 薄封装(行为不变)。
// spawn.ts 的 spawnAgent = runAgentCore + 静默 hooks(子 agent)。

import type OpenAI from 'openai';
import {
  chat,
  estimatePromptTokens,
  estimateTokens,
  isContextLengthError,
  planChatTools,
  chatTools,
  type ChatMessage,
  type ChatResult,
  type ChatUsage,
  type ToolCallRef,
} from '../llm/index.js';
import { executeToolOutcome, findTool, isFileMutationTool, type ToolOutcome } from '../tools/registry.js';
import { checkPermission } from '../permissions/index.js';
import { validateToolArguments } from '../tools/validation.js';
import { getPlanDisabledTools, getRuntimeDisabledTools, getSkillRuntimeDisabledTools } from '../tools/constants.js';
import { ADD_TOOL_GROUPS_TOOL_NAME } from '../config/profiles.js';
import type { ToolPolicyController } from '../tools/policy.js';
import { defaultAgentRuntimeContext, type AgentRuntimeContext } from './runtime-context.js';
import {
  parseArgs,
  argumentErrorHint,
  isToolResultsNoise,
  isParallelTool,
  isResourceLockedCall,
  deniedOutcome,
  readDiffContext,
  pushToolResult,
} from './tool-helpers.js';
import { maybeCompact, contextState, summarizeToolArguments } from '../session/index.js';
import { TurnTraceState } from './trace-state.js';
import type { ContextState } from '../session/compact.js';
import { createBudgetScheduler } from '../session/scheduler.js';
import { invalidateArtifacts, rehydrateArtifacts } from '../context/index.js';
import { createRelevancePruner } from '../context/relevance.js';
import { t } from '../i18n/index.js';
import { createLifecycleEngine } from '../context/lifecycle.js';
import type { LifecycleEngine } from '../context/lifecycle.js';
import type { BudgetScheduler } from '../session/scheduler.js';
import type { AgentTraceEvent, AgentTurnTrace, TraceEventType } from '../session/trace.js';

/** nag 提醒阈值:连续 N 个"执行了工具但没更新 notes.md"的步后提醒一次(对齐 Claude Code TodoWrite 的 3 轮)。 */
const PLAN_NAG_THRESHOLD = 3;
/** nag 提醒文本:注入到当前步第一条 tool_result 内容前(与最新工具输出同批被模型看到,而非单独一条易被冲淡)。 */
const PLAN_NAG_TEXT =
  '[mocode] Reminder: you have an active plan in notes.md but have not updated it recently. ' +
  'If you finished a step, call plan_update to check it off (keep at most one in_progress); ' +
  'if the whole plan is done, let plan_update settle it to ## Done:. If the plan changed scope, update it to match reality.';

// 工具辅助纯函数(parseArgs / argumentErrorHint / isToolResultsNoise / isParallelTool /
// isResourceLockedTool / isResourceLockedCall / deniedOutcome / readDiffContext / pushToolResult)
// 已提取至 ./tool-helpers.ts——它们不依赖本循环的局部状态,只接受显式参数,故可安全模块化。

/** 文件 mutation 由 capability metadata 判定，供 diff、回滚与上下文失效共用。 */
const isMutationTool = (name: string): boolean => isFileMutationTool(name);

/** 工具调用 ● 头所需信息(交给 hooks 渲染;core 不直接写屏)。 */
export interface ToolCallView {
  name: string;
  arguments: string;
  id: string;
}

// ── hooks:把 runAgent 的展示副作用参数化 ──────────────────────────────────

/**
 * agent 循环的展示副作用接缝。主 agent 注入 TUI 渲染实现;子 agent 注入静默/摘要实现。
 * 所有方法可选——core 对 undefined hooks 安全跳过。
 */
export interface AgentHooks {
  /** 流式正文增量(主 agent:走 markdown 渲染写内容区)。 */
  onText?: (delta: string) => void;
  /** 模型开始生成某 tool_call 的参数(主 agent:补换行 + 启「生成中」spinner)。 */
  onToolCall?: (name: string) => void;
  /** 每步开始,spinner 启「思考中」(主 agent:spinner.start)。 */
  onStepStart?: () => void;
  /** 流式实时 token 用量(本轮累计 = 已完成步实测 + 当前步估算)。
   *  promptTokens 为裸值(chip ↑ 由 layout 按 裸-cached 的计费口径显示,与轮末摘要 (↑…) 一致);
   *  cachedTokens = 已完成步实测 cache 命中 + 当前步(流式期间按前缀缓存估算 ≈ 上一步实测 prompt,
   *  末尾 usage chunk 到达后换实测)。prompt / completion 同样在末尾 chunk 后换实测。
   *  主 agent:写底栏 context 进度条左侧的实时 chip;200ms 心跳重画自然取最新值。 */
  onLiveUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
  }) => void;
  /** chat 返回后停 spinner(主 agent:spinner.stop)。 */
  onChatDone?: () => void;
  /** 流式正文末尾补换行(若 onToolCall 已补则 no-op);防 ● 行黏在正文行尾。 */
  onTextEnd?: () => void;
  /** 工具调用 ● 头渲染(主 agent:工具名 + 参数摘要)。 */
  onToolHeader?: (tc: ToolCallRef) => void;
  /** 启「执行 工具」spinner(主 agent:spinner.start)。 */
  onToolStart?: (name: string) => void;
  /** 工具执行完停 spinner(主 agent:spinner.stop)。 */
  onToolDone?: () => void;
  /** 工具结果渲染(主 agent:mutation 走 diff 块;其余走一行 preview)。 */
  onToolResult?: (
    tc: ToolCallRef,
    output: string,
    parsed: Record<string, unknown> | null,
    preWriteOld: string | null,
    editStartLine: number,
  ) => void;
  /** 工具步末尾补一空行(与下一轮思考/正文分隔)。 */
  onToolBatchEnd?: () => void;
  /** 无回复提示(模型既无文本也无工具调用)。 */
  onNoReply?: () => void;
  /** 达到最大步数提示。 */
  onMaxSteps?: () => void;
  /** 中断还原:停 spinner + 补换行 + (已中断)提示 + history 还原 + 模式还原。 */
  onAbort?: () => void;
  /** 跑完(正常/达上限)在回复末尾打耗时摘要行;中断不调。
   *  usage 是本轮 chat 调用累计的 token 用量(未开启 include_usage 或全失败时为 undefined)。 */
  onDone?: (elapsedMs: number, usage?: ChatUsage) => void;
}

/** runAgentCore 的运行选项。 */
export interface AgentRunOptions {
  history: ChatMessage[];
  /** 纯文本字符串,或多模态 parts 数组(OpenAI content 数组,text + image_url)。 */
  userInput: string | ContentPart[];
  signal?: AbortSignal;
  /** 每步 chat() 返回后回调:repl 据此重算并重画状态行 context 用量条。 */
  onContextUpdate?: () => void;
  hooks: AgentHooks;
  /** 步数上限;缺省 = config.maxSteps。子 agent 可传更低值。 */
  maxSteps?: number;
  /** 工具 schema 覆盖。子 agent 可传受限子集；未传时由 toolPolicy 或旧模式工具表提供。 */
  toolsOverride?: OpenAI.Chat.Completions.ChatCompletionTool[];
  /**
   * 当前用户 turn 独享的版本化工具策略。每个模型 step 捕获不可变 snapshot；执行中扩容
   * 只影响下一 step，确保发送给模型的 schema 与运行时 backstop 始终同源。
   */
  toolPolicy?: ToolPolicyController;
  /** Host 侧本轮初始路由决策；core 用自己的 session/turn id 写入统一 trace。 */
  initialToolRoute?: Record<string, unknown>;
  /**
   * 父 Agent 授予的工具上限。子 Agent/skill 只能与自己的 schema 求交，不能借由全局工具表扩权。
   */
  runtimeAllowedToolNames?: ReadonlySet<string>;
  /** 本 agent 独享的上下文统计状态；缺省为主 agent 全局 contextState。 */
  contextState?: ContextState;
  /**
   * 运行时依赖注入(Context 参数化,2.0 步骤1):覆盖 config / agentMode / sessionId /
   * token 校准 / notes mtime 等模块级单例的来源。缺省 = defaultAgentRuntimeContext
   * (原样绑定全局单例,行为与改造前完全一致)。宿主(子 agent / stdio host / 未来
   * 多 runtime)可注入自定义实现,在同一进程内获得互不干扰的运行时视图。
   */
  runtimeContext?: AgentRuntimeContext;
  /**
   * 可选的宿主交互桥：桌面端可将高风险工具的确认请求交给图形界面处理。
   * 未传时保持原有 TUI / 非交互 fail-closed 行为。
   */
  permissionPrompt?: import('../permissions/index.js').PermissionCheckOptions['prompt'];
  /** 每轮结束的兼容汇总 sink。 */
  onTrace?: (trace: AgentTurnTrace) => void;
  /** 逐事件黑匣子 sink；写入失败不得影响 Agent。 */
  onTraceEvent?: (event: AgentTraceEvent) => void;
  /** EVAL/嵌入方可提供稳定 ID；主进程默认读取当前 session/rollback turn。 */
  traceContext?: { sessionId?: string; turnId?: number };
  /** Structured observer used by sub-agent coordinators to build read/write provenance. */
  onToolOutcome?: (tool: string, args: Record<string, unknown>, outcome: ToolOutcome) => void;
  /** 子代理传 true:不注入「开场分析」动态段(该指令仅用于主线面对用户的首次响应)。 */
  suppressOpeningAnalysis?: boolean;
  /**
   * 子代理传 true:不注入主会话的「会话状态」提醒(活跃 plan + 笔记正文)。
   * 子 worker 的系统提示本就用 buildMocodeCorePrompt() 切掉了会话私有尾段(见 spawn.ts),
   * 且其工具表排除 plan_update(不应改动主计划);若把主会话 plan/笔记灌进去,
   * 窄 worker 会被无关上下文干扰,也白付这部分 token。
   */
  suppressSessionState?: boolean;
}

/** OpenAI content array 的子集(text + image_url);repl 构造 user 多模态消息用。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

/** Why the agent loop stopped. */
export type AgentTerminationReason = 'completed' | 'aborted' | 'max_steps';

/** runAgentCore 的运行结果。 */
export interface AgentRunResult {
  /** 只有生成最终回复时为 true；达到步数上限始终为 false。 */
  completed: boolean;
  terminationReason: AgentTerminationReason;
  /** 最终 assistant 文本回复(content);无回复或中断为 null。 */
  finalText: string | null;
  /** 本轮累计 token 用量(各 chat 步 prompt+completion 之和);后端不开 include_usage 或全失败则 undefined。 */
  usage?: ChatUsage;
  /** rollback 事务观察到的本轮实际磁盘变化。 */
  changedFiles?: string[];
}

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
export async function runAgentCore(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { history, userInput, signal, onContextUpdate, hooks } = opts;
  const ctx: AgentRuntimeContext = opts.runtimeContext ?? defaultAgentRuntimeContext;
  const runtimeContextState = opts.contextState ?? contextState;
  /** 本轮 ask_human 成功调用次数，仅用于 trace 观测，不影响工具执行或模型上下文。 */
  let askHumanCountThisTurn = 0;
  const maxSteps = opts.maxSteps ?? ctx.config.maxSteps;
  // 中断还原:repl 的 /plan / /auto / Shift+Tab 等用户面触发 setAgentMode 中途切了模式,
  // abort 时连同模式一起还原回轮首。模型不再持有 switch_mode 工具,无法自切。
  const savedMode = ctx.getAgentMode();
  // 本轮计时:从入口到完毕(正常 return / 达上限),供 finally 打 ✻ Worked for 摘要行。
  const t0 = Date.now();
  // trace / token-usage 状态聚合(2.0 步骤2 深拆第一刀):emit/addUsage/turnUsage 收敛进
  // TurnTraceState,事件 payload 与 hooks 序列保持字节级不变。
  const traceState = new TurnTraceState({
    sessionId: opts.traceContext?.sessionId ?? ctx.getCurrentSessionId() ?? `ephemeral-${process.pid}`,
    turnId: opts.traceContext?.turnId ?? ctx.getCurrentTurnId(),
    onTraceEvent: opts.onTraceEvent,
  });
  const traceSessionId = traceState.sessionId;
  const traceTurnId = traceState.turnId;
  const emitTrace = (
    type: TraceEventType,
    data: Record<string, unknown> = {},
    ids: Partial<Pick<AgentTraceEvent, 'step' | 'stepId' | 'toolCallId' | 'providerToolCallId'>> = {},
  ): void => traceState.emit(type, data, ids);
  emitTrace('turn_start', { mode: ctx.getAgentMode() });
  if (opts.initialToolRoute) emitTrace('tool_route', opts.initialToolRoute);
  let done = false; // 正常完毕 / 达上限 true;中断 false(不显摘要)
  let traceStatus: AgentTurnTrace['status'] = 'error';
  // A+B(plan 可靠性):跨步计数"执行了工具但没改动 notes.md"的连续步数。
  // 本步写了 notes.md(plan_update 或直接 write/edit)→ 清零并重同步 history[0];
  // 否则累计,达阈值则在当前步 tool_result 前注入 nag 提醒。
  let stepsSincePlanTouch = 0;
  // 本轮 token 累计在 traceState.turnUsage(每步 chat() 返回后 addUsage),供 onDone 摘要行 + AgentRunResult.usage
  // 透传给 repl(显示在底栏模式 chip 右边)。未开启 include_usage 或全失败时为 undefined。
  // 实时 chip ↻ 估算用:上一步 chat 实测 prompt(前缀缓存下当前步命中 ≈ 它)+ 后端是否报过 cache 命中
  // (从不报 cache 的后端不估算,避免虚显 ↻)。
  let lastStepPromptTokens = 0;
  let providerCacheSeen = false;
  history.push({ role: 'user', content: userInput });
  // 中断回滚快照:push 用户消息后整段浅拷贝。abort 时 length=0;push(...saved) 还原。
  // 这样中断时至少保留用户消息(及之前的历史);每步工具全部执行完毕后刷新快照,
  // 保留已完成的 assistant+tool_calls+tool 结果,只丢弃当前未完成步骤的消息。
  // 用 slice() 而非 length:maybeCompact 会原地重建(length=0;push(...rebuilt)),savedLen 会失效。
  let savedHistory = history.slice();
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
    ctx.config.contextBudget !== false ? createBudgetScheduler(runtimeContextState) : null;
  // 本轮流式状态:首个正文 token 到达即停 spinner(思考期间 spinner 持续转「思考中…」,不写思考内容)。
  let mode: 'idle' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';

  const onText = (s: string) => {
    hooks.onText?.(s); // 主 agent:走 markdown 渲染写内容区
    mode = 'text';
    gotText = true;
    if (s) lastChar = s[s.length - 1];
  };

  const onToolCall = (name: string) => {
    // 文本/思考已流完,模型转而生成 tool_call 参数(可能很长,如 write_file 整篇内容):
    // 补换行(让随后的 ● 行与 diff 不黏在正文末尾)+ 启「生成中」内联 spinner,内容区不再干等。
    if (lastChar && lastChar !== '\n') {
      hooks.onTextEnd?.(); // 主 agent:layout.contentWrite('\n')
      lastChar = '\n';
    }
    hooks.onToolCall?.(name); // 主 agent:spinner.start(`生成 ${name}…`)
  };

  // 中断还原:停 spinner + 补换行 + (已中断)提示 + history 还原到本 turn 前 + 模式还原。
  // 两处共用:① await chat() 抛 AbortError 的 catch;② 工具被 abort 杀后循环顶检查。
  // 实现已收敛进 TurnTraceState.abortRestore;savedHistory/savedMode 是函数级 let,此处闭包现读。
  const abortRestore = (): void => traceState.abortRestore({ hooks, history, savedHistory, ctx, savedMode });
  try {
    for (let step = 0; step < maxSteps; step++) {
      traceState.currentTraceStep = step;
      const stepStartedAt = Date.now();
      emitTrace('step_start', { ordinal: step });
      try {
        // 上一步工具被 abort 杀(run_command/web_fetch 等)→ signal.aborted,直接还原退出,不等 maybeCompact + chat()
        if (signal?.aborted) {
          abortRestore();
          traceStatus = 'aborted';
          return traceState.buildAbortedResult(ctx.getCurrentTurnMutationState());
        }
        // 本步只捕获一次不可变 policy snapshot。即便 add_tool_groups 在执行阶段扩容，
        // 本次模型响应仍必须按旧 snapshot 校验；新工具只在下一 step 的 schema 中出现。
        const planMode = ctx.getAgentMode() === 'plan';
        const policySnapshot = opts.toolPolicy?.snapshot(planMode);
        const configuredTools = opts.toolsOverride ?? policySnapshot?.tools ?? (planMode ? planChatTools : chatTools);
        const policyAllowedTools = opts.runtimeAllowedToolNames
          ? configuredTools.filter((tool) => opts.runtimeAllowedToolNames?.has(tool.function.name))
          : configuredTools;
        const skillDisabledTools = getSkillRuntimeDisabledTools();
        const legacyDisabledTools =
          opts.toolPolicy || opts.runtimeAllowedToolNames ? new Set<string>() : getRuntimeDisabledTools();
        // schema、runtime backstop 与后代权限都从同一 effective allow-list 派生。
        // policy snapshot 是本 step 的不可扩张上限；skill deny 可在同批 use_skill 后继续动态收窄。
        const activeTools = policyAllowedTools.filter(
          (tool) => !skillDisabledTools.has(tool.function.name) && !legacyDisabledTools.has(tool.function.name),
        );
        const stepAllowedNames = new Set(activeTools.map((tool) => tool.function.name));
        const currentAllowedToolNames = (): string[] => {
          const currentSkillDisabledTools = getSkillRuntimeDisabledTools();
          return [...stepAllowedNames].filter((name) => !currentSkillDisabledTools.has(name));
        };
        const isToolDeniedForStep = (name: string): boolean =>
          !stepAllowedNames.has(name) || getSkillRuntimeDisabledTools().has(name);
        const requestBaseURL = ctx.config.baseURL;
        const requestModel = ctx.getActiveModel();
        const storedCalibration = ctx.getTokenCalibration(requestBaseURL, requestModel, activeTools);
        runtimeContextState.correction = storedCalibration.correction;
        runtimeContextState.calibrationSamples = storedCalibration.samples;

        // 会话状态(活跃 plan + 笔记正文)在调度器**之前**取一次:
        //  ① 它会被追加到本次请求末尾(见下方 ephemeralReminder),属于本步固定开销,
        //     必须计入压力线——它不在 history 里,调度器只能由此入参看见(否则最多 5k
        //     的笔记 + plan 段对 80% 触发线完全不可见,小窗口模型会压不住);
        //  ② 压缩步在压缩成功后重取(P2 固结的 Compaction Snapshot 当步即可见)。
        let sessionStateText = opts.suppressSessionState ? '' : ctx.buildSessionStateReminder();

        // The scheduler is the only automatic path that may compress old evidence.
        // Normal tool pushes and lifecycle tracking remain metadata-only.

        // 压缩**之前**先刷一次状态栏:bar 要显示「本步真实 prompt 撞线」那一刻。
        // 触发器算的就是 history + 工具 schema + 本段 sessionStateText,此刻三者都已就位,
        // bar 与触发器完全同口径同一步。若等压缩跑完再刷,那 30+ 秒的 LLM 摘要调用里
        // bar 一直冻在上一步的值,用户只看到「75% 怎么就压了」。
        runtimeContextState.ephemeralText = sessionStateText || undefined;
        onContextUpdate?.();

        // 步前:五区 Budget Scheduler 在当前完整 history 上决策；开关关闭时退化回 maybeCompact 路径。
        // 此时 spinner 已停,通知行干净。
        let historyRebuilt = false;
        /** 本步是否已因「后端报上下文超长」压过一轮(限一次,防压缩↔重试死循环)。 */
        let overflowRetried = false;
        const compactStartedAt = Date.now();
        if (scheduler) {
          historyRebuilt = await scheduler.runStep(
            history,
            step,
            activeTools,
            sessionStateText ? estimateTokens(sessionStateText) : 0,
            // signal 透传:压缩的 LLM 摘要是几十秒的调用,不串进来 Ctrl+C 掐不断。
            signal,
          );
          if (scheduler.lastRunLog?.compactHistoryCalled) {
            emitTrace('compact', {
              source: 'automatic',
              reason: 'scheduled',
              historyRebuilt,
              durationMs: Date.now() - compactStartedAt,
            });
          }
        } else {
          const compactResult = await maybeCompact(
            history,
            undefined,
            undefined,
            runtimeContextState,
            activeTools,
            signal,
          );
          historyRebuilt = compactResult?.historyRebuilt === true;
          if (compactResult) {
            emitTrace('compact', {
              source: 'automatic_fallback',
              reason: compactResult.reason,
              compacted: compactResult.compacted,
              historyRebuilt,
              estimateBefore: compactResult.estimateBefore,
              estimateAfter: compactResult.estimateAfter,
              durationMs: Date.now() - compactStartedAt,
            });
          }
        }
        // compact 用新消息数组原地重建 history 后，所有按消息位置恢复的状态都需重建。
        if (historyRebuilt) {
          if (lifecycle) {
            lifecycle = createLifecycleEngine(history);
            runtimeContextState.lifecycleStats = lifecycle.stats();
          }
          rehydrateArtifacts(runtimeContextState, history);
          // 压缩可能刚把进度快照固结进 notes.md(P2)→ 重取,让本步 requestHistory
          // 末尾就带上最新 Compaction Snapshot,不必等下一步。bar 口径对应的
          // ephemeralText 仍用触发时旧值(见 buildRequestHistory 注释),仅差这一段。
          if (!opts.suppressSessionState) sessionStateText = ctx.buildSessionStateReminder();
          // 会话状态(活跃 plan + 笔记段)不再回写 history[0]:每步都会在 requestHistory
          // 末尾注入最新副本(见下方 ephemeralReminder),compact 后自然恢复。
        }
        hooks.onStepStart?.(); // 主 agent:spinner.start('思考中')
        mode = 'idle';
        gotText = false;
        lastChar = '';
        let result: ChatResult;
        const modelStartedAt = Date.now();
        const provider = ctx.safeProviderId(requestBaseURL);
        emitTrace('model_start', { model: requestModel, provider });
        // 动态注入(prompt 缓存关键):所有随步/随文件变化的提示统一拼成**历史末尾**一条
        // ephemeral system 消息,不再改写 history[0]。这样系统提示 + 已有对话逐字节稳定,
        // 支持自动前缀缓存的后端(OpenAI / DeepSeek / GLM / Qwen)可从头命中,只有尾部这
        // 一小条随内容变化;若改写 history[0],单次 plan_update 就会让 6-8k 的系统提示
        // 在本轮后续每步全价重算。
        //  - 开场分析:仅主线(step===0 且 !suppressOpeningAnalysis)——用户发任务后 agent
        //    的第一次模型调用。子代理经 spawn.ts 传 suppressOpeningAnalysis:true 排除。
        //    放在尾部还有额外好处:step 0 与 step 1 的前缀不再因这段的出现/消失而错位。
        //  - historyRebuilt:compact 恢复步,要求重新锚定目标。
        //  - 会话状态:notes.md 的活跃 plan + 笔记正文(纯读,每步重取,始终最新)。
        //  .filter(Boolean) 保证空段不产生多余空行;三段全空时不追加任何消息(requestHistory === history)。
        //  安全保证:只拼进 requestHistory(新建数组),绝不写回 history,故不会跨 step/跨 turn 残留。
        // 抽成函数:后端报上下文超长时压缩后要按新 history 重建一次(见下方 catch)。
        // 不写 contextState.ephemeralText:bar 用的是触发器同口径的 sessionStateText
        // (步骤顶部已设),而本函数还会额外拼 opening / post-compact 段——那两段触发器
        // 不计,让 bar 用会让两条线再错开几百 token。
        const buildRequestHistory = (): ChatMessage[] => {
          const ephemeralReminder = [
            opts.toolPolicy?.reminder(planMode) ?? '',
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
            sessionStateText, // 调度器之前已取(并计入压力线),此处复用同一份,不重复读文件
          ]
            .filter(Boolean)
            .join('\n\n');
          return ephemeralReminder
            ? [...history, { role: 'system', content: ephemeralReminder } as ChatMessage]
            : history;
        };
        let requestHistory: ChatMessage[] = buildRequestHistory();
        // 再刷一次:压缩刚跑完(history 已重建),bar 从「撞线 82%」跳到「压后 62%」,
        // 让用户看到压缩确实起了作用。撞线那一刻的刷新在步骤顶部(trigger 之前),
        // 那一次才是解释「为什么要压」的。
        onContextUpdate?.();

        // 实时用量:当前步 prompt 估算(含校准系数)+ 流式累计 completion 估算,
        // 叠上已完成步的实测 turnUsage(traceState 内累加,每次调用读最新值),经 onLiveUsage 推给底栏实时 chip。
        let stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
        const reportLive = (p: { completionTokens: number; promptTokens?: number; cachedTokens?: number }): void =>
          traceState.reportLive(hooks, stepPromptEst, lastStepPromptTokens, providerCacheSeen, p);
        reportLive({ completionTokens: 0 }); // 思考阶段先显 ↑ prompt 估算,首 token 到达后 ↓ 开始涨
        // 单一 chat 入口:错误侧的 model_end 埋点只写一处(重试也会记,不丢失败轨迹)。
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
            return await chat(requestHistory, chatHandlers, signal, activeTools);
          } catch (err) {
            const errorValue =
              err && typeof err === 'object' ? (err as { status?: number; code?: string; name?: string }) : undefined;
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
            throw err;
          }
        };
        try {
          result = await runChatOnce();
        } catch (e) {
          // 中断(用户运行中 Ctrl+C):chat() 抛 AbortError(signal.aborted)→ 还原 history + 模式 + return(不抛)。
          // 工具执行现已串 signal:run_command/web_fetch 被 abort 即时杀,循环顶检查兜底(不会留未配对 tool_call_id)。
          if (signal?.aborted || (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError'))) {
            abortRestore();
            traceStatus = 'aborted';
            return traceState.buildAbortedResult(ctx.getCurrentTurnMutationState());
          }
          // 后端实测拒绝了 prompt(上下文超长):本地估算对该 provider 系统性偏低时,
          // 压力线压不住,这是唯一可信的触发。强压一轮后重试一次;仍失败才抛(限一次,防循环)。
          if (!overflowRetried && isContextLengthError(e)) {
            overflowRetried = true;
            // 估算被后端证伪:raw×correction 明明在压力线以下,真实 prompt 却超了窗。
            // 用「实测 = 窗口」这个下限样本喂校准,让压力线对这家 provider 立刻变严——
            // 否则每一步都要等后端报错才压,而不是提前压。EWMA α=0.2 + [0.5,2] 夹逼,
            // 偶发误判会被后续真实 usage 样本拉回。
            const rawEstimate = estimatePromptTokens(requestHistory, activeTools);
            if (rawEstimate > 1_000) {
              const cal = ctx.updateTokenCalibration(
                requestBaseURL,
                requestModel,
                activeTools,
                rawEstimate,
                ctx.config.contextWindowTokens,
              );
              runtimeContextState.correction = cal.correction;
              runtimeContextState.calibrationSamples = cal.samples;
            }
            const overflowResult = await maybeCompact(
              history,
              undefined,
              { manual: true, force: true },
              runtimeContextState,
              activeTools,
              signal,
            );
            emitTrace('compact', {
              source: 'overflow_retry',
              reason: overflowResult?.reason ?? 'noop',
              compacted: overflowResult?.compacted === true,
              estimateBefore: overflowResult?.estimateBefore,
              estimateAfter: overflowResult?.estimateAfter,
              durationMs: Date.now() - modelStartedAt,
            });
            if (!overflowResult?.compacted) throw e; // 压不动:没法救,原样抛
            if (overflowResult.historyRebuilt) {
              historyRebuilt = true;
              if (lifecycle) {
                lifecycle = createLifecycleEngine(history);
                runtimeContextState.lifecycleStats = lifecycle.stats();
              }
              rehydrateArtifacts(runtimeContextState, history);
            }
            requestHistory = buildRequestHistory();
            stepPromptEst = estimatePromptTokens(requestHistory, activeTools, runtimeContextState.correction);
            result = await runChatOnce(); // 仍超长 → 抛出,交给上层报错
          } else {
            throw e;
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
        runtimeContextState.lastUsage = result.usage; // 供 /context 与状态行显示实测 token
        traceState.addUsage(result.usage); // 本轮累计:onDone 摘要行 + AgentRunResult.usage 透传
        if (result.usage) {
          lastStepPromptTokens = result.usage.promptTokens; // 下一步流式期 ↻ 估算的前缀基准
          if (result.usage.cachedTokens > 0) providerCacheSeen = true;
        }
        // 用本次实际发送的 tools 计算分母，再以 EWMA 更新 provider/model/tool-set 校准。
        // 只持久化比例与样本数；无 usage 或短 prompt 时保持既有值。
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
        hooks.onChatDone?.(); // 主 agent:spinner.stop()
        // lastUsage 已更新:触发状态行 context 用量条重算+重画,运行中不再冻结在轮首。
        onContextUpdate?.();

        if (result.toolCalls.length > 0) {
          traceState.toolCallCount += result.toolCalls.length;
          // 若 content 只是 Claude 式 "Tool results:" 噪声，清空它：不补换行、不写入 history，
          // 避免污染后续轮次上下文并在 TUI 泄露为孤立行。
          if (result.content && isToolResultsNoise(result.content)) {
            result.content = null;
            mode = 'idle';
            gotText = false;
            lastChar = '';
          }
          // 流式正文末尾补换行(若 onToolCall 已补则 lastChar='\n',此处 no-op);防 ● 行黏在正文行尾
          if (mode !== 'idle' && lastChar !== '\n') hooks.onTextEnd?.();
          // 带工具调用的 assistant 消息原样回灌(OpenAI 格式要求)
          history.push({
            role: 'assistant',
            content: result.content,
            tool_calls: result.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          } as ChatMessage);
          // A+B:记录本步第一条 tool_result 的下标 + 执行前 notes.md 的 mtime,
          // 工具全部执行完后据此判断"本步是否改动了 notes.md"(重同步 / nag)。
          const toolResultStartIdx = history.length;
          const notesMtimeBefore = ctx.getNotesMtime();

          // Record interstitial narration for observability only. It never changes tool output
          // or injects instructions back into the model context.
          const narration = result.content?.trim() ?? '';
          if (narration) {
            emitTrace('narration', {
              chars: [...narration].length,
              toolCalls: result.toolCalls.length,
              step,
            });
          }

          // 工具分组执行(保 tool_calls 原顺序)：safe parallel 工具照常并发；连续
          // resource-locked mutation 先按序完成权限预检，再按 canonical resource lock 启动。
          // registry 对所有真实资源访问统一持锁，所以不同 Agent 间的 read/write/process 也不会竞态。
          // 串行工具仍是本调用列表内的屏障；渲染/history 回灌始终按原 tool_calls 顺序。
          // executeToolOutcome 永不抛错，失败通过结构化 status/code 返回。
          const calls = result.toolCalls;
          const modelAttachments: NonNullable<ToolOutcome['modelAttachments']> = [];
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
              pushToolResult(history, currentCall, error, relprune, lifecycle, scheduler, runtimeContextState, false);
              traceToolEnd(currentCall, i, outcome);
              i++;
              continue;
            }
            if (isParallelTool(currentCall.name)) {
              // 收集连续只读组(≥1),并发执行:先渲染所有 header，再一次性启动所有
              // (executeTool 调用即开始 I/O)，最后按原顺序逐个 await + 回灌。
              // 必须先 header 后 execute：grep 等同步快速工具会在 executeTool 返回 Promise 前
              // 已经完成；若先 started.map，用户只能在工具完成后才看到摘要与其前面的换行。
              // 异步工具(web_fetch 等)并发跑、总耗时 ≈ 最慢一个;同步工具(glob/grep)map 时已顺序跑完,await 即返。
              let j = i;
              while (j < calls.length && isParallelTool(calls[j].name) && !isToolDeniedForStep(calls[j].name)) j++;
              const batch = calls.slice(i, j);
              for (const tc of batch) hooks.onToolHeader?.(tc);
              hooks.onToolStart?.(batch[0].name);
              const started = batch.map((tc) =>
                executeToolOutcome(tc.name, tc.arguments, signal, {
                  callId: tc.id,
                  allowedToolNames: currentAllowedToolNames(),
                }),
              );
              for (let k = 0; k < batch.length; k++) {
                const tc = batch[k];
                const outcome = await started[k];
                traceState.addUsage(outcome.usage);
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
              isResourceLockedCall(currentCall) &&
              !(ctx.getAgentMode() === 'plan' && getPlanDisabledTools().has(currentCall.name))
            ) {
              // 连续文件 mutation：权限确认仍严格按原序进行；全部 preflight 完成后再启动。
              // 每个执行在 registry 内按 canonical path 获取锁，不同文件可并发，同文件别名会排队。
              let j = i;
              while (
                j < calls.length &&
                isResourceLockedCall(calls[j]) &&
                !isToolDeniedForStep(calls[j].name) &&
                !(ctx.getAgentMode() === 'plan' && getPlanDisabledTools().has(calls[j].name))
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
                const tool = findTool(tc.name);
                const argumentsValid = tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
                let denied: ToolOutcome | undefined;
                if (tool && argumentsValid) {
                  const perm = await checkPermission(tool, parsed ?? {}, signal, {
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
                return executeToolOutcome(entry.tc.name, entry.tc.arguments, signal, {
                  callId: entry.tc.id,
                  allowedToolNames: currentAllowedToolNames(),
                  ...(hint ? { argumentErrorHint: hint } : {}),
                  onLockAcquired: (lockedArgs) => {
                    entry.diff = readDiffContext(entry.tc, lockedArgs);
                  },
                });
              });

              for (let k = 0; k < entries.length; k++) {
                const entry = entries[k];
                const outcome = await started[k];
                traceState.addUsage(outcome.usage);
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
                const invalidatedFiles = [...new Set([...(outcome.changedFiles ?? []), ...(outcome.staleFiles ?? [])])];
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
              if (ctx.getAgentMode() === 'plan' && getPlanDisabledTools().has(tc.name)) {
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
              const tool = findTool(tc.name);
              const argumentsValid = tool && parsed !== null ? validateToolArguments(tool, parsed).valid : false;
              if (tool && argumentsValid) {
                const perm = await checkPermission(tool, parsed ?? {}, signal, {
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
              const mutationParsed = isMutationTool(tc.name) ? parsed : null;
              let diff = readDiffContext(tc, mutationParsed);
              hooks.onToolStart?.(tc.name);
              const serialHint = argumentErrorHint(tc.name, runtimeContextState);
              const outcome = await executeToolOutcome(tc.name, tc.arguments, signal, {
                callId: tc.id,
                allowedToolNames: currentAllowedToolNames(),
                ...(serialHint ? { argumentErrorHint: serialHint } : {}),
                onLockAcquired: (lockedArgs) => {
                  if (mutationParsed) diff = readDiffContext(tc, lockedArgs);
                },
              });
              traceState.addUsage(outcome.usage);
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
              const invalidatedFiles = [...new Set([...(outcome.changedFiles ?? []), ...(outcome.staleFiles ?? [])])];
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
          // A(计划触碰计数):本步若改动了 notes.md 则清零计数。会话状态本身无需在此重注入——
          // 每步都会由 buildSessionStateReminder() 在 requestHistory 末尾重建最新副本(见上方注入点),
          // 所以模型下一步看到的必然是当前勾选态。只保留计数,避免多余的 history 改写(prompt 缓存)。
          // B(nag 提醒):连续 N 步有工具活动但没更新 plan,在当前步第一条 tool_result 前注入提醒。
          const notesMtimeAfter = ctx.getNotesMtime();
          if (notesMtimeAfter !== notesMtimeBefore) {
            stepsSincePlanTouch = 0;
          } else {
            stepsSincePlanTouch += 1;
            if (stepsSincePlanTouch >= PLAN_NAG_THRESHOLD) {
              const activePlan = ctx.extractActivePlanSection();
              const firstToolMsg = history[toolResultStartIdx];
              if (
                activePlan &&
                firstToolMsg &&
                firstToolMsg.role === 'tool' &&
                typeof firstToolMsg.content === 'string'
              ) {
                firstToolMsg.content = `${PLAN_NAG_TEXT}\n\n${firstToolMsg.content}`;
              }
              stepsSincePlanTouch = 0;
            }
          }

          if (modelAttachments.length > 0) {
            const names = modelAttachments.map((attachment) => attachment.name).join(', ');
            const content: ContentPart[] = [
              {
                type: 'text',
                text: `The view_image tool loaded the following visual input: ${names}. Analyze the attached image content directly.`,
              },
              ...modelAttachments.map(
                (attachment): ContentPart => ({
                  type: 'image_url',
                  image_url: {
                    url: attachment.dataUrl,
                    // 不默认补 auto: OpenAI 省略时等同 auto，但 MiniMax 仅接受 low/default/high。
                    // 让各 provider 采用默认枚举；仅保留工具明确请求的 low/high。
                    ...(attachment.detail === 'low' || attachment.detail === 'high'
                      ? { detail: attachment.detail }
                      : {}),
                  },
                }),
              ),
            ];
            // OpenAI tool-call protocol requires every tool result to immediately follow the
            // assistant tool_calls message; append visual input only after the full batch.
            history.push({ role: 'user', content } as ChatMessage);
          }
          // 工具步末尾补一空行:与下一轮的思考 / 正文分隔(否则 ↳ 后紧接 ▎ 思考,无空行不好看;
          // 与正文→● 的 1 空行对称)。工具结果已以 \n 收尾,此处再补 \n 恰好 1 空行。
          hooks.onToolBatchEnd?.();
          // 刷新中断快照:工具全部执行完毕后,history 处于一致状态(assistant+tool_calls+tool 结果完整),
          // 此时中断可安全保留这些已完成的消息,只丢弃下一轮未完成的 chat() 响应。
          savedHistory = history.slice();
          continue; // 带着工具结果再调一次 LLM
        }

        if (mode !== 'idle' && lastChar !== '\n') hooks.onTextEnd?.(); // 流式末尾补换行

        // 没有工具调用：接受 agent 的完成判断。框架不自动运行测试、构建或完成门，
        // 也不因缺少验证证据强制追加模型轮次；agent 仍可自行调用工具验证。
        if (!gotText) hooks.onNoReply?.();
        history.push({ role: 'assistant', content: result.content } as ChatMessage);

        const finalMutation = ctx.getCurrentTurnMutationState();
        done = true;
        traceStatus = 'completed';
        return {
          completed: true,
          terminationReason: 'completed',
          finalText: result.content,
          usage: traceState.turnUsage,
          changedFiles: finalMutation.changedFiles.map((item) => item.path),
        };
      } finally {
        emitTrace('step_end', {
          durationMs: Date.now() - stepStartedAt,
          aborted: signal?.aborted === true,
        });
      }
    }

    hooks.onMaxSteps?.();
    done = true;
    traceStatus = 'max_steps';
    const finalMutation = ctx.getCurrentTurnMutationState();
    return {
      completed: false,
      terminationReason: 'max_steps',
      finalText: null,
      usage: traceState.turnUsage,
      changedFiles: finalMutation.changedFiles.map((item) => item.path),
    };
  } finally {
    const finalMutation = ctx.getCurrentTurnMutationState();
    traceState.currentTraceStep = undefined;
    emitTrace('turn_end', {
      status: traceStatus,
      durationMs: Date.now() - t0,
      toolCalls: traceState.toolCallCount,
      changedFiles: finalMutation.changedFiles.map((item) => item.path),
      totalTokens: traceState.turnUsage?.totalTokens,
    });
    try {
      opts.onTrace?.({
        ts: new Date().toISOString(),
        sessionId: traceSessionId,
        turnId: traceTurnId,
        status: traceStatus,
        durationMs: Date.now() - t0,
        toolCalls: traceState.toolCallCount,
        changedFiles: finalMutation.changedFiles.map((item) => item.path),
        usage: traceState.turnUsage,
      });
    } catch {
      // Trace is best-effort and must not change the turn result.
    }
    // 跑完(正常 / 达上限)在回复末尾打耗时摘要行;中断 done=false 不打。
    if (done) {
      hooks.onDone?.(Date.now() - t0, traceState.turnUsage);
    }
  }
}

// ── 导出共享辅助(主 agent 的 TUI hooks 实现要用)──────────────────────────
export { parseArgs, readDiffContext, isMutationTool, isParallelTool };
