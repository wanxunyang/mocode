// Pressure-only tool-result encoding coordinator.
// Normal pushes are raw apart from the per-result hard safety cap.

import type { ChatMessage } from '../llm/index.js';
import { optimizeToolResult } from './pipeline.js';
import { canonicalizePath, extractPath, isToolResultSuccess, toText } from './utils.js';

interface ToolEncodingRecord {
  toolCallId: string;
  toolName: string;
  argsRaw: string;
  pushOrdinal: number;
  succeeded: boolean;
  isFirstRead?: boolean;
}

interface ToolCallShape {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ToolMessageShape {
  tool_call_id?: string;
  content?: unknown;
}

/** Rebuilds records from current history for each pressure pass. */
export class AgeAwareEncodingState {
  private pushOrdinal = 0;
  private readonly records = new Map<string, ToolEncodingRecord>();
  private readonly seenReadPaths = new Set<string>();

  constructor(history: ChatMessage[] = []) {
    this.rehydrate(history);
  }

  /**
   * Pressure-only, progressive encoding of Cold logs and retrievable searches.
   * It never touches code reads, skills, human decisions, or sub-agent output;
   * repeated pressure passes may further reduce content only when strictly shorter.
   */
  sweepPressure(history: ChatMessage[], hotBoundary: number): number {
    try {
      const pressureEncodable = new Set(['run_command', 'grep', 'glob', 'web_search', 'web_fetch']);
      const end = Math.min(Math.max(hotBoundary, 1), history.length);
      let encodedCount = 0;
      for (let idx = 1; idx < end; idx++) {
        const message = history[idx];
        if (message.role !== 'tool') continue;

        const toolMessage = message as ToolMessageShape;
        const id = toolMessage.tool_call_id;
        const record = id ? this.records.get(id) : undefined;
        if (!record || !record.succeeded || !pressureEncodable.has(record.toolName)) continue;

        const content = toText(toolMessage.content);
        if (!content || content.startsWith('⌦[')) continue;
        const age = Math.max(0, this.pushOrdinal - record.pushOrdinal - 1);
        const encoded = optimizeToolResult(record.toolName, content, record.argsRaw, {
          age,
          isCold: true,
          isFirstRead: record.isFirstRead,
          phase: 'sweep',
        });
        if (encoded.length < content.length) {
          toolMessage.content = encoded;
          encodedCount++;
        }
      }
      return encodedCount;
    } catch {
      return 0;
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
        const path = call.name === 'read_file' ? canonicalizePath(extractPath(call.argsRaw)) : null;
        const isFirstRead = path ? !this.seenReadPaths.has(path) : undefined;

        this.records.set(id, {
          toolCallId: id,
          toolName: call.name,
          argsRaw: call.argsRaw,
          pushOrdinal: this.pushOrdinal,
          succeeded,
          isFirstRead,
        });
        this.pushOrdinal++;
        if (succeeded && path) this.seenReadPaths.add(path);
      }
    } catch {
      // A partial rebuild is conservative: unknown records simply stay full.
    }
  }
}

export function createAgeAwareEncodingState(history: ChatMessage[] = []): AgeAwareEncodingState {
  return new AgeAwareEncodingState(history);
}
