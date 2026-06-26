/**
 * session/ 入口:上下文压缩 + 会话落盘。
 *  - compact.ts:三层压缩(push-time 上限 / 微压缩 / 摘要)+ 自动门槛
 *  - persist.ts:history 序列化到磁盘 + --resume / /resume
 * 依赖方向:session → {llm(摘要复用 chat), config, ui};llm 不反向依赖 session。
 */
export {
  compactHistory,
  maybeCompact,
  capToolResultForHistory,
  truncateMid,
  contextState,
} from './compact.js';
export type { CompactOptions, CompactResult } from './compact.js';

export {
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  sessionDir,
} from './persist.js';
export type { SessionMeta, SessionRecord } from './persist.js';
