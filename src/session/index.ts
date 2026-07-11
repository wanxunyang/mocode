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
// agent/core.ts 步前调 runScheduler(history, step):评估五区预算 → 按 ROI 调度
// shrink_cold_tools / cap_hot_tools / compact_history。开关关闭时退化为 maybeCompact。
// repl /compact 命令调 manualCompact(history, focus?):与自动路径完全一致,focus 透传摘要 prompt。
export {
  runScheduler,
  manualCompact,
  createBudgetScheduler,
} from './scheduler.js';
export type { BudgetScheduler, SchedulerRunLog } from './scheduler.js';

export {
  dropContextFromHistory,
  formatDropResult,
} from './drop.js';

export {
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  sessionDir,
} from './persist.js';
export type { SessionMeta, SessionRecord } from './persist.js';
