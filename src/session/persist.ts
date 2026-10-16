import type { ToolRouteGroupName } from '../config/profiles.js';
import type { ChatMessage } from '../llm/index.js';
import { defaultSessionStore } from './store.js';

export type { SessionMeta, SessionRecord } from './store.js';

/** 会话目录(确保存在)。 */
export function sessionDir(): string {
  return defaultSessionStore.sessionDir();
}

/** 新会话 id：可排序时间前缀 + 碰撞防护后缀。 */
export function newSessionId(): string {
  return defaultSessionStore.createId();
}

/** 保存会话；保留旧同步 API 与磁盘格式。 */
export function saveSession(
  history: ChatMessage[],
  id: string,
  queryHistory: readonly string[] = [],
  lastToolGroups: readonly ToolRouteGroupName[] = [],
) {
  return defaultSessionStore.save(history, id, queryHistory, lastToolGroups);
}

/** 加载会话；不存在或损坏时返回 null。restoreAssets=true 时(resume)把归档 gz
 *  内嵌的 compacted 资产写回磁盘;列表/检索等只读场景保持默认不产生写盘副作用。 */
export function loadSession(id: string, opts?: { restoreAssets?: boolean }) {
  return defaultSessionStore.load(id, opts);
}

/** 列出最近会话，按 createdAt 降序。 */
export function listSessions(limit?: number) {
  return defaultSessionStore.list(limit);
}
