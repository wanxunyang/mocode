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
  createContextState,
} from './compact.js';
export type { CompactOptions, CompactResult, ContextState } from './compact.js';

// ── Context Budget Scheduler 接缝 ────────────────────────────────────────
// agent/core.ts 在 age-aware sweep 后调用 runScheduler(history, step):评估五区预算，
// 只执行可落地的 warn / compact_history；开关关闭时退化为 maybeCompact。
// repl /compact 命令调 manualCompact(history, focus?):与自动路径共享决策，focus 透传摘要 prompt。
export { runScheduler, manualCompact, createBudgetScheduler } from './scheduler.js';
export type { BudgetScheduler, SchedulerRunLog } from './scheduler.js';

export { newSessionId, saveSession, loadSession, listSessions, sessionDir } from './persist.js';
export type { SessionMeta, SessionRecord } from './persist.js';
export { SessionStore, defaultSessionStore, getActiveSessionStore, withSessionStore } from './store.js';
export type { SessionStoreOptions } from './store.js';

export {
  appendCurrentSessionTrace,
  appendCurrentSessionTraceEvent,
  appendCurrentSessionRuntimeEvent,
  createTraceEvent,
} from './trace.js';
export type { AgentTurnTrace, AgentTraceEvent, TraceEventInput, TraceEventType } from './trace.js';
export { reduceTraceMetrics, readTraceEvents, readTraceMetrics } from './trace-metrics.js';
export type { TraceMetrics } from './trace-metrics.js';
export { summarizeToolArguments, hashTraceValue, safeProviderId } from './trace-sanitize.js';
export type { SafeArgumentSummary } from './trace-sanitize.js';
