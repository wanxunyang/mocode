import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { type AgentHooks, type ContentPart } from '../agent/core.js';
import { createRuntime, type Runtime } from '../runtime/index.js';
import { config, isMemoryEnabled } from '../config/index.js';
import { type ChatMessage } from '../llm/index.js';
import { measureContextUsage } from '../context/usage-snapshot.js';
import { initializeAllMcp, getMcpTools, getMcpWarnings, closeAllMcp } from '../mcp/index.js';
import {
  appendCurrentSessionTraceEvent,
  createContextState,
  SessionStore,
  type SessionMeta,
} from '../session/index.js';
import { registerWorkspace, readWorkspaceRegistry } from '../workspace/registry.js';
import { clearSkillActivation } from '../skills/activation.js';
import { buildSystemMessage } from '../prompt/system-prompt.js';
import {
  buildMemoryTailSection,
  buildTurnRecallSection,
  captureMemoryBaseline,
  gcMemories,
  initPersona,
  isTurnRecallEnabled,
  memoryTailChangedIds,
} from '../memory/index.js';
import { ToolPolicyController } from '../tools/policy.js';
import { routeToolGroups } from '../tools/router.js';
import type { ToolRouteGroupName } from '../config/profiles.js';
// 装配官方默认工具包:registry 不再顶层 import builtins(破模块循环),host 入口须显式装配。
import '../tools/builtins/index.js';
import type { InterventionRequest, InterventionResult } from '../ui/intervention.js';
import { setAskHumanHandler } from '../tools/builtins/ask-human.js';
import { HOST_PROTOCOL_VERSION, parseCommand, type HostCommand, type HostEnvelope } from './protocol.js';
// ── 面板数据源（会话 / 回滚 / 改动 / 用量 / 记忆 / 设置）──
// 这些在 terminal 里各是一个斜杠命令，命令体本身是 ui/layout 渲染 + 数据拼装两段；
// host 只取「拼装」那一半：数据从同一批 core 函数来，渲染交给 GUI。
import { readGlobalUsage, summarizeGlobalUsage } from '../session/global-usage.js';
import { summarizeUsage } from '../session/usage-stats.js';
import { unifiedFileDiff } from '../changeset/unified-diff.js';
import type { Snapshot } from '../rollback/index.js';
import {
  buildMemoryHealth,
  forgetEntry,
  formatMemoryHealth,
  invalidateEdge,
  inspectPrimaryProfile,
  isMemoryWritesPaused,
  kickoffReflection,
  listInternalizedProfile,
  listProfileCandidates,
  loadAll,
  promoteEdge,
  readAudit,
  searchEntries,
  snapshotTranscript,
} from '../memory/index.js';
import { readRecallStats } from '../memory/recall-stats.js';
import {
  getActiveEffort,
  isComputerUseEnabled,
  isFrontendToolsEnabled,
  isSubAgentEnabled,
  isToolRoutingEnabled,
  updateComputerUseConfig,
  updateFrontendToolsConfig,
  updateMemoryConfig,
  updateModelConfig,
  updateSubAgentConfig,
  updateToolRoutingEnabled,
} from '../config/index.js';
import { parseReasoningEffort } from '../llm/reasoning.js';
import { writeConfigKeys } from '../config/file.js';

interface ApprovalWaiter {
  resolve: (result: InterventionResult) => void;
  runId: string;
}

let initialized: Promise<void> | null = null;
let runtimeFacade: Runtime | null = null;
let activeRun: { id: string; controller: AbortController } | null = null;
let closing = false;
const hostClosedReason = new DOMException('Host input closed.', 'AbortError');
const shutdownController = new AbortController();
let sessionId = '';
let history: ChatMessage[] = [];
let queryHistory: string[] = [];
let lastToolGroups: ToolRouteGroupName[] = [];
let contextState = createContextState();
const approvals = new Map<string, ApprovalWaiter>();

function runtime(): Runtime {
  if (!runtimeFacade) throw new Error('Runtime is not initialized.');
  return runtimeFacade;
}

function write(envelope: HostEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
function emit(event: string, payload: Record<string, unknown> = {}, requestId?: string): void {
  write({ type: 'event', event, payload, requestId });
}
function error(message: string, requestId?: string): void {
  write({ type: 'error', error: message, requestId });
}

/**
 * 转发的「执行前文件内容」上限。
 *
 * write_file 覆盖写时旧内容是 diff 的删除侧，必须让 GUI 看得到改动前的样子；但这份内容要
 * JSON 序列化穿过 stdio + IPC 两跳再进 DOM，几十万字符会把管道和渲染都拖垮。
 * 超限就不转发，GUI 按「全部新增」展示（与终端 replay 路径同策略）。
 */
const MAX_FORWARDED_OLD_BYTES = 200_000;

async function initializeRuntime(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    if (closing) return;
    await initializeAllMcp();
    if (closing) return;
    const createdRuntime = createRuntime({ sandboxRoot: process.cwd(), initialMode: 'auto' });
    runtimeFacade = createdRuntime;
    createdRuntime.context.toolRuntime.registerToolsExtension('mcp', getMcpTools());
    await createdRuntime.start();
    // 登记到全局工作空间注册表：终端每进一个目录都会登记（src/workspace/index.ts），
    // host 以前不登记 —— 于是 work-app 的工作空间在注册表里永远缺席，
    // 「跨工作空间列会话」看不到它，而终端也看不到 work-app 里建的会话。
    registerWorkspace(process.cwd());
    if (closing) return;
    // 启动期身份归一 + 记忆 GC：与 REPL 同序（见 src/repl/runtime.ts 的 startRepl）。
    // 顺序有意义——先归一把画像碎片并入 person-primary，About you 段才渲染得出来；
    // GC 放在归一之后。两者都 best-effort，失败不能拖垮 host 启动。
    initPersona(isMemoryEnabled());
    if (isMemoryEnabled()) {
      try {
        gcMemories();
      } catch {
        /* best-effort */
      }
    }
    // `ask_human` 一律走审批通道转给控制面 —— 不能只在 supervised 模式下注入。
    //
    // 旧代码把注入锁在 `MOCODE_SUPERVISED_WORKER === '1'` 里，注释说「普通 Host 有人盯着面板」，
    // 但普通 Host 压根没有面板：没有 handler 时 ask_human 落到 promptIntervention，
    // 而 host 进程没有 layout，layout.isActive() 为 false，于是走「非 TTY 降级」分支
    // **自动选第一项并当作已答复返回给模型**（src/ui/intervention.ts:113-124）。
    // 结果是模型「问」了、用户从没看见、却已经被答复——最坏情况下选中的是危险选项。
    // 现在两种模式同一条通道，差别只在 who 回答（supervised 由父 agent，普通由 GUI）。
    setAskHumanHandler((request) =>
      waitForApproval(
        activeRun?.id ?? '',
        {
          type: request.options.length > 0 ? 'choice' : 'input',
          title: request.question,
          ...(request.options.length > 0
            ? {
                options: request.options.map((item) => ({
                  label: item.label,
                  ...(item.detail ? { detail: item.detail } : {}),
                })),
              }
            : {}),
          ...(request.context ? { detail: request.context } : {}),
          // 允许控制面在选项之外输入自由文本：ask_human 的常见形态是「给我一个值」，
          // 把用户限制在模型预设的选项里，等于逼他选一个错的。
          allowCustom: true,
        },
        'ask_human',
      ),
    );
    const runtimeConfig = createdRuntime.context.config;
    emit('runtime_ready', {
      // 握手回执里必须带版本：客户端据此判断「我发的新命令它认不认」，而不是靠猜。
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectRoot: createdRuntime.context.sandboxRoot,
      provider: runtimeConfig.provider,
      promptCache: runtimeConfig.provider === 'anthropic' && runtimeConfig.anthropicPromptCache,
      warnings: getMcpWarnings(),
      // Supervised Worker 的控制面靠这两个字段确认「这个 host 是谁、还活着」。
      pid: process.pid,
      ...(process.env.MOCODE_WORKER_ID ? { workerId: process.env.MOCODE_WORKER_ID } : {}),
    });
  })();
  return initialized;
}

/**
 * 当前模式下的系统提示（history[0] 的唯一来源）。
 *
 * 段组合的单一事实源在 src/prompt/system-prompt.ts —— REPL 与 stdio host 走同一个函数。
 * 此前 host 自己拼了一版、漏掉 About you / Memory Index / Episode / graph hint / plan 段，
 * 结果是「记忆开关打开、库也写满了，工作台里的模型却从没见过」。
 * planMode 现读：模式切换要立刻反映在下一步请求的系统提示里。
 */
function currentSystemMessage(): string {
  const planMode = (runtimeFacade?.context.getAgentMode() ?? 'auto') === 'plan';
  return buildSystemMessage({ sessionId, planMode });
}

/** 当前是否 plan 模式（现读，不缓存：切换后下一步请求就要看到）。 */
function isPlanMode(): boolean {
  return (runtimeFacade?.context.getAgentMode() ?? 'auto') === 'plan';
}

/**
 * 切换 agent 模式。与 REPL 的 cycleMode 同语义（src/repl/runtime.ts:534-549）：
 * ① 改模式状态；② 重写 history[0] 的系统提示（plan 段随之出现/消失）；
 * ③ 回 `mode_changed` 让控制面刷新指示。
 *
 * 为什么必须重写 history[0]：system 提示是对话里唯一常驻的指令位，plan 约束写在那里
 * 模型才会在**下一步**就只读；只改状态而提示还停在 auto，模型会继续写文件。
 * 为什么模式只能由用户面触发：模型不该给自己解锁（见 src/agent/mode.ts 的注释）。
 */
function setMode(command: Extract<HostCommand, { type: 'set_mode' }>): void {
  if (closing) return;
  if (!runtimeFacade) {
    // 还没初始化：先记为待生效，启动后再落。这里直接初始化更简单，但会拖慢首条命令；
    // 客户端在 start 后就发 set_mode，initializeRuntime 已在跑，await 它即可。
    void initializeRuntime()
      .then(() => setMode(command))
      .catch(() => undefined);
    return;
  }
  const previous = runtime().context.setAgentMode(command.mode);
  if (sessionId) {
    history[0] = { role: 'system', content: currentSystemMessage() };
  }
  emit('mode_changed', { mode: command.mode, previous }, command.id);
}

/**
 * R18 每轮静默召回段。开关求与的写法与 REPL 一致（src/agent/index.ts 的 runAgent）：
 * 记忆总开关 × 召回子开关。排除 memoryTailChangedIds() —— 那批已由 R17 尾注播报。
 */
function turnRecallFor(prompt: string): string {
  if (!isMemoryEnabled() || !isTurnRecallEnabled()) return '';
  return buildTurnRecallSection(prompt, { excludeIds: memoryTailChangedIds() });
}

function createSession(): void {
  const activeRuntime = runtime();
  sessionId = activeRuntime.session.create();
  // 不在这里重置模式：host 的模式是进程级状态、由控制面通过 set_mode 管理，
  // 新建会话不该顺手把用户刚切的 plan 打回 auto（终端里 /clear 也不改模式）。
  // 首次启动的 auto 由 createRuntime({ initialMode: 'auto' }) 保证。
  history = [{ role: 'system', content: currentSystemMessage() }];
  queryHistory = [];
  lastToolGroups = [];
  contextState = createContextState();
  // R17 基线必须跟着「会话真正开始」这一刻拍：/clear、resume 之后旧基线作废，
  // 否则新会话第一条消息会把上一会话的改动当成「本轮新增」播报一遍。
  captureMemoryBaseline();
}

function restoreSession(id: string): boolean {
  const activeRuntime = runtime();
  const loaded = activeRuntime.session.resume(id);
  if (!loaded?.history.length) return false;
  sessionId = loaded.id;
  activeRuntime.context.setAgentMode('auto');
  history = [...loaded.history];
  if (history[0]?.role === 'system') history[0] = { role: 'system', content: currentSystemMessage() };
  else history.unshift({ role: 'system', content: currentSystemMessage() });
  queryHistory = [...(loaded.queryHistory ?? [])];
  lastToolGroups = [...(loaded.lastToolGroups ?? [])];
  contextState = createContextState();
  captureMemoryBaseline();
  return true;
}

function persistSession(): void {
  if (!sessionId) return;
  // 工具批提交后的检查点仍处在 Runtime.run 内，runtime.session.save 的 assertIdle
  // 会把它拒掉。host 每个任务独占一个 Runtime，这里沿同一条同步调用链写该 Runtime
  // 自己的 store；不能为了绕过闸门另建全局 SessionStore，否则会写到别的工作区。
  const activeRuntime = runtime();
  activeRuntime.context.sessionStore.setCurrentSessionId(sessionId);
  activeRuntime.context.sessionStore.save(history, sessionId, queryHistory, lastToolGroups);
  activeRuntime.context.rollbackStore.persistSnapshots(sessionId);
}

function prepareSession(requestedSessionId?: string): boolean | null {
  if (!requestedSessionId) {
    if (!sessionId) createSession();
    return false;
  }
  if (requestedSessionId === sessionId) return true;
  return restoreSession(requestedSessionId) ? true : null;
}

function waitForApproval(
  runId: string,
  request: InterventionRequest,
  kind: 'permission' | 'ask_human' = 'permission',
): Promise<InterventionResult> {
  if (closing) return Promise.resolve({ action: 'cancelled' });
  const approvalId = randomUUID();
  emit(
    'approval_requested',
    {
      approvalId,
      // `kind` 让控制面能区分「工具权限面板」与「Worker 主动提问」：措辞、默认选项、
      // 以及回答后回给模型的话术都不一样。旧客户端不认识它会忽略，行为与以前一致。
      kind,
      title: request.title,
      detail: request.detail ?? '',
      options: (request.options ?? []).map((option) => (typeof option === 'string' ? option : option.label)),
      // 下面四项以前都没过协议，导致控制面只能「猜」：
      //   type       — choice / input。input 形态没有选项，必须给输入框；
      //   allowCustom — 默认 true，控制面据此决定是否露出「其他…」输入；
      //   defaultIndex — 危险操作把它落在「拒绝」上；不传就是默认高亮首项，
      //                  用户顺手回车就放行了 rm -rf；
      //   seed       — input 形态的预填文本（例如建议的路径）。
      type: request.type,
      allowCustom: request.allowCustom !== false,
      defaultIndex: request.defaultIndex ?? 0,
      seed: request.seed ?? '',
    },
    runId,
  );
  return new Promise<InterventionResult>((resolve) => approvals.set(approvalId, { resolve, runId }));
}

/**
 * 把 agent 的展示接缝翻译成 NDJSON 事件。
 *
 * 每个钩子的取舍标准是「终端里看得见、而 GUI 不转发就等于没有」：
 *   - onModelRetry：退避重试期间终端有状态行；不转发的话用户在 GUI 面对的是几十秒静止。
 *   - onLiveUsage：底栏上下文进度条的实时来源；只在轮末给一次百分比会让人以为卡住。
 *   - onImageRelief：图片压缩要几十秒，终端有「正在压缩图片…」；GUI 无反馈就是假死。
 *   - onToolOutput：长命令（build/test）的流式输出，终端边跑边出，GUI 只能等最后一坨。
 *   - onNoReply / onMaxSteps：两种「没内容但有结局」的终止，必须各自可见。
 * onToolDone / onTextEnd / onChatDone / onToolBatchEnd / onHistoryRebuilt 是终端的行排版细节
 * （批次收口、换行归一、spinner 停转），GUI 用 DOM 结构表达，不需要镜像。
 */
function hooksFor(runId: string): AgentHooks {
  return {
    onStepStart: () => emit('status', { value: 'thinking' }, runId),
    onText: (text) => emit('text_delta', { text }, runId),
    onToolCall: (name) => emit('status', { value: 'preparing_tool', tool: name }, runId),
    // 用户消息追加后、第一批工具提交后各保存一次。崩溃留下的半个模型回答只由
    // work-app 的 UI 日志回放，绝不能伪装成完整 assistant 消息写入可续聊的会话。
    onCheckpoint: () => persistSession(),
    onToolHeader: (tool) => emit('tool_started', { id: tool.id, name: tool.name, arguments: tool.arguments }, runId),
    onToolStart: (name) => emit('status', { value: 'running_tool', tool: name }, runId),
    onToolOutput: (tool, chunk) => emit('tool_output', { id: tool.id, name: tool.name, chunk }, runId),
    onToolResult: (tool, output, _parsed, preWriteOld, editStartLine, multiHunks, outcome) =>
      emit(
        'tool_completed',
        {
          id: tool.id,
          name: tool.name,
          output,
          // 结构化结局：GUI 靠它区分成功/失败/被拒/中断、显示改动文件数，
          // 而不是在 output 上嗅探 '错误:' / 'CHANGE_CONFLICT' 这类字符串前缀。
          ...(outcome
            ? {
                status: outcome.status,
                code: outcome.code,
                retryable: outcome.retryable,
                changedFiles: outcome.changedFiles ?? [],
                ...(outcome.durationMs != null ? { durationMs: outcome.durationMs } : {}),
                ...(outcome.changeSet
                  ? { changeSetId: outcome.changeSet.id, changeSetFiles: outcome.changeSet.changedFiles }
                  : {}),
                ...(outcome.usage ? { nestedUsage: outcome.usage } : {}),
              }
            : {}),
          // 真实行号：终端 diff 头行的行号来自执行前快照（src/agent/tool-helpers.ts:readDiffContext）。
          // 不转发的话 GUI 只能用「相对本次改动的 1」重算，与终端对不上、也看不出改在文件哪一段。
          ...(editStartLine > 1 ? { editStartLine } : {}),
          ...(multiHunks && multiHunks.length > 0 ? { multiHunks } : {}),
          // write_file 覆盖写：旧内容就是 diff 的「删除侧」。超过上限不转发（IPC 与 DOM 都吃不消），
          // GUI 退回「全部按新增展示」，与终端 replay 同策略。
          ...(preWriteOld != null && preWriteOld.length <= MAX_FORWARDED_OLD_BYTES ? { preWriteOld } : {}),
        },
        runId,
      ),
    onModelRetry: (info) =>
      emit(
        'model_retry',
        { attempt: info.attempt, nextAttempt: info.nextAttempt, waitMs: info.waitMs, code: info.code },
        runId,
      ),
    onLiveUsage: (usage) => {
      // usage.totalTokens 是本轮累计消耗，绝不是上下文占用；详情统一读当前 prompt 快照。
      emit('live_usage', { ...usage, contextUsage: contextUsageSnapshot() }, runId);
    },
    onImageRelief: (info) => emit('image_relief', { ...info }, runId),
    onNoReply: () => emit('no_reply', {}, runId),
    onMaxSteps: () => emit('max_steps', {}, runId),
    onAbort: () => emit('run_aborted', {}, runId),
    onDone: (elapsedMs, usage) => emit('run_finished', { elapsedMs, usage }, runId),
  };
}

async function run(command: Extract<HostCommand, { type: 'run' }>): Promise<void> {
  if (closing) return;
  if (activeRun) return error('An agent run is already active for this project.', command.id);
  if (!command.prompt.trim() && !command.attachments?.length) return;
  let toolPolicy: ToolPolicyController | undefined;
  try {
    await initializeRuntime();
    if (closing) return;
    const resumed = prepareSession(command.sessionId);
    if (resumed === null) return error(`Session ${command.sessionId} could not be restored.`, command.id);
    // 每个被接受的 stdio run 都是真实用户 turn；在路由与 Agent 执行前清除上一轮 skill deny。
    clearSkillActivation();
    const controller = new AbortController();
    activeRun = { id: command.id, controller };
    queryHistory.push(command.prompt);
    // 首个模型请求前也要有可恢复的用户轮。run-coordinator 的 cancellation checkpoint
    // 是内存快照、不会调用 onCheckpoint；这里追加 user 后再落盘，避免首轮崩溃只剩侧栏标题。
    const userInput: string | ContentPart[] = command.attachments?.length
      ? [
          ...(command.prompt ? [{ type: 'text' as const, text: command.prompt }] : []),
          ...command.attachments.flatMap((attachment): ContentPart[] => {
            if (attachment.dataUrl)
              return [{ type: 'image_url', name: attachment.name, image_url: { url: attachment.dataUrl } }];
            if (typeof attachment.text !== 'string') return [];
            // name/attachment/truncated 是会话回放元数据，transport 发送前统一移除。
            return [
              {
                type: 'text',
                name: attachment.name,
                attachment: true,
                truncated: attachment.truncated === true,
                text: `用户附件 ${JSON.stringify(attachment.name)} 的提取文本如下。${attachment.truncated ? '（内容已截断，仅提供前 100000 字符）' : ''}\n\n${attachment.text}`,
              },
            ];
          }),
        ]
      : command.prompt;
    history.push({ role: 'user', content: userInput });
    persistSession();
    emit(
      'run_started',
      {
        sessionId,
        projectRoot: process.cwd(),
        resumed,
        provider: runtime().context.config.provider,
        promptCache: runtime().context.config.provider === 'anthropic' && runtime().context.config.anthropicPromptCache,
        attachments: command.attachments?.map((attachment) => attachment.name) ?? [],
      },
      command.id,
    );
    const previousGroups = [...lastToolGroups];
    // planMode 现读而不是硬编码：plan 模式下路由器要拿到 "PLAN" 语境（只挑探查类能力），
    // 工具面也要走 ToolPolicyController.snapshot(true) 的只读过滤（PLAN_DISABLED_TOOLS）。
    const planMode = isPlanMode();
    const decision = await routeToolGroups({
      input: command.prompt,
      previousGroups,
      planMode,
      attachmentNames: command.attachments?.map((attachment) => attachment.name),
      signal: controller.signal,
      transport: runtime().context.modelTransport,
      tools: runtime().context.toolRuntime.tools,
    });
    if (closing) throw hostClosedReason;
    toolPolicy = new ToolPolicyController({
      groups: decision.groups,
      reason: decision.reason,
      confidence: decision.confidence,
      tools: runtime().context.toolRuntime.tools,
    });
    lastToolGroups = toolPolicy.groupNames;
    const initialToolRoute = {
      policyId: toolPolicy.id,
      groups: toolPolicy.groupNames,
      previousGroups,
      inheritPrevious: decision.inheritPrevious,
      confidence: decision.confidence,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
      fallback: decision.fallback,
      planMode,
    };
    emit('tool_route', initialToolRoute, command.id);
    const result = await runtime().run({
      turn: 'new',
      turnLabel: command.prompt.split('\n')[0]?.slice(0, 40) ?? command.prompt.slice(0, 40),
      history,
      userInput,
      // 上面已把用户轮写入首个持久化检查点，core 不能再 append 一次。
      continueFromHistory: true,
      signal: controller.signal,
      hooks: hooksFor(command.id),
      contextState,
      toolPolicy,
      initialToolRoute,
      traceContext: { sessionId },
      onTraceEvent: appendCurrentSessionTraceEvent,
      permissionPrompt: (request) => waitForApproval(command.id, request),
      // R17 尾注 + R18 静默召回：与 REPL 同口径（src/agent/index.ts 的 runAgent）。
      // 两者都走 ephemeral 段，不重建 history[0]，前缀缓存不受影响；
      // 排除 memoryTailChangedIds() 是刻意的——那批条目已由尾注播报，同一轮不重复讲。
      memoryTail: buildMemoryTailSection(isMemoryEnabled()),
      memoryRecall: turnRecallFor(command.prompt),
    });
    lastToolGroups = toolPolicy.groupNames;
    persistSession();
    const contextUsage = contextUsageSnapshot();
    emit(
      'run_completed',
      {
        sessionId,
        completed: result.completed,
        terminationReason: result.terminationReason,
        changedFiles: result.changedFiles ?? [],
        usage: result.usage,
        provider: runtime().context.config.provider,
        promptCache: runtime().context.config.provider === 'anthropic' && runtime().context.config.anthropicPromptCache,
        usagePercent: contextUsage.percent,
        contextUsage,
        contextWindow: runtime().context.config.contextWindowTokens,
      },
      command.id,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (toolPolicy) lastToolGroups = toolPolicy.groupNames;
    try {
      if (sessionId) persistSession();
    } catch {
      /* Preserve the runtime error. */
    }
    if (activeRun?.id === command.id && activeRun.controller.signal.aborted) {
      emit('run_aborted', {}, command.id);
    } else {
      emit('run_failed', { message }, command.id);
    }
  } finally {
    for (const [approvalId, waiter] of approvals) {
      if (waiter.runId === command.id) {
        waiter.resolve({ action: 'cancelled' });
        approvals.delete(approvalId);
      }
    }
    activeRun = null;
  }
}

function cancel(command: Extract<HostCommand, { type: 'cancel' }>): void {
  if (!activeRun) return emit('run_idle', {}, command.id);
  activeRun.controller.abort();
  runtimeFacade?.cancel();
  for (const [approvalId, waiter] of approvals) {
    if (waiter.runId === activeRun.id) {
      waiter.resolve({ action: 'cancelled' });
      approvals.delete(approvalId);
    }
  }
  emit('cancelling', {}, command.id);
}

/** 与终端底栏同源：system + 对话 + 实际工具 schema + ephemeral。 */
function contextUsageSnapshot() {
  return measureContextUsage(history, runtime().context.config.contextWindowTokens, contextState);
}

async function compact(command: Extract<HostCommand, { type: 'compact' }>): Promise<void> {
  if (closing) return;
  if (activeRun) return error('有正在运行的任务，请先取消后再压缩。', command.id);
  try {
    await initializeRuntime();
    if (closing) return;
    if (!sessionId) createSession();
    emit('status', { value: 'compacting' }, command.id);
    const activeRuntime = runtime();
    const log = await activeRuntime.compact(history, {
      focus: command.focus,
      force: true,
      contextState,
      signal: shutdownController.signal,
    });
    persistSession();
    // 旧实测锚点属于压缩前请求，不能跨摘要边界继续外推。
    contextState.promptAnchor = undefined;
    const usage = contextUsageSnapshot();
    emit(
      'compact_done',
      {
        compacted: log.compactHistoryCalled,
        beforeTokens: log.compactDetail?.estimateBefore,
        afterTokens: log.compactDetail?.estimateAfter,
        usagePercent: usage.percent,
        contextUsage: usage,
        contextWindow: runtime().context.config.contextWindowTokens,
      },
      command.id,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    error(`压缩失败: ${message}`, command.id);
  }
}

function resolveApproval(command: Extract<HostCommand, { type: 'approval' }>): void {
  const waiter = approvals.get(command.approvalId);
  if (!waiter) return error('Approval request has expired.', command.id);
  approvals.delete(command.approvalId);
  waiter.resolve({ action: command.action, value: command.value });
}

/* ────────────────────────────────────────────────────────────────
 * 面板命令：会话 / 回滚 / 改动 / 用量 / 记忆 / 设置
 *
 * 这些在终端里各是一条斜杠命令（/sessions、/rollback、/diff、/usage、/memory、/effort…），
 * 命令体里都是「取数据 → 排版成终端文本」两段。这里只复刻**取数据**那一段，
 * 数据以结构化 payload 回给 GUI，由 GUI 自己排版 —— 别把终端文案搬到协议里，
 * 否则渲染层只能原样打印一行行等宽文本，点什么都没法交互。
 *
 * 所有 handler 都遵守同一条：出错用 error(msg, requestId)，**不抛**。
 * 抛出去会被 stdio 主循环当成未处理拒绝，客户端只看到「没有响应」。
 * ──────────────────────────────────────────────────────────────── */

/** 面板命令统一前置：host 还没起来就先 etc 起来；运行中则拒绝（读会话/回滚都要求空闲）。 */
async function withRuntime(commandId: string, allowRunning: boolean): Promise<boolean> {
  await initializeRuntime();
  if (closing) return false;
  if (!allowRunning && activeRun) {
    error('有正在运行的任务，请先停止后再操作。', commandId);
    return false;
  }
  return true;
}

/** 会话元数据 → 协议载荷（只带 GUI 用得上的字段，history 另走磁盘回放）。 */
function sessionMetaPayload(meta: SessionMeta): Record<string, unknown> {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    model: meta.model,
    firstUser: meta.firstUser,
    ...(meta.archived ? { archived: true } : {}),
    current: meta.id === sessionId,
  };
}

/** host 的工作区根：host 以 `cwd = 工作空间根` 启动（见 initializeRuntime 的 sandboxRoot）。 */
function hostWorkspaceRoot(): string {
  return path.resolve(process.cwd());
}

/**
 * 要扫描会话的工作空间清单（按最近使用倒序）。
 *
 * 当前工作空间永远排第一并强制包含：注册表可能还没登记它（例如 work-app 首次启动，
 * 或注册表被清空），少了它就会出现「终端能看到、GUI 看不到」的错位。
 */
function sessionWorkspaceRoots(): Array<{ root: string; name: string; lastSeen: string }> {
  const current = hostWorkspaceRoot();
  const rows = readWorkspaceRegistry().map((entry) => ({
    root: path.resolve(entry.root),
    name: entry.name || path.basename(entry.root),
    lastSeen: entry.lastSeen,
  }));
  const key = (root: string): string => root.toLowerCase();
  const currentRow = rows.find((row) => key(row.root) === key(current));
  const rest = rows.filter((row) => key(row.root) !== key(current));
  return [{ root: current, name: path.basename(current) || current, lastSeen: currentRow?.lastSeen ?? '' }, ...rest];
}

/**
 * 跨工作空间聚合会话列表。
 *
 * 每个工作空间一个独立 SessionStore（各自读 `<root>/.mocode/sessions`），
 * 终端在 F:\mocode 留下的会话与 work-app 在 %APPDATA% 留下的会话因此同列。
 * 单次全量扫描实测 ≈1.3s（47 个工作空间 / 376 条），面板级操作可以接受；
 * 注册表里会话数为 0 的工作空间直接跳过，不白扫临时目录。
 */
function listSessionsEverywhere(limit: number): Array<Record<string, unknown>> {
  const current = hostWorkspaceRoot();
  const registered = new Map(
    readWorkspaceRegistry().map((entry) => [path.resolve(entry.root).toLowerCase(), entry.sessions]),
  );
  const out: Array<Record<string, unknown>> = [];
  for (const workspace of sessionWorkspaceRoots()) {
    const known = registered.get(workspace.root.toLowerCase());
    if (known === 0) continue;
    const sessionsRoot = path.join(workspace.root, '.mocode', 'sessions');
    if (!existsSync(sessionsRoot)) continue;
    let metas: SessionMeta[];
    try {
      metas = new SessionStore({ sessionsRoot }).list(limit);
    } catch {
      continue; // 单个工作空间读不了不能拖垮整张列表
    }
    const isCurrent = workspace.root.toLowerCase() === current.toLowerCase();
    for (const meta of metas) {
      out.push({
        ...sessionMetaPayload(meta),
        workspace: workspace.root,
        workspaceName: workspace.name,
        // 只有当前工作空间里的会话可能是「当前会话」。
        current: isCurrent && meta.id === sessionId,
      });
    }
  }
  out.sort((left, right) => (String(left.createdAt) < String(right.createdAt) ? 1 : -1));
  return out.slice(0, limit);
}

/**
 * 会话面板：list / search / resume / fork / workspaces，
 * 对齐终端 /sessions、/ssearch、/resume、/fork。
 *
 * resume 会**切换 host 内存里的当前会话**（后续 run 续在这个会话上），
 * fork 只产出一个副本、不动当前会话 —— 与终端语义一致，别把两者合并。
 */
async function sessionsCommand(command: Extract<HostCommand, { type: 'sessions' }>): Promise<void> {
  // workspaces 只读全局注册表，不需要 runtime：GUI 在没有任务时也要能问「有哪些工作空间」。
  if (command.action === 'workspaces') {
    const current = hostWorkspaceRoot();
    emit(
      'sessions_report',
      {
        action: 'workspaces',
        currentWorkspace: current,
        workspaces: sessionWorkspaceRoots().map((workspace) => ({
          root: workspace.root,
          name: workspace.name,
          lastSeen: workspace.lastSeen,
          sessionCount: (() => {
            try {
              return readdirSync(path.join(workspace.root, '.mocode', 'sessions'), { withFileTypes: true }).filter(
                (entry) => entry.isDirectory() && /^\d{8}-\d{6}(?:-\d{3}-[a-f0-9]{8})?$/.test(entry.name),
              ).length;
            } catch {
              return 0;
            }
          })(),
          isCurrent: workspace.root.toLowerCase() === current.toLowerCase(),
        })),
      },
      command.id,
    );
    return;
  }
  // list / search 是只读的：任务正在跑时也要能查（终端 /sessions 同理不打断 run）。
  // resume / fork 会换当前会话或写磁盘，必须等这一轮跑完。
  const readOnly = command.action === 'list' || command.action === 'search';
  if (!(await withRuntime(command.id, readOnly))) return;
  const activeRuntime = runtime();
  try {
    if (command.action === 'list') {
      const limit = command.limit ?? 50;
      emit(
        'sessions_report',
        {
          action: 'list',
          scope: command.scope ?? 'current',
          // scope=all 才扫全盘；缺省与终端 /sessions 一致，只看本工作空间。
          sessions:
            command.scope === 'all'
              ? listSessionsEverywhere(limit)
              : activeRuntime.session.list(limit).map(sessionMetaPayload),
          currentSessionId: sessionId,
          currentWorkspace: hostWorkspaceRoot(),
        },
        command.id,
      );
      return;
    }
    if (command.action === 'search') {
      const query = (command.query ?? '').trim();
      if (!query) return error('搜索关键词为空。', command.id);
      emit(
        'sessions_report',
        {
          action: 'search',
          query,
          // 归档命中即使 purged 也保留（只能看摘要）—— GUI 据此禁用「恢复」按钮。
          hits: activeRuntime.session.searchArchive(query, command.limit ?? 10).map((hit) => ({ ...hit })),
          currentSessionId: sessionId,
        },
        command.id,
      );
      return;
    }
    if (command.action === 'resume') {
      const target = command.sessionId?.trim();
      if (!target) return error('缺少要恢复的会话 id。', command.id);
      if (target === sessionId) {
        emit('session_resumed', { sessionId, unchanged: true }, command.id);
        return;
      }
      if (!restoreSession(target)) return error(`会话 ${target} 无法恢复（文件缺失或内容为空）。`, command.id);
      emit(
        'session_resumed',
        {
          sessionId,
          messages: history.filter((message) => message.role !== 'system').length,
          // 渲染层切会话要重放历史：把来源告诉它，由它决定走磁盘回放还是等 run_started。
          source: 'resume',
        },
        command.id,
      );
      return;
    }
    // fork：先把内存里最新对话落盘，副本才包含尚未自动保存的尾部（与终端 /fork 同因）。
    const sourceId = command.sessionId?.trim() || sessionId;
    if (!sourceId) return error('当前还没有会话可分叉。', command.id);
    if (sourceId === sessionId && history.length > 1) persistSession();
    const newId = activeRuntime.session.fork(sourceId);
    if (!newId) return error(`会话 ${sourceId} 只有归档副本，无法分叉。`, command.id);
    emit('session_forked', { sourceId, sessionId: newId }, command.id);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/** 每轮改动（供回滚菜单展示「选这一轮会丢掉哪些文件」）。 */
function turnChangesPayload(): Array<Record<string, unknown>> {
  const store = runtime().context.rollbackStore;
  const turns = store.listTurns();
  const snapshots = store.snapshotsSince(0);
  return turns.map((turn, index) => {
    // 选第 index 轮 = 放弃这一轮及之后的全部改动，所以文件面是「该轮及以后」的并集。
    const byPath = new Map<string, { path: string; ops: string[]; snapshotAvailable: boolean }>();
    for (const snapshot of snapshots) {
      if (snapshot.turnId < turn.turnId) continue;
      const entry = byPath.get(snapshot.path) ?? { path: snapshot.path, ops: [], snapshotAvailable: true };
      if (snapshot.contentUnavailable) entry.snapshotAvailable = false;
      for (const op of snapshot.ops ?? ['file_change']) if (!entry.ops.includes(op)) entry.ops.push(op);
      byPath.set(snapshot.path, entry);
    }
    return {
      index,
      turnId: turn.turnId,
      firstLine: turn.firstLine,
      files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
  });
}

/**
 * 回滚：list 只读；apply 截断对话到第 turnIndex 轮之前，并**只**还原显式列出的文件。
 *
 * 文件还原默认一个都不做（revertFiles 空集），与终端 /rollback 的默认一致：
 * 用户点「回滚对话」时，磁盘上的代码不该悄悄跟着变。
 */
async function rollbackCommand(command: Extract<HostCommand, { type: 'rollback' }>): Promise<void> {
  if (!(await withRuntime(command.id, false))) return;
  try {
    if (command.action === 'list') {
      if (!sessionId) return emit('rollback_report', { action: 'list', turns: [], currentSessionId: '' }, command.id);
      emit('rollback_report', { action: 'list', turns: turnChangesPayload(), currentSessionId: sessionId }, command.id);
      return;
    }
    if (!sessionId) return error('当前还没有会话，无法回滚。', command.id);
    const turns = runtime().context.rollbackStore.listTurns();
    const turnIndex = command.turnIndex ?? -1;
    if (turnIndex < 0 || turnIndex >= turns.length) {
      return error(`轮次下标无效：当前可回滚 ${turns.length} 轮。`, command.id);
    }
    const plan = runtime().rollback.plan(turnIndex, history);
    const revertPaths = new Set<string>();
    const skipped: string[] = [];
    for (const path of command.revertFiles ?? []) {
      const change = plan.changes.find((item) => item.path === path);
      // 快照不可用的文件（超出捕获预算）不能还原：静默跳过会让用户以为已经还原了。
      if (change?.snapshotAvailable) revertPaths.add(path);
      else skipped.push(path);
    }
    const result = runtime().rollback.apply(plan, history, revertPaths);
    // 被撤销轮次的最终路由不能再当 continuation 基线（与终端 rollbackFlow 同处理）。
    lastToolGroups = [];
    persistSession();
    captureMemoryBaseline();
    emit(
      'rollback_applied',
      {
        turnIndex,
        deletedMsgs: result.deletedMsgs,
        revertedFiles: result.revertedFiles,
        conflictedFiles: result.conflictedFiles,
        skippedFiles: skipped,
        messages: history.filter((message) => message.role !== 'system').length,
        sessionId,
      },
      command.id,
    );
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/** 快照 before → 文本（与终端 /diff 同口径：base64 解不动就当 null）。 */
function snapshotTextOf(snapshot: Snapshot): string | null {
  if (snapshot.before === null) return null;
  if (snapshot.encoding === 'base64') {
    try {
      return Buffer.from(snapshot.before, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return snapshot.before;
}

function readWorkspaceText(relativePath: string): string | null {
  try {
    return readFileSync(path.resolve(runtime().context.sandboxRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 改动面板：list 给文件清单（含每文件是否可回滚），diff 给 unified diff 文本。
 *
 * `turn` 省略 = 最近一轮；给 0-based 下标 = 指定轮；≥ 轮数 = 全部累计（与终端 `/diff all` 等价）。
 * 数据源是 rollback 快照而不是 git：没有 git 的目录也能看，且口径与回滚完全一致。
 */
async function changesCommand(command: Extract<HostCommand, { type: 'changes' }>): Promise<void> {
  if (!(await withRuntime(command.id, true))) return;
  try {
    const store = runtime().context.rollbackStore;
    const turns = store.listTurns();
    if (turns.length === 0) {
      return emit('changes_report', { action: command.action, turn: null, files: [], empty: true }, command.id);
    }
    let minTurnIdExclusive: number;
    let label: string;
    let turnIndex: number | null;
    if (command.turn === undefined) {
      const last = turns[turns.length - 1]!;
      minTurnIdExclusive = last.turnId - 1;
      label = 'latest';
      turnIndex = turns.length - 1;
    } else if (command.turn >= turns.length) {
      minTurnIdExclusive = 0;
      label = 'all';
      turnIndex = null;
    } else {
      minTurnIdExclusive = turns[command.turn]!.turnId - 1;
      label = 'turn';
      turnIndex = command.turn;
    }

    // 每 path 取范围内最早的 before（= 该范围开始前的状态），与 /diff 一致。
    const byPath = new Map<string, { snapshot: Snapshot; unavailable: boolean }>();
    for (const snapshot of store.snapshotsSince(minTurnIdExclusive)) {
      if (command.path && snapshot.path !== command.path) continue;
      const existing = byPath.get(snapshot.path);
      const diffable = snapshot.kind === 'file' && snapshot.contentUnavailable !== true;
      if (!existing || snapshot.turnId < existing.snapshot.turnId) {
        byPath.set(snapshot.path, { snapshot, unavailable: (existing?.unavailable ?? false) || !diffable });
      } else if (!diffable) {
        existing.unavailable = true;
      }
    }

    const entries = [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right));
    const files: Array<Record<string, unknown>> = [];
    for (const [relativePath, entry] of entries) {
      const after = readWorkspaceText(relativePath);
      const base = {
        path: relativePath,
        unavailable: entry.unavailable,
        ops: entry.snapshot.ops ?? [],
      };
      if (command.action === 'list') {
        files.push({ ...base, diffAvailable: !entry.unavailable });
        continue;
      }
      if (entry.unavailable) {
        files.push({ ...base, diff: '' });
        continue;
      }
      const diff = unifiedFileDiff(relativePath, snapshotTextOf(entry.snapshot), after);
      files.push({ ...base, diff, unchanged: diff === '' });
    }
    emit('changes_report', { action: command.action, label, turn: turnIndex, files }, command.id);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/** 当前任务读内存中的实测锚点；旧任务只读自己的落盘 history，不篡改当前会话。 */
async function contextUsageCommand(command: Extract<HostCommand, { type: 'context_usage' }>): Promise<void> {
  if (!(await withRuntime(command.id, true))) return;
  try {
    const targetSessionId = command.sessionId?.trim() || sessionId;
    if (!targetSessionId) return emit('context_usage', { contextUsage: null }, command.id);
    if (targetSessionId === sessionId) {
      return emit('context_usage', { sessionId: targetSessionId, contextUsage: contextUsageSnapshot() }, command.id);
    }
    const loaded = runtime().context.sessionStore.load(targetSessionId);
    if (!loaded) return emit('context_usage', { sessionId: targetSessionId, contextUsage: null }, command.id);
    const restored = [...loaded.history];
    const system = buildSystemMessage({ sessionId: targetSessionId, planMode: isPlanMode() });
    if (restored[0]?.role === 'system') restored[0] = { role: 'system', content: system };
    else restored.unshift({ role: 'system', content: system });
    const historicalState = createContextState();
    const policy = new ToolPolicyController({
      groups: loaded.lastToolGroups ?? [],
      tools: runtime().context.toolRuntime.tools,
    });
    historicalState.activeTools = policy.snapshot(isPlanMode()).tools;
    const contextUsage = measureContextUsage(restored, runtime().context.config.contextWindowTokens, historicalState);
    emit('context_usage', { sessionId: targetSessionId, contextUsage }, command.id);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/**
 * 用量：session = 指定会话的 usage.jsonl；global = 跨工作空间账本（days 默认 7）。
 *
 * session 口径优先用命令带的 sessionId：面板命令由懒启动的 host 处理时，
 * 进程内 `sessionId` 还没建立（它只在 run 期间有效），只认进程内值就永远查不到。
 */
async function usageCommand(command: Extract<HostCommand, { type: 'usage' }>): Promise<void> {
  if (!(await withRuntime(command.id, true))) return;
  try {
    if (command.scope === 'session') {
      const targetSessionId = command.sessionId?.trim() || sessionId;
      if (!targetSessionId) return emit('usage_report', { scope: 'session', empty: true }, command.id);
      const raw = runtime().context.sessionStore.readUsage(targetSessionId) as Array<Record<string, unknown>>;
      // usage.jsonl 是历史文件，坏行/旧字段都可能出现；只保留形状对得上的记录，
      // 否则 summarizeUsage 里会把 undefined 累加成 NaN，整张表变成 NaN。
      const records = raw.filter(
        (row) =>
          typeof row.inputTokens === 'number' &&
          typeof row.outputTokens === 'number' &&
          typeof row.cachedTokens === 'number',
      );
      emit(
        'usage_report',
        {
          scope: 'session',
          sessionId: targetSessionId,
          summary: summarizeUsage(
            records.map((row) => ({
              step: Number(row.step) || 0,
              phase: row.phase === 'compact' ? ('compact' as const) : ('main' as const),
              inputTokens: Number(row.inputTokens) || 0,
              outputTokens: Number(row.outputTokens) || 0,
              cachedTokens: Number(row.cachedTokens) || 0,
              reasoningTokens: Number(row.reasoningTokens) || 0,
              ...(typeof row.cacheCreationTokens === 'number' ? { cacheCreationTokens: row.cacheCreationTokens } : {}),
            })),
          ),
        },
        command.id,
      );
      return;
    }
    const days = command.days ?? 7;
    const records = readGlobalUsage();
    // 热力图窗口 == 统计窗口：GUI 的 7 / 30 / 180 / 365 天选择决定日历跨度，一格永远是一天。
    // 只扫一遍、只算一次 —— 两段同源，省掉 GUI 第二趟往返，也不会出现「窗口与日历不一致」。
    const summary = summarizeGlobalUsage(records, days);
    emit(
      'usage_report',
      {
        scope: 'global',
        days,
        summary,
        calendar: { fromDay: summary.fromDay, toDay: summary.toDay, days: summary.byDay },
      },
      command.id,
    );
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/** 记忆条目 → 载荷（正文截断：面板只列不读全文，全文用 show 动作取）。 */
function memoryEntryPayload(entry: ReturnType<typeof loadAll>[number]): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    summary: entry.summary,
    status: entry.status,
    scope: entry.scope,
    pinned: entry.pinned,
    recallCount: entry.recallCount,
    updatedAt: entry.updatedAt,
    ...(entry.source?.file ? { seededFrom: entry.source.file } : {}),
    ...(entry.source?.session ? { fromSession: entry.source.session } : {}),
  };
}

/**
 * 记忆面板：对齐终端 /memory 全家桶。
 *
 * 写操作（confirm / drop / forget / reflect）一律要求 `confirm: true`：
 * 协议层不信任客户端「已经问过用户了」，GUI 忘了弹确认就是静默改用户记忆库。
 */
async function memoryCommand(command: Extract<HostCommand, { type: 'memory' }>): Promise<void> {
  if (!(await withRuntime(command.id, true))) return;
  const needsConfirm = command.action === 'confirm' || command.action === 'drop' || command.action === 'forget';
  if (needsConfirm && command.confirm !== true) {
    return error('该操作会修改记忆库，需要客户端二次确认后再带 confirm:true 重发。', command.id);
  }
  try {
    if (command.action === 'overview') {
      const all = loadAll();
      const active = all.filter((entry) => entry.status === 'active');
      const byType: Record<string, number> = {};
      for (const entry of active) byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      emit(
        'memory_report',
        {
          action: 'overview',
          enabled: isMemoryEnabled(),
          paused: isMemoryWritesPaused(),
          counts: {
            total: all.length,
            active: active.length,
            archived: all.filter((entry) => entry.status === 'archived').length,
            superseded: all.filter((entry) => entry.status === 'superseded').length,
            byType,
          },
          // 最近更新的在前：面板默认列这些，不做分页（记忆库量级本来就小）。
          entries: [...active]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, command.limit ?? 50)
            .map(memoryEntryPayload),
        },
        command.id,
      );
      return;
    }
    if (command.action === 'health') {
      emit('memory_report', { action: 'health', health: buildMemoryHealth(), lines: formatMemoryHealth() }, command.id);
      return;
    }
    if (command.action === 'audit') {
      emit('memory_report', { action: 'audit', records: readAudit(command.limit ?? 50) }, command.id);
      return;
    }
    if (command.action === 'profile') {
      const { me, edges } = inspectPrimaryProfile();
      emit(
        'memory_report',
        {
          action: 'profile',
          primary: me ? { id: me.id, name: me.name } : null,
          edgeCount: edges.length,
          internalized: listInternalizedProfile().map((candidate) => ({
            id: candidate.edge.id,
            text: candidate.text,
            relation: candidate.relation,
            confidence: candidate.edge.confidence ?? null,
            evidence: candidate.edge.evidence ?? null,
          })),
          candidates: listProfileCandidates().map((candidate) => ({
            id: candidate.edge.id,
            text: candidate.text,
            relation: candidate.relation,
            confidence: candidate.edge.confidence ?? null,
            evidence: candidate.edge.evidence ?? null,
          })),
          recall: readRecallStats(),
        },
        command.id,
      );
      return;
    }
    if (command.action === 'search') {
      const query = (command.query ?? '').trim();
      if (!query) return error('搜索关键词为空。', command.id);
      emit(
        'memory_report',
        {
          action: 'search',
          query,
          entries: searchEntries(query, { limit: command.limit ?? 8, status: 'any' }).map(memoryEntryPayload),
        },
        command.id,
      );
      return;
    }
    if (command.action === 'confirm') {
      const id = command.entryId?.trim();
      if (!id) return error('缺少要确认的边 id。', command.id);
      const result = promoteEdge(id);
      if (!result.ok) return error(`确认失败：${result.reason}`, command.id);
      // 画像进了 About you，下一轮系统提示必须重算，否则要等下一次 /resume 才生效。
      if (sessionId) history[0] = { role: 'system', content: currentSystemMessage() };
      emit('memory_report', { action: 'confirm', entryId: id, ok: true }, command.id);
      return;
    }
    if (command.action === 'drop') {
      const id = command.entryId?.trim();
      if (!id) return error('缺少要撤销的边 id。', command.id);
      const result = invalidateEdge(id, 'profile-dropped');
      if (!result.ok) return error(`撤销失败：${result.reason}`, command.id);
      if (sessionId) history[0] = { role: 'system', content: currentSystemMessage() };
      emit('memory_report', { action: 'drop', entryId: id, ok: true }, command.id);
      return;
    }
    if (command.action === 'forget') {
      const id = command.entryId?.trim();
      if (!id) return error('缺少要遗忘的记忆 id。', command.id);
      const result = forgetEntry(id);
      emit('memory_report', { action: 'forget', entryId: id, ...result }, command.id);
      return;
    }
    if (command.action === 'reflect') {
      if (!isMemoryEnabled()) return error('记忆子系统已关闭，反思不会执行。', command.id);
      // manual=true：绕过自动节流的次数/转录闸门（用户显式点了按钮）。
      kickoffReflection(snapshotTranscript(history, 20), true);
      emit('memory_report', { action: 'reflect', triggered: true }, command.id);
      return;
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/** 设置项 → 当前值（read 侧）。与 set 侧共用同一份键名，避免两边各写一套字符串。 */
function readSettingsSnapshot(): Record<string, unknown> {
  const envFlag = (key: string, fallback: boolean): boolean => {
    const raw = process.env[key];
    if (raw === undefined) return fallback;
    return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
  };
  return {
    effort: getActiveEffort(),
    router: isToolRoutingEnabled(),
    memory: isMemoryEnabled(),
    subAgent: isSubAgentEnabled(),
    frontendTools: isFrontendToolsEnabled(),
    computerUse: isComputerUseEnabled(),
    turnRecall: isTurnRecallEnabled(),
    proactive: envFlag('MOCODE_MEMORY_PROACTIVE', true),
    episodic: envFlag('MOCODE_MEMORY_EPISODIC', true),
    consolidate: envFlag('MOCODE_MEMORY_CONSOLIDATE', true),
    autoCompact: config.autoCompact,
    autoReflect: config.autoReflect,
  };
}

/**
 * 运行时设置：get 返回快照；set 应用 patch 并持久化到 ~/.mocode/config。
 *
 * 为什么必须写盘：host 每次启动都重新读配置，只在内存里改等于「重启就丢」。
 * 为什么改完要调用方重启 host：模型客户端、工具表、路由开关都在 host 启动期固化成快照，
 * 改内存值对已经起来的子进程不生效（与切模型同因，见 work-app 的 restartAllAgents）。
 */
async function settingsCommand(command: Extract<HostCommand, { type: 'settings' }>): Promise<void> {
  if (command.action === 'get') {
    // get 不要求 runtime：设置本身是进程级配置，host 没起来也能读（GUI 首屏就要显示）。
    return emit('settings_state', { settings: readSettingsSnapshot() }, command.id);
  }
  const patch = command.patch ?? {};
  const persist: Record<string, string> = {};
  const changed: string[] = [];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'effort') {
        const effort = parseReasoningEffort(value);
        if (!effort) return error(`无效的思考强度：${String(value)}`, command.id);
        updateModelConfig({ reasoningEffort: effort });
        persist.REASONING_EFFORT = effort;
        changed.push(key);
        continue;
      }
      if (typeof value !== 'boolean') continue;
      switch (key) {
        case 'router':
          updateToolRoutingEnabled(value);
          persist.MOCODE_ROUTER_ENABLED = String(value);
          break;
        case 'memory':
          updateMemoryConfig(value);
          persist.MEMORY_ENABLED = String(value);
          break;
        case 'subAgent':
          updateSubAgentConfig(value);
          persist.MOCODE_SUBAGENT_ENABLED = String(value);
          break;
        case 'frontendTools':
          updateFrontendToolsConfig(value);
          persist.MOCODE_FRONTEND_TOOLS_ENABLED = String(value);
          break;
        case 'computerUse':
          updateComputerUseConfig(value);
          persist.MOCODE_COMPUTER_USE_ENABLED = String(value);
          break;
        case 'turnRecall':
          process.env.MOCODE_MEMORY_TURN_RECALL = String(value);
          persist.MOCODE_MEMORY_TURN_RECALL = String(value);
          break;
        case 'proactive':
          process.env.MOCODE_MEMORY_PROACTIVE = String(value);
          persist.MOCODE_MEMORY_PROACTIVE = String(value);
          break;
        case 'episodic':
          process.env.MOCODE_MEMORY_EPISODIC = String(value);
          persist.MOCODE_MEMORY_EPISODIC = String(value);
          break;
        case 'consolidate':
          process.env.MOCODE_MEMORY_CONSOLIDATE = String(value);
          persist.MOCODE_MEMORY_CONSOLIDATE = String(value);
          break;
        case 'autoCompact':
          // 这两个没有 update* 写入口：config 单例的布尔字段就是唯一真源，直接改。
          config.autoCompact = value;
          process.env.AUTO_COMPACT = String(value);
          persist.AUTO_COMPACT = String(value);
          break;
        case 'autoReflect':
          config.autoReflect = value;
          process.env.AUTO_REFLECT = String(value);
          persist.AUTO_REFLECT = String(value);
          break;
        default:
          continue;
      }
      changed.push(key);
    }
    if (Object.keys(persist).length > 0) writeConfigKeys(persist);
    // 记忆总开关变了，history[0] 的 Memory Index / plan 段都要重算（否则下一轮还是旧画面）。
    if (sessionId && changed.includes('memory')) {
      history[0] = { role: 'system', content: currentSystemMessage() };
    }
    emit(
      'settings_state',
      { settings: readSettingsSnapshot(), changed, restartRequired: changed.length > 0 },
      command.id,
    );
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause), command.id);
  }
}

/**
 * 命令分发。default 分支显式报错而不是静默丢弃：新客户端发来本 host 不认识的命令时，
 * 用户要能看到「这条指令没生效」，而不是盯着一个没有反应的界面。
 */
async function handle(command: HostCommand): Promise<void> {
  // 先取出这两个字段：switch 穷尽后 default 分支里的 command 会被收窄成 never，
  // 而这里仍要报出「具体哪个 type 没被支持」。不用 as 去掉类型，用局部变量保留可读性。
  const { type, id } = command as { type: string; id: string };
  switch (command.type) {
    case 'run':
      return run(command);
    case 'cancel':
      return cancel(command);
    case 'compact':
      return compact(command);
    case 'approval':
      return resolveApproval(command);
    case 'set_mode':
      return setMode(command);
    case 'sessions':
      return sessionsCommand(command);
    case 'rollback':
      return rollbackCommand(command);
    case 'changes':
      return changesCommand(command);
    case 'usage':
      return usageCommand(command);
    case 'context_usage':
      return contextUsageCommand(command);
    case 'memory':
      return memoryCommand(command);
    case 'settings':
      return settingsCommand(command);
    default:
      return error(`Host does not support command type "${type}" (protocol v${HOST_PROTOCOL_VERSION}).`, id);
  }
}

/** 心跳间隔：控制面用「最近一次心跳」判断 Worker 是卡死还是进程已死。 */
const HEARTBEAT_MS = 5_000;

/**
 * Supervised Worker 才发心跳：普通 work-app 宿主不需要这份额外流量，
 * 且旧客户端不认识这个事件（保持默认行为不变）。
 */
function startHeartbeat(): NodeJS.Timeout | undefined {
  if (process.env.MOCODE_SUPERVISED_WORKER !== '1') return undefined;
  const timer = setInterval(() => {
    emit('heartbeat', { pid: process.pid, at: Date.now() });
  }, HEARTBEAT_MS);
  // 不因为心跳把进程钉在事件循环上：stdin 关闭时该退就退。
  timer.unref?.();
  return timer;
}

function requestShutdownCancellation(): void {
  activeRun?.controller.abort(hostClosedReason);
  runtimeFacade?.cancel(hostClosedReason);
  for (const [approvalId, waiter] of approvals) {
    waiter.resolve({ action: 'cancelled' });
    approvals.delete(approvalId);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pendingCommands = new Set<Promise<void>>();
const heartbeatTimer = startHeartbeat();
const startupPromise = initializeRuntime();
void startupPromise.catch((cause) => error(cause instanceof Error ? cause.message : String(cause)));
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const command = parseCommand(JSON.parse(line));
    if (!command) {
      error('Invalid MoCode Work host command.');
    } else {
      const pending = Promise.resolve(handle(command));
      pendingCommands.add(pending);
      void pending.then(
        () => pendingCommands.delete(pending),
        () => pendingCommands.delete(pending),
      );
    }
  } catch {
    error('Invalid JSON command.');
  }
}
closing = true;
shutdownController.abort(hostClosedReason);
requestShutdownCancellation();
await startupPromise.catch(() => undefined);
requestShutdownCancellation();
await Promise.allSettled([...pendingCommands]);
const runtimeAtShutdown = runtimeFacade as Runtime | null;
await runtimeAtShutdown?.close().catch(() => undefined);
await closeAllMcp().catch(() => undefined);
if (heartbeatTimer) clearInterval(heartbeatTimer);
