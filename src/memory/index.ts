// Memory barrel: Tier-2 JSONL store + knowledge-graph layer + background reflection.
// AGENTS.md is intentionally not loaded here either: config/index.ts
// (buildAgentsImportSection) auto-imports the workspace-root AGENTS.md body into the
// system prompt — independent of the memory switch — truncating it when it exceeds the cap.

export {
  buildMemoryIndexSection,
  loadAll,
  gcMemories,
  type MemoryEntry,
  type MemoryIndexItem,
  type MemoryType,
  type MemoryStatus,
  type MemoryScope,
} from './store.js';

export {
  addTriple,
  upsertEntity,
  findEntity,
  searchGraph,
  neighborsOf,
  pathBetween,
  graphStats,
  ensurePrimaryPerson,
  mergeEntities,
  canonicalizePrimaryPerson,
  PRIMARY_PERSON_ID,
  type GraphEntity,
  type GraphEdge,
  type TripleInput,
  type AddTripleResult,
  type CanonicalizeReport,
} from './graph.js';

export { buildAboutYouSection, initPersona, __resetPersonaInitForTests, ABOUT_YOU_MAX_CHARS } from './persona.js';

export {
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
  runReflection,
  type ReflectResult,
} from './reflect.js';
