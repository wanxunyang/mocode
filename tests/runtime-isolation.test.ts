import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgentCore } from '../src/agent/core.js';
import { createAgentRuntimeContext } from '../src/agent/runtime-context.js';
import type { ChatMessage, ChatTransport, ToolCallRef } from '../src/llm/index.js';
import { jailResolve } from '../src/sandbox/index.js';
import type { Tool } from '../src/tools/types.js';

function toolCall(id: string): ToolCallRef {
  return { id, name: 'runtime_probe', arguments: '{}' };
}

function createProbeTool(label: string, delayMs: number): Tool {
  return {
    name: 'runtime_probe',
    description: `Probe ${label}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capabilities: { effect: 'network', concurrency: 'parallel' },
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `${label}:${jailResolve('.')}`;
    },
  };
}

function createProbeTransport(label: string, expectedModel: string): ChatTransport {
  let step = 0;
  return async (messages, _handlers, _signal, tools) => {
    assert.equal(tools?.length, 1);
    assert.equal(tools?.[0]?.function.name, 'runtime_probe');
    if (step++ === 0) {
      return { content: '', toolCalls: [toolCall(`${label}-call`)] };
    }
    assert.ok(
      messages.some(
        (message) =>
          message.role === 'tool' && typeof message.content === 'string' && message.content.startsWith(label),
      ),
      `${label} must receive only its own tool result`,
    );
    return { content: `${label}:${expectedModel}:done`, toolCalls: [] };
  };
}

test('two concurrent RuntimeContexts isolate config, model transport, same-name tools, and sandbox roots', async () => {
  const leftRoot = mkdtempSync(path.join(tmpdir(), 'mocode-runtime-left-'));
  const rightRoot = mkdtempSync(path.join(tmpdir(), 'mocode-runtime-right-'));
  try {
    const left = createAgentRuntimeContext({
      sandboxRoot: leftRoot,
      tools: [createProbeTool('left', 20)],
      configOverrides: { model: 'left-model', baseURL: 'https://left.invalid/v1', apiKey: 'left-key' },
      modelTransport: createProbeTransport('left', 'left-model'),
    });
    const right = createAgentRuntimeContext({
      sandboxRoot: rightRoot,
      tools: [createProbeTool('right', 5)],
      configOverrides: { model: 'right-model', baseURL: 'https://right.invalid/v1', apiKey: 'right-key' },
      modelTransport: createProbeTransport('right', 'right-model'),
    });
    const leftHistory: ChatMessage[] = [{ role: 'system', content: 'left runtime' }];
    const rightHistory: ChatMessage[] = [{ role: 'system', content: 'right runtime' }];

    const [leftResult, rightResult] = await Promise.all([
      runAgentCore({
        history: leftHistory,
        userInput: 'probe',
        hooks: {},
        maxSteps: 2,
        runtimeContext: left,
        runtimeAllowedToolNames: new Set(['runtime_probe']),
      }),
      runAgentCore({
        history: rightHistory,
        userInput: 'probe',
        hooks: {},
        maxSteps: 2,
        pipeline: 'staged',
        runtimeContext: right,
        runtimeAllowedToolNames: new Set(['runtime_probe']),
      }),
    ]);

    assert.equal(leftResult.finalText, 'left:left-model:done');
    assert.equal(rightResult.finalText, 'right:right-model:done');
    assert.equal(left.config.model, 'left-model');
    assert.equal(right.config.model, 'right-model');
    assert.equal(left.toolRuntime.findTool('runtime_probe')?.description, 'Probe left');
    assert.equal(right.toolRuntime.findTool('runtime_probe')?.description, 'Probe right');

    const leftToolResult = leftHistory.find((message) => message.role === 'tool');
    const rightToolResult = rightHistory.find((message) => message.role === 'tool');
    assert.equal(leftToolResult?.content, `left:${path.resolve(leftRoot)}`);
    assert.equal(rightToolResult?.content, `right:${path.resolve(rightRoot)}`);
  } finally {
    rmSync(leftRoot, { recursive: true, force: true });
    rmSync(rightRoot, { recursive: true, force: true });
  }
});
