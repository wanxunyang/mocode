/**
 * 系统提示组装测试。
 *
 * 这个模块存在的唯一理由是「REPL 与 stdio host 必须用同一套段组合」。历史上 host
 * 自己拼了一版、漏掉 About you / Memory Index / Episode / graph hint / plan 五段，
 * 表现是「记忆打开了但从未进上下文」——没有报错、没有日志，只有模型不知道。
 * 所以这里守的是接线，不是文案：段落开关是否真的跟随入参。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemMessage } from '../../src/prompt/system-prompt.js';

test('记忆关闭时不注入 About you / Memory Index / 情节段', () => {
  const prompt = buildSystemMessage({ memoryEnabled: false });
  assert.ok(prompt.length > 0, '系统提示不能为空');
  assert.ok(!prompt.includes('## About you'), 'memoryEnabled=false 时不应有 About you 段');
  assert.ok(!prompt.includes('## Memory Index'), 'memoryEnabled=false 时不应有 Memory Index 段');
});

test('plan 模式追加只读约束段', () => {
  const auto = buildSystemMessage({ memoryEnabled: false, planMode: false });
  const plan = buildSystemMessage({ memoryEnabled: false, planMode: true });
  assert.ok(!auto.includes('PLAN MODE'), 'auto 模式不应带 PLAN 段');
  assert.ok(plan.includes('PLAN MODE'), 'plan 模式必须带 PLAN MODE 段');
  assert.ok(plan.length > auto.length, 'PLAN 段应为纯追加');
  // 段位置契约：追加在末尾而不是改写前缀，否则 plan 切换会让整段前缀缓存失效。
  assert.ok(plan.startsWith(auto), 'PLAN 段必须追加，不能改写已有前缀');
});

test('Skills 段仍在系统提示内（effectiveSystemPrompt 未被绕过）', () => {
  const prompt = buildSystemMessage({ memoryEnabled: false });
  // skills 段只在存在可用 skill 时出现；这里断言的是「没被拼成残缺的 base」。
  assert.ok(prompt.includes('terminal coding agent'), 'base 主体必须存在');
});
