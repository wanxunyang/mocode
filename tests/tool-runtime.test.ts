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
  right.registerToolsExtension('right-extension', [rightShared]);

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

  assert.notEqual(fakeTool('shared_probe', 'x').name, rightShared.description);
});

test('ToolRuntime preserves builtin precedence without leaking it to another runtime', () => {
  const runtime = new ToolRuntime();
  const builtin = fakeTool('probe', 'builtin impl');
  runtime.installBuiltinTools([builtin]);

  const rejected = runtime.registerToolsExtension('ext', [fakeTool('probe', 'extension impl')]);

  assert.deepEqual(rejected, ['probe']);
  assert.equal(runtime.findTool('probe'), builtin);
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

/**
 * 弱模型/中转网关常把 integer 参数序列化成字符串(真实会话 2026-10-08:
 * read_file {"offset":"124","limit":"22"} / run_command {"timeout":"90000"}),
 * coerceTypes 必须在 AJV 校验前自动还原,否则模型反复撞 "must be integer" 乒乓失败。
 * 此测试锁定该行为,防止有人把 coerceTypes 改回 false 而不被察觉。
 */
test('ToolRuntime coerces string-encoded integers before AJV validation (coerceTypes guard)', async () => {
  let seen: Record<string, unknown> | undefined;
  const runtime = new ToolRuntime({
    // 沙箱放行:本用例只关心校验层,不关心沙箱路径重写。
    enforceSandbox: () => null,
  });
  runtime.registerToolsExtension('coerce-test', [
    {
      name: 'coerce_probe',
      description: 'probe with integer params',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
      },
      capabilities: { effect: 'read', concurrency: 'parallel' },
      execute: async (args) => {
        seen = { ...args };
        return 'ok';
      },
    },
  ]);

  // 真实故障形态:字符串数字。必须校验通过,且强转后的值传给 execute。
  const outcome = await runtime.executeToolOutcome(
    'coerce_probe',
    JSON.stringify({ path: 'a.ts', offset: '124', limit: '22' }),
  );
  assert.equal(outcome.status, 'success');
  assert.deepEqual(seen, { path: 'a.ts', offset: 124, limit: 22 });

  // 真正的类型错误仍要拦:非数字字符串、浮点数、区间字符串。
  for (const bad of ['"350.5"', '"350-460"', '[124]', '{}']) {
    const rejected = await runtime.executeToolOutcome(
      'coerce_probe',
      JSON.stringify({ path: 'a.ts', offset: JSON.parse(bad) }),
    );
    assert.equal(rejected.status, 'error');
    assert.equal(rejected.code, 'INVALID_ARGUMENTS');
    assert.match(rejected.output, /must be integer/);
  }
});
