import type OpenAI from 'openai';
import type { AgentMode } from '../mode.js';
import type { ChatMessage, ChatResult, ChatUsage, ToolCallRef } from '../../llm/index.js';
import type { AgentTraceEvent } from '../../session/trace.js';
import type { SafeArgumentSummary } from '../../session/index.js';
import type { ToolOutcome } from '../../tools/types.js';
import type { ToolPolicyExpansion, ToolPolicySnapshot } from '../../tools/policy.js';
import type { PermissionCheckOptions } from '../../permissions/index.js';

/** Runtime pipeline selection during the staged migration. */
export type AgentPipeline = 'legacy' | 'staged';

/** Stable stage identities used by assembly and per-stage rollback. */
export const AGENT_STAGE_NAMES = [
  'history',
  'model',
  'tools',
  'context',
  'trace',
  'usage',
  'cancellation',
  'termination',
  'capabilities',
] as const;
export type AgentStageName = (typeof AGENT_STAGE_NAMES)[number];
export type AgentStageImplementation = 'legacy' | 'staged';

export interface ReadonlyHistorySnapshot {
  readonly revision: number;
  readonly messages: readonly ChatMessage[];
}

export interface HistoryCheckpoint extends ReadonlyHistorySnapshot {}

export interface HistoryInit {
  messages: ChatMessage[];
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: readonly ToolCallRef[];
}

export interface OrderedToolCallResult {
  call: ToolCallRef;
  outcome: ToolOutcome;
}

export interface HistoryBatchTransaction {
  /** Migration-only mutable view used by the existing dispatcher and metadata recorders. */
  readonly workingMessages: ChatMessage[];
  /** Atomically publishes all ordered tool results followed by the optional user attachment. */
  commit(attachment?: ChatMessage): void;
  /** Settles an unfinished batch; staged mode discards its unpublished shadow. */
  rollback(): void;
}

export interface CompactedHistory {
  messages: readonly ChatMessage[];
}

/** Persistent protocol ledger. Tool calls are public before their result batch is assembled. */
export interface HistoryManager {
  snapshot(): ReadonlyHistorySnapshot;
  appendUserTurn(content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content']): void;
  appendAssistantTurn(turn: AssistantTurn): void;
  beginToolBatch(calls: readonly ToolCallRef[]): HistoryBatchTransaction;
  replaceAfterCompaction(result: CompactedHistory): void;
  createCheckpoint(): HistoryCheckpoint;
  restore(checkpoint: HistoryCheckpoint): void;
  /** Narrow bridge for the legacy scheduler/compact implementation during staged migration. */
  withLegacyMutableHistory<T>(operation: (messages: ChatMessage[]) => T | Promise<T>): Promise<T>;
}

export interface ModelStreamHandlers {
  onText?(delta: string): void;
  onToolCall?(name: string): void;
  onProgress?(usage: { completionTokens: number; promptTokens?: number; cachedTokens?: number }): void;
  onRetry?(retry: { attempt: number; nextAttempt: number; waitMs: number; code: string }): void;
}

export interface ModelRequest {
  readonly history: readonly ChatMessage[];
  readonly tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  readonly handlers: ModelStreamHandlers;
}

/** Executes one immutable model request and never mutates persistent history. */
export interface ModelRunner {
  readonly implementation: AgentStageImplementation;
  run(request: ModelRequest, signal?: AbortSignal): Promise<ChatResult>;
}

export interface RunPolicySnapshot {
  readonly mode: AgentMode;
  readonly tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  readonly allowedToolNames: ReadonlySet<string>;
  readonly toolPolicy?: ToolPolicySnapshot;
  readonly reminder: string;
}

export interface CapabilityRequest {
  readonly mode: AgentMode;
  readonly toolsOverride?: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  readonly toolPolicy?: ToolPolicySnapshot;
  readonly defaultTools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  readonly runtimeAllowedToolNames?: ReadonlySet<string>;
  readonly skillDisabledToolNames: ReadonlySet<string>;
  readonly legacyDisabledToolNames: ReadonlySet<string>;
  readonly useLegacyDisabledFallback: boolean;
  readonly reminder: string;
}

export interface CapabilityResolver {
  readonly implementation: AgentStageImplementation;
  resolve(request: CapabilityRequest): RunPolicySnapshot;
}

export interface ToolDelegationSnapshot {
  readonly history: ChatMessage[];
  readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

export interface ToolDiffContext {
  readonly preWriteOld: string | null;
  readonly editStartLine: number;
}

export interface ToolDispatchRequest {
  readonly calls: readonly ToolCallRef[];
  readonly policy: RunPolicySnapshot;
  readonly signal?: AbortSignal;
  readonly permissionPrompt?: PermissionCheckOptions['prompt'];
  readonly isDenied: (name: string) => boolean;
  readonly currentAllowedToolNames: () => string[];
  readonly delegation: () => ToolDelegationSnapshot;
  readonly argumentErrorHint: (name: string) => string | undefined;
  readonly expandToolGroups?: (groups: readonly unknown[], reason: string) => ToolPolicyExpansion;
  /** Synchronous live publication; throwing stops dispatch at the same point as the legacy hook. */
  readonly onEvent: (event: ToolDispatchEvent) => void;
}

export type ToolDispatchEvent =
  | {
      readonly type: 'call_start';
      readonly call: ToolCallRef;
      readonly callIndex: number;
      readonly argumentSummary: SafeArgumentSummary;
    }
  | {
      readonly type: 'permission';
      readonly call: ToolCallRef;
      readonly callIndex: number;
      readonly decision: 'allow' | 'deny';
    }
  | {
      readonly type: 'route_expand';
      readonly fromVersion?: number;
      readonly expansion: ToolPolicyExpansion;
      readonly requestedGroups: readonly unknown[];
      readonly reason: string;
      readonly status: ToolOutcome['status'];
    }
  | { readonly type: 'header'; readonly call: ToolCallRef }
  | { readonly type: 'start'; readonly tool: string }
  | { readonly type: 'done' }
  | { readonly type: 'usage'; readonly usage: ChatUsage | undefined }
  | {
      readonly type: 'host_outcome';
      readonly call: ToolCallRef;
      readonly parsed: Record<string, unknown>;
      readonly outcome: ToolOutcome;
    }
  | {
      readonly type: 'trace_end';
      readonly call: ToolCallRef;
      readonly callIndex: number;
      readonly argumentSummary: SafeArgumentSummary;
      readonly outcome: ToolOutcome;
    }
  | {
      readonly type: 'result';
      readonly call: ToolCallRef;
      readonly outcome: ToolOutcome;
      readonly parsed: Record<string, unknown> | null;
      readonly diff: ToolDiffContext;
      readonly succeeded: boolean;
      readonly includeContextState: boolean;
    }
  | { readonly type: 'invalidate'; readonly files: readonly string[] };

export interface ToolDispatchResult {
  readonly orderedResults: readonly OrderedToolCallResult[];
  readonly changedFiles: readonly string[];
  readonly modelAttachments: NonNullable<ToolOutcome['modelAttachments']>;
}

/** Full dispatcher above executeToolOutcome; Stage 6 owns policy, permission and scheduling. */
export interface ToolDispatcher {
  readonly implementation: AgentStageImplementation;
  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult>;
}

export type ContextTrimMode = 'scheduled' | 'fallback' | 'overflow';

export interface ContextTrimRequest {
  readonly mode: ContextTrimMode;
  readonly history: ReadonlyHistorySnapshot;
  readonly step: number;
  readonly tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  readonly ephemeralTokens: number;
  readonly signal?: AbortSignal;
}

export interface TrimStats {
  readonly estimateBefore?: number;
  readonly estimateAfter?: number;
  readonly reason?: string;
  readonly compacted?: boolean;
  readonly compactHistoryCalled?: boolean;
}

export type ContextTrimResult =
  | { kind: 'none'; stats: TrimStats }
  | { kind: 'content'; stats: TrimStats }
  | { kind: 'rebuild'; history: CompactedHistory; stats: TrimStats }
  | { kind: 'aborted' };

export interface ContextTrimmer {
  readonly implementation: AgentStageImplementation;
  trim(request: ContextTrimRequest): Promise<ContextTrimResult>;
}

export interface TraceSink {
  readonly implementation: AgentStageImplementation;
  emit(event: AgentTraceEvent): void;
}

export interface UsageMeter {
  readonly implementation: AgentStageImplementation;
  add(usage: ChatUsage | undefined): void;
  snapshot(): ChatUsage | undefined;
}

export interface CancellationLifecycle {
  readonly implementation: AgentStageImplementation;
  checkpoint(): void;
  restore(): void;
}

export type TerminationPhase = 'step_start' | 'model_result' | 'tool_batch_committed' | 'loop_exhausted';

export interface TerminationInput {
  readonly phase: TerminationPhase;
  readonly step: number;
  readonly maxSteps: number;
  readonly aborted: boolean;
  readonly modelResult?: ChatResult;
}

export type TerminationDecision =
  | { kind: 'continue' }
  | { kind: 'completed'; finalText: string | null }
  | { kind: 'aborted' }
  | { kind: 'max_steps' };

export interface TerminationPolicy {
  readonly implementation: AgentStageImplementation;
  decide(input: TerminationInput): TerminationDecision;
}

/** Stage ports are replaced one legacy binding at a time. */
export interface AgentStages {
  createHistoryManager(input: HistoryInit): HistoryManager;
  modelRunner: ModelRunner;
  toolDispatcher: ToolDispatcher;
  contextTrimmer: ContextTrimmer;
  traceSink: TraceSink;
  usageMeter: UsageMeter;
  cancellationLifecycle: CancellationLifecycle;
  terminationPolicy: TerminationPolicy;
  capabilityResolver: CapabilityResolver;
}
