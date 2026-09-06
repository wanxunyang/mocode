import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime } from '../src/tools/registry.js';
import type { Tool } from '../src/tools/types.js';

function fakeTool(name: string, output: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {} },
    capabilities: { effect: 'network', concurrency: 'parallel' },
    execute: async () => output,
  };
}

test('ToolRuntime instances isolate builtins, extensions, indexes, and implementations', async () => {
  const left = new ToolRuntime();
  const right = new ToolRuntime();
  const leftTools = left.tools;
  const rightTools = right.tools;
  const leftBuiltin = fakeTool('left_builtin', 'left builtin');
  const leftShared = fakeTool('shared_probe', 'left implementation');
  const rightShared = fakeTool('shared_probe', 'right implementation');

  left.installBuiltinTools([leftBuiltin]);
  left.registerToolsExtension('left-extension', [leftShared]);
  right.registerToolsExtension([rightShared]);

  assert.equal(left.tools, leftTools);
  assert.equal(right.tools, rightTools);
  assert.notEqual(left.tools, right.tools);
  assert.equal(left.findTool('left_builtin'), leftBuiltin);
  assert.equal(right.findTool('left_builtin'), undefined);
  assert.equal(left.findTool('shared_probe'), leftShared);
  assert.equal(right.findTool('shared_probe'), rightShared);
  assert.equal(await left.executeTool('shared_probe', '{}'), 'left implementation');
  assert.equal(await right.executeTool('shared_probe', '{}'), 'right implementation');

  left.clearToolsExtension('left-extension');
  assert.equal(left.tools, leftTools);
  assert.equal(left.findTool('shared_probe'), undefined);
  assert.equal(right.findTool('shared_probe'), rightShared);
});

test('ToolRuntime preserves builtin precedence without leaking it to another runtime', () => {
  const left = new ToolRuntime();
  const right = new ToolRuntime();
  const builtin = fakeTool('collision_probe', 'builtin');
  const extension = fakeTool('collision_probe', 'extension');

  left.installBuiltinTools([builtin]);
  assert.deepEqual(left.registerToolsExtension('extension', [extension]), ['collision_probe']);
  assert.equal(left.findTool('collision_probe'), builtin);
  assert.equal(right.findTool('collision_probe'), undefined);

  assert.deepEqual(right.registerToolsExtension('extension', [extension]), []);
  assert.equal(right.findTool('collision_probe'), extension);
  assert.equal(left.findTool('collision_probe'), builtin);
});

test('ToolRuntime uses its injected sandbox enforcement and normalizes denial', async () => {
  let executed = false;
  const runtime = new ToolRuntime({
    enforceSandbox: (name) => (name === 'sandboxed_probe' ? 'blocked by isolated sandbox' : null),
  });
  runtime.registerToolsExtension('sandbox-test', [
    {
      ...fakeTool('sandboxed_probe', 'should not execute'),
      execute: async () => {
        executed = true;
        return 'should not execute';
      },
    },
  ]);

  const outcome = await runtime.executeToolOutcome('sandboxed_probe', '{}');

  assert.equal(executed, false);
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.code, 'SANDBOX_DENIED');
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.output, 'blocked by isolated sandbox');
  assert.deepEqual(outcome.changedFiles, []);
});
