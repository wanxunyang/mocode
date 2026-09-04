// context/ barrel: metadata tracking, optional pressure encoders, and budget reporting.
// Normal tool pushes stay raw apart from the hard per-result cap. The session
// scheduler is the only automatic rewrite coordinator at real pressure.

export { optimizeToolResult } from './pipeline.js';
export type { ContextKind, ContextEncoder, EncoderInput, EncoderOutput, EncoderRuntimeContext } from './types.js';
export { classify, knownToolKinds } from './classifier.js';
export {
  recordArtifact,
  invalidateArtifacts,
  rehydrateArtifacts,
  refreshArtifactFreshness,
  pruneStaleArtifacts,
  collectArtifactRefs,
  formatArtifactTokenSources,
  knownEditTargets,
} from './artifacts.js';
export type {
  ArtifactDependency,
  ArtifactFreshness,
  ArtifactSourceType,
  ArtifactStats,
  ContextArtifact,
  KnownEditTarget,
} from './artifacts.js';
export { registerEncoder, registerAll, getEncoder, registeredKinds } from './registry.js';

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
} from './budget.js';
export type {
  BudgetLayer,
  BudgetPolicy,
  SystemCostBreakdown,
  LayerBudget,
  BudgetReport,
  ScheduleAction,
} from './budget.js';
