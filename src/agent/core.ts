// agent 核心循环(纯逻辑,无 TUI 依赖):流式 chat → 工具执行 → 回灌。
// 所有展示副作用经 AgentHooks 注入——主 agent 注入 TUI 渲染(layout + spinner + diff),
// 子 agent 注入静默/摘要 hooks(不写屏)。逻辑层共享,避免重复实现循环 / 分组 / abort 还原。
//
// 与 index.ts 的关系:index.ts 的 runAgent = runAgentCore + TUI hooks 薄封装(行为不变)。
// spawn.ts 的 spawnAgent = runAgentCore + 静默 hooks(子 agent)。

import { readFileSync } from 'node:fs';
import type OpenAI from 'openai';
import {
  chat,
  estimatePromptTokens,
  planChatTools,
  chatTools,
  type ChatMessage,
  type ChatResult,
  type ChatUsage,
  type ToolCallRef,
} from '../llm/index.js';
import {
  executeToolOutcome,
  getToolCapabilities,
  isFileMutationTool,
  tools,
  type ToolOutcome,
  type ToolRetryInfo,
} from '../tools/registry.js';
import { checkPermission } from '../permissions/index.js';
import { validateToolArguments } from '../tools/validation.js';
import { getPlanDisabledTools, getRuntimeDisabledTools } from '../tools/constants.js';
import {
  createPreCompletionChecklistMiddleware,
  type PreCompletionChecklistHandler,
  type ChecklistContext,
} from './middleware/checklist.js';
import { inferModelFamily } from './work-discipline.js';
import { reflectionHint, classifyError, type ErrorCategory } from './retry-classifier.js';
import { getAgentMode, setAgentMode } from './mode.js';
import {
  maybeCompact,
  contextState,
  dropContextFromHistory,
  createTraceEvent,
  summarizeToolArguments,
  safeProviderId,
} from '../session/index.js';
import type { ContextState } from '../session/compact.js';
import { createBudgetScheduler } from '../session/scheduler.js';
import {
  optimizeToolResult,
  HOT_TURN_WINDOW,
  userTurnBoundary,
  recordArtifact,
  invalidateArtifacts,
  rehydrateArtifacts,
} from '../context/index.js';
import {
  createAgeAwareEncodingState,
  type AgeAwareEncodingState,
} from '../context/age-aware.js';
import { createRelevancePruner } from '../context/relevance.js';
import { isToolResultSuccess } from '../context/utils.js';
import { config } from '../config/index.js';
import { t } from '../i18n/index.js';
import { jailResolve } from '../sandbox/index.js';
import { createLifecycleEngine } from '../context/lifecycle.js';
import type { LifecycleEngine } from '../context/lifecycle.js';
import type { BudgetScheduler } from '../session/scheduler.js';
import type { DropContextFilter, DropContextResult } from '../tools/types.js';
import {
  getTokenCalibration,
  updateTokenCalibration,
} from '../context/token-calibration.js';
import { getCurrentTurnId, getCurrentTurnMutationState } from '../rollback/index.js';
import {
  createAutomaticValidator,
  type ValidationCallbacks,
  type ValidationResult,
} from '../verification/index.js';
import type { AgentTraceEvent, AgentTurnTrace, TraceEventType } from '../session/trace.js';
import { getCurrentSessionId } from '../session/state.js';

/** Stable per-history age state survives user turns; WeakMap avoids retaining closed sessions. */
const ageAwareStateByHistory = new WeakMap<ChatMessage[], AgeAwareEncodingState>();

function ageAwareStateFor(history: ChatMessage[]): AgeAwareEncodingState {
  const existing = ageAwareStateByHistory.get(history);
  if (existing) return existing;
  const created = createAgeAwareEncodingState(history);
  ageAwareStateByHistory.set(history, created);
  return created;
}

/** 解析工具 arguments JSON;非法或空返 null(调用方据此降级到普通 preview)。 */
function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/**
 * Thrashing 检测:同一工具 + 完全相同 arguments 在本轮重复 ≥ THRASH_THRESHOLD 次,
 * 返一段提示(注入到工具结果尾部),引导模型换思路而不是再试一次。
 * 阈值 2 = "试过两次同样的调用还没好,该停了"。指纹 = `${name}\\x00${args}`
 * (直接拼,不哈希——避免热路径开销;args 长度本身有限,内存压力可忽略)。
 * null 表示未触发,不污染输出。
 */
const THRASH_THRESHOLD = 2;
function thrashHint(name: string, args: string, count: number): string | null {
  if (count < THRASH_THRESHOLD) return null;
  return (
    `\n\n[hint] This is call #${count} of \`${name}\` with identical arguments — ` +
    'either failing or returning the same content. STOP retrying and switch strategy:\n' +
    '- read_file / glob → path likely wrong; call `glob` to discover paths, or `ask_human`\n' +
    '- run_command → Windows path-escaping issue; use `read_file` / `glob` with absolute paths instead\n' +
    '- write_file / edit_file CHANGE_CONFLICT → do not resend; read_file the same path and use its latest hash (use null only when read_file says the path is missing)\n' +
    '- edit_file old_string mismatch → re-read the exact region and copy it verbatim\n' +
    '- otherwise → re-read the tool description; the argument shape may be wrong'
  );
}

/**
 * Detect only a strict streak of identical failures. Successful calls, or a
 * different tool/argument pair, end the streak. This keeps intentional phased
 * read_file/glob calls from being mislabeled after the underlying files change.
 */
export function createThrashTracker(): (
  name: string,
  args: string,
  succeeded: boolean,
) => string | null {
  let lastFailedFingerprint: string | null = null;
  let consecutiveFailures = 0;
  return (name, args, succeeded) => {
    if (succeeded) {
      lastFailedFingerprint = null;
      consecutiveFailures = 0;
      return null;
    }
    const fingerprint = `${name}\x00${args}`;
    if (fingerprint === lastFailedFingerprint) consecutiveFailures += 1;
    else {
      lastFailedFingerprint = fingerprint;
      consecutiveFailures = 1;
    }
    return thrashHint(name, args, consecutiveFailures);
  };
}

/** 只有显式声明 parallel 且无需权限确认的工具才进入普通并发组。 */
function isParallelTool(name: string): boolean {
  const tool = tools.find((candidate) => candidate.name === name);
  return !!tool && (tool.risk ?? 'safe') === 'safe' &&
    getToolCapabilities(tool).concurrency === 'parallel';
}

/** resource-locked 工具先顺序完成权限预检，再依赖 canonical resource lock 并发执行。 */
function isResourceLockedTool(name: string): boolean {
  const tool = tools.find((candidate) => candidate.name === name);
  return !!tool && getToolCapabilities(tool).concurrency === 'resource-locked';
}

function isResourceLockedCall(call: ToolCallRef): boolean {
  if (!isResourceLockedTool(call.name)) return false;
  if (call.name !== 'sub-agent') return true;
  const args = parseArgs(call.arguments);
  // Unknown write sets stay on the serial path. Read tasks and known disjoint write sets may batch.
  return args?.mode !== 'write' || (Array.isArray(args.writeSet) && args.writeSet.length > 0);
}

/** 文件 mutation 由 capability metadata 判定，供 diff、回滚与上下文失效共用。 */
const isMutationTool = (name: string): boolean => isFileMutationTool(name);

function deniedOutcome(name: string): ToolOutcome {
  return {
    status: 'denied',
    code: 'PERMISSION_DENIED',
    retryable: false,
    output: `错误:用户拒绝了工具 ${name} 的执行。`,
  };
}

/** 工具调用 ● 头所需信息(交给 hooks 渲染;core 不直接写屏)。 */
export interface ToolCallView {
  name: string;
  arguments: string;
  id: string;
}

/** mutation 执行前读旧内容供 diff:write_file 取整文件旧内容(不存在→null=新建),
 * edit_file 取 old_string 起始行号(供 diff 显示真实文件行号)。读不到则 diff 退化为相对行号。
 * 非 mutation 或参数非法返 { preWriteOld: null, editStartLine: 1 }。失败不阻断。 */
function readDiffContext(
  tc: ToolCallRef,
  parsed: Record<string, unknown> | null,
): { preWriteOld: string | null; editStartLine: number } {
  if (!parsed) return { preWriteOld: null, editStartLine: 1 };
  const p = String(parsed.path ?? '');
  if (!p) return { preWriteOld: null, editStartLine: 1 };
  if (tc.name === 'write_file') {
    try {
      // jailResolve:沙箱越界(../../、绝对外圈、软链出圈)抛错 → catch 兜底返 null,不泄露牢外内容(TOCTOU)
      return { preWriteOld: readFileSync(jailResolve(p), 'utf8'), editStartLine: 1 };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 文件不存在(新建)、不可读 或 沙箱越界(不泄露)
    }
  }
  if (tc.name === 'edit_file') {
    // 行尾归一化:LLM 生成的 old_string 用 LF(\n),但 Windows 文件可能是 CRLF(\r\n),
    // 不统一则 indexOf 必败、editStartLine 恒为 1。与 edit-file.ts 保持一致归一化为 LF。
    const oldStr = String(parsed.old_string ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    try {
      // jailResolve:同上,沙箱越界抛错 → catch 兜底,不泄露牢外内容
      const raw = readFileSync(jailResolve(p), 'utf8');
      const data = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const idx = oldStr ? data.indexOf(oldStr) : -1;
      return {
        preWriteOld: null,
        editStartLine: idx >= 0 ? data.slice(0, idx).split('\n').length : 1,
      };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 读不到:diff 退化为相对行号(含沙箱越界)
    }
  }
  return { preWriteOld: null, editStartLine: 1 };
}

/** 回灌 tool 结果到 history:经 Context Optimization Pipeline 编码(tree/search/log/...)后裁到单条上限。
 *  tool_call_id 与 assistant.tool_calls 按序配对。未注册 encoder 时回落 capToolResultForHistory(零行为变化)。
 *  TUI 渲染(hooks.onToolResult)用原始 output,与此解耦——屏上看全量,LLM 看编码后紧凑版。
 *  出口再经 Relevance Pruner 做跨条裁剪:同 path 旧 read_file 自动 stub 为存根。
 *  - pruner 在每个 runAgentCore 实例化一次(本闭包持有),会话级状态。
 *  - 开关关闭时 pruner 不创建(零开销、零行为变化)。
 *  出口再经 Lifecycle Engine 做引用追踪:LIVE→REFERENCED→OBSOLETE→STUB 四态。
 *  - lifecycle 也在每个 runAgentCore 实例化一次,登记 grep/glob/web_search/web_fetch 等 producer
 *    与 read/edit/write 的 consumer 关系;孤立+老化自动 STUB(观察类工具永不到 STUB)。
 *  - 开关关闭时 lifecycle=null 完全跳过。 */

/** RETRY-01: 把 thrash hint + 反思指针一次性拼到 output 尾部。
 *  - thrash hint 永远可能存在(连续失败才出现);
 *  - 反思指针仅在 error/denied 状态追加,success 跳过避免噪声。
 *  抽出 helper 是为了 sequential + parallel 两处共用,避免拼装逻辑漂移。
 *  返回追加后的字符串 + 反思 category(用于 QUAL-01 trace 硬事件),
 *  success / aborted 时 category === null,调用方据此决定是否 emit 'retry_reflection' 事件。 */
function appendRetryAnnotations(
  output: string,
  status: 'success' | 'error' | 'denied' | 'aborted',
  code: import('./../tools/types.js').ToolOutcomeCode,
  thrashHint: string | null,
): { output: string; reflectionCategory: ErrorCategory | null } {
  let result = thrashHint ? `${output}${thrashHint}` : output;
  let reflectionCategory: ErrorCategory | null = null;
  if (status !== 'success' && status !== 'aborted') {
    reflectionCategory = classifyError(code);
    const reflection = reflectionHint(reflectionCategory);
    result = `${result}\n\n[retry reflection: ${reflectionCategory}]\n${reflection}`;
  }
  return { output: result, reflectionCategory };
}

/** ASK-01: ask_human 工具调用本 turn 计数器。纯函数无副作用,
 * 计数规则简单:1-based(本 turn 第 1 次 = 1, 第 2 次 = 2, 第 3+ 次 = exceeded)。
 * 预算上限常量与工作纪律段 "Budget: at most 2 ask_human calls per turn" 保持一致;
 * 改这里时,fixture 与纪律段都要同步。 */
export const ASK_HUMAN_PER_TURN_BUDGET = 2;

export function askHumanBudgetAnnotation(askHumanCountThisTurn: number, status: 'success' | 'error' | 'denied' | 'aborted'): string | null {
  // 工具失败 / aborted 不追加(避免噪声;模型已被错误消息告知失败)。
  if (status !== 'success') return null;
  if (askHumanCountThisTurn < ASK_HUMAN_PER_TURN_BUDGET) return null;
  if (askHumanCountThisTurn === ASK_HUMAN_PER_TURN_BUDGET) {
    return `\n\n[ask budget] This was your ${askHumanCountThisTurn}nd ask_human call this turn (budget = ${ASK_HUMAN_PER_TURN_BUDGET}). For the rest of this turn, prefer the safer default and disclose the choice in your final reply — do not silently guess.`;
  }
  // 第 3+ 次(超过预算):强硬提示,鼓励模型停下问自己是否还有意义。
  return `\n\n[ask budget EXCEEDED] This is ask_human call #${askHumanCountThisTurn} this turn (budget = ${ASK_HUMAN_PER_TURN_BUDGET}). Stop asking; choose a default, implement, and disclose the choice in your final reply. Continuing to ask is more harmful than a documented guess.`;
}

/** NARR-01: 工具轮旁白(assistant 消息同时带 content + tool_calls)的软预算。
 * 超出即追加回压提示;未超只 emit trace(可度量,不打扰)。
 * 单位是 code point 而非字节——中文一字一 point,英文一字母一 point,
 * 对两种语言都是"一句话大约多长"的直觉量级。 */
export const NARRATION_CHAR_BUDGET = 120;

/** 分类工具轮旁白。返回 null 表示这一轮没有旁白(纯工具调用,理想情况)。
 * hint 仅在超预算时非 null:prompt 里的"工具轮保持静默"是软约束,
 * 这里给出机制层面的回压,同时让 trace 能统计旁白率。 */
export function classifyNarration(
  content: string | null | undefined,
  toolCallCount: number,
): { chars: number; overBudget: boolean; hint: string | null } | null {
  const text = content?.trim() ?? '';
  if (!text) return null;
  const chars = [...text].length;
  if (chars <= NARRATION_CHAR_BUDGET) {
    return { chars, overBudget: false, hint: null };
  }
  const plural = toolCallCount === 1 ? '' : 's';
  return {
    chars,
    overBudget: true,
    hint:
      `\n\n[narration] Your previous message emitted ${chars} characters of prose alongside ` +
      `${toolCallCount} tool call${plural} (soft budget = ${NARRATION_CHAR_BUDGET}). ` +
      'Interstitial commentary costs the user screen space and costs you context on every ' +
      'later step. For the rest of this turn, emit prose mid-turn ONLY to (a) flag a genuine ' +
      'decision fork needing user input, (b) disclose an error or risk, or (c) deliver the ' +
      'final answer once tools are done. Otherwise call the next tool with no preamble.',
  };
}

function pushToolResult(
  history: ChatMessage[],
  tc: ToolCallRef,
  output: string,
  pruner: ReturnType<typeof createRelevancePruner> | null,
  lifecycle: LifecycleEngine | null,
  _scheduler: BudgetScheduler | null,
  runtimeContextState: ContextState = contextState,
  succeededOverride?: boolean,
): void {
  const succeeded = succeededOverride ?? isToolResultSuccess(output);
  const ageAware = config.contextOptimize ? ageAwareStateFor(history) : null;
  const encodingContext = ageAware?.preparePush(tc, succeeded);
  const msg = {
    role: 'tool' as const,
    tool_call_id: tc.id,
    // 初次 push 始终保守(age=0);旧 Cold 结果在下一 step 的 sweep 中按类型降级。
    content: optimizeToolResult(tc.name, output, tc.arguments, encodingContext),
  } as ChatMessage;
  history.push(msg);
  const messageIndex = history.length - 1;
  recordArtifact(runtimeContextState, history, messageIndex, output, succeeded);
  // 失败 read 不得淘汰旧 read；失败 consumer 也不能改变 lifecycle 上游状态。
  if (pruner) pruner.observePush(history, msg, succeeded);
  if (lifecycle) lifecycle.pushTool(history, messageIndex, succeeded);
  runtimeContextState.lifecycleStats = lifecycle?.stats();
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
  /** 自动验证开始/结束；验证不是模型 tool_call，不写入 tool role history。 */
  onValidationStart?: (command: string) => void;
  onValidationResult?: (result: ValidationResult) => void;
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
  /**
   * 每次模型请求前动态生成临时 system prompt 后缀。返回空串时不注入；
   * 后缀仅用于本次请求，不写回 history，适合由外部状态驱动的提醒。
   */
  dynamicSystemSuffix?: () => string;
  hooks: AgentHooks;
  /** 步数上限;缺省 = config.maxSteps。子 agent 可传更低值。 */
  maxSteps?: number;
  /** 工具 schema 覆盖;plan 模式传 planChatTools(只读子集)。子 agent 可传受限子集。
   *  缺省 = 按 getAgentMode() 自动选(auto=全量 / plan=只读)。 */
  toolsOverride?: OpenAI.Chat.Completions.ChatCompletionTool[];
  /** 本 agent 独享的上下文统计状态；缺省为主 agent 全局 contextState。 */
  contextState?: ContextState;
  /** 主 Agent 收尾自动验证；子 Agent 必须保持 false，由主 Agent 统一验证共享工作区。 */
  autoValidate?: boolean;
  /**
   * 可选的宿主交互桥：桌面端可将高风险工具的确认请求交给图形界面处理。
   * 未传时保持原有 TUI / 非交互 fail-closed 行为。
   */
  permissionPrompt?: import('../permissions/index.js').PermissionCheckOptions['prompt'];
  /**
   * PROMPT-02: 在 agent 宣告完成(no tool calls + 有 candidate 正文)那一刻,
   * 向 history 推一条 user [checklist] 消息,强制模型再做一轮显式确认。
   * - 缺省(undefined) = 启用内置 createPreCompletionChecklistMiddleware。
   * - 传 false = 完全关闭(checklist 自身调试用)。
   * - 传自定义 handler = 替换默认触发条件(调用方自定义更严格/更宽松的策略)。
   * plan 模式永远不触发(无论 handler 是什么)。
   */
  preCompletionChecklist?: PreCompletionChecklistHandler | false;
  /** 验证器注入点；缺省使用项目脚本发现与 run_command 同源执行器。 */
  validator?: (
    signal?: AbortSignal,
    callbacks?: ValidationCallbacks,
  ) => Promise<ValidationResult>;
  /** 每轮结束的兼容汇总 sink。 */
  onTrace?: (trace: AgentTurnTrace) => void;
  /** 逐事件黑匣子 sink；写入失败不得影响 Agent。 */
  onTraceEvent?: (event: AgentTraceEvent) => void;
  /** EVAL/嵌入方可提供稳定 ID；主进程默认读取当前 session/rollback turn。 */
  traceContext?: { sessionId?: string; turnId?: number };
  /** Structured observer used by sub-agent coordinators to build read/write provenance. */
  onToolOutcome?: (tool: string, args: Record<string, unknown>, outcome: ToolOutcome) => void;
}

/** OpenAI content array 的子集(text + image_url);repl 构造 user 多模态消息用。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

/** Why the agent loop stopped; max_steps and unverified changes are never normal completion. */
export type AgentTerminationReason =
  | 'completed'
  | 'completed_unverified'
  | 'aborted'
  | 'max_steps'
  | 'unverified_changes';

/** runAgentCore 的运行结果。 */
export interface AgentRunResult {
  /** 只有生成最终回复时为 true；达到步数上限始终为 false。 */
  completed: boolean;
  terminationReason: AgentTerminationReason;
  /** 最终 assistant 文本回复(content);无回复或中断为 null。 */
  finalText: string | null;
  /** 本轮累计 token 用量(各 chat 步 prompt+completion 之和);后端不开 include_usage 或全失败则 undefined。 */
  usage?: ChatUsage;
  /** 本轮最终自动验证状态；无代码变更或未启用时为空。 */
  validation?: ValidationResult;
  /** rollback 事务观察到的本轮实际磁盘变化。 */
  changedFiles?: string[];
  /**
   * QUAL-01 affordance: 本轮 agent 收尾时的完整 chat history。
   * 只读快照,evals/coding/runner 用它来推断 [checklist] / [retry reflection:]
   * 等 marker 的真实触发次数。不序列化进磁盘(只内存)→ 减少 baseline json 体积。
   * 不影响主 agent 行为,仅供 eval/trace 后处理使用。 */
  history?: readonly ChatMessage[];
}

/**
 * agent 核心循环(纯逻辑):
 *  流式调 LLM(经 hooks.onText 实时渲染)→ 有 tool_calls 就分组执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由调用方持有。
 *  步前经 session/maybeCompact 自动压缩(接近窗口上限时三层压缩);
 *  工具结果进 history 前经 Context Optimization Pipeline(optimizeToolResult:类型化编码 + 长度裁剪)。
 *
 *  中断语义:signal 经 executeTool(name, args, signal) 串进工具;run_command/web_fetch 等 abort 即时杀
 *  (树杀子进程 / 取消 fetch),循环顶 if(signal.aborted) 兜底还原。不会留下未配对的 tool_call_id。
 *  abort 时 history 还原到本 turn 前(savedHistory 浅拷贝),模式还原,调 hooks.onAbort。
 *
 *  所有展示副作用经 hooks 注入;core 自身不直接调 layout / spinner(不依赖 ui/layout.ts)。
 *  但 core 仍依赖 ui/render.ts 的纯函数(summarizeToolCall / truncateDisplay / fmtElapsed)——
 *  这些是纯字符串格式化,无副作用,共享安全。
 */
export async function runAgentCore(
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const { history, userInput, signal, onContextUpdate, hooks } = opts;
  const runtimeContextState = opts.contextState ?? contextState;
  // ASK-01: 本 turn 已使用的 ask_human 次数(每次 tool call 后递增)。
  // 预算超过时,工具结果尾部追加 ask budget 提示,不直接拒绝调用(更轻量,
  // 也避免和现有 permission 系统的"拒绝"语义重叠)。
  let askHumanCountThisTurn = 0;
  // NARR-01: 上一条 assistant 消息(带 tool_calls)超出旁白预算时,待注入的回压提示。
  // 只挂在本批次的第一条工具结果上并立即清空——重复注入会变成新的噪声源。
  let pendingNarrationHint: string | null = null;
  /** 取出并清空待注入的旁白回压提示(每批工具只消费一次)。 */
  const takeNarrationHint = (): string | null => {
    const hint = pendingNarrationHint;
    pendingNarrationHint = null;
    return hint;
  };
  // PROMPT-02: 解析 preCompletionChecklist 选项。undefined = 启用默认 middleware;
  // false = opt-out(checklist 自身调试用);function = 调用方自定义。
  const _checklistMiddleware = createPreCompletionChecklistMiddleware();
  const preCompletionChecklistHandler: PreCompletionChecklistHandler | null =
    opts.preCompletionChecklist === false
      ? null
      : (opts.preCompletionChecklist ?? _checklistMiddleware.handler);
  const maxSteps = opts.maxSteps ?? config.maxSteps;
  // 中断还原:repl 的 /plan / /auto / Shift+Tab 等用户面触发 setAgentMode 中途切了模式,
  // abort 时连同模式一起还原回轮首。模型不再持有 switch_mode 工具,无法自切。
  const savedMode = getAgentMode();
  // 本轮计时:从入口到完毕(正常 return / 达上限),供 finally 打 ✻ Worked for 摘要行。
  const t0 = Date.now();
  const traceSessionId = opts.traceContext?.sessionId ?? getCurrentSessionId() ?? `ephemeral-${process.pid}`;
  const traceTurnId = opts.traceContext?.turnId ?? getCurrentTurnId();
  let currentTraceStep: number | undefined;
  let abortTraced = false;
  const emitTrace = (
    type: TraceEventType,
    data: Record<string, unknown> = {},
    ids: Partial<Pick<AgentTraceEvent, 'step' | 'stepId' | 'toolCallId' | 'providerToolCallId'>> = {},
  ): void => {
    try {
      opts.onTraceEvent?.(createTraceEvent({
        sessionId: traceSessionId,
        turnId: traceTurnId,
        type,
        ...(currentTraceStep === undefined ? {} : {
          step: currentTraceStep,
          stepId: `${traceTurnId}:step:${currentTraceStep}`,
        }),
        ...ids,
        data,
      }));
    } catch {
      // Trace is best-effort and must never alter execution.
    }
  };
  emitTrace('turn_start', { mode: getAgentMode() });
  let done = false; // 正常完毕 / 达上限 true;中断 false(不显摘要)
  let traceStatus: AgentTurnTrace['status'] = 'error';
  let toolCallCount = 0;
  let latestValidation: ValidationResult | undefined;
  const initialMutationVersion = getCurrentTurnMutationState().version;
  let validatedMutationVersion = initialMutationVersion;
  let fullyValidatedMutationVersion = initialMutationVersion;
  const validator = opts.validator ?? createAutomaticValidator();
  // 本轮 token 累计:每步 chat() 返回后把 result.usage 累加,供 onDone 摘要行 + AgentRunResult.usage
  // 透传给 repl(显示在底栏模式 chip 右边)。未开启 include_usage 或全失败时为 undefined。
  let turnUsage: ChatUsage | undefined;
  const addUsage = (u: ChatUsage | undefined): void => {
    if (!u) return;
    turnUsage = turnUsage
      ? {
          promptTokens: turnUsage.promptTokens + u.promptTokens,
          completionTokens: turnUsage.completionTokens + u.completionTokens,
          totalTokens: turnUsage.totalTokens + u.totalTokens,
          cachedTokens: turnUsage.cachedTokens + u.cachedTokens,
          reasoningTokens: turnUsage.reasoningTokens + u.reasoningTokens,
        }
      : u;
  };
  const addToolUsage = (outcome: ToolOutcome): void => addUsage(outcome.usage);
  // Only consecutive identical failures are thrashing. Any success (including
  // a mutation between two reads) or different call resets the streak.
  const recordAndHint = createThrashTracker();
  history.push({ role: 'user', content: userInput });
  // 中断回滚快照:push 用户消息后整段浅拷贝。abort 时 length=0;push(...saved) 还原。
  // 这样中断时至少保留用户消息(及之前的历史);每步工具全部执行完毕后刷新快照,
  // 保留已完成的 assistant+tool_calls+tool 结果,只丢弃当前未完成步骤的消息。
  // 用 slice() 而非 length:maybeCompact 会原地重建(length=0;push(...rebuilt)),savedLen 会失效。
  let savedHistory = history.slice();
  // drop_context 工具的上下文剔除回调:闭包捕获 history,原地剔除无关旧 tool 结果。
  // 保护由 dropContextFromHistory 内部保证:history[0](system)+ 当前轮(最后 user 及其后)永不剔除。
  // 子 agent 也在自己的 history 上操作(子 agent 独立 history)，文件回滚事务则与主轮共享。
  const dropContext = (filter: DropContextFilter): DropContextResult =>
    dropContextFromHistory(history, filter);
  // 相关性裁剪 pruner:每个 runAgentCore 实例一个,纯静态、不调 LLM、自动判定 read_file 失效。
  // 开关关闭时为 null,所有 pushToolResult 调用走无 pruner 路径(零行为变化)。
  const relprune = config.contextRelprune ? createRelevancePruner() : null;
  // 观察者生命周期引擎:每个 runAgentCore 实例一个,纯静态、自动维护 grep/glob/web_search/web_fetch 等
  // producer 与 read/edit/write 的 consumer 引用关系;孤立+老化的非观察类工具自动 STUB。
  // 开关关闭时为 null,所有 pushToolResult / mutation 调用走无 lifecycle 路径(零行为变化)。
  // 引擎需要从已有会话 history 恢复观察结果的年龄和 path 索引；不能只追踪本次
  // runAgentCore，否则跨用户轮次的 grep/glob 永远不会衰减。
  let lifecycle: LifecycleEngine | null = config.contextLifecycle
    ? createLifecycleEngine(history)
    : null;
  runtimeContextState.lifecycleStats = lifecycle?.stats();
  rehydrateArtifacts(runtimeContextState, history);
  // 预算调度器:每个 runAgentCore 实例一个，在 age-aware sweep 后评估并执行 warn / compact。
  // contextBudget 开关关闭时为 null。
  const scheduler: BudgetScheduler | null = config.contextBudget !== false
    ? createBudgetScheduler(runtimeContextState) // 在 step 循环之外实例化一次,跨步持有 lastRunLog
    : null;
  // age-aware encoder 与 history 数组同寿命；每轮重建一次以覆盖外部 /compact 等原地修改。
  const ageAware = config.contextOptimize ? ageAwareStateFor(history) : null;
  ageAware?.rehydrate(history);
  // 本轮流式状态:首个正文 token 到达即停 spinner(思考期间 spinner 持续转「思考中…」,不写思考内容)。
  let mode: 'idle' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';
  // 早退重探:本 turn 已执行过工具但模型突然返回无工具调用 + 空文本 → 推一条提示让模型继续。
  // 短回复也可能是合法完成结果，不再按字符数误判；每 turn 最多触发 1 次以防死循环。
  let nudgeCount = 0;
  let hadToolsThisTurn = false;

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
  const abortRestore = (): void => {
    if (!abortTraced) {
      emitTrace('abort', { phase: 'observed', reason: 'signal' });
      abortTraced = true;
    }
    hooks.onAbort?.();
    history.length = 0;
    history.push(...savedHistory);
    ageAware?.rehydrate(history);
    setAgentMode(savedMode);
  };
  try {
    for (let step = 0; step < maxSteps; step++) {
      currentTraceStep = step;
      const stepStartedAt = Date.now();
      emitTrace('step_start', { ordinal: step });
      try {
      // 上一步工具被 abort 杀(run_command/web_fetch 等)→ signal.aborted,直接还原退出,不等 maybeCompact + chat()
      if (signal?.aborted) {
        abortRestore();
        traceStatus = 'aborted';
        const mutation = getCurrentTurnMutationState();
        return {
          completed: false,
          terminationReason: 'aborted',
          finalText: null,
          usage: turnUsage,
          validation: latestValidation,
          changedFiles: mutation.changedFiles.map((item) => item.path),
        };
      }
      // 本步只计算一次实际工具集合，调度、请求和 usage 校准必须使用完全相同的 schema。
      const activeTools = opts.toolsOverride
        ?? (getAgentMode() === 'plan' ? planChatTools : chatTools);
      const requestBaseURL = config.baseURL;
      const requestModel = config.model;
      const storedCalibration = getTokenCalibration(
        requestBaseURL,
        requestModel,
        activeTools,
      );
      runtimeContextState.correction = storedCalibration.correction;
      runtimeContextState.calibrationSamples = storedCalibration.samples;

      // 初次 tool push 只做保守编码；预算评估前先对 Cold 且 age 达阈值的旧结果降级，
      // 避免 scheduler 根据马上会被 sweep 的陈旧占用误触发 history compact。
      ageAware?.sweep(history, userTurnBoundary(history, HOT_TURN_WINDOW));

      // 步前:五区 Budget Scheduler 在优化后的 history 上决策；开关关闭时退化回原 maybeCompact 路径。
      // 此时 spinner 已停,通知行干净。
      let historyRebuilt = false;
      const compactStartedAt = Date.now();
      if (scheduler) {
        historyRebuilt = await scheduler.runStep(history, step, activeTools);
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
        ageAware?.rehydrate(history);
        rehydrateArtifacts(runtimeContextState, history);
      }
      hooks.onStepStart?.(); // 主 agent:spinner.start('思考中')
      mode = 'idle';
      gotText = false;
      lastChar = '';
      let result: ChatResult;
      const modelStartedAt = Date.now();
      const provider = safeProviderId(requestBaseURL);
      emitTrace('model_start', { model: requestModel, provider });
      const dynamicSystemSuffix = [
        opts.dynamicSystemSuffix?.().trim() ?? '',
        historyRebuilt
          ? '## Post-compaction recovery\nContext was compacted before this request. Re-establish the current objective and unresolved work from retained evidence or the session note, avoid repeating completed investigation, and re-read exact file context before any dependent edit.'
          : '',
      ].filter(Boolean).join('\n\n');
      const systemMessage = history[0];
      const requestHistory: ChatMessage[] =
        dynamicSystemSuffix
        && systemMessage?.role === 'system'
        && typeof systemMessage.content === 'string'
          ? [
              {
                ...systemMessage,
                content: `${systemMessage.content}\n\n${dynamicSystemSuffix}`,
              },
              ...history.slice(1),
            ]
          : history;
      try {
        result = await chat(
          requestHistory,
          {
            onText,
            onToolCall,
            onRetry: (retry) => emitTrace('model_retry', {
              model: requestModel,
              provider,
              attempt: retry.attempt,
              nextAttempt: retry.nextAttempt,
              waitMs: retry.waitMs,
              code: retry.code,
            }),
          },
          signal,
          activeTools,
        );
      } catch (e) {
        const errorValue = e && typeof e === 'object'
          ? e as { status?: number; code?: string; name?: string }
          : undefined;
        emitTrace('model_end', {
          model: requestModel,
          provider,
          status: signal?.aborted ? 'aborted' : 'error',
          code: typeof errorValue?.status === 'number'
            ? `HTTP_${errorValue.status}`
            : errorValue?.code ?? errorValue?.name ?? 'MODEL_ERROR',
          durationMs: Date.now() - modelStartedAt,
        });
        // 中断(用户运行中 Ctrl+C):chat() 抛 AbortError(signal.aborted)→ 还原 history + 模式 + return(不抛)。
        // 工具执行现已串 signal:run_command/web_fetch 被 abort 即时杀,循环顶检查兜底(不会留未配对 tool_call_id)。
        if (
          signal?.aborted ||
          (e instanceof Error &&
            (e.name === 'AbortError' || e.name === 'APIUserAbortError'))
        ) {
          abortRestore();
          traceStatus = 'aborted';
          const mutation = getCurrentTurnMutationState();
          return {
            completed: false,
            terminationReason: 'aborted',
            finalText: null,
            usage: turnUsage,
            validation: latestValidation,
            changedFiles: mutation.changedFiles.map((item) => item.path),
          };
        }
        throw e;
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
      addUsage(result.usage); // 本轮累计:onDone 摘要行 + AgentRunResult.usage 透传
      // 用本次实际发送的 tools 计算分母，再以 EWMA 更新 provider/model/tool-set 校准。
      // 只持久化比例与样本数；无 usage 或短 prompt 时保持既有值。
      if (result.usage?.promptTokens && result.usage.promptTokens > 100) {
        const estimated = estimatePromptTokens(requestHistory, activeTools);
        const updated = updateTokenCalibration(
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
        toolCallCount += result.toolCalls.length;
        hadToolsThisTurn = true;
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

        // NARR-01: 这条 assistant 消息同时带正文 + tool_calls,即"工具轮旁白"。
        // prompt 里的"工具轮保持静默"只是软约束,这里补上机制层:
        //   - 永远 emit trace(旁白率可度量,不再靠肉眼感觉);
        //   - 超预算时把回压提示挂到本批第一条工具结果尾部(复用 thrash/ask
        //     budget 已验证的注入接缝,不新增消息、不打断工具流)。
        const narration = classifyNarration(result.content, result.toolCalls.length);
        if (narration) {
          emitTrace('narration', {
            chars: narration.chars,
            toolCalls: result.toolCalls.length,
            budget: NARRATION_CHAR_BUDGET,
            overBudget: narration.overBudget,
            step,
          });
          pendingNarrationHint = narration.hint;
        }

        // 工具分组执行(保 tool_calls 原顺序)：safe parallel 工具照常并发；连续
        // resource-locked mutation 先按序完成权限预检，再按 canonical resource lock 启动。
        // registry 对所有真实资源访问统一持锁，所以不同 Agent 间的 read/write/process 也不会竞态。
        // 串行工具仍是本调用列表内的屏障；渲染/history 回灌始终按原 tool_calls 顺序。
        // executeToolOutcome 永不抛错，失败通过结构化 status/code 返回。
        const calls = result.toolCalls;
        const tracedCalls = calls.map((tc, index) => ({
          toolCallId: `${traceTurnId}:step:${step}:tool:${index}`,
          args: summarizeToolArguments(tc.arguments),
        }));
        for (let index = 0; index < calls.length; index++) {
          const tc = calls[index];
          const traceCall = tracedCalls[index];
          emitTrace('tool_call_start', {
            tool: tc.name,
            argumentHash: traceCall.args.sha256,
            arguments: traceCall.args,
            attempt: 1,
            retry: 0,
          }, {
            toolCallId: traceCall.toolCallId,
            ...(tc.id ? { providerToolCallId: tc.id } : {}),
          });
        }
        const traceToolRetry = (tc: ToolCallRef, index: number, retry: ToolRetryInfo): void => {
          const traceCall = tracedCalls[index];
          emitTrace('tool_retry', {
            tool: tc.name,
            argumentHash: traceCall.args.sha256,
            attempt: retry.attempt,
            nextAttempt: retry.nextAttempt,
            waitMs: retry.waitMs,
            code: retry.code,
          }, {
            toolCallId: traceCall.toolCallId,
            ...(tc.id ? { providerToolCallId: tc.id } : {}),
          });
        };
        const traceToolEnd = (tc: ToolCallRef, index: number, outcome: ToolOutcome): void => {
          const traceCall = tracedCalls[index];
          emitTrace('tool_call_end', {
            tool: tc.name,
            argumentHash: traceCall.args.sha256,
            status: outcome.status,
            code: outcome.code,
            retryable: outcome.retryable,
            durationMs: outcome.durationMs ?? 0,
            attempt: outcome.attempts ?? 1,
            retry: Math.max(0, (outcome.attempts ?? 1) - 1),
            retryDelayMs: outcome.retryDelayMs ?? 0,
            changedFiles: outcome.changedFiles ?? [],
            staleFiles: outcome.staleFiles ?? [],
            ...(outcome.changeSet ? { changeSet: outcome.changeSet } : {}),
            ...(outcome.usage ? { nestedUsage: outcome.usage } : {}),
          }, {
            toolCallId: traceCall.toolCallId,
            ...(tc.id ? { providerToolCallId: tc.id } : {}),
          });
        };
        let i = 0;
        while (i < calls.length) {
          const currentCall = calls[i];
          if (getRuntimeDisabledTools().has(currentCall.name)) {
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
            const hint = recordAndHint(currentCall.name, currentCall.arguments, false);
            pushToolResult(
              history,
              currentCall,
              hint ? `${error}${hint}` : error,
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
          if (isParallelTool(currentCall.name)) {
            // 收集连续只读组(≥1),并发执行:先渲染所有 header，再一次性启动所有
            // (executeTool 调用即开始 I/O)，最后按原顺序逐个 await + 回灌。
            // 必须先 header 后 execute：grep 等同步快速工具会在 executeTool 返回 Promise 前
            // 已经完成；若先 started.map，用户只能在工具完成后才看到摘要与其前面的换行。
            // 异步工具(web_fetch 等)并发跑、总耗时 ≈ 最慢一个;同步工具(glob/grep)map 时已顺序跑完,await 即返。
            let j = i;
            while (j < calls.length && isParallelTool(calls[j].name)) j++;
            const batch = calls.slice(i, j);
            for (const tc of batch) hooks.onToolHeader?.(tc);
            hooks.onToolStart?.(batch[0].name);
            const started = batch.map((tc, offset) => executeToolOutcome(
              tc.name,
              tc.arguments,
              signal,
              {
                dropContext,
                onRetry: (retry) => traceToolRetry(tc, i + offset, retry),
              },
            ));
            for (let k = 0; k < batch.length; k++) {
              const tc = batch[k];
              const outcome = await started[k];
              addToolUsage(outcome);
              opts.onToolOutcome?.(tc.name, parseArgs(tc.arguments) ?? {}, outcome);
              traceToolEnd(tc, i + k, outcome);
              const output = outcome.output;
              hooks.onToolResult?.(tc, output, null, null, 1); // 并行工具无 diff
              // Thrashing:history 里附 hint(UI 已用干净 output 渲染,避免屏幕噪声)
              const hint = recordAndHint(tc.name, tc.arguments, outcome.status === 'success');
              const { output: annotated, reflectionCategory } = appendRetryAnnotations(output, outcome.status, outcome.code, hint);
              // QUAL-01 trace 硬事件:反思指针注入计数(history 文本扫描会因 LLM 在
              // 正文里提一句 "[retry reflection]" 而误算,改用 core 接缝处显式 emit)。
              if (reflectionCategory !== null) {
                emitTrace('retry_reflection', {
                  tool: tc.name,
                  code: outcome.code,
                  category: reflectionCategory,
                  attempt: outcome.attempts ?? 1,
                }, tc.id ? { providerToolCallId: tc.id } : {});
              }
              // ASK-01: 计数 + 预算提示
              if (tc.name === 'ask_human' && outcome.status === 'success') {
                askHumanCountThisTurn += 1;
                // QUAL-01 trace 硬事件:ask_human 真实调用计数(取代 tool_call_end.name 推断)。
                emitTrace('ask_human_call', {
                  tool: tc.name,
                  status: outcome.status,
                  perTurnCount: askHumanCountThisTurn,
                }, tc.id ? { providerToolCallId: tc.id } : {});
              }
              const askBudget = askHumanBudgetAnnotation(askHumanCountThisTurn, outcome.status);
              // NARR-01: 旁白回压提示只挂本批第一条结果(takeNarrationHint 自清空)。
              const narrationHint = takeNarrationHint();
              const finalOutput = `${annotated}${askBudget ?? ''}${narrationHint ?? ''}`;
              pushToolResult(
                history,
                tc,
                finalOutput,
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
            !(getAgentMode() === 'plan' && getPlanDisabledTools().has(currentCall.name))
          ) {
            // 连续文件 mutation：权限确认仍严格按原序进行；全部 preflight 完成后再启动。
            // 每个执行在 registry 内按 canonical path 获取锁，不同文件可并发，同文件别名会排队。
            let j = i;
            while (
              j < calls.length &&
              isResourceLockedCall(calls[j]) &&
              !getRuntimeDisabledTools().has(calls[j].name) &&
              !(getAgentMode() === 'plan' && getPlanDisabledTools().has(calls[j].name))
            ) j++;
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
              const tool = tools.find((candidate) => candidate.name === tc.name);
              const argumentsValid = tool && parsed !== null
                ? validateToolArguments(tool, parsed).valid
                : false;
              let denied: ToolOutcome | undefined;
              if (tool && argumentsValid) {
                const perm = await checkPermission(tool, parsed ?? {}, signal, {
                  prompt: opts.permissionPrompt,
                });
                emitTrace('permission', {
                  source: 'agent_tool',
                  tool: tc.name,
                  decision: perm,
                  argumentHash: tracedCalls[i + k].args.sha256,
                }, {
                  toolCallId: tracedCalls[i + k].toolCallId,
                  ...(tc.id ? { providerToolCallId: tc.id } : {}),
                });
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
            const started = entries.map((entry, offset) => entry.denied
              ? Promise.resolve(entry.denied)
              : executeToolOutcome(entry.tc.name, entry.tc.arguments, signal, {
                  dropContext,
                  onLockAcquired: (lockedArgs) => {
                    entry.diff = readDiffContext(entry.tc, lockedArgs);
                  },
                  onRetry: (retry) => traceToolRetry(entry.tc, i + offset, retry),
                }));

            for (let k = 0; k < entries.length; k++) {
              const entry = entries[k];
              const outcome = await started[k];
              addToolUsage(outcome);
              opts.onToolOutcome?.(entry.tc.name, entry.parsed ?? {}, outcome);
              traceToolEnd(entry.tc, i + k, outcome);
              hooks.onToolResult?.(
                entry.tc,
                outcome.output,
                entry.denied ? null : entry.parsed,
                entry.diff.preWriteOld,
                entry.diff.editStartLine,
              );
              const hint = recordAndHint(entry.tc.name, entry.tc.arguments, outcome.status === 'success');
              pushToolResult(
                history,
                entry.tc,
                hint ? `${outcome.output}${hint}` : outcome.output,
                relprune,
                lifecycle,
                scheduler,
                runtimeContextState,
                outcome.status === 'success',
              );
              const invalidatedFiles = [...new Set([
                ...(outcome.changedFiles ?? []),
                ...(outcome.staleFiles ?? []),
              ])];
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
            if (getAgentMode() === 'plan' && getPlanDisabledTools().has(tc.name)) {
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
              // Thrashing:同上
              const hint = recordAndHint(tc.name, tc.arguments, false);
              pushToolResult(history, tc, hint ? `${err}${hint}` : err, relprune, lifecycle, scheduler);
              traceToolEnd(tc, i, outcome);
              i++;
              continue;
            }
            // 权限预检查:在渲染 ● 头之前弹确认面板(体验:先问再执行,而非执行完再问)。
            // 拒绝时只渲染拒绝结果,不渲染执行头;放行则继续走 header → start → executeTool 流程。
            const parsed = parseArgs(tc.arguments);
            const tool = tools.find((t) => t.name === tc.name);
            const argumentsValid = tool && parsed !== null
              ? validateToolArguments(tool, parsed).valid
              : false;
            if (tool && argumentsValid) {
              const perm = await checkPermission(tool, parsed ?? {}, signal, {
                prompt: opts.permissionPrompt,
              });
              emitTrace('permission', {
                source: 'agent_tool',
                tool: tc.name,
                decision: perm,
                argumentHash: tracedCalls[i].args.sha256,
              }, {
                toolCallId: tracedCalls[i].toolCallId,
                ...(tc.id ? { providerToolCallId: tc.id } : {}),
              });
              if (perm === 'deny') {
                hooks.onToolHeader?.(tc);
                const outcome = deniedOutcome(tc.name);
                hooks.onToolResult?.(tc, outcome.output, null, null, 1);
                const hint = recordAndHint(tc.name, tc.arguments, false);
                pushToolResult(
                  history,
                  tc,
                  hint ? `${outcome.output}${hint}` : outcome.output,
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
            const mutationParsed = isMutationTool(tc.name)
              ? parsed
              : null;
            let diff = readDiffContext(tc, mutationParsed);
            hooks.onToolStart?.(tc.name);
            const outcome = await executeToolOutcome(tc.name, tc.arguments, signal, {
              dropContext,
              onLockAcquired: (lockedArgs) => {
                if (mutationParsed) diff = readDiffContext(tc, lockedArgs);
              },
              onRetry: (retry) => traceToolRetry(tc, i, retry),
            });
            addToolUsage(outcome);
            opts.onToolOutcome?.(tc.name, parsed ?? {}, outcome);
            traceToolEnd(tc, i, outcome);
            const output = outcome.output;
            hooks.onToolDone?.();
            hooks.onToolResult?.(tc, output, mutationParsed, diff.preWriteOld, diff.editStartLine);
            // Thrashing:同上(history 附 hint,UI 干净)
            const hint = recordAndHint(tc.name, tc.arguments, outcome.status === 'success');
            // RETRY-01: 同 parallel 路径,在非成功状态追加反思指针。
            const { output: annotated, reflectionCategory } = appendRetryAnnotations(output, outcome.status, outcome.code, hint);
            // QUAL-01 trace 硬事件:反思指针注入计数(history 文本扫描会因 LLM 在
            // 正文里提一句 "[retry reflection]" 而误算,改用 core 接缝处显式 emit)。
            if (reflectionCategory !== null) {
              emitTrace('retry_reflection', {
                tool: tc.name,
                code: outcome.code,
                category: reflectionCategory,
                attempt: outcome.attempts ?? 1,
              }, tc.id ? { providerToolCallId: tc.id } : {});
            }
            // ASK-01: ask_human 计数 + 预算提示(同 parallel 路径)。
            if (tc.name === 'ask_human' && outcome.status === 'success') {
              askHumanCountThisTurn += 1;
              // QUAL-01 trace 硬事件:ask_human 真实调用计数(取代 tool_call_end.name 推断)。
              emitTrace('ask_human_call', {
                tool: tc.name,
                status: outcome.status,
                perTurnCount: askHumanCountThisTurn,
              }, tc.id ? { providerToolCallId: tc.id } : {});
            }
            const askBudget = askHumanBudgetAnnotation(askHumanCountThisTurn, outcome.status);
            // NARR-01: 旁白回压提示只挂本批第一条结果(takeNarrationHint 自清空)。
            const narrationHint = takeNarrationHint();
            const finalOutput = `${annotated}${askBudget ?? ''}${narrationHint ?? ''}`;
            pushToolResult(
              history,
              tc,
              finalOutput,
              relprune,
              lifecycle,
              scheduler,
              runtimeContextState,
              outcome.status === 'success',
            );
            const invalidatedFiles = [...new Set([
              ...(outcome.changedFiles ?? []),
              ...(outcome.staleFiles ?? []),
            ])];
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
        // 工具步末尾补一空行:与下一轮的思考 / 正文分隔(否则 ↳ 后紧接 ▎ 思考,无空行不好看;
        // 与正文→● 的 1 空行对称)。工具结果已以 \n 收尾,此处再补 \n 恰好 1 空行。
        hooks.onToolBatchEnd?.();
        // 刷新中断快照:工具全部执行完毕后,history 处于一致状态(assistant+tool_calls+tool 结果完整),
        // 此时中断可安全保留这些已完成的消息,只丢弃下一轮未完成的 chat() 响应。
        savedHistory = history.slice();
        continue; // 带着工具结果再调一次 LLM
      }

      if (mode !== 'idle' && lastChar !== '\n') hooks.onTextEnd?.(); // 流式末尾补换行

      // 早退保护:本 turn 已执行过工具调用,但模型突然返回无工具 + 极短/空文本 → 很可能是在探索中途
      // 提前"说完了"。此时推一条 user 提示消息让模型继续探索,而非直接退出。每 turn 最多 1 次,防死循环。
      // 早退重探只处理真正的空回复。短回复可能是合法完成结果（例如精确状态标记）；
      // 仅凭字符数继续调用会重复输出，并产生一次完整的额外模型请求。
      const replyIsEmpty = (result.content?.trim().length ?? 0) === 0;
      if (hadToolsThisTurn && nudgeCount < 1 && replyIsEmpty) {
        nudgeCount++;
        history.push({ role: 'assistant', content: result.content });
        history.push({
          role: 'user',
          content: 'You stopped before completing the task. Please continue investigating — call more tools if needed, or provide a complete answer based on what you have gathered so far.',
        });
        continue; // 带着提示再调一次 LLM
      }

      // 没有工具调用:候选正文已流式打印。若本轮有新的代码变更，先通过框架验证门；
      // failed 作为 system observation 风格的 user 消息回灌，不能伪造无配对的 tool 消息。
      if (!gotText) hooks.onNoReply?.();
      const candidate = { role: 'assistant' as const, content: result.content } as ChatMessage;
      const mutationBeforeValidation = getCurrentTurnMutationState();
      const shouldValidate =
        opts.autoValidate === true &&
        getAgentMode() !== 'plan' &&
        (mutationBeforeValidation.version > validatedMutationVersion || latestValidation?.status === 'failed');

      if (shouldValidate) {
        history.push(candidate);
        emitTrace('validation_start', {
          mutationVersion: mutationBeforeValidation.version,
          changedFiles: mutationBeforeValidation.changedFiles.map((item) => item.path),
        });
        try {
          latestValidation = await validator(signal, {
            onCommandStart: (command) => hooks.onValidationStart?.(command),
            onPermissionDecision: (permission) => {
              const summary = summarizeToolArguments(JSON.stringify(permission.arguments));
              emitTrace('permission', {
                source: 'automatic_validation',
                tool: permission.tool,
                decision: permission.decision,
                argumentHash: summary.sha256,
              });
            },
          });
        } catch (error) {
          const mutation = getCurrentTurnMutationState();
          const message = `Automatic validation failed to run: ${error instanceof Error ? error.message : String(error)}`;
          const status = signal?.aborted ? 'aborted' : 'failed';
          latestValidation = {
            status,
            level: 'V0',
            output: message,
            durationMs: 0,
            diagnostics: [{
              level: 'V0', source: 'verifier', severity: 'error', code: 'VERIFIER_ERROR', message,
            }],
            stages: [],
            verificationComplete: false,
            fingerprint: `verifier-error-${mutation.version}`,
            inputFingerprint: `mutation-${mutation.version}`,
            inputMutationVersion: mutation.version,
            affectedPackages: [],
            changedFiles: mutation.changedFiles.map((item) => item.path),
            mutationVersion: mutation.version,
          };
        }
        emitTrace('validation_end', {
          status: latestValidation.status,
          level: latestValidation.level,
          durationMs: latestValidation.durationMs,
          verificationComplete: latestValidation.verificationComplete,
          skipReason: latestValidation.skipReason,
          fingerprint: latestValidation.fingerprint,
          mutationVersion: latestValidation.mutationVersion,
          stages: latestValidation.stages.map((stage) => ({
            level: stage.level,
            status: stage.status,
            adapter: stage.adapter,
            code: stage.diagnostics[0]?.code,
            durationMs: stage.durationMs,
            cached: stage.cached === true,
          })),
        });
        hooks.onValidationResult?.(latestValidation);
        validatedMutationVersion = latestValidation.mutationVersion;
        if (latestValidation.status === 'passed' && latestValidation.verificationComplete) {
          fullyValidatedMutationVersion = latestValidation.mutationVersion;
        }

        if (signal?.aborted || latestValidation.status === 'aborted') {
          abortRestore();
          traceStatus = 'aborted';
          const mutation = getCurrentTurnMutationState();
          return {
            completed: false,
            terminationReason: 'aborted',
            finalText: null,
            usage: turnUsage,
            validation: latestValidation,
            changedFiles: mutation.changedFiles.map((item) => item.path),
          };
        }

        if (latestValidation.status === 'failed') {
          history.push({
            role: 'user',
            content:
              '[System observation: automatic validation failed]\n' +
              `Command: ${latestValidation.command ?? '(internal verifier)'}\n` +
              `${latestValidation.output}\n\n` +
              'Fix the reported problem, then finish the task. Do not claim success until validation passes.',
          });
          // 验证及其失败观察均已完整落入 history；下一步中断时可安全保留。
          savedHistory = history.slice();
          continue;
        }
      } else {
        // PROMPT-02: 硬关卡 — 收尾路径上,如果本 turn 有 mutation 且未通过
        // validation(autoValidate=false / 验证已 passed 但 LLM 又宣称完成),
        // 推一条 [checklist] user 消息,强制模型再走一轮显式确认。
        // 防死循环:checklist 已推过 2 次仍无新工具调用 → 放行(走原本的 push)。
        const finalMutationForChecklist = getCurrentTurnMutationState();
        const checklistCtx: ChecklistContext = {
          hadMutation: finalMutationForChecklist.version > 0,
          lastValidationStatus: (latestValidation?.status === 'failed' || latestValidation?.status === 'passed')
            ? latestValidation.status
            : 'none',
          mode: getAgentMode(),
          modelFamily: inferModelFamily(config.model),
        };
        const checklistRetryCount = (history as { __checklistStreak?: number }).__checklistStreak ?? 0;
        const shouldFireChecklist = preCompletionChecklistHandler !== null
          && preCompletionChecklistHandler(checklistCtx)
          && checklistRetryCount < 2;
        if (shouldFireChecklist) {
          history.push(candidate);
          history.push({
            role: 'user',
            content: _checklistMiddleware.buildUserMessage(checklistCtx.modelFamily),
          });
          (history as { __checklistStreak?: number }).__checklistStreak = checklistRetryCount + 1;
          // QUAL-01 trace 硬事件:PROMPT-02 触发计数(取代 history 文本扫描
          // [checklist] marker — LLM 在正文里提一句 "[checklist]" 也会被误算)。
          emitTrace('checklist_triggered', {
            streak: checklistRetryCount + 1,
            validationStatus: checklistCtx.lastValidationStatus,
            hadMutation: checklistCtx.hadMutation,
            modelFamily: checklistCtx.modelFamily ?? 'other',
          });
          // 重要: 不置 done,让主循环继续下一轮(模型被迫用工具或写出可验证声明)。
          continue;
        }
        history.push(candidate);
      }

      const finalMutation = getCurrentTurnMutationState();
      done = true;
      traceStatus = 'completed';
      const verified = finalMutation.version <= fullyValidatedMutationVersion;
      return {
        completed: true,
        terminationReason: verified ? 'completed' : 'completed_unverified',
        finalText: result.content,
        usage: turnUsage,
        validation: latestValidation,
        changedFiles: finalMutation.changedFiles.map((item) => item.path),
        history: history.slice(),
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
    const finalMutation = getCurrentTurnMutationState();
    const hasUnverifiedChanges = finalMutation.version > fullyValidatedMutationVersion;
    return {
      completed: false,
      terminationReason: hasUnverifiedChanges ? 'unverified_changes' : 'max_steps',
      finalText: null,
      usage: turnUsage,
      validation: latestValidation,
      changedFiles: finalMutation.changedFiles.map((item) => item.path),
      history: history.slice(),
    };
  } finally {
    const finalMutation = getCurrentTurnMutationState();
    currentTraceStep = undefined;
    emitTrace('turn_end', {
      status: traceStatus,
      durationMs: Date.now() - t0,
      toolCalls: toolCallCount,
      changedFiles: finalMutation.changedFiles.map((item) => item.path),
      totalTokens: turnUsage?.totalTokens,
      validationStatus: latestValidation?.status,
    });
    try {
      opts.onTrace?.({
        ts: new Date().toISOString(),
        sessionId: traceSessionId,
        turnId: traceTurnId,
        status: traceStatus,
        durationMs: Date.now() - t0,
        toolCalls: toolCallCount,
        changedFiles: finalMutation.changedFiles.map((item) => item.path),
        usage: turnUsage,
        validation: latestValidation,
      });
    } catch {
      // Trace is best-effort and must not change the turn result.
    }
    // 跑完(正常 / 达上限)在回复末尾打耗时摘要行;中断 done=false 不打。
    if (done) {
      hooks.onDone?.(Date.now() - t0, turnUsage);
    }
  }
}

// ── 导出共享辅助(主 agent 的 TUI hooks 实现要用)──────────────────────────
export { parseArgs, readDiffContext, isMutationTool, isParallelTool };
