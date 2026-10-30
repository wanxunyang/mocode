// Memory barrel: Tier-2 JSONL store + knowledge-graph layer + background reflection.
// AGENTS.md is intentionally not loaded here either: config/index.ts
// (buildAgentsImportSection) auto-imports the workspace-root AGENTS.md body into the
// system prompt — independent of the memory switch — truncating it when it exceeds the cap.

export {
  buildMemoryIndexSection,
  loadAll,
  gcMemories,
  supersedeEntry,
  flushRecallStats,
  pendingRecallCount,
  computeDedupKey,
  computeStaleness,
  loadStalenessMap,
  __resetPendingRecallForTests,
  // R8.2 / R8.5 / R8.3 / R9.2:用户主权面
  purgeEntries,
  importEntries,
  forgetEntry,
  searchEntries,
  setMemoryWritesPaused,
  isMemoryWritesPaused,
  memoryWriteBlockReason,
  memoryWriteBlockedMessage,
  __resetMemoryPauseForTests,
  type PurgeOptions,
  type PurgeResult,
  type ImportEntriesResult,
  type SearchOpts,
  type MemoryEntry,
  type MemoryIndexItem,
  type MemoryType,
  type MemoryStatus,
  type MemoryScope,
  type EntryStaleness,
} from './store.js';

export { appendAudit, readAudit, auditPath, type AuditRecord } from './audit.js';

export {
  buildPack,
  writePack,
  parsePack,
  applyPack,
  importPackFile,
  defaultPackPath,
  MEMORY_PACK_SCHEMA_VERSION,
  type MemoryPack,
  type ApplyPackResult,
  type ParsePackResult,
} from './portable.js';

export {
  addTriple,
  upsertEntity,
  loadAllGraph,
  importGraphPart,
  type GraphFile,
  type GraphImportResult,
  findEntity,
  searchGraph,
  searchGraphFacts,
  neighborsOf,
  pathBetween,
  graphStats,
  ensurePrimaryPerson,
  mergeEntities,
  canonicalizePrimaryPerson,
  invalidateEdge,
  promoteEdge,
  voteEdge,
  invalidateProfileEdges,
  migrateLegacyProfileProvenance,
  __resetLegacyMigrationForTests,
  PRIMARY_PERSON_ID,
  type GraphEntity,
  type GraphEdge,
  type EdgeProvenance,
  type EdgeVote,
  type EdgeVoteResult,
  type TripleInput,
  type AddTripleResult,
  type CanonicalizeReport,
} from './graph.js';

export {
  buildAboutYouSection,
  initPersona,
  isInternalizedEdge,
  listProfileCandidates,
  listInternalizedProfile,
  inspectPrimaryProfile,
  __resetPersonaInitForTests,
  ABOUT_YOU_MAX_CHARS,
  type ProfileCandidate,
} from './persona.js';

export { buildProjectGraphHint, GRAPH_HINT_MAX_CHARS } from './recall.js';

export {
  isProactiveEnabled,
  proactiveHint,
  resetProactiveTurn,
  proactiveTurnCount,
  proactiveFiredIds,
  proactiveCounters,
  flushProactiveStats,
  __resetProactiveForTests,
  __resetProactiveCountersForTests,
  type ProactiveMatch,
  type ProactiveCounters,
} from './proactive.js';

export {
  buildMemoryHealth,
  writeMemoryHealth,
  readMemoryHealth,
  formatMemoryHealth,
  MEMORY_HEALTH_SCHEMA_VERSION,
  type MemoryHealth,
} from './health.js';

export {
  captureMemoryBaseline,
  buildMemoryTailSection,
  __resetMemoryBaselineForTests,
  type MemoryBaseline,
} from './tail.js';

export {
  isCompactHandoffEnabled,
  appendPendingCandidates,
  loadPendingCandidates,
  trimPendingCandidates,
  pendingCandidateCount,
  extractMemoryCandidates,
  formatPendingForReflect,
  memoryCandidatesInstruction,
  MEMORY_CANDIDATES_HEADING,
  type MemoryCandidate,
} from './pending.js';

export {
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
  runReflection,
  kickoffConsolidation,
  runConsolidation,
  parseConsolidationPlan,
  getLastConsolidationResult,
  clearLastConsolidationResult,
  formatConsolidationResult,
  type ReflectResult,
  type ConsolidationResult,
} from './reflect.js';

export {
  isEpisodicEnabled,
  isConsolidationEnabled,
  collectChangedFiles,
  extractCompactionSummary,
  parsePendingSteps,
  buildEpisode,
  recordSessionEpisode,
  listEpisodes,
  buildEpisodeSection,
  episodeFactsOf,
  findConsolidationGroups,
  applyConsolidation,
  CONSOLIDATED_NAME_SUFFIX,
  type EpisodeInput,
  type EpisodeDraft,
  type RecordEpisodeResult,
  type EpisodeFacts,
  type ConsolidationGroup,
  type ConsolidationDraft,
  type ConsolidationApplyResult,
} from './episodic.js';
