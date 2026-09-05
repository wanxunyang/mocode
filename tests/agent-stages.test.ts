import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentCore, type AgentHooks, type AgentRunOptions, type AgentRunResult } from '../src/agent/core.js';
import { defaultAgentRuntimeContext } from '../src/agent/runtime-context.js';
import { createAgentPipelineAssembly } from '../src/agent/pipeline.js';
import {
  AGENT_STAGE_NAMES,
  type AgentPipeline,
  type AgentStageImplementation,
  type AgentStageName,
} from '../src/agent/stages/contracts.js';
import { __setChatCreateImpl, type ChatMessage } from '../src/llm/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
import type { AgentTraceEvent } from '../src/session/trace.js';
import { findTool } from '../src/tools/registry.js';
import { ToolPolicyController } from '../src/tools/policy.js';
import '../src/tools/builtins/index.js';

function sseStream(
  chunks: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>,
): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [], ...(chunk.usage ? { usage: chunk.usage } : {}) };
    }
  })();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'ts' && key !== 'eventId' && key !== 'durationMs')
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

interface ReplayResult {
  result: AgentRunResult;
  history: ChatMessage[];
  hooks: string[];
  traces: unknown[];
  traceSummaries: unknown[];
  requests: unknown[];
  modelCalls: number;
}

async function replayRecordedTurn(
  pipeline: AgentPipeline,
  stageOverrides?: Partial<Record<AgentStageName, AgentStageImplementation>>,
): Promise<ReplayResult> {
  let modelCalls = 0;
  const requests: unknown[] = [];
  __setChatCreateImpl(async (body) => {
    modelCalls++;
    requests.push(stableValue(structuredClone(body)));
    if (modelCalls === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'stage1-read',
                function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
              },
            ],
          },
        },
        { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      ]);
    }
    return sseStream([
      { delta: { content: 'stage replay done' } },
      { usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205 } },
    ]);
  });

  const history: ChatMessage[] = [{ role: 'system', content: 'stage replay system' }];
  const hookEvents: string[] = [];
  const traceEvents: AgentTraceEvent[] = [];
  const traceSummaries: unknown[] = [];
  const hooks: AgentHooks = {
    onStepStart: () => hookEvents.push('step_start'),
    onToolCall: (name) => hookEvents.push(`tool_call:${name}`),
    onLiveUsage: (usage) => hookEvents.push(`live_usage:${JSON.stringify(usage)}`),
    onChatDone: () => hookEvents.push('chat_done'),
    onToolHeader: (call) => hookEvents.push(`tool_header:${call.name}`),
    onToolStart: (name) => hookEvents.push(`tool_start:${name}`),
    onToolResult: (call) => hookEvents.push(`tool_result:${call.name}`),
    onToolDone: () => hookEvents.push('tool_done'),
    onToolBatchEnd: () => hookEvents.push('batch_end'),
    onText: (text) => hookEvents.push(`text:${text}`),
    onTextEnd: () => hookEvents.push('text_end'),
    onDone: () => hookEvents.push('done'),
  };

  try {
    const result = await runAgentCore({
      pipeline,
      stageOverrides,
      history,
      userInput: 'read fixture then finish',
      maxSteps: 2,
      hooks,
      toolPolicy: new ToolPolicyController({ id: 'stage1-replay-policy', maxExpansions: 0 }),
      runtimeContext: {
        ...defaultAgentRuntimeContext,
        getAgentMode: () => 'auto' as const,
        getCurrentSessionId: () => 'stage1-replay',
        getCurrentTurnId: () => 501,
        getTokenCalibration: () => ({ correction: 1, samples: 0 }),
        updateTokenCalibration: () => ({ correction: 1, samples: 1 }),
      },
      onContextUpdate: () => hookEvents.push('context_update'),
      traceContext: { sessionId: 'stage1-replay', turnId: 501 },
      onTraceEvent: (event) => traceEvents.push(event),
      onTrace: (trace) => traceSummaries.push(stableValue(trace)),
      suppressOpeningAnalysis: true,
      suppressSessionState: true,
    });
    return {
      result,
      history: structuredClone(history),
      hooks: hookEvents,
      traces: traceEvents.map(stableValue),
      traceSummaries,
      requests,
      modelCalls,
    };
  } finally {
    __setChatCreateImpl(null);
  }
}

async function replayAskHumanOrder(
  pipeline: AgentPipeline,
  stageOverrides?: Partial<Record<AgentStageName, AgentStageImplementation>>,
): Promise<string[]> {
  let modelCalls = 0;
  __setChatCreateImpl(async () => {
    modelCalls++;
    if (modelCalls === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'ask-order',
                function: { name: 'ask_human', arguments: '{"question":"Continue?","options":[]}' },
              },
            ],
          },
        },
      ]);
    }
    return sseStream([{ delta: { content: 'done' } }]);
  });
  const history: ChatMessage[] = [{ role: 'system', content: 'ask order system' }];
  const sequence: string[] = [];
  const toolCount = () => history.filter((message) => message.role === 'tool').length;
  const askTool = findTool('ask_human');
  const originalExecute = askTool?.execute;
  if (askTool) askTool.execute = async () => 'answer';
  try {
    await runAgentCore({
      pipeline,
      stageOverrides,
      history,
      userInput: 'ask once',
      maxSteps: 2,
      hooks: { onToolResult: () => sequence.push(`hook:${toolCount()}`) },
      toolsOverride: askTool
        ? [
            {
              type: 'function',
              function: {
                name: askTool.name,
                description: askTool.description,
                parameters: askTool.parameters as never,
              },
            },
          ]
        : [],
      runtimeAllowedToolNames: new Set(['ask_human']),
      traceContext: { sessionId: 'ask-order', turnId: 777 },
      onTraceEvent: (event) => {
        if (event.type === 'ask_human_call') sequence.push(`trace:${toolCount()}`);
      },
      suppressOpeningAnalysis: true,
      suppressSessionState: true,
    });
    return sequence;
  } finally {
    if (askTool && originalExecute) askTool.execute = originalExecute;
    __setChatCreateImpl(null);
  }
}

test('Stage assembly: 每个 run 新建 adapters，staged 全量绑定且只委托一次', async () => {
  const result: AgentRunResult = {
    completed: true,
    terminationReason: 'completed',
    finalText: 'delegated once',
  };
  let calls = 0;
  const runLegacy = async (): Promise<AgentRunResult> => {
    calls++;
    return result;
  };
  const first = createAgentPipelineAssembly({ pipeline: 'legacy', runLegacy });
  const second = createAgentPipelineAssembly({ pipeline: 'staged', runLegacy });

  assert.notEqual(first, second);
  assert.notEqual(first.coordinator, second.coordinator);
  assert.notEqual(first.stages, second.stages);
  assert.notEqual(first.createHistoryManager, second.createHistoryManager);
  assert.equal(first.pipeline, 'legacy');
  assert.equal(second.pipeline, 'staged');
  for (const name of AGENT_STAGE_NAMES) {
    assert.equal(first.stages[name].name, name);
    assert.equal(first.stages[name].implementation, 'legacy');
    assert.equal(second.stages[name].implementation, 'staged');
  }

  const toolsRolledBack = createAgentPipelineAssembly({
    pipeline: 'staged',
    stageOverrides: { tools: 'legacy' },
    runLegacy,
  });
  assert.equal(toolsRolledBack.stages.tools.implementation, 'legacy');
  assert.equal(toolsRolledBack.stages.model.implementation, 'staged');

  const delegated = await second.run({ history: [], userInput: 'noop', hooks: {} } as AgentRunOptions);
  assert.equal(delegated, result);
  assert.equal(calls, 1, 'staged assembly must not shadow-run the legacy coordinator');
});

test('Stage 6 replay: ask_human trace 保持在 result hook 之后、history publication 之前', async () => {
  const legacy = await replayAskHumanOrder('legacy');
  const stagedWithDirectHistory = await replayAskHumanOrder('staged', { history: 'legacy' });
  assert.deepEqual(legacy, ['hook:0', 'trace:0']);
  assert.deepEqual(stagedWithDirectHistory, legacy);
});

test('Stage 1 replay: legacy/staged 的 request、history、hooks、trace 和 result 稳定字段一致', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-agent-stage1-replay-'));
  writeFileSync(join(root, 'fixture.txt'), 'stage-one-replay-content', 'utf8');
  const previousRoot = setSandboxRoot(root);

  try {
    const legacy = await replayRecordedTurn('legacy');
    const staged = await replayRecordedTurn('staged');
    const toolsRolledBack = await replayRecordedTurn('staged', { tools: 'legacy' });

    assert.equal(legacy.modelCalls, 2);
    assert.equal(staged.modelCalls, 2);
    assert.equal(toolsRolledBack.modelCalls, 2);
    assert.deepEqual(staged.requests, legacy.requests);
    assert.deepEqual(staged.history, legacy.history);
    assert.deepEqual(staged.hooks, legacy.hooks);
    assert.deepEqual(staged.traces, legacy.traces);
    assert.deepEqual(staged.traceSummaries, legacy.traceSummaries);
    assert.deepEqual(staged.result, legacy.result);
    assert.deepEqual(toolsRolledBack.requests, legacy.requests);
    assert.deepEqual(toolsRolledBack.history, legacy.history);
    assert.deepEqual(toolsRolledBack.hooks, legacy.hooks);
    assert.deepEqual(toolsRolledBack.traces, legacy.traces);
    assert.deepEqual(toolsRolledBack.traceSummaries, legacy.traceSummaries);
    assert.deepEqual(toolsRolledBack.result, legacy.result);
  } finally {
    __setChatCreateImpl(null);
    setSandboxRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});
