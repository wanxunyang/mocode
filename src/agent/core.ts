import { defaultToolRuntime, type ToolRuntime } from '../tools/registry.js';
import { createAgentPipelineAssembly } from './pipeline.js';
import type { AgentRunOptions, AgentRunResult } from './run-contracts.js';
import { runAgentCoreLegacy } from './run-coordinator.js';
import { defaultAgentRuntimeContext, withAgentRuntimeContext } from './runtime-context.js';

export type {
  AgentHooks,
  AgentRunOptions,
  AgentRunResult,
  AgentTerminationReason,
  ContentPart,
  ToolCallView,
} from './run-contracts.js';

/**
 * Public entry point. Per-run assembly selects stage implementations while preserving a single coordinator execution.
 */
export async function runAgentCore(opts: AgentRunOptions): Promise<AgentRunResult> {
  const runtimeContext = opts.runtimeContext ?? defaultAgentRuntimeContext;
  const assembly = createAgentPipelineAssembly({
    pipeline: opts.pipeline,
    stageOverrides: opts.stageOverrides,
    runLegacy: runAgentCoreLegacy,
  });
  return withAgentRuntimeContext(runtimeContext, () =>
    runtimeContext.runInScope(() => assembly.run({ ...opts, runtimeContext })),
  );
}

/** 文件 mutation 由 capability metadata 判定，供 diff、回滚与上下文失效共用。 */
export const isMutationTool = (name: string, toolRuntime: ToolRuntime = defaultToolRuntime): boolean =>
  toolRuntime.isFileMutationTool(name);

export { parseArgs, readDiffContext, isParallelTool } from './tool-helpers.js';
