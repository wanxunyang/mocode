// context/ barrel:Context Optimization Pipeline + 五区 Budget Scheduler。
//
// 单一入口 optimizeToolResult(agent/core.ts pushToolResult 调)接管"工具结果进 LLM 前"的表示。
// 单一入口 runScheduler(agent/core.ts 步前调)接管"何时调用哪一闸"的调度。
// 不调 LLM、不碰 Tool Calling schema / executeTool / tool_call_id 配对 / TUI 渲染
// (叶子级:仅 stdlib + tools/constants + session/compact 的 capToolResultForHistory 兜底 + config 开关)。

export { optimizeToolResult } from './pipeline.js';
export type {
  ContextKind,
  ContextEncoder,
  EncoderInput,
  EncoderOutput,
  EncoderRuntimeContext,
} from './types.js';
export { classify, knownToolKinds } from './classifier.js';
export {
  recordArtifact,
  invalidateArtifacts,
  rehydrateArtifacts,
  refreshArtifactFreshness,
  pruneStaleArtifacts,
  collectArtifactRefs,
  formatArtifactTokenSources,
} from './artifacts.js';
export type {
  ArtifactDependency,
  ArtifactFreshness,
  ArtifactSourceType,
  ArtifactStats,
  ContextArtifact,
} from './artifacts.js';
export {
  registerEncoder,
  registerAll,
  getEncoder,
  registeredKinds,
} from './registry.js';

// ── Context Budget Scheduler ───────────────────────────────────────────────
export {
  evaluateBudget,
  scheduleActions,
  formatReport,
  quickEstimate,
  userTurnBoundary,
  BUDGET_LAYERS,
  DEFAULT_BUDGET_POLICY,
  BUDGET_RATIO,
  HOT_TURN_WINDOW,
  TOOL_OLD_AGE,
} from './budget.js';
export type {
  BudgetLayer,
  BudgetPolicy,
  SystemCostBreakdown,
  LayerBudget,
  BudgetReport,
  ScheduleAction,
} from './budget.js';
