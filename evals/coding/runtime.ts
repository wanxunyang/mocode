import { defaultAgentRuntimeContext, type AgentRuntimeContext } from '../../src/agent/runtime-context.js';
import { buildBasePrompt, isMemoryEnabled } from '../../src/config/index.js';
import type { ToolRouteGroupName } from '../../src/config/profiles.js';
import { type ChatMessage } from '../../src/llm/index.js';
import { buildMemoryIndexSection } from '../../src/memory/index.js';
import { clearSkillActivation } from '../../src/skills/activation.js';
import { effectiveSystemPrompt } from '../../src/skills/index.js';
import { ToolPolicyController } from '../../src/tools/policy.js';
import { routeToolGroups, type ToolRouteDecision, type ToolRouteRequest } from '../../src/tools/router.js';

export const CODING_EVAL_SESSION_ID = 'coding-eval';

export interface CodingEvalTurnAssembly {
  history: ChatMessage[];
  systemPrompt: string;
  toolPolicy: ToolPolicyController;
  initialToolRoute: Record<string, unknown>;
}

export interface CodingEvalTurnDependencies {
  route?: (request: ToolRouteRequest) => Promise<ToolRouteDecision>;
  runtimeContext?: AgentRuntimeContext;
}

/** Build the exact AUTO-mode system prefix sent by the coding benchmark. */
export function buildCodingEvalSystemPrompt(sessionId = CODING_EVAL_SESSION_ID): string {
  return effectiveSystemPrompt(buildBasePrompt(sessionId) + buildMemoryIndexSection(isMemoryEnabled()));
}

/**
 * Assemble one headless coding-eval turn through the same prompt and dynamic tool-policy path as the REPL.
 * The caller owns restoration of process-global mode/session state after the turn finishes.
 */
export async function assembleCodingEvalTurn(
  input: string,
  signal?: AbortSignal,
  systemPrompt = buildCodingEvalSystemPrompt(),
  dependencies: CodingEvalTurnDependencies = {},
): Promise<CodingEvalTurnAssembly> {
  const runtimeContext = dependencies.runtimeContext ?? defaultAgentRuntimeContext;
  runtimeContext.setAgentMode('auto');
  runtimeContext.sessionStore.setCurrentSessionId(CODING_EVAL_SESSION_ID);
  clearSkillActivation();

  const previousGroups: ToolRouteGroupName[] = [];
  const decision = await (dependencies.route ?? routeToolGroups)({
    input,
    previousGroups,
    planMode: false,
    signal,
    transport: runtimeContext.modelTransport,
    tools: runtimeContext.toolRuntime.tools,
  });
  const toolPolicy = new ToolPolicyController({
    groups: decision.groups,
    reason: decision.reason,
    confidence: decision.confidence,
    tools: runtimeContext.toolRuntime.tools,
  });
  const initialToolRoute = {
    policyId: toolPolicy.id,
    groups: toolPolicy.groupNames,
    previousGroups,
    inheritPrevious: decision.inheritPrevious,
    confidence: decision.confidence,
    reason: decision.reason,
    latencyMs: decision.latencyMs,
    fallback: decision.fallback,
    planMode: false,
  };

  return {
    history: [{ role: 'system', content: systemPrompt }],
    systemPrompt,
    toolPolicy,
    initialToolRoute,
  };
}
