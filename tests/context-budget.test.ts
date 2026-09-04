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
  const layers = Object.fromEntries(BUDGET_LAYERS.map((name) => [name, layer()])) as Record<BudgetLayer, LayerBudget>;
  layers.system = layer(input.system ?? false, input.system ? 1 : 0);
  layers.history = layer(input.history ?? false, input.history ? 1 : 0);
  return {
    step: 0,
    total: input.total ?? 0,
    rawTotal: input.rawTotal ?? input.total ?? 0,
    window: input.window ?? 10_000,
    layers,
    systemCosts: { prompt: 10, toolSchemas: 5, ephemeralInjection: 0 },
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
    BUDGET_LAYERS.filter((name) => name !== 'reserve').reduce((sum, name) => sum + result.layers[name].actual, 0),
  );
  for (let index = 1; index < result.triggers.length; index++) {
    assert.ok(result.layers[result.triggers[index - 1]].overRatio >= result.layers[result.triggers[index]].overRatio);
  }
});

test('scheduleActions 常规触发与窗口硬闸', () => {
  assert.deepEqual(scheduleActions(report({})), []);
  // system 层超预算只是诊断,不再产出告警动作(唯一消费方是每步刷屏,小窗口下是常态噪声)
  assert.deepEqual(scheduleActions(report({ system: true })), []);
  // 常规:history 层超预算 + headroom 为负 → compact
  assert.deepEqual(scheduleActions(report({ history: true, total: 10_000 })), [{ kind: 'compact_history' }]);
  // 硬闸:校正后 total=0、history 层未超、totalOver=false,但 rawTotal 达触发线 → 照样 compact
  assert.deepEqual(
    scheduleActions(
      report({
        total: 0,
        rawTotal: Math.ceil(DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000),
        correction: 0.5,
      }),
    ),
    [{ kind: 'compact_history' }],
  );
  // 硬闸未达触发线 → 不压
  assert.deepEqual(
    scheduleActions(
      report({
        total: 0,
        rawTotal: Math.floor(DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000) - 1,
        correction: 0.5,
      }),
    ),
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

test('ephemeralTokens 计入 system 层与总量(尾部注入不在 history 里)', () => {
  // 回归:会话状态提醒等尾部注入只进 requestHistory,不写回 history。
  // 若不显式传入,这部分固定开销对压力线不可见 → 小窗口下压不住。
  const history: ChatMessage[] = [system('sys')];
  history.push({ role: 'user', content: 'hi' } as ChatMessage);
  const window = 32_000;

  const without = evaluateBudget(history, window, 0, 1, [], 0);
  const withEphemeral = evaluateBudget(history, window, 0, 1, [], 5_000);

  assert.equal(without.systemCosts.ephemeralInjection, 0);
  assert.equal(withEphemeral.systemCosts.ephemeralInjection, 5_000);
  // 计入 system 层、总量与裸总量,三者同步增加。
  assert.equal(withEphemeral.layers.system.actual - without.layers.system.actual, 5_000);
  assert.equal(withEphemeral.total - without.total, 5_000);
  assert.equal(withEphemeral.rawTotal - without.rawTotal, 5_000);
  // 纯函数:不改 history。
  assert.equal(history.length, 2);

  // 负数 / NaN 等非法入参归零,不污染报告。
  assert.equal(evaluateBudget(history, window, 0, 1, [], -100).systemCosts.ephemeralInjection, 0);
  assert.equal(evaluateBudget(history, window, 0, 1, [], Number.NaN).systemCosts.ephemeralInjection, 0);
});

test('ephemeralTokens 可独立把总量推过压力线', () => {
  // 构造:history 本身刚好在触发线以下,仅靠尾部注入越线 → 必须触发 compact。
  const window = 32_000;
  const triggerLine = DEFAULT_BUDGET_POLICY.pressureTriggerRatio * window;
  const history: ChatMessage[] = [system('s')];
  history.push({ role: 'user', content: 'x'.repeat(90_000) } as ChatMessage);

  const before = evaluateBudget(history, window, 0, 1, [], 0);
  assert.ok(before.rawTotal < triggerLine, `基线 ${before.rawTotal} 应低于触发线 ${triggerLine}`);
  assert.deepEqual(scheduleActions(before), [], '基线不应触发压缩');

  const gap = Math.ceil(triggerLine - before.rawTotal) + 1;
  const after = evaluateBudget(history, window, 0, 1, [], gap);
  assert.ok(after.rawTotal >= triggerLine, '加上尾部注入后应达触发线');
  assert.deepEqual(scheduleActions(after), [{ kind: 'compact_history' }], '尾部注入的固定开销必须能独立触发压缩');
});

test('evaluateBudget property: 300 组输入保持纯函数与报告不变量', () => {
  const messageArb = fc.record({
    role: fc.constantFrom<'user' | 'assistant' | 'tool'>('user', 'assistant', 'tool'),
    content: fc.string({ maxLength: 80 }),
  });
  fc.assert(
    fc.property(
      fc.array(messageArb, { maxLength: 30 }),
      fc.integer({ min: 1, max: 100_000 }),
      fc.integer({ min: 0, max: 300 }),
      (messages, window, correctionPercent) => {
        const history = [system('root'), ...messages] as ChatMessage[];
        const before = JSON.stringify(history);
        const result = evaluateBudget(history, window, 3, correctionPercent / 100);
        assert.equal(JSON.stringify(history), before);
        assert.equal(
          result.total,
          BUDGET_LAYERS.filter((name) => name !== 'reserve').reduce((sum, name) => sum + result.layers[name].actual, 0),
        );
        for (const name of BUDGET_LAYERS) {
          assert.equal(result.layers[name].budget, Math.floor(BUDGET_RATIO[name] * window));
          assert.ok(Number.isInteger(result.layers[name].actual) && result.layers[name].actual >= 0);
        }
        // rawTotal ≈ correction=1 时的总量:adj() 每条消息 round(raw*corr) 再除回 corr,
        // 逐条误差 ≤ 0.5/corr ≤ 1(correction 已钳位到 ≥0.5),故容差取消息条数。
        const raw = evaluateBudget(history, window, 3, 1);
        assert.ok(
          Math.abs(result.rawTotal - raw.total) <= history.length + 1,
          `rawTotal ${result.rawTotal} vs raw.total ${raw.total}`,
        );
      },
    ),
    { numRuns: 300 },
  );
});

test('scheduleActions property: 300 组报告动作有序且硬闸不被校正折扣否决', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.boolean(),
      fc.boolean(),
      fc.double({ min: 0.5, max: 2, noNaN: true }),
      (total, rawTotal, historyOver, totalOver, correction) => {
        const actions = scheduleActions(
          report({
            history: historyOver,
            total: totalOver && total === 0 ? 1 : total,
            totalOver,
            rawTotal,
            correction,
          }),
        );
        assert.ok(actions.every((action) => action.kind === 'compact_history'));
        const hasCompact = actions.some((action) => action.kind === 'compact_history');
        if (rawTotal >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000) {
          assert.ok(hasCompact, `硬闸:rawTotal=${rawTotal} 必须触发 compact`);
        }
        if (!hasCompact) {
          assert.ok(
            Math.max(rawTotal, totalOver && total === 0 ? 1 : total) <
              DEFAULT_BUDGET_POLICY.pressureTriggerRatio * 10_000,
          );
        }
      },
    ),
    { numRuns: 300 },
  );
});
