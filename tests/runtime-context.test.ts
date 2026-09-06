import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { config, createConfigSnapshot } from '../src/config/index.js';
import { createAgentRuntimeContext, defaultAgentRuntimeContext } from '../src/agent/runtime-context.js';
import { isMutationTool } from '../src/agent/core.js';
import { chat, type ChatTransport } from '../src/llm/index.js';
import { getSandboxRoot } from '../src/sandbox/root.js';
import { defaultToolRuntime } from '../src/tools/registry.js';
import { resetPermissionGrantsForTests, type PermissionCheckOptions } from '../src/permissions/index.js';
import type { Tool } from '../src/tools/types.js';

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {} },
    capabilities: { effect: 'network', concurrency: 'parallel' },
    execute: async () => name,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

test('createConfigSnapshot clones config, applies overrides, and owns mutable arrays', () => {
  const source = createConfigSnapshot({
    model: 'source-model',
    systemPrompt: 'source prompt',
    llmKeysFromShell: ['LLM_MODEL'],
  });
  const snapshot = createConfigSnapshot({ model: 'runtime-model' }, source);

  assert.notEqual(snapshot, source);
  assert.equal(snapshot.model, 'runtime-model');
  assert.equal(snapshot.systemPrompt, 'source prompt');
  assert.deepEqual(snapshot.llmKeysFromShell, ['LLM_MODEL']);
  assert.notEqual(snapshot.llmKeysFromShell, source.llmKeysFromShell);

  snapshot.llmKeysFromShell.push('LLM_BASE_URL');
  assert.deepEqual(source.llmKeysFromShell, ['LLM_MODEL']);
});

test('createAgentRuntimeContext owns tool runtime and exposes an injectable model transport', async () => {
  const leftTool = fakeTool('left_probe');
  const runtimeMutationTool: Tool = {
    ...fakeTool('runtime_mutation_probe'),
    capabilities: { effect: 'write', concurrency: 'resource-locked' },
  };
  const rightTool = fakeTool('right_probe');
  const transport: ChatTransport = async () => ({ content: 'runtime transport', toolCalls: [] });
  const left = createAgentRuntimeContext({ tools: [leftTool, runtimeMutationTool], modelTransport: transport });
  const right = createAgentRuntimeContext({ tools: [rightTool] });

  assert.notEqual(left.config, config);
  assert.notEqual(left.toolRuntime, right.toolRuntime);
  assert.notEqual(left.toolRuntime, defaultToolRuntime);
  assert.equal(left.toolRuntime.findTool('left_probe'), leftTool);
  assert.equal(left.toolRuntime.findTool('right_probe'), undefined);
  assert.equal(isMutationTool('runtime_mutation_probe'), false);
  assert.equal(isMutationTool('runtime_mutation_probe', left.toolRuntime), true);
  assert.equal(right.toolRuntime.findTool('right_probe'), rightTool);
  assert.equal(right.toolRuntime.findTool('left_probe'), undefined);
  assert.equal(left.modelTransport, transport);
  assert.equal(typeof right.modelTransport, 'function');
  assert.equal((await left.modelTransport([{ role: 'user', content: 'probe' }])).content, 'runtime transport');

  assert.equal(left.getAgentMode(), 'auto');
  assert.equal(left.setAgentMode('plan'), 'auto');
  assert.equal(left.getAgentMode(), 'plan');
  assert.equal(right.getAgentMode(), 'auto');
});

test('independent runtimes own session permission grants', async () => {
  resetPermissionGrantsForTests();
  const confirmTool: Tool = { ...fakeTool('permission_probe'), risk: 'confirm' };
  const left = createAgentRuntimeContext({
    tools: [confirmTool],
    sandboxRoot: resolve('.runtime-permission-left'),
    configOverrides: { permissionEnabled: true },
  });
  const right = createAgentRuntimeContext({
    tools: [confirmTool],
    sandboxRoot: resolve('.runtime-permission-right'),
    configOverrides: { permissionEnabled: true },
  });
  let leftPrompts = 0;
  let rightPrompts = 0;

  const allowSession: NonNullable<PermissionCheckOptions['prompt']> = async (request) => {
    leftPrompts++;
    const option = request.options?.[1];
    return { action: 'selected', value: typeof option === 'string' ? option : (option?.label ?? '') };
  };
  assert.equal(await left.checkPermission(confirmTool, {}, undefined, { prompt: allowSession }), 'allow');
  assert.equal(await left.checkPermission(confirmTool, {}, undefined, { prompt: allowSession }), 'allow');
  assert.equal(leftPrompts, 1);

  assert.equal(
    await right.checkPermission(confirmTool, {}, undefined, {
      prompt: async () => {
        rightPrompts++;
        return { action: 'cancelled' as const };
      },
    }),
    'deny',
  );
  assert.equal(rightPrompts, 1);
  resetPermissionGrantsForTests();
});

test('defaultAgentRuntimeContext keeps global singleton bindings', () => {
  assert.equal(defaultAgentRuntimeContext.config, config);
  assert.equal(defaultAgentRuntimeContext.toolRuntime, defaultToolRuntime);
  assert.equal(defaultAgentRuntimeContext.modelTransport, chat);
});

test('runInScope isolates concurrent sandbox roots and restores the outer scope', async () => {
  const before = getSandboxRoot();
  const leftRoot = resolve('.runtime-context-left');
  const rightRoot = resolve('.runtime-context-right');
  const left = createAgentRuntimeContext({ sandboxRoot: leftRoot, tools: [] });
  const right = createAgentRuntimeContext({ sandboxRoot: rightRoot, tools: [] });

  await Promise.all([
    left.runInScope(async () => {
      assert.equal(getSandboxRoot(), leftRoot);
      await delay(15);
      assert.equal(getSandboxRoot(), leftRoot);
    }),
    right.runInScope(async () => {
      assert.equal(getSandboxRoot(), rightRoot);
      await delay(5);
      assert.equal(getSandboxRoot(), rightRoot);
      await delay(15);
      assert.equal(getSandboxRoot(), rightRoot);
    }),
  ]);

  assert.equal(getSandboxRoot(), before);
});
