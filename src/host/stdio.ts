import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { runAgentCore, type AgentHooks, type ContentPart } from '../agent/core.js';
import { createAgentRuntimeContext, type AgentRuntimeContext } from '../agent/runtime-context.js';
import { buildBasePrompt } from '../config/index.js';
import { estimateMessagesTokens, type ChatMessage } from '../llm/index.js';
import { initializeAllMcp, getMcpTools, getMcpWarnings, closeAllMcp } from '../mcp/index.js';
import {
  appendCurrentSessionTraceEvent,
  createContextState,
  loadSession,
  newSessionId,
  saveSession,
} from '../session/index.js';
import { setCurrentSessionId } from '../session/state.js';
import { manualCompact } from '../session/scheduler.js';
import { effectiveSystemPrompt } from '../skills/index.js';
import { clearSkillActivation } from '../skills/activation.js';
import { ToolPolicyController } from '../tools/policy.js';
import { routeToolGroups } from '../tools/router.js';
import type { ToolRouteGroupName } from '../config/profiles.js';
// 装配官方默认工具包:registry 不再顶层 import builtins(破模块循环),host 入口须显式装配。
import '../tools/builtins/index.js';
import type { InterventionRequest, InterventionResult } from '../ui/intervention.js';
import { parseCommand, type HostCommand, type HostEnvelope } from './protocol.js';

interface ApprovalWaiter {
  resolve: (result: InterventionResult) => void;
  runId: string;
}

let initialized: Promise<void> | null = null;
let runtimeContext: AgentRuntimeContext | null = null;
let activeRun: { id: string; controller: AbortController } | null = null;
let sessionId = '';
let history: ChatMessage[] = [];
let queryHistory: string[] = [];
let lastToolGroups: ToolRouteGroupName[] = [];
let contextState = createContextState();
const approvals = new Map<string, ApprovalWaiter>();

function runtime(): AgentRuntimeContext {
  if (!runtimeContext) throw new Error('Runtime is not initialized.');
  return runtimeContext;
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

async function initializeRuntime(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    await initializeAllMcp();
    runtimeContext = createAgentRuntimeContext({ sandboxRoot: process.cwd(), initialMode: 'auto' });
    runtimeContext.toolRuntime.registerToolsExtension('mcp', getMcpTools());
    const runtimeConfig = runtimeContext.config;
    emit('runtime_ready', {
      projectRoot: runtimeContext.sandboxRoot,
      provider: runtimeConfig.provider,
      promptCache: runtimeConfig.provider === 'anthropic' && runtimeConfig.anthropicPromptCache,
      warnings: getMcpWarnings(),
    });
  })();
  return initialized;
}

function systemMessage(): string {
  return effectiveSystemPrompt(buildBasePrompt(sessionId));
}

function createSession(): void {
  sessionId = newSessionId();
  setCurrentSessionId(sessionId, process.cwd());
  runtime().setAgentMode('auto');
  history = [{ role: 'system', content: systemMessage() }];
  queryHistory = [];
  lastToolGroups = [];
  contextState = createContextState();
}

function restoreSession(id: string): boolean {
  const loaded = loadSession(id);
  if (!loaded?.history.length) return false;
  sessionId = loaded.id;
  setCurrentSessionId(sessionId, process.cwd());
  runtime().setAgentMode('auto');
  history = [...loaded.history];
  if (history[0]?.role === 'system') history[0] = { role: 'system', content: systemMessage() };
  else history.unshift({ role: 'system', content: systemMessage() });
  queryHistory = [...(loaded.queryHistory ?? [])];
  lastToolGroups = [...(loaded.lastToolGroups ?? [])];
  contextState = createContextState();
  return true;
}

function prepareSession(requestedSessionId?: string): boolean | null {
  if (!requestedSessionId) {
    if (!sessionId) createSession();
    return false;
  }
  if (requestedSessionId === sessionId) return true;
  return restoreSession(requestedSessionId) ? true : null;
}

function waitForApproval(runId: string, request: InterventionRequest): Promise<InterventionResult> {
  const approvalId = randomUUID();
  emit(
    'approval_requested',
    {
      approvalId,
      title: request.title,
      detail: request.detail ?? '',
      options: (request.options ?? []).map((option) => (typeof option === 'string' ? option : option.label)),
    },
    runId,
  );
  return new Promise<InterventionResult>((resolve) => approvals.set(approvalId, { resolve, runId }));
}

function hooksFor(runId: string): AgentHooks {
  return {
    onStepStart: () => emit('status', { value: 'thinking' }, runId),
    onText: (text) => emit('text_delta', { text }, runId),
    onToolCall: (name) => emit('status', { value: 'preparing_tool', tool: name }, runId),
    onToolHeader: (tool) => emit('tool_started', { id: tool.id, name: tool.name, arguments: tool.arguments }, runId),
    onToolStart: (name) => emit('status', { value: 'running_tool', tool: name }, runId),
    onToolResult: (tool, output) => emit('tool_completed', { id: tool.id, name: tool.name, output }, runId),
    onAbort: () => emit('run_aborted', {}, runId),
    onDone: (elapsedMs, usage) => emit('run_finished', { elapsedMs, usage }, runId),
  };
}

async function run(command: Extract<HostCommand, { type: 'run' }>): Promise<void> {
  if (activeRun) return error('An agent run is already active for this project.', command.id);
  if (!command.prompt.trim()) return;
  let toolPolicy: ToolPolicyController | undefined;
  try {
    await initializeRuntime();
    const resumed = prepareSession(command.sessionId);
    if (resumed === null) return error(`Session ${command.sessionId} could not be restored.`, command.id);
    // 每个被接受的 stdio run 都是真实用户 turn；在路由与 Agent 执行前清除上一轮 skill deny。
    clearSkillActivation();
    const controller = new AbortController();
    activeRun = { id: command.id, controller };
    queryHistory.push(command.prompt);
    const userInput: string | ContentPart[] = command.attachments?.length
      ? [
          { type: 'text', text: command.prompt },
          ...command.attachments.map((attachment) => ({
            type: 'image_url' as const,
            image_url: { url: attachment.dataUrl },
          })),
        ]
      : command.prompt;
    emit(
      'run_started',
      {
        sessionId,
        projectRoot: process.cwd(),
        resumed,
        provider: runtime().config.provider,
        promptCache: runtime().config.provider === 'anthropic' && runtime().config.anthropicPromptCache,
        attachments: command.attachments?.map((attachment) => attachment.name) ?? [],
      },
      command.id,
    );
    const previousGroups = [...lastToolGroups];
    const decision = await routeToolGroups({
      input: command.prompt,
      previousGroups,
      planMode: false,
      attachmentNames: command.attachments?.map((attachment) => attachment.name),
      signal: controller.signal,
      transport: runtime().modelTransport,
      tools: runtime().toolRuntime.tools,
    });
    toolPolicy = new ToolPolicyController({
      groups: decision.groups,
      reason: decision.reason,
      confidence: decision.confidence,
      tools: runtime().toolRuntime.tools,
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
      planMode: false,
    };
    emit('tool_route', initialToolRoute, command.id);
    const turnId = runtime().beginTurn(command.prompt.split('\n')[0]?.slice(0, 40) ?? command.prompt.slice(0, 40));
    const result = await runAgentCore({
      history,
      userInput,
      signal: controller.signal,
      hooks: hooksFor(command.id),
      contextState,
      runtimeContext: runtime(),
      toolPolicy,
      initialToolRoute,
      traceContext: { sessionId, turnId },
      onTraceEvent: appendCurrentSessionTraceEvent,
      permissionPrompt: (request) => waitForApproval(command.id, request),
    });
    lastToolGroups = toolPolicy.groupNames;
    saveSession(history, sessionId, queryHistory, lastToolGroups);
    emit(
      'run_completed',
      {
        sessionId,
        completed: result.completed,
        terminationReason: result.terminationReason,
        changedFiles: result.changedFiles ?? [],
        usage: result.usage,
        provider: runtime().config.provider,
        promptCache: runtime().config.provider === 'anthropic' && runtime().config.anthropicPromptCache,
        usagePercent: Math.round(contextUsagePercent() * 100),
        contextWindow: runtime().config.contextWindowTokens,
      },
      command.id,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (toolPolicy) lastToolGroups = toolPolicy.groupNames;
    try {
      if (sessionId) saveSession(history, sessionId, queryHistory, lastToolGroups);
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
  for (const [approvalId, waiter] of approvals) {
    if (waiter.runId === activeRun.id) {
      waiter.resolve({ action: 'cancelled' });
      approvals.delete(approvalId);
    }
  }
  emit('cancelling', {}, command.id);
}

/** 计算当前上下文用量百分比(不含 system prompt)，用于 UI 展示。 */
function contextUsagePercent(): number {
  const dialog = history.filter((m) => m.role !== 'system');
  const est = estimateMessagesTokens(dialog);
  return Math.min(1, est / runtime().config.contextWindowTokens);
}

async function compact(command: Extract<HostCommand, { type: 'compact' }>): Promise<void> {
  if (activeRun) return error('有正在运行的任务，请先取消后再压缩。', command.id);
  try {
    await initializeRuntime();
    if (!sessionId) createSession();
    emit('status', { value: 'compacting' }, command.id);
    const activeRuntime = runtime();
    const log = await manualCompact(history, command.focus, {
      force: true,
      contextState,
      activeTools: activeRuntime.toolRuntime.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      runtime: activeRuntime,
    });
    saveSession(history, sessionId, queryHistory, lastToolGroups);
    const pct = contextUsagePercent();
    emit(
      'compact_done',
      {
        compacted: log.compactHistoryCalled,
        beforeTokens: log.compactDetail?.estimateBefore,
        afterTokens: log.compactDetail?.estimateAfter,
        usagePercent: Math.round(pct * 100),
        contextWindow: runtime().config.contextWindowTokens,
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

async function handle(command: HostCommand): Promise<void> {
  if (command.type === 'run') return run(command);
  if (command.type === 'cancel') return cancel(command);
  if (command.type === 'compact') return compact(command);
  resolveApproval(command);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
void initializeRuntime().catch((cause) => error(cause instanceof Error ? cause.message : String(cause)));
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const command = parseCommand(JSON.parse(line));
    if (!command) error('Invalid Mocode Work host command.');
    else void handle(command);
  } catch {
    error('Invalid JSON command.');
  }
}
await closeAllMcp().catch(() => undefined);
