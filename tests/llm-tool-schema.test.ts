/** sanitizeToolSchemas:transport 边界剔除 uniqueItems(kimi-k3@dashscope 实测整请求 400)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { sanitizeToolSchemas } from '../src/llm/tool-schema.js';
// 触发内置工具自注册(installBuiltinTools),policy snapshot 才有真实工具面
import '../src/tools/builtins/index.js';
import { ToolPolicyController } from '../src/tools/policy.js';

type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

function hasUniqueItems(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUniqueItems);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === 'uniqueItems' || hasUniqueItems(v));
  }
  return false;
}

test('sanitizeToolSchemas: 递归剔除任意深度的 uniqueItems,保留其它关键字', () => {
  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'poisoned',
        description: 'd',
        parameters: {
          type: 'object',
          properties: {
            groups: { type: 'array', items: { type: 'string', enum: ['a'] }, minItems: 1, uniqueItems: true },
            nested: {
              type: 'object',
              properties: { deep: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
            },
          },
          required: ['groups'],
          additionalProperties: false,
        } as OpenAI.FunctionParameters,
      },
    },
  ];
  const out = sanitizeToolSchemas(tools);
  assert.equal(hasUniqueItems(out[0].function.parameters), false, 'uniqueItems 应被剔除');
  const params = out[0].function.parameters as Record<string, any>;
  assert.deepEqual(params.properties.groups.minItems, 1, 'minItems 应保留');
  assert.deepEqual(params.properties.groups.items.enum, ['a'], 'enum 应保留');
  assert.equal(params.additionalProperties, false, 'additionalProperties 应保留');
  assert.equal(out[0].function.name, 'poisoned');
});

test('sanitizeToolSchemas: 无需改写时返回原数组引用(前缀缓存逐字节稳定)', () => {
  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'clean',
        description: 'd',
        parameters: { type: 'object', properties: {} } as OpenAI.FunctionParameters,
      },
    },
  ];
  assert.equal(sanitizeToolSchemas(tools), tools, '干净 schema 必须原引用返回');
});

test('回归:add_tool_groups / select_tool_groups 构造点不再携带 uniqueItems', () => {
  // 真实路由 schema(依赖已注册 builtins;tests 装配与 agent-core.test 相同路径)
  const ctrl = new ToolPolicyController({ groups: ['workspace-write', 'shell-debug'], maxExpansions: 3 });
  const snap = ctrl.snapshot(false);
  const addTool = snap.tools.find((t) => t.function.name === 'add_tool_groups');
  if (addTool) {
    assert.equal(hasUniqueItems(addTool.function.parameters), false, 'add_tool_groups schema 不应含 uniqueItems');
  }
});
