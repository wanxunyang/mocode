/** context 测试共享 helper:ChatMessage 构造与工具调用追加(从 scripts/core-tests/test-harness 迁移)。 */
import type { ChatMessage } from '../src/llm/index.js';

export function system(content = 'system'): ChatMessage {
  return { role: 'system', content } as ChatMessage;
}

export function appendTool(
  history: ChatMessage[],
  name: string,
  id: string,
  args: Record<string, unknown>,
  content: string,
): number {
  history.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } as ChatMessage);
  history.push({ role: 'tool', tool_call_id: id, content } as ChatMessage);
  return history.length - 1;
}

export function contentAt(history: ChatMessage[], index: number): string {
  return String((history[index] as { content?: unknown }).content ?? '');
}
