/** M3 单测：reasoning-cap（能力形态 + 厂商方言 → 请求字段）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { paramsFromCatalog, dialectForProvider } from '../src/models/reasoning-cap.js';

test('dialectForProvider: 已知厂商映射；未知 undefined', () => {
  assert.equal(dialectForProvider('openai'), 'openai-effort');
  assert.equal(dialectForProvider('alibaba'), 'qwen');
  assert.equal(dialectForProvider('zhipuai'), 'thinking-toggle');
  assert.equal(dialectForProvider('volcengine'), 'thinking-toggle');
  assert.equal(dialectForProvider('unknown-co'), undefined);
  assert.equal(dialectForProvider(undefined), undefined);
});

test('未知厂商：保守不下发 {}', () => {
  assert.deepEqual(
    paramsFromCatalog({ effort: 'high', catalogProviderId: 'mystery', reasoningOptions: [{ type: 'toggle' }] }),
    {},
  );
});

test('toggle + thinking 方言：非 off → enabled；off → disabled', () => {
  const opts = [{ type: 'toggle' as const }];
  assert.deepEqual(paramsFromCatalog({ effort: 'high', catalogProviderId: 'volcengine', reasoningOptions: opts }), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(paramsFromCatalog({ effort: 'off', catalogProviderId: 'zhipuai', reasoningOptions: opts }), {
    thinking: { type: 'disabled' },
  });
});

test('effort + openai 方言：档位映射进合法 values；off 落最低档', () => {
  const opts = [{ type: 'effort' as const, values: ['low', 'medium', 'high'] }];
  assert.deepEqual(paramsFromCatalog({ effort: 'high', catalogProviderId: 'openai', reasoningOptions: opts }), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(paramsFromCatalog({ effort: 'medium', catalogProviderId: 'openai', reasoningOptions: opts }), {
    reasoning_effort: 'medium',
  });
  // 只有 low/high/max 时，medium → 就近（high 优先于 low 取决于实现；这里断言落在合法集合内）。
  const opts2 = [{ type: 'effort' as const, values: ['low', 'high', 'max'] }];
  const r = paramsFromCatalog({ effort: 'medium', catalogProviderId: 'xai', reasoningOptions: opts2 });
  assert.ok(['low', 'high', 'max'].includes((r as { reasoning_effort: string }).reasoning_effort));
});

test('off + openai 方言：无法真关，落到 values 最低档', () => {
  const opts = [{ type: 'effort' as const, values: ['low', 'high'] }];
  assert.deepEqual(paramsFromCatalog({ effort: 'off', catalogProviderId: 'openai', reasoningOptions: opts }), {
    reasoning_effort: 'low',
  });
});

test('qwen 方言：off → enable_thinking false；非 off 带 budget（budget_tokens 选项）', () => {
  assert.deepEqual(
    paramsFromCatalog({ effort: 'off', catalogProviderId: 'alibaba', reasoningOptions: [{ type: 'toggle' }] }),
    { enable_thinking: false },
  );
  const withBudget = paramsFromCatalog({
    effort: 'medium',
    catalogProviderId: 'alibaba',
    reasoningOptions: [{ type: 'budget_tokens' }],
  });
  assert.equal(withBudget.enable_thinking, true);
  assert.equal(withBudget.thinking_budget, 4096);

  // min 下界生效。
  const minB = paramsFromCatalog({
    effort: 'low',
    catalogProviderId: 'alibaba',
    reasoningOptions: [{ type: 'budget_tokens', min: 2048 }],
  });
  assert.equal(minB.thinking_budget, 2048);
});

test('无 reasoningOptions 但方言已知：openai 仍下发归一化档；qwen 仅开关', () => {
  assert.deepEqual(paramsFromCatalog({ effort: 'high', catalogProviderId: 'openai', reasoningOptions: [] }), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(paramsFromCatalog({ effort: 'off', catalogProviderId: 'alibaba', reasoningOptions: [] }), {
    enable_thinking: false,
  });
});
