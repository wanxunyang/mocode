// Tool-result clearing: 可重取结果的低成本清除(Anthropic 三原语之一)。
//
// 与 relevance pruner 的区别:pruner 只在有「精确的新替代」时 stub;clearing 更宽——
// 冷区中来自可重取工具的结果,无论有没有新替代,内容都可丢弃(需要时重新调用即可),
// 只保留「调用发生过」的 tombstone。不删消息、不改 tool_call_id 配对。
//
// 在低压阶段(60%)运行:零 LLM 成本、不依赖摘要质量。热区(最近 hotTurnWindow 个
// user turn)不动。

import type { ChatMessage } from '../llm/index.js';
import { toText } from './utils.js';

type AnyMessage = ChatMessage & { content?: unknown; tool_call_id?: string };

interface ToolCallShape {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** 结果可随时重取的工具:纯读、无副作用。 */
export const REFETCHABLE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep', 'glob', 'web_search', 'web_fetch']);

/** Tombstone 前缀,与 relevance stub 同属 ⌦[ 家族,其余子系统据此识别已清除内容。 */
const CLEARED_PREFIX = '⌦[已清除:';

/** 回溯 tool_call_id → 产生该结果的工具名(同 relevance.ts callAt 的最小版本)。 */
function toolNameAt(history: ChatMessage[], idx: number): string | null {
  const tcId = (history[idx] as AnyMessage)?.tool_call_id;
  if (!tcId) return null;
  for (let j = idx - 1; j >= 1; j--) {
    if (history[j].role !== 'assistant') continue;
    const calls = (history[j] as { tool_calls?: ToolCallShape[] }).tool_calls;
    const hit = calls?.find((tc) => tc?.id === tcId);
    if (hit?.function?.name) return hit.function.name;
  }
  return null;
}

/**
 * 清除冷区可重取工具的结果内容。
 * @param coldBoundary 仅处理 index < coldBoundary 的消息(热区保留)。
 * @returns 被清除的消息数。
 */
export function clearRetrievableResults(history: ChatMessage[], coldBoundary: number): number {
  let cleared = 0;
  const end = Math.min(coldBoundary, history.length);
  for (let idx = 1; idx < end; idx++) {
    const message = history[idx] as AnyMessage;
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const content = toText(message.content);
    if (!content || content.startsWith('⌦[')) continue;
    const name = toolNameAt(history, idx);
    if (!name || !REFETCHABLE_TOOLS.has(name)) continue;
    message.content =
      `${CLEARED_PREFIX}${name}] 原结果 ${content.length} 字符已清除(可重新调用获取)` +
      ` · id …${message.tool_call_id.slice(-6)}⌫`;
    cleared++;
  }
  return cleared;
}
