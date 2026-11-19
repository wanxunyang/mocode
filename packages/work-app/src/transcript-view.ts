import type { WorkAttachment } from './attachment-types.js';
import type { RecoverySnapshot, RecoveryStreamItem } from './recovery-log.js';

export type HistoryItem = {
  role: 'user' | 'assistant' | 'tool' | 'summary';
  text: string;
  name?: string;
  arguments?: string;
  attachments?: WorkAttachment[];
};

/** 只识别模型历史里的会话摘要，首条系统提示始终留在模型侧。 */
export function compactedHistorySummary(message: Record<string, unknown>, index: number): HistoryItem | undefined {
  if (index === 0 || message.role !== 'system' || typeof message.content !== 'string') return;
  const marker = /^# 会话摘要[ \t]*(?:\r?\n|$)/.exec(message.content);
  if (marker) return { role: 'summary', text: message.content.slice(marker[0].length).trim() };
}

function hasAssistantHistory(items: readonly RecoveryStreamItem[]): boolean {
  return items.some((item) => item.kind === 'tool' || (item.kind === 'text' && item.text.trim().length > 0));
}

/** 只含用户气泡的缓存不能遮住磁盘正文。若本地已有更新一轮，保留其现场。 */
export function transcriptSource(
  cached: Pick<RecoverySnapshot, 'items' | 'running'> | undefined,
  recovery: RecoverySnapshot | null | undefined,
  history: readonly HistoryItem[] = [],
): 'live' | 'recovery' | 'history' {
  const cachedHasReplies = cached ? hasAssistantHistory(cached.items) : false;
  const recoveryHasReplies = recovery && hasAssistantHistory(recovery.items);
  if (cached && recoveryHasReplies && (!cached.running || !cachedHasReplies)) {
    const cachedTurns = cached.items.flatMap((item) => item.kind === 'user' ? [item.text] : []);
    const recoveredTurns = recovery.items.flatMap((item) => item.kind === 'user' ? [item.text] : []);
    const offset = recoveredTurns.length - cachedTurns.length;
    if (
      (!cached.running || recovery.running) &&
      (!cachedHasReplies || offset > 0) &&
      offset >= 0 && cachedTurns.every((text, index) => text === recoveredTurns[offset + index])
    ) return 'recovery';
    if (cachedTurns.length && offset < 0) return 'live';
  }
  if (cached && (cached.running || cachedHasReplies)) return 'live';
  if (recoveryHasReplies || recovery?.running || recovery?.items.some((item) => item.kind === 'error')) {
    return 'recovery';
  }
  if (history.some((item) => item.role !== 'user')) return 'history';
  if (cached?.items.length) return 'live';
  return recovery?.items.length ? 'recovery' : 'history';
}
