import type { AgentRunOptions, AgentRunResult } from '../core.js';
import {
  AGENT_STAGE_NAMES,
  type AgentStageImplementation,
  type AgentStageName,
  type HistoryManager,
} from './contracts.js';

export type LegacyAgentCoordinator = (
  options: AgentRunOptions,
  historyManager: HistoryManager,
  stages: LegacyStageAdapters,
) => Promise<AgentRunResult>;

export interface LegacyCoordinatorAdapter {
  readonly implementation: 'legacy';
  run(options: AgentRunOptions, historyManager: HistoryManager, stages: LegacyStageAdapters): Promise<AgentRunResult>;
}

export interface LegacyStageAdapter {
  readonly name: AgentStageName;
  readonly implementation: AgentStageImplementation;
}

export type LegacyStageAdapters = Readonly<Record<AgentStageName, LegacyStageAdapter>>;

/**
 * Untouched stages keep every business rule inside the existing coordinator. These adapters are explicit rollback
 * boundaries, not fake partial implementations of HistoryManager/ToolDispatcher/etc. Each migration stage replaces
 * one descriptor with a real port while the remaining stages continue through the same legacy coordinator.
 */
export function createLegacyStageAdapters(
  overrides: Partial<Record<AgentStageName, AgentStageImplementation>> = {},
): LegacyStageAdapters {
  return Object.freeze(
    Object.fromEntries(
      AGENT_STAGE_NAMES.map((name) => [
        name,
        Object.freeze({ name, implementation: overrides[name] ?? ('legacy' as const) }),
      ]),
    ) as Record<AgentStageName, LegacyStageAdapter>,
  );
}

/** One adapter per run: state and future staged replacements must never leak across agent runs. */
export function createLegacyCoordinatorAdapter(coordinator: LegacyAgentCoordinator): LegacyCoordinatorAdapter {
  return Object.freeze({
    implementation: 'legacy' as const,
    run: (options: AgentRunOptions, historyManager: HistoryManager, stages: LegacyStageAdapters) =>
      coordinator(options, historyManager, stages),
  });
}
