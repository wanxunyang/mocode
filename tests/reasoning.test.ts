/** Reasoning Effort 适配层测试(#token-efficiency P3)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReasoningEffort,
  recognizesReasoning,
  resolveReasoningParams,
  runWithEffortScope,
  getScopedEffort,
} from '../src/llm/reasoning.js';
import { effectiveReasoningEffort } from '../src/config/index.js';

// ── parse ──────────────────────────────────────────────
test('parseReasoningEffort: 五档大小写/空白, 非法返 undefined', () => {
  assert.equal(parseReasoningEffort('HIGH'), 'high');
  assert.equal(parseReasoningEffort(' low '), 'low');
  assert.equal(parseReasoningEffort('auto'), 'auto');
  assert.equal(parseReasoningEffort('xhigh'), undefined);
  assert.equal(parseReasoningEffort(42), undefined);
  // 配对引号剥离。
  assert.equal(parseReasoningEffort('"medium"'), 'medium');
  assert.equal(parseReasoningEffort("'off'"), 'off');
});

// ── Anthropic 4.6+ ────────────────────────────────────
test('anthropic 4.6+: output_config + adaptive; off → disabled', () => {
  const target = { provider: 'anthropic' as const, model: 'claude-opus-4-6' };
  assert.deepEqual(resolveReasoningParams('off', target), { thinking: { type: 'disabled' } });
  assert.deepEqual(resolveReasoningParams('low', target), {
    output_config: { effort: 'low' },
    thinking: { type: 'adaptive' },
  });
  assert.deepEqual(resolveReasoningParams('high', target), {
    output_config: { effort: 'high' },
    thinking: { type: 'adaptive' },
  });
});

// ── Anthropic 旧版 ────────────────────────────────────
test('anthropic 旧版: budget_tokens; off/auto 不下发', () => {
  const target = { provider: 'anthropic' as const, model: 'claude-3-5-sonnet-20241022' };
  assert.deepEqual(resolveReasoningParams('low', target), {
    thinking: { type: 'enabled', budget_tokens: 1024 },
  });
  assert.deepEqual(resolveReasoningParams('medium', target), {
    thinking: { type: 'enabled', budget_tokens: 4096 },
  });
  assert.deepEqual(resolveReasoningParams('off', target), {});
  assert.deepEqual(resolveReasoningParams('auto', target), {});
});

test('anthropic budget clamp: high@8192 → 7168; max=1024 → 不下发', () => {
  const t1 = resolveReasoningParams('high', {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 8192,
  });
  assert.deepEqual(t1, { thinking: { type: 'enabled', budget_tokens: 7168 } });

  const t2 = resolveReasoningParams('high', {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 1024,
  });
  assert.deepEqual(t2, {});
});

// ── OpenAI o / gpt-5 ──────────────────────────────────
test('openai o3/gpt-5: reasoning_effort; off 落到 low', () => {
  assert.deepEqual(resolveReasoningParams('medium', { provider: 'openai', model: 'o3' }), {
    reasoning_effort: 'medium',
  });
  assert.deepEqual(resolveReasoningParams('off', { provider: 'openai', model: 'o1' }), {
    reasoning_effort: 'low',
  });
  assert.deepEqual(resolveReasoningParams('high', { provider: 'openai', model: 'gpt-5' }), {
    reasoning_effort: 'high',
  });
});

// ── Qwen3 ─────────────────────────────────────────────
test('qwen3: enable_thinking + thinking_budget', () => {
  assert.deepEqual(resolveReasoningParams('off', { provider: 'openai', model: 'qwen3-235b' }), {
    enable_thinking: false,
  });
  assert.deepEqual(resolveReasoningParams('low', { provider: 'openai', model: 'Qwen3-32B' }), {
    enable_thinking: true,
    thinking_budget: 1024,
  });
});

// ── GLM / DeepSeek / 未知 ─────────────────────────────
test('glm-4.5/4.6/5: thinking enabled/disabled; deepseek-r1/未知不下发', () => {
  assert.deepEqual(resolveReasoningParams('off', { provider: 'openai', model: 'glm-4.6' }), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(resolveReasoningParams('high', { provider: 'openai', model: 'glm-4.5-air' }), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(resolveReasoningParams('high', { provider: 'openai', model: 'deepseek-r1-70b' }), {});
  assert.deepEqual(resolveReasoningParams('high', { provider: 'openai', model: 'some-mystery-model' }), {});
});

// ── 豆包 Seed(火山 Ark) ──────────────────────────────
test('doubao-seed: thinking enabled/disabled(开关式)', () => {
  assert.equal(recognizesReasoning({ provider: 'openai', model: 'doubao-seed-evolving' }), true);
  assert.deepEqual(resolveReasoningParams('high', { provider: 'openai', model: 'doubao-seed-evolving' }), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(resolveReasoningParams('medium', { provider: 'openai', model: 'doubao_seed_1_6' }), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(resolveReasoningParams('off', { provider: 'openai', model: 'doubao-seed-evolving' }), {
    thinking: { type: 'disabled' },
  });
});

// ── recognizes ────────────────────────────────────────
test('recognizesReasoning 白名单', () => {
  assert.equal(recognizesReasoning({ provider: 'anthropic', model: 'whatever' }), true);
  assert.equal(recognizesReasoning({ provider: 'openai', model: 'o4-mini' }), true);
  assert.equal(recognizesReasoning({ provider: 'openai', model: 'gpt5-chat' }), true);
  assert.equal(recognizesReasoning({ provider: 'openai', model: 'llama-3-70b' }), false);
});

// ── ALS scope + 统一解析 ──────────────────────────────
test('effort scope: scope 内可见, 嵌套覆盖, scope 外回退', async () => {
  assert.equal(getScopedEffort(), undefined);
  await runWithEffortScope('high', async () => {
    assert.equal(getScopedEffort(), 'high');
    assert.equal(effectiveReasoningEffort(), 'high');
    // 显式参数高于 scope(compact low 不被改写)。
    assert.equal(effectiveReasoningEffort('low'), 'low');
    await runWithEffortScope('off', async () => {
      assert.equal(getScopedEffort(), 'off');
    });
    assert.equal(getScopedEffort(), 'high');
  });
  assert.equal(getScopedEffort(), undefined);
});
