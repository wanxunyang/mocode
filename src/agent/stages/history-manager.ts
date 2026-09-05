import type OpenAI from 'openai';
import type { ChatMessage, ToolCallRef } from '../../llm/index.js';
import type {
  AssistantTurn,
  CompactedHistory,
  HistoryBatchTransaction,
  HistoryCheckpoint,
  HistoryInit,
  HistoryManager,
  ReadonlyHistorySnapshot,
} from './contracts.js';

interface HistoryManagerOptions {
  readonly stagedToolBatches: boolean;
}

function replaceMessages(backing: ChatMessage[], messages: readonly ChatMessage[]): void {
  const replacement = messages.slice();
  backing.length = 0;
  backing.push(...replacement);
}

function assistantMessage(turn: AssistantTurn): ChatMessage {
  const message: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: turn.content,
  };
  if (turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return message;
}

function validateCalls(calls: readonly ToolCallRef[]): void {
  const seen = new Set<string>();
  for (const call of calls) {
    if (!call.id) throw new Error('History tool batch contains an empty tool_call id.');
    if (seen.has(call.id)) throw new Error(`History tool batch contains duplicate tool_call id: ${call.id}.`);
    seen.add(call.id);
  }
}

function validateAssistantBatch(backing: readonly ChatMessage[], calls: readonly ToolCallRef[]): void {
  const message = backing.at(-1) as
    | (ChatMessage & {
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      })
    | undefined;
  if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
    throw new Error('History tool batch must follow an assistant tool_calls message.');
  }
  if (message.tool_calls.length !== calls.length) {
    throw new Error(
      `History assistant declared ${message.tool_calls.length} tool call(s), transaction received ${calls.length}.`,
    );
  }
  for (let index = 0; index < calls.length; index++) {
    const actual = message.tool_calls[index];
    const expected = calls[index];
    if (
      actual.id !== expected.id ||
      actual.function?.name !== expected.name ||
      actual.function?.arguments !== expected.arguments
    ) {
      throw new Error(`History tool batch call ${index} does not match the preceding assistant message.`);
    }
  }
}

function validateToolResults(
  calls: readonly ToolCallRef[],
  messages: readonly ChatMessage[],
  resultStartIndex: number,
): void {
  const results = messages.slice(resultStartIndex);
  if (results.length !== calls.length) {
    throw new Error(`History tool batch expected ${calls.length} result(s), received ${results.length}.`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < calls.length; index++) {
    const message = results[index] as ChatMessage & { tool_call_id?: string };
    if (message.role !== 'tool') {
      throw new Error(`History tool batch result ${index} must be a tool message.`);
    }
    const actualId = message.tool_call_id ?? '';
    const expectedId = calls[index].id;
    if (seen.has(actualId)) {
      throw new Error(`History tool batch contains duplicate result id: ${actualId || '<empty>'}.`);
    }
    seen.add(actualId);
    if (actualId !== expectedId) {
      throw new Error(
        `History tool batch result ${index} expected id ${expectedId}, received ${actualId || '<empty>'}.`,
      );
    }
  }
}

function validateAttachment(attachment: ChatMessage | undefined): void {
  if (attachment && attachment.role !== 'user') {
    throw new Error('History tool batch attachment must be a user message.');
  }
}

class DefaultHistoryManager implements HistoryManager {
  private revision = 0;
  private activeBatch = false;
  private activeBatchRollback: (() => void) | undefined;

  constructor(
    private readonly backing: ChatMessage[],
    private readonly options: HistoryManagerOptions,
  ) {}

  snapshot(): ReadonlyHistorySnapshot {
    return { revision: this.revision, messages: this.backing.slice() };
  }

  appendUserTurn(content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content']): void {
    this.assertNoActiveBatch('append a user turn');
    this.backing.push({ role: 'user', content });
    this.revision++;
  }

  appendAssistantTurn(turn: AssistantTurn): void {
    this.assertNoActiveBatch('append an assistant turn');
    if (turn.toolCalls.length > 0) validateCalls(turn.toolCalls);
    this.backing.push(assistantMessage(turn));
    this.revision++;
  }

  beginToolBatch(calls: readonly ToolCallRef[]): HistoryBatchTransaction {
    this.assertNoActiveBatch('begin another tool batch');
    validateCalls(calls);
    validateAssistantBatch(this.backing, calls);
    this.activeBatch = true;

    const resultStartIndex = this.backing.length;
    const workingMessages = this.options.stagedToolBatches ? this.backing.slice() : this.backing;
    let settled = false;

    const settle = (): void => {
      settled = true;
      this.activeBatch = false;
      this.activeBatchRollback = undefined;
    };
    const rollback = (): void => {
      if (settled) return;
      // staged has only a shadow to discard; legacy deliberately leaves its direct working view unchanged.
      settle();
    };
    this.activeBatchRollback = rollback;

    return {
      workingMessages,
      commit: (attachment?: ChatMessage): void => {
        if (settled) throw new Error('History tool batch transaction is already settled.');
        try {
          validateAttachment(attachment);
          validateToolResults(calls, workingMessages, resultStartIndex);
          if (this.options.stagedToolBatches) {
            this.backing.push(...workingMessages.slice(resultStartIndex));
          }
          if (attachment) this.backing.push(attachment);
          this.revision++;
          settle();
        } catch (error) {
          // Validation is pre-publication in staged mode. Legacy keeps its direct-view failure state for rollback parity.
          settle();
          throw error;
        }
      },
      rollback,
    };
  }

  replaceAfterCompaction(result: CompactedHistory): void {
    this.assertNoActiveBatch('replace history after compaction');
    replaceMessages(this.backing, result.messages);
    this.revision++;
  }

  createCheckpoint(): HistoryCheckpoint {
    return { revision: this.revision, messages: this.backing.slice() };
  }

  restore(checkpoint: HistoryCheckpoint): void {
    this.activeBatchRollback?.();
    replaceMessages(this.backing, checkpoint.messages);
    this.revision++;
  }

  async withLegacyMutableHistory<T>(operation: (messages: ChatMessage[]) => T | Promise<T>): Promise<T> {
    this.assertNoActiveBatch('run a legacy history mutation');
    try {
      return await operation(this.backing);
    } finally {
      // The bridge deliberately assumes mutation: compact may rewrite message content without changing array shape.
      this.revision++;
    }
  }

  private assertNoActiveBatch(action: string): void {
    if (this.activeBatch) throw new Error(`Cannot ${action} while a history tool batch is active.`);
  }
}

export function createLegacyHistoryManager(input: HistoryInit): HistoryManager {
  return new DefaultHistoryManager(input.messages, { stagedToolBatches: false });
}

export function createStagedHistoryManager(input: HistoryInit): HistoryManager {
  return new DefaultHistoryManager(input.messages, { stagedToolBatches: true });
}
