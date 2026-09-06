import type { AgentRunOptions, AgentRunResult } from './run-contracts.js';
import {
  AGENT_STAGE_NAMES,
  type AgentPipeline,
  type AgentStageImplementation,
  type AgentStageName,
  type HistoryInit,
  type HistoryManager,
} from './stages/contracts.js';
import { createLegacyHistoryManager, createStagedHistoryManager } from './stages/history-manager.js';
import {
  createLegacyCoordinatorAdapter,
  createLegacyStageAdapters,
  type LegacyCoordinatorAdapter,
  type LegacyStageAdapters,
} from './stages/legacy-adapters.js';

export interface AgentPipelineAssembly {
  readonly pipeline: AgentPipeline;
  readonly coordinator: LegacyCoordinatorAdapter;
  readonly stages: LegacyStageAdapters;
  readonly createHistoryManager: (input: HistoryInit) => HistoryManager;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}

export interface AgentPipelineAssemblyInit {
  pipeline?: AgentPipeline;
  stageOverrides?: Partial<Record<AgentStageName, AgentStageImplementation>>;
  runLegacy(
    options: AgentRunOptions,
    historyManager: HistoryManager,
    stages: LegacyStageAdapters,
  ): Promise<AgentRunResult>;
}

/** Build a fresh, independently overridable stage assembly for one agent run. */
export function createAgentPipelineAssembly(init: AgentPipelineAssemblyInit): AgentPipelineAssembly {
  const pipeline = init.pipeline ?? 'legacy';
  const coordinator = createLegacyCoordinatorAdapter(init.runLegacy);
  const defaults = Object.fromEntries(
    AGENT_STAGE_NAMES.map((name) => [name, pipeline === 'staged' ? 'staged' : 'legacy']),
  ) as Record<AgentStageName, AgentStageImplementation>;
  const stages = createLegacyStageAdapters({ ...defaults, ...init.stageOverrides });
  const createHistoryManager =
    stages.history.implementation === 'staged' ? createStagedHistoryManager : createLegacyHistoryManager;
  return Object.freeze({
    pipeline,
    coordinator,
    stages,
    createHistoryManager,
    run: (options: AgentRunOptions) =>
      coordinator.run(options, createHistoryManager({ messages: options.history }), stages),
  });
}
