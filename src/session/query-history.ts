import { listSessions, loadSession } from './persist.js';

/**
 * 跨会话输入历史聚合(供输入框 Ctrl+R / Ctrl+P 历史搜索做候选源)。
 *
 * 数据源:
 *  1. 当前会话内存里的 queryHistory(repl 维护,含本会话所有已真实提交的 query);
 *  2. 最近 N 个会话落盘的 `SessionRecord.queryHistory`(persist.ts 已在存)。
 *
 * 顺序:新的在前(当前会话按倒序在前,其余会话按 createdAt 降序)。
 * 去重:按 trim 后的文本;续接会话时当前会话与磁盘记录天然重复,靠这里收敛。
 *
 * 性能:只读最近 maxSessions 个会话(默认 20)。loadSession 会 JSON.parse 整个
 * session.json(含 history),故上限是常数而非"堆了几百个目录就全量解析"。
 */

export interface HistoryEntry {
  /** 已 trim 的原文(可能多行)。 */
  text: string;
  sessionId: string;
  /** 会话创建时间(ISO);当前会话条目为空串。 */
  at: string;
}

/** 当前会话条目的 sessionId 标记。 */
export const CURRENT_SESSION = 'current';

export interface CollectOpts {
  maxSessions?: number;
  maxEntries?: number;
}

export function collectQueryHistory(current: readonly string[], opts: CollectOpts = {}): HistoryEntry[] {
  const maxSessions = Math.max(0, opts.maxSessions ?? 20);
  const maxEntries = Math.max(1, opts.maxEntries ?? 500);
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];

  const push = (raw: string, sessionId: string, at: string): void => {
    if (out.length >= maxEntries) return;
    const text = raw.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ text, sessionId, at });
  };

  // 当前会话:数组末尾最新 → 倒序,让"刚发的"排最前。
  for (let i = current.length - 1; i >= 0; i--) push(current[i] ?? '', CURRENT_SESSION, '');

  if (out.length < maxEntries && maxSessions > 0) {
    // listSessions 已按 createdAt 降序(最新在前);损坏文件内部跳过。
    for (const meta of listSessions(maxSessions)) {
      let rec;
      try {
        rec = loadSession(meta.id);
      } catch {
        continue;
      }
      const qh = rec?.queryHistory;
      if (!qh?.length) continue;
      for (let i = qh.length - 1; i >= 0; i--) push(qh[i] ?? '', meta.id, meta.createdAt ?? '');
      if (out.length >= maxEntries) break;
    }
  }

  return out;
}

/** 取展示用首行(多行 query 折叠成一行;换行符显示为 ␊)。 */
export function historyFirstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
