import type {
  CapabilityRequest,
  CapabilityResolver,
  RunPolicySnapshot,
  TerminationDecision,
  TerminationInput,
  TerminationPolicy,
} from './contracts.js';

class DefaultCapabilityResolver implements CapabilityResolver {
  constructor(readonly implementation: 'legacy' | 'staged') {}

  resolve(request: CapabilityRequest): RunPolicySnapshot {
    const configured = request.toolsOverride ?? request.toolPolicy?.tools ?? request.defaultTools;
    const bounded = request.runtimeAllowedToolNames
      ? configured.filter((tool) => request.runtimeAllowedToolNames?.has(tool.function.name))
      : configured.slice();
    const legacyDisabled = request.useLegacyDisabledFallback ? request.legacyDisabledToolNames : new Set<string>();
    const tools = bounded.filter(
      (tool) => !request.skillDisabledToolNames.has(tool.function.name) && !legacyDisabled.has(tool.function.name),
    );
    return Object.freeze({
      mode: request.mode,
      tools: Object.freeze(tools),
      allowedToolNames: new Set(tools.map((tool) => tool.function.name)),
      ...(request.toolPolicy ? { toolPolicy: request.toolPolicy } : {}),
      reminder: request.reminder,
    });
  }
}

class PhaseAwareTerminationPolicy implements TerminationPolicy {
  constructor(readonly implementation: 'legacy' | 'staged') {}

  decide(input: TerminationInput): TerminationDecision {
    if (input.phase === 'step_start') return input.aborted ? { kind: 'aborted' } : { kind: 'continue' };
    if (input.phase === 'model_result') {
      if (!input.modelResult) throw new Error('model_result termination requires a model result.');
      return input.modelResult.toolCalls.length === 0
        ? { kind: 'completed', finalText: input.modelResult.content }
        : { kind: 'continue' };
    }
    if (input.phase === 'tool_batch_committed') return { kind: 'continue' };
    return { kind: 'max_steps' };
  }
}

class LegacyCapabilityResolver extends DefaultCapabilityResolver {
  constructor() {
    super('legacy');
  }
}

class StagedCapabilityResolver extends DefaultCapabilityResolver {
  constructor() {
    super('staged');
  }
}

class LegacyTerminationPolicy extends PhaseAwareTerminationPolicy {
  constructor() {
    super('legacy');
  }
}

class StagedTerminationPolicy extends PhaseAwareTerminationPolicy {
  constructor() {
    super('staged');
  }
}

export function createLegacyCapabilityResolver(): CapabilityResolver {
  return new LegacyCapabilityResolver();
}

export function createStagedCapabilityResolver(): CapabilityResolver {
  return new StagedCapabilityResolver();
}

export function createLegacyTerminationPolicy(): TerminationPolicy {
  return new LegacyTerminationPolicy();
}

export function createStagedTerminationPolicy(): TerminationPolicy {
  return new StagedTerminationPolicy();
}
