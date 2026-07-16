// Age-aware tool-result encoding coordinator.
// Initial pushes stay conservative; old Cold results are re-encoded before chat.

import type { ChatMessage, ToolCallRef } from '../llm/index.js';
import { TOOL_OLD_AGE } from './budget.js';
import { optimizeToolResult } from './pipeline.js';
import type { EncoderRuntimeContext } from './types.js';
import {
  canonicalizePath,
  extractPath,
  isToolResultSuccess,
  toText,
} from './utils.js';

interface ToolEncodingRecord {
  toolCallId: string;
  toolName: string;
  argsRaw: string;
  pushOrdinal: number;
  succeeded: boolean;
  isFirstRead?: boolean;
  agedEncoded: boolean;
}

interface ToolCallShape {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ToolMessageShape {
  tool_call_id?: string;
  content?: unknown;
}

/**
 * Tracks successful first reads and tool-result age without coupling encoders to
 * lifecycle's mutable history indexes. All methods are fail-safe and idempotent.
 */
export class AgeAwareEncodingState {
  private pushOrdinal = 0;
  private readonly records = new Map<string, ToolEncodingRecord>();
  private readonly seenReadPaths = new Set<string>();

  constructor(history: ChatMessage[] = []) {
    this.rehydrate(history);
  }
  /** Build the conservative context for a newly completed tool result. */
  preparePush(tc: ToolCallRef, succeeded: boolean): EncoderRuntimeContext {
    const path = tc.name === 'read_file'
      ? canonicalizePath(extractPath(tc.arguments))
      : null;
    const isFirstRead = path ? !this.seenReadPaths.has(path) : undefined;

    this.records.set(tc.id, {
      toolCallId: tc.id,
      toolName: tc.name,
      argsRaw: tc.arguments,
      pushOrdinal: this.pushOrdinal,
      succeeded,
      isFirstRead,
      agedEncoded: false,
    });
    this.pushOrdinal++;

    // Failed reads must not consume the "first successful read" privilege.
    if (succeeded && path) this.seenReadPaths.add(path);

    return {
      age: 0,
      isCold: false,
      isFirstRead,
      phase: 'push',
    };
  }

  /** Re-encode eligible tool messages in the Cold prefix in place. */
  sweep(history: ChatMessage[], hotBoundary: number): void {
    try {
      const end = Math.min(Math.max(hotBoundary, 1), history.length);
      for (let idx = 1; idx < end; idx++) {
        const message = history[idx];
        if (message.role !== 'tool') continue;

        const toolMessage = message as ToolMessageShape;
        const id = toolMessage.tool_call_id;
        const record = id ? this.records.get(id) : undefined;
        if (!record || !record.succeeded || record.agedEncoded) continue;

        const content = toText(toolMessage.content);
        if (!content || content.startsWith('⌦[')) {
          record.agedEncoded = true;
          continue;
        }

        // Exclude the result's own push: immediately after insertion its age is 0.
        const age = Math.max(0, this.pushOrdinal - record.pushOrdinal - 1);
        if (age < TOOL_OLD_AGE) continue;

        const encoded = optimizeToolResult(
          record.toolName,
          content,
          record.argsRaw,
          {
            age,
            isCold: true,
            isFirstRead: record.isFirstRead,
            phase: 'sweep',
          },
        );

        // Aged encoding is a degradation step: never replace content with a
        // representation that is equal-sized or larger.
        if (encoded.length < content.length) toolMessage.content = encoded;
        record.agedEncoded = true;
      }
    } catch {
      // Context optimization must never block an agent request.
    }
  }
  /** Rebuild stable state after resume or structural history compaction. */
  rehydrate(history: ChatMessage[]): void {
    this.pushOrdinal = 0;
    this.records.clear();
    this.seenReadPaths.clear();

    try {
      const calls = new Map<string, { name: string; argsRaw: string }>();
      for (const message of history) {
        if (message.role === 'assistant') {
          const toolCalls = (message as { tool_calls?: ToolCallShape[] }).tool_calls;
          for (const tc of toolCalls ?? []) {
            if (!tc.id || !tc.function?.name) continue;
            calls.set(tc.id, {
              name: tc.function.name,
              argsRaw: tc.function.arguments ?? '',
            });
          }
          continue;
        }
        if (message.role !== 'tool') continue;

        const toolMessage = message as ToolMessageShape;
        const id = toolMessage.tool_call_id;
        const call = id ? calls.get(id) : undefined;
        if (!id || !call) continue;

        const content = toText(toolMessage.content);
        const succeeded = isToolResultSuccess(content);
        const path = call.name === 'read_file'
          ? canonicalizePath(extractPath(call.argsRaw))
          : null;
        const isFirstRead = path ? !this.seenReadPaths.has(path) : undefined;

        this.records.set(id, {
          toolCallId: id,
          toolName: call.name,
          argsRaw: call.argsRaw,
          pushOrdinal: this.pushOrdinal,
          succeeded,
          isFirstRead,
          agedEncoded: false,
        });
        this.pushOrdinal++;
        if (succeeded && path) this.seenReadPaths.add(path);
      }
    } catch {
      // A partial rebuild is conservative: unknown records simply stay full.
    }
  }
}

export function createAgeAwareEncodingState(
  history: ChatMessage[] = [],
): AgeAwareEncodingState {
  return new AgeAwareEncodingState(history);
}
