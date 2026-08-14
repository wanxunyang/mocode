/** budget 评估与调度单元测试(从 scripts/core-tests/budget.test.ts 迁移到 node:test)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { ChatMessage } from '../src/llm/index.js';
import {
  BUDGET_LAYERS,
  BUDGET_RATIO,
  DEFAULT_BUDGET_POLICY,
  evaluateBudget,
  scheduleActions,
} from '../src/context/budget.js';
import type { BudgetLayer, BudgetReport, LayerBudget } from '../src/context/budget.js';
import { system } from './helpers.js';

function layer(overBudget = false, overRatio = 0): LayerBudget {
  return { actual: overBudget ? 101 : 0, budget: 100, overBudget, overRatio };
}

function report(input: {
  history?: boolean;
  system?: boolean;
  totalOver?: boolean;
  total?: number;
  window?: number;
  rawTotal?: number;
  correction?: number;
}): BudgetReport {
  const layers = Object.fromEntries(
    BUDGET_LAYERS.map((name) => [name, layer()]),
  ) as Record<BudgetLayer, LayerBudget>;
  layers.system = layer(input.system ?? false, input.system ? 1 : 0);
  layers.history = layer(input.history ?? false, input.history ? 1 : 0);
  return {
    step: 0,
    total: input.total ?? 0,
    rawTotal: input.rawTotal ?? input.total ?? 0,
    window: input.window ?? 10_000,
    layers,
    systemCosts: { prompt: 10, toolSchemas: 5 },
    triggers: [],
    totalOver: input.totalOver ?? false,
    hotBoundary: 1,
    correction: input.correction ?? 1,
  };
}

test('evaluateBudget 正确分层、排序且不修改 history', () => {
  const history: ChatMessage[] = [system('s'.repeat(40))];
  history.push({ role: 'system', content: '# 会话摘要\nsummary' } as ChatMessage);
  for (let turn = 0; turn < 5; turn++) {
    history.push({ role: 'user', content: `turn-${turn}` } as ChatMessage);
    history.push({ role: 'tool', tool_call_id: `tool-${turn}`, content: 'x'.repeat(20 + turn) } as ChatMessage);
  }
  const before = JSON.stringify(history);
  const result = evaluateBudget(history, 1_000, 7, 1.25);

  assert.equal(JSON.stringify(history), before);
  assert.equal(result.step, 7);
  assert.ok(result.layers.summary.actual > 0);
  assert.ok(result.layers.toolOld.actual > 0);
  assert.ok(result.layers.toolRecent.actual > 0);
  assert.equal(
    result.total,
    BUDGET_LAYERS.filter((name) => name !== 'reserve')
      .reduce((sum, name) => sum + result.layers[name].actual, 0),
  );
  for (let index = 1; index < result.triggers.length; index++) {
    assert.ok(result.layers[result.triggers[index - 1]].overRatio >= result.layers[result.triggers[index]].overRatio);
  }
});

test('scheduleActions 常规触发与窗口硬闸', () => {
  assert.deepEqual(scheduleActions(report({})), []);
  assert.deepEqual(
    scheduleActions(report({ system: true })),
    [{ kind: 'warn', layer: 'system', reason: '固定开销 101/100 (+1, 101%)；提示 10 + 工具 5，×1.00。' }],
  );
  // 常规:history 层超预算 + headroom 为负 → compact
  assert.deepEqual(
    scheduleActions(report({ history: true, total: 10_000 })),
    [{ kind: 'compact_history' }],
  );
  // 硬闸:校正后 total=0、history 层未超、totalOver=false,但 rawTotal 达触发线 → 照样 compact
  assert.deepEqual(
    scheduleActions(report({
      total: 0,
      rawTotal: Math.ceil(DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000),
      correction: 0.5,
    })),
    [{ kind: 'compact_history' }],
  );
  // 硬闸未达触发线 → 不压
  assert.deepEqual(
    scheduleActions(report({
      total: 0,
      rawTotal: Math.floor(DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000) - 1,
      correction: 0.5,
    })),
    [],
  );
});

test('硬闸回归:correction<1 折扣不否决真实溢出(289k/256k bug)', () => {
  // 复现用户场景:窗口 256k,correction 0.5 把调度器视角压到触发线以下,
  // 而 UI 裸估算已超窗。修复前 scheduleActions 返回 [],永不压缩。
  // 数据量取 rawTotal ≈ 300k:介于触发线 0.82×256k ≈ 210k 与 2×触发线之间,
  // 使校正后 total ≈ 150k 不超阈(totalOver=false),只能靠硬闸触发。
  const history: ChatMessage[] = [system('sys '.repeat(400))];
  for (let turn = 0; turn < 50; turn++) {
    history.push({ role: 'user', content: `please investigate and fix issue ${turn}` } as ChatMessage);
    history.push({ role: 'assistant', content: `I will check ${turn}` } as ChatMessage);
    for (let k = 0; k < 3; k++) {
      history.push({ role: 'tool', tool_call_id: `t${turn}-${k}`, content: 'x'.repeat(8000) } as ChatMessage);
    }
  }
  const window = 256_000;
  const result = evaluateBudget(history, window, 0, 0.5, []);
  assert.equal(result.totalOver, false, 'correction 0.5 下校正后 total 未超阈');
  const triggerLine = DEFAULT_BUDGET_POLICY.pressureTriggerRatio * window;
  assert.ok(result.rawTotal >= triggerLine, `裸估算 ${result.rawTotal} 应达触发线 ${triggerLine}`);
  assert.ok(result.rawTotal < 2 * triggerLine, '保持 totalOver=false 的构造(校正后不超阈)');
  const actions = scheduleActions(result);
  assert.deepEqual(actions, [{ kind: 'compact_history' }], '硬闸必须强制触发压缩');
});

test('evaluateBudget property: 300 组输入保持纯函数与报告不变量', () => {
  const messageArb = fc.record({
    role: fc.constantFrom<'user' | 'assistant' | 'tool'>('user', 'assistant', 'tool'),
    content: fc.string({ maxLength: 80 }),
  });
  fc.assert(fc.property(
    fc.array(messageArb, { maxLength: 30 }),
    fc.integer({ min: 1, max: 100_000 }),
    fc.integer({ min: 0, max: 300 }),
    (messages, window, correctionPercent) => {
      const history = [system('root'), ...messages] as ChatMessage[];
      const before = JSON.stringify(history);
      const result = evaluateBudget(history, window, 3, correctionPercent / 100);
      assert.equal(JSON.stringify(history), before);
      assert.equal(result.total, BUDGET_LAYERS.filter((name) => name !== 'reserve')
        .reduce((sum, name) => sum + result.layers[name].actual, 0));
      for (const name of BUDGET_LAYERS) {
        assert.equal(result.layers[name].budget, Math.floor(BUDGET_RATIO[name] * window));
        assert.ok(Number.isInteger(result.layers[name].actual) && result.layers[name].actual >= 0);
      }
      // rawTotal ≈ correction=1 时的总量:adj() 每条消息 round(raw*corr) 再除回 corr,
      // 逐条误差 ≤ 0.5/corr ≤ 1(correction 已钳位到 ≥0.5),故容差取消息条数。
      const raw = evaluateBudget(history, window, 3, 1);
      assert.ok(Math.abs(result.rawTotal - raw.total) <= history.length + 1,
        `rawTotal ${result.rawTotal} vs raw.total ${raw.total}`);
    },
  ), { numRuns: 300 });
});

test('scheduleActions property: 300 组报告动作有序且硬闸不被校正折扣否决', () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 100_000 }),
    fc.integer({ min: 0, max: 100_000 }),
    fc.boolean(),
    fc.boolean(),
    fc.double({ min: 0.5, max: 2, noNaN: true }),
    (total, rawTotal, historyOver, totalOver, correction) => {
      const actions = scheduleActions(report({
        history: historyOver,
        total: totalOver && total === 0 ? 1 : total,
        totalOver,
        rawTotal,
        correction,
      }));
      assert.ok(actions.every((action) => action.kind === 'warn' || action.kind === 'compact_history'));
      const hasCompact = actions.some((action) => action.kind === 'compact_history');
      if (rawTotal >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000) {
        assert.ok(hasCompact, `硬闸:rawTotal=${rawTotal} 必须触发 compact`);
      }
      if (!hasCompact) {
        assert.ok(Math.max(rawTotal, totalOver && total === 0 ? 1 : total) < DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000);
      }
    },
  ), { numRuns: 300 });
});
