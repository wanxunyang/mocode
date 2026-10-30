import type OpenAI from 'openai';
import type { ChatMessage, ChatUsage, ToolCallRef } from '../llm/index.js';
import type { PermissionCheckOptions } from '../permissions/index.js';
import type { ContextState } from '../session/compact.js';
import type { AgentTraceEvent, AgentTurnTrace } from '../session/trace.js';
import type { ToolOutcome } from '../tools/registry.js';
import type { ToolPolicyController } from '../tools/policy.js';
import type { AgentRuntimeContext } from './runtime-context.js';
import type { AgentPipeline, AgentStageImplementation, AgentStageName } from './stages/contracts.js';

/** 工具调用渲染所需的稳定视图。 */
export interface ToolCallView {
  name: string;
  arguments: string;
  id: string;
}

/** Agent 循环的展示副作用接缝；所有方法均可选。 */
export interface AgentHooks {
  onText?: (delta: string) => void;
  onToolCall?: (name: string) => void;
  onStepStart?: () => void;
  /**
   * 上下文压缩导致 history 被原地重建后触发(每个 step 至多一次,overflow 重试重建时也会触发)。
   * 展示层据此收口压缩前的工具调用批次,使压缩后的工具调用另起新批,
   * 而不是并入压缩行之前那个仍未 flush 的 currentBatch。
   */
  onHistoryRebuilt?: () => void;
  onLiveUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
  }) => void;
  onChatDone?: () => void;
  /** 一次 chat 失败后即将退避重试(429/5xx/网络错/流中途故障)。宿主可据此给出可见反馈,
   *  否则用户面对的是长达数十秒的「无解释等待」。 */
  onModelRetry?: (info: { attempt: number; nextAttempt: number; waitMs: number; code: string }) => void;
  /** 请求体字节预算触发的「图片 → 文字卡」压缩。start 在描述请求发出前,done 在替换完成后(replaced=0 表示未改动)。 */
  onImageRelief?: (
    info:
      | { phase: 'start'; images: number; bytes: number }
      | { phase: 'done'; replaced: number; described: number; bytesBefore: number; bytesAfter: number },
  ) => void;
  onTextEnd?: () => void;
  onToolHeader?: (tc: ToolCallRef) => void;
  onToolStart?: (name: string) => void;
  onToolOutput?: (tc: ToolCallRef, chunk: string) => void;
  onToolDone?: () => void;
  onToolResult?: (
    tc: ToolCallRef,
    output: string,
    parsed: Record<string, unknown> | null,
    preWriteOld: string | null,
    editStartLine: number,
    /** edit_file replacements[] 模式:每个替换段一个 diff hunk;缺省按单段 old/new 渲染。 */
    multiHunks?: ReadonlyArray<{ oldStr: string; newStr: string; startLine: number }>,
  ) => void;
  onToolBatchEnd?: () => void;
  /** D3: after each committed tool batch, checkpoint full history for resume. */
  onCheckpoint?: (history: ChatMessage[]) => void;
  onNoReply?: () => void;
  onMaxSteps?: () => void;
  onAbort?: () => void;
  onDone?: (elapsedMs: number, usage?: ChatUsage) => void;
}

/** OpenAI content array 的受支持子集。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type AgentTerminationReason = 'completed' | 'aborted' | 'max_steps';

export interface AgentRunResult {
  completed: boolean;
  terminationReason: AgentTerminationReason;
  finalText: string | null;
  usage?: ChatUsage;
  changedFiles?: string[];
}

export interface AgentRunOptions {
  history: ChatMessage[];
  pipeline?: AgentPipeline;
  stageOverrides?: Partial<Record<AgentStageName, AgentStageImplementation>>;
  userInput: string | ContentPart[];
  signal?: AbortSignal;
  onContextUpdate?: () => void;
  hooks: AgentHooks;
  maxSteps?: number;
  toolsOverride?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolPolicy?: ToolPolicyController;
  initialToolRoute?: Record<string, unknown>;
  runtimeAllowedToolNames?: ReadonlySet<string>;
  contextState?: ContextState;
  /** D3: resume — do not append userInput as a new user turn; loop starts from existing history. */
  continueFromHistory?: boolean;
  runtimeContext?: AgentRuntimeContext;
  permissionPrompt?: PermissionCheckOptions['prompt'];
  onTrace?: (trace: AgentTurnTrace) => void;
  onTraceEvent?: (event: AgentTraceEvent) => void;
  traceContext?: { sessionId?: string; turnId?: number };
  onToolOutcome?: (tool: string, args: Record<string, unknown>, outcome: ToolOutcome) => void;
  suppressOpeningAnalysis?: boolean;
  suppressSessionState?: boolean;
  /**
   * R17:会话内记忆尾注。由调用方每个用户轮现算一次(基线差分),作为 ephemeral
   * system 段追加在 history 末尾——**绝不重建 history[0]**,否则整段对话的前缀缓存每轮失效。
   * 空串/undefined 时零注入。
   */
  memoryTail?: string;
}
