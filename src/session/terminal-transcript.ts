import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ToolCallRef } from '../llm/index.js';

export const TERMINAL_TRANSCRIPT_FILE = 'terminal-transcript.json';

export interface TerminalTranscript {
  base: ChatMessage[];
  turns: Array<{ turnId: number; messages: ChatMessage[] }>;
}

/** 仅为回放保存图片的类型，图像字节仍由模型会话自身管理。 */
function displayContent(
  content: Extract<ChatMessage, { role: 'user' }>['content'],
  imageNames: readonly string[] = [],
): typeof content {
  if (!Array.isArray(content)) return content;
  let imageIndex = 0;
  return content.map((part) => {
    if (part.type !== 'image_url') return { ...part };
    const name = imageNames[imageIndex++];
    return {
      ...part,
      ...(name ? { name } : {}),
      image_url: { url: /^data:image\/[a-z0-9.+-]+;/i.exec(part.image_url.url)?.[0] ?? 'data:image/png;' },
    };
  });
}

export function createTerminalTranscript(history: readonly ChatMessage[]): TerminalTranscript {
  const base = history.map((message, index): ChatMessage => {
    if (message.role === 'system' && index === 0) return { role: 'system', content: '' };
    if (message.role === 'user') return { ...message, content: displayContent(message.content) };
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: message.content,
        ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
      };
    return { ...message };
  });
  if (base[0]?.role !== 'system') base.unshift({ role: 'system', content: '' });
  return { base, turns: [] };
}

export function terminalCompactionMarker(): ChatMessage {
  return { role: 'system', content: '# 会话摘要' };
}

export function rollbackTerminalTranscript(
  transcript: TerminalTranscript,
  firstDiscardedTurnId: number | undefined,
  retainedHistory: readonly ChatMessage[],
): TerminalTranscript {
  const firstRecordedTurn = transcript.turns[0];
  if (!firstRecordedTurn || firstDiscardedTurnId === undefined || firstDiscardedTurnId < firstRecordedTurn.turnId) {
    return createTerminalTranscript(retainedHistory);
  }
  return { base: transcript.base, turns: transcript.turns.filter((turn) => turn.turnId < firstDiscardedTurnId) };
}

export function createTerminalTurn(
  content: Extract<ChatMessage, { role: 'user' }>['content'],
  imageNames?: readonly string[],
) {
  const messages: ChatMessage[] = [{ role: 'user', content: displayContent(content, imageNames) }];
  return {
    messages,
    addUser(text: string): void {
      messages.push({ role: 'user', content: text });
    },
    addText(text: string): void {
      if (!text) return;
      const last = messages.at(-1);
      if (last?.role === 'assistant' && typeof last.content === 'string' && !last.tool_calls?.length) {
        last.content += text;
      } else {
        messages.push({ role: 'assistant', content: text });
      }
    },
    addTool(call: ToolCallRef, output: string): void {
      messages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
        },
        { role: 'tool', tool_call_id: call.id, content: output },
      );
    },
    compacted(): void {
      messages.push(terminalCompactionMarker());
    },
  };
}

export type TerminalTurnTranscript = ReturnType<typeof createTerminalTurn>;

export function parseTerminalTranscript(value: unknown): TerminalTranscript | undefined {
  if (!value || typeof value !== 'object') return;
  const { base, turns } = value as Partial<TerminalTranscript>;
  const isMessageList = (items: unknown): items is ChatMessage[] =>
    Array.isArray(items) && items.every((item) => item && typeof item === 'object' && typeof item.role === 'string');
  if (
    isMessageList(base) &&
    Array.isArray(turns) &&
    turns.every((turn) => Number.isSafeInteger(turn?.turnId) && isMessageList(turn.messages))
  )
    return { base, turns };
}

export function readTerminalTranscriptFile(dir: string): TerminalTranscript | undefined {
  try {
    return parseTerminalTranscript(JSON.parse(readFileSync(path.join(dir, TERMINAL_TRANSCRIPT_FILE), 'utf8')));
  } catch {
    // 旧会话或损坏记录仍可按模型历史回放。
  }
}

export function writeTerminalTranscriptFile(dir: string, transcript: TerminalTranscript): void {
  const file = path.join(dir, TERMINAL_TRANSCRIPT_FILE);
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(transcript), 'utf8');
  renameSync(temporary, file);
}
