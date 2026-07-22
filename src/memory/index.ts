// Memory barrel: Tier-2 JSONL store + background reflection.
// MOCODE.md is intentionally not loaded here: the system prompt only tells the agent
// to read the workspace file on demand, keeping its full body out of every request.

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
  kickoffReflection,
  drainMemoryBackground,
  getLastReflectResult,
  clearLastReflectResult,
  snapshotTranscript,
  formatReflectResult,
  runReflection,
  type ReflectResult,
} from './reflect.js';
