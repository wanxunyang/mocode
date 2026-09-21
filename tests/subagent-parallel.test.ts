import test from 'node:test';
import assert from 'node:assert/strict';
import { createStagedToolDispatcher } from '../src/agent/stages/tool-dispatcher.js';
import { clearToolsExtension, registerToolsExtension } from '../src/tools/registry.js';
import type { Tool } from '../src/tools/types.js';
import type { ToolCallRef } from '../src/llm/index.js';

// 编排类工具(sub-agent 的调度语义)：同一轮内连续派发的多个调用按并发上限成批并行。
// 断言的是「块内交错启动 + 结果按 provider 原序发布」——串行实现会先 end 再 start,
// 故 log 中 start:fast 与 end:slow 的相对位置就是并行/串行的判别式。
const makeOrchestrationTool = (name: string, waitMs: number, log: string[]): Tool => ({
  name,
  description: name,
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
    additionalProperties: false,
  },
  capabilities: {
    effect: 'write',
    concurrency: 'resource-locked',
    delegatesResourceLocks: true,
    parallelOrchestration: true,
  },
  async execute(args) {
    log.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    log.push(`end:${name}`);
    return `${name}:${String(args.prompt)}`;
  },
});

const makeCalls = (names: string[]): ToolCallRef[] =>
  names.map((name) => ({ id: name, name, arguments: `{"prompt":"${name}"}` }));

const dispatchRequest = (
  calls: ToolCallRef[],
  orchestrationConcurrency: number | undefined,
): Parameters<ReturnType<typeof createStagedToolDispatcher>['dispatch']>[0] => ({
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
  orchestrationConcurrency,
  onEvent: () => undefined,
});

test('ToolDispatcher 编排批:同块内交错启动,结果按原序发布', async () => {
  const source = 'subagent-parallel-interleaved';
  const log: string[] = [];
  registerToolsExtension(source, [makeOrchestrationTool('orch_slow', 30, log), makeOrchestrationTool('orch_fast', 1, log)]);
  try {
    const calls = makeCalls(['orch_slow', 'orch_fast']);
    const result = await createStagedToolDispatcher({ checkPermission: async () => 'allow' }).dispatch(
      dispatchRequest(calls, 2),
    );

    assert.ok(
      log.indexOf('start:orch_slow') < log.indexOf('start:orch_fast'),
      `两个调用都已启动: ${log.join(',')}`,
    );
    // 并行的关键证据:慢调用尚未结束,快调用就已经启动(串行实现里 fast 必在 slow 之后)。
    assert.ok(
      log.indexOf('start:orch_fast') < log.indexOf('end:orch_slow'),
      `块内必须交错执行,实际顺序: ${log.join(',')}`,
    );
    // 完成顺序反了,但 history 回灌始终是 provider 原序。
    assert.deepEqual(
      result.orderedResults.map(({ call, outcome }) => [call.name, outcome.output]),
      [
        ['orch_slow', 'orch_slow:orch_slow'],
        ['orch_fast', 'orch_fast:orch_fast'],
      ],
    );
  } finally {
    clearToolsExtension(source);
  }
});

test('ToolDispatcher 编排批:上限为 1 时退化为逐个串行', async () => {
  const source = 'subagent-parallel-serial';
  const log: string[] = [];
  registerToolsExtension(source, [makeOrchestrationTool('orch_one', 30, log), makeOrchestrationTool('orch_two', 1, log)]);
  try {
    const calls = makeCalls(['orch_one', 'orch_two']);
    const result = await createStagedToolDispatcher({ checkPermission: async () => 'allow' }).dispatch(
      dispatchRequest(calls, 1),
    );

    assert.deepEqual(log, ['start:orch_one', 'end:orch_one', 'start:orch_two', 'end:orch_two']);
    assert.deepEqual(
      result.orderedResults.map(({ call }) => call.name),
      ['orch_one', 'orch_two'],
    );
  } finally {
    clearToolsExtension(source);
  }
});