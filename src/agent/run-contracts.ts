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
  onLiveUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
  }) => void;
  onChatDone?: () => void;
  onTextEnd?: () => void;
  onToolHeader?: (tc: ToolCallRef) => void;
  onToolStart?: (name: string) => void;
  onToolDone?: () => void;
  onToolResult?: (
    tc: ToolCallRef,
    output: string,
    parsed: Record<string, unknown> | null,
    preWriteOld: string | null,
    editStartLine: number,
  ) => void;
  onToolBatchEnd?: () => void;
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
  runtimeContext?: AgentRuntimeContext;
  permissionPrompt?: PermissionCheckOptions['prompt'];
  onTrace?: (trace: AgentTurnTrace) => void;
  onTraceEvent?: (event: AgentTraceEvent) => void;
  traceContext?: { sessionId?: string; turnId?: number };
  onToolOutcome?: (tool: string, args: Record<string, unknown>, outcome: ToolOutcome) => void;
  suppressOpeningAnalysis?: boolean;
  suppressSessionState?: boolean;
}
