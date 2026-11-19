import {
  chatTools,
  correctTokenEstimate,
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  estimateTokens,
  type ChatMessage,
} from '../llm/index.js';
import type { ContextState } from '../session/compact.js';
import { compactOverlappingReads } from './overlapping-reads.js';

/** 当前上下文占用的可序列化快照；percent 仅在展示层封顶为 100。 */
export interface ContextUsageSnapshot {
  tokens: number;
  window: number;
  remaining: number;
  percent: number;
  messages: number;
  cachedTokens?: number;
  source: 'measured' | 'estimated';
}

/**
 * 与终端底栏、上下文压力线同口径：system + 对话 + 实际工具 schema + ephemeral。
 * 不能用本轮累计 input+output：后者是消耗量，不是此刻驻留的上下文。
 */
export function measureContextUsage(
  history: readonly ChatMessage[],
  contextWindowTokens: number,
  contextState: ContextState,
): ContextUsageSnapshot {
  const window = Math.max(0, Math.round(contextWindowTokens));
  let tokens = 0;
  let source: ContextUsageSnapshot['source'] = 'estimated';
  if (history.some((message) => message.role !== 'system')) {
    const activeTools = contextState.activeTools ?? chatTools;
    const ephemeralText = contextState.ephemeralText ?? '';
    const ephemeralRaw = ephemeralText ? estimateTokens(ephemeralText) : 0;
    const historyRaw = estimateMessagesTokens(compactOverlappingReads([...history]));
    const schemaRaw = estimateToolSchemaTokens(activeTools);
    const fullRaw = historyRaw + schemaRaw + ephemeralRaw;
    const anchor = contextState.promptAnchor;
    const anchorPrefixRaw = anchor
      ? estimateMessagesTokens(compactOverlappingReads(history.slice(0, anchor.historyLen)))
      : 0;
    const anchorHistoryRaw = anchor
      ? anchorPrefixRaw + schemaRaw + (anchor.ephemeralText ? estimateTokens(anchor.ephemeralText) : 0)
      : 0;
    if (
      anchor &&
      history.length >= anchor.historyLen &&
      anchor.tools === activeTools &&
      anchor.ephemeralText === ephemeralText &&
      // 同长度替换/原地微压缩也不能沿用旧锚点；历史增长时只比较锚点前缀。
      Math.abs(anchorHistoryRaw - anchor.baseRaw) <= 4 &&
      fullRaw >= anchor.baseRaw - 4
    ) {
      const grownRaw = historyRaw - anchorPrefixRaw;
      tokens = anchor.measuredPromptTokens + Math.max(0, grownRaw);
      // 只有完全同一请求快照才全是实测；后续新增内容仍属于估算。
      source = history.length === anchor.historyLen && fullRaw <= anchor.baseRaw + 4 ? 'measured' : 'estimated';
    } else {
      tokens = Math.max(fullRaw, correctTokenEstimate(fullRaw, contextState.correction));
    }
  }
  const used = Math.max(0, Math.round(tokens));
  return {
    tokens: used,
    window,
    remaining: Math.max(0, window - used),
    percent: window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0,
    messages: history.length,
    ...(typeof contextState.lastUsage?.cachedTokens === 'number'
      ? { cachedTokens: contextState.lastUsage.cachedTokens }
      : {}),
    source,
  };
}
