/**
 * 工具注册表单元测试:Map 索引一致性、扩展注册/重名拒绝/清除、
 * isFileMutationCapabilities 判定与资源键异常回落。
 * 注意:tools 数组是模块级单例,扩展注册会污染全局状态,统一 after() 清理。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  tools,
  findTool,
  registerToolsExtension,
  clearToolsExtension,
  getToolCapabilities,
  getToolResourceKeys,
  isFileMutationCapabilities,
  isFileMutationTool,
} from '../src/tools/registry.js';
import { builtinTools } from '../src/tools/builtins/index.js';
import type { Tool, ToolCapabilities } from '../src/tools/types.js';

const EXT_SOURCE = 'test-ext';

function fakeTool(name: string, capabilities?: ToolCapabilities): Tool {
  return {
    name,
    description: 'fake tool for tests',
    parameters: { type: 'object', properties: {} },
    capabilities,
    execute: async () => 'ok',
  };
}

after(() => {
  clearToolsExtension(EXT_SOURCE);
});

test('findTool: 命中返回工具,未命中返回 undefined', () => {
  const tool = findTool('read_file');
  assert.ok(tool);
  assert.equal(tool.name, 'read_file');
  assert.equal(findTool('no_such_tool_xyz'), undefined);
});

test('tools 数组与索引一致:每个数组元素都能 O(1) 命中', () => {
  for (const tool of tools) {
    assert.equal(findTool(tool.name), tool);
  }
});

test('registerToolsExtension: 注册后索引同步,新工具可查、数组可见', () => {
  const added = fakeTool('ext_probe', { effect: 'read', concurrency: 'parallel' });
  const rejected = registerToolsExtension(EXT_SOURCE, [added]);
  assert.deepEqual(rejected, []);
  assert.equal(findTool('ext_probe'), added);
  assert.ok(tools.includes(added));
});

test('registerToolsExtension: 与 builtin 重名被拒绝,builtin 实例优先保留', () => {
  const impostor = fakeTool('read_file');
  const rejected = registerToolsExtension(EXT_SOURCE, [impostor]);
  assert.deepEqual(rejected, ['read_file']);
  // 重名后注册表里仍是 builtin 实例,不是冒充者
  assert.notEqual(findTool('read_file'), impostor);
  assert.equal(findTool('read_file'), builtinTools.find((t) => t.name === 'read_file'));
});

test('clearToolsExtension: 清除后索引同步移除扩展工具', () => {
  const added = fakeTool('ext_ephemeral');
  registerToolsExtension(EXT_SOURCE, [added]);
  assert.equal(findTool('ext_ephemeral'), added);
  clearToolsExtension(EXT_SOURCE);
  assert.equal(findTool('ext_ephemeral'), undefined);
  assert.ok(!tools.includes(added));
});

test('getToolCapabilities: 缺声明回落保守默认(unknown + serial)', () => {
  const caps = getToolCapabilities('ext_probe_missing_caps');
  assert.equal(caps.effect, 'unknown');
  assert.equal(caps.concurrency, 'serial');
});

test('getToolResourceKeys: resources() 抛错回落空数组(调度器不抛)', () => {
  const tool = {
    ...fakeTool('ext_throwing_resources'),
    capabilities: {
      effect: 'write',
      concurrency: 'resource-locked',
      resources: () => { throw new Error('bad args'); },
    },
  } as Tool;
  registerToolsExtension(EXT_SOURCE, [tool]);
  assert.deepEqual(getToolResourceKeys('ext_throwing_resources', { path: 'x' }), []);
});

test('isFileMutationCapabilities: 仅 write + resource-locked 为真', () => {
  assert.equal(isFileMutationCapabilities({ effect: 'write', concurrency: 'resource-locked' }), true);
  assert.equal(isFileMutationCapabilities({ effect: 'write', concurrency: 'serial' }), false);
  assert.equal(isFileMutationCapabilities({ effect: 'read', concurrency: 'resource-locked' }), false);
  assert.equal(isFileMutationCapabilities({ effect: 'read', concurrency: 'parallel' }), false);
});

test('isFileMutationTool: 真实 builtin 中 write_file/edit_file 为 mutation', () => {
  assert.equal(isFileMutationTool('write_file'), true);
  assert.equal(isFileMutationTool('edit_file'), true);
  assert.equal(isFileMutationTool('read_file'), false);
  assert.equal(isFileMutationTool('run_command'), false);
  // sub-agent 声明 write+resource-locked,故按能力判定为 true;
  // 但 registry 热路径以 !delegatesResourceLocks 前置排除,不按 path 记 rollback。
  assert.equal(isFileMutationTool('sub-agent'), true);
});
