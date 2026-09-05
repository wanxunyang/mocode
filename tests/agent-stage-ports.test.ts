import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyHistoryManager, createStagedHistoryManager } from '../src/agent/stages/history-manager.js';
import { createLegacyContextTrimmer, createStagedContextTrimmer } from '../src/agent/stages/context-trimmer.js';
import { createLegacyModelRunner, createStagedModelRunner } from '../src/agent/stages/model-runner.js';
import { createLegacyToolDispatcher, createStagedToolDispatcher } from '../src/agent/stages/tool-dispatcher.js';
import {
  createLegacyCapabilityResolver,
  createLegacyTerminationPolicy,
  createStagedCapabilityResolver,
  createStagedTerminationPolicy,
} from '../src/agent/stages/run-policy.js';
import {
  createLegacyTraceSink,
  createLegacyUsageMeter,
  createStagedCancellationLifecycle,
  createStagedTraceSink,
  createStagedUsageMeter,
} from '../src/agent/trace-state.js';
import { contextState } from '../src/session/compact.js';
import type { BudgetScheduler } from '../src/session/scheduler.js';
import { __setChatCreateImpl, type ChatMessage, type ToolCallRef } from '../src/llm/index.js';
import { clearToolsExtension, registerToolsExtension } from '../src/tools/registry.js';
import type { Tool } from '../src/tools/types.js';

function textStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

test('Stage rollback factories: legacy/staged 绑定是可辨识的独立实现', () => {
  const legacyTrace = createLegacyTraceSink({});
  const stagedTrace = createStagedTraceSink({});
  const legacyModel = createLegacyModelRunner();
  const stagedModel = createStagedModelRunner();
  const legacyTools = createLegacyToolDispatcher();
  const stagedTools = createStagedToolDispatcher();
  assert.equal(legacyTrace.implementation, 'legacy');
  assert.equal(stagedTrace.implementation, 'staged');
  assert.notEqual(legacyTrace.constructor, stagedTrace.constructor);
  assert.equal(createLegacyUsageMeter().implementation, 'legacy');
  assert.equal(createStagedUsageMeter().implementation, 'staged');
  assert.equal(legacyModel.implementation, 'legacy');
  assert.equal(stagedModel.implementation, 'staged');
  assert.notEqual(legacyModel.constructor, stagedModel.constructor);
  assert.equal(legacyTools.implementation, 'legacy');
  assert.equal(stagedTools.implementation, 'staged');
  assert.notEqual(legacyTools.constructor, stagedTools.constructor);
  assert.equal(createLegacyCapabilityResolver().implementation, 'legacy');
  assert.equal(createStagedCapabilityResolver().implementation, 'staged');
  assert.equal(createLegacyTerminationPolicy().implementation, 'legacy');
  assert.equal(createStagedTerminationPolicy().implementation, 'staged');
});

test('Stage 3 ports: trace 隔离、usage 累加与 cancellation 恢复顺序独立', () => {
  const trace = createStagedTraceSink({
    onTraceEvent: () => {
      throw new Error('sink failure');
    },
  });
  assert.doesNotThrow(() => trace.emit({ type: 'abort' } as never));

  const usage = createStagedUsageMeter();
  usage.add({
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
    cachedTokens: 3,
    cacheCreationTokens: 4,
    reasoningTokens: 1,
  });
  usage.add({
    promptTokens: 20,
    completionTokens: 5,
    totalTokens: 25,
    cachedTokens: 6,
    reasoningTokens: 2,
  });
  assert.deepEqual(usage.snapshot(), {
    promptTokens: 30,
    completionTokens: 7,
    totalTokens: 37,
    cachedTokens: 9,
    cacheCreationTokens: 4,
    reasoningTokens: 3,
  });

  const history: ChatMessage[] = [{ role: 'system', content: 'system' }];
  const manager = createStagedHistoryManager({ messages: history });
  manager.appendUserTurn('turn');
  const order: string[] = [];
  const lifecycle = createStagedCancellationLifecycle({
    historyManager: manager,
    onObserved: () => order.push('observed'),
    onAbort: () => order.push('hook'),
    onHistoryRestored: () => {
      order.push('history');
      assert.equal(history.length, 2);
    },
    restoreMode: () => order.push('mode'),
  });
  lifecycle.checkpoint();
  manager.appendAssistantTurn({ content: 'discard', toolCalls: [] });
  lifecycle.restore();
  lifecycle.restore();
  assert.deepEqual(order, ['observed', 'hook', 'history', 'mode', 'hook', 'history', 'mode']);
});

test('Stage 4 ModelRunner: immutable request 只触发一次 chat transport', async () => {
  let calls = 0;
  __setChatCreateImpl(async () => {
    calls++;
    return textStream('done');
  });
  try {
    const runner = createStagedModelRunner();
    const history: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const result = await runner.run({ history, tools: [], handlers: {} });
    assert.equal(calls, 1);
    assert.equal(result.content, 'done');
    assert.deepEqual(history, [{ role: 'user', content: 'hello' }]);
  } finally {
    __setChatCreateImpl(null);
  }
});

test('Stage 5 ContextTrimmer: scheduled 明确区分 content 与 rebuild', async () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'work' },
  ];
  const manager = createLegacyHistoryManager({ messages: history });
  const scheduler: BudgetScheduler = {
    lastRunLog: null,
    async runStep(messages: ChatMessage[]) {
      (messages[1] as { content: string }).content = 'trimmed';
      scheduler.lastRunLog = {
        report: { total: 100 },
        pressure: { after: 80 },
        compactHistoryCalled: true,
        historyMutation: 'content',
      } as never;
      return false;
    },
  } as unknown as BudgetScheduler;
  const trimmer = createStagedContextTrimmer({ historyManager: manager, scheduler, contextState });
  assert.equal(trimmer.implementation, 'staged');
  assert.equal(
    createLegacyContextTrimmer({ historyManager: manager, scheduler, contextState }).implementation,
    'legacy',
  );
  const content = await trimmer.trim({
    mode: 'scheduled',
    history: manager.snapshot(),
    step: 0,
    tools: [],
    ephemeralTokens: 0,
  });
  assert.equal(content.kind, 'content');
  assert.equal((history[1] as { content: string }).content, 'trimmed');

  scheduler.runStep = async (messages: ChatMessage[]) => {
    messages.splice(0, messages.length, { role: 'user', content: 'rebuilt' });
    scheduler.lastRunLog = {
      report: { total: 80 },
      pressure: { after: 20 },
      compactHistoryCalled: true,
      historyMutation: 'rebuild',
    } as never;
    return true;
  };
  const rebuilt = await trimmer.trim({
    mode: 'scheduled',
    history: manager.snapshot(),
    step: 1,
    tools: [],
    ephemeralTokens: 0,
  });
  assert.equal(rebuilt.kind, 'rebuild');
  assert.deepEqual(history, [{ role: 'user', content: 'rebuilt' }]);
});

test('Stage 6 ToolDispatcher: resource permission 全部预检后才启动，结果按 provider 原序发布', async () => {
  const source = 'agent-stage-dispatcher-resource';
  const execution: string[] = [];
  const makeTool = (name: string, waitMs: number): Tool => ({
    name,
    description: name,
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    capabilities: {
      effect: 'write',
      concurrency: 'resource-locked',
      resources: (args) => [`file:${String(args.path)}`],
    },
    async execute(args) {
      execution.push(`execute:${name}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return `${name}:${String(args.path)}`;
    },
  });
  registerToolsExtension(source, [makeTool('stage_resource_slow', 20), makeTool('stage_resource_fast', 1)]);
  const calls: ToolCallRef[] = [
    { id: 'slow', name: 'stage_resource_slow', arguments: '{"path":"slow.txt"}' },
    { id: 'fast', name: 'stage_resource_fast', arguments: '{"path":"fast.txt"}' },
  ];
  const events: string[] = [];
  try {
    const dispatcher = createStagedToolDispatcher();
    const result = await dispatcher.dispatch({
      calls,
      policy: {
        mode: 'auto',
        tools: [],
        allowedToolNames: new Set(calls.map((call) => call.name)),
        reminder: '',
      },
      isDenied: () => false,
      currentAllowedToolNames: () => calls.map((call) => call.name),
      delegation: () => ({ history: [], tools: [] }),
      argumentErrorHint: () => undefined,
      onEvent: (event) => {
        if (event.type === 'permission') events.push(`permission:${event.call.name}`);
        if (event.type === 'trace_end') events.push(`end:${event.call.name}`);
        if (event.type === 'start') {
          assert.deepEqual(events, ['permission:stage_resource_slow', 'permission:stage_resource_fast']);
          events.push(`start:${event.tool}`);
        }
      },
    });
    assert.deepEqual(execution.sort(), ['execute:stage_resource_fast', 'execute:stage_resource_slow']);
    assert.deepEqual(
      result.orderedResults.map(({ call, outcome }) => [call.name, outcome.output]),
      [
        ['stage_resource_slow', 'stage_resource_slow:slow.txt'],
        ['stage_resource_fast', 'stage_resource_fast:fast.txt'],
      ],
    );
    assert.deepEqual(events.slice(-2), ['end:stage_resource_slow', 'end:stage_resource_fast']);
  } finally {
    clearToolsExtension(source);
  }
});

test('Stage 7 policies: capability precedence 与 phase-aware termination', () => {
  const schema = (name: string) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
  });
  const resolver = createStagedCapabilityResolver();
  const policy = resolver.resolve({
    mode: 'auto',
    toolsOverride: [schema('override'), schema('blocked')],
    toolPolicy: {
      id: 'snapshot',
      version: 1,
      groups: new Set(),
      allowedNames: new Set(['policy']),
      tools: [schema('policy')],
      reason: 'test',
      confidence: 1,
      planMode: false,
    },
    defaultTools: [schema('default')],
    runtimeAllowedToolNames: new Set(['override', 'blocked']),
    skillDisabledToolNames: new Set(['blocked']),
    legacyDisabledToolNames: new Set(['override']),
    useLegacyDisabledFallback: false,
    reminder: 'policy reminder',
  });
  assert.deepEqual(
    policy.tools.map((tool) => tool.function.name),
    ['override'],
  );
  assert.deepEqual([...policy.allowedToolNames], ['override']);
  assert.equal(policy.reminder, 'policy reminder');

  const termination = createStagedTerminationPolicy();
  assert.deepEqual(termination.decide({ phase: 'step_start', step: 0, maxSteps: 1, aborted: true }), {
    kind: 'aborted',
  });
  assert.deepEqual(
    termination.decide({
      phase: 'model_result',
      step: 0,
      maxSteps: 1,
      aborted: false,
      modelResult: { content: null, toolCalls: [] },
    }),
    { kind: 'completed', finalText: null },
  );
  assert.deepEqual(termination.decide({ phase: 'tool_batch_committed', step: 0, maxSteps: 1, aborted: true }), {
    kind: 'continue',
  });
  assert.deepEqual(termination.decide({ phase: 'loop_exhausted', step: 1, maxSteps: 1, aborted: true }), {
    kind: 'max_steps',
  });
});
