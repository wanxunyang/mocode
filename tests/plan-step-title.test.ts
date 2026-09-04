/**
 * plan 步骤短标签(step title)单测。
 *
 * 背景:状态栏 plan chip 只有一行,而 step.content 为了压缩免疫必须写得自包含
 * (常 40+ 字),直接显示会被 truncateDisplay 截成看不懂的半句话。现在 plan_update
 * 可以为每步额外写一个短 title,渲染成 `**短标签** — 详细描述`,状态栏优先显示短标签。
 *
 * 本文件锁定这条链路的契约:
 *   - renderPlanSection:有 title 用新格式,无 title 时**字节级保持老格式**(存量 plan 兼容);
 *   - title 里的星号/换行被清洗(否则破坏行首 `**…**` 解析)、超长软截断;
 *   - planStepLabel:三种历史写法都能解析,优先级 title > activeForm > content;
 *   - plan_update.normalizeArguments:别名归一,且 title/content 兜底互不污染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_STEP_TITLE_MAX, planStepLabel, renderPlanSection, type PlanState } from '../src/session/notes.js';
import { planUpdateTool } from '../src/tools/builtins/plan-update.js';

/** 取 normalizeArguments 处理后的第一个 step(测试内部已知 shape)。 */
function normalizeStep(raw: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { steps: [raw] };
  planUpdateTool.normalizeArguments?.(args);
  return (args.steps as Record<string, unknown>[])[0];
}

test('renderPlanSection: 有 title 渲染为 `**短标签** — 详细描述`', () => {
  const plan: PlanState = {
    title: '集成测试安全网',
    steps: [{ title: '编写测试', content: '写 tests/agent-core.test.ts 覆盖完整循环', status: 'pending' }],
  };
  const out = renderPlanSection(plan);
  assert.ok(out.includes('- [ ] 1. **编写测试** — 写 tests/agent-core.test.ts 覆盖完整循环'), `实际输出:\n${out}`);
});

test('renderPlanSection: 无 title 时保持原格式(存量 plan 字节级兼容)', () => {
  const plan: PlanState = {
    title: 't',
    steps: [{ content: '详细描述', status: 'completed' }],
  };
  const out = renderPlanSection(plan);
  assert.ok(out.includes('- [x] 1. 详细描述'), `实际输出:\n${out}`);
  assert.ok(!out.includes('**'));
});

test('renderPlanSection: title 里的星号与换行被清洗(否则破坏行首解析)', () => {
  const plan: PlanState = {
    title: 't',
    steps: [{ title: '**粗体**\n换行', content: 'c', status: 'pending' }],
  };
  const out = renderPlanSection(plan);
  assert.ok(out.includes('- [ ] 1. **粗体 换行** — c'), `实际输出:\n${out}`);
});

test(`renderPlanSection: title 超长软截断到 ${PLAN_STEP_TITLE_MAX}`, () => {
  const plan: PlanState = { title: 't', steps: [{ title: 'x'.repeat(200), content: 'c', status: 'pending' }] };
  const out = renderPlanSection(plan);
  assert.ok(out.includes(`**${'x'.repeat(PLAN_STEP_TITLE_MAX)}**`), `实际输出:\n${out}`);
  assert.ok(!out.includes('x'.repeat(PLAN_STEP_TITLE_MAX + 1)));
});

test('renderPlanSection: in_progress 步骤仍带 `◀ activeForm` 后缀', () => {
  const plan: PlanState = {
    title: 't',
    steps: [{ title: '短', content: '长', status: 'in_progress', activeForm: '正在写' }],
  };
  const out = renderPlanSection(plan);
  assert.ok(out.includes('- [ ] 1. **短** — 长  ◀ 正在写'), `实际输出:\n${out}`);
});

test('planStepLabel: 新格式优先取 title', () => {
  assert.equal(planStepLabel('**编写测试** — 用 mock LLM 驱动完整循环'), '编写测试');
  assert.equal(planStepLabel('**编写测试**'), '编写测试');
});

test('planStepLabel: 无 title 时退回 activeForm(老 plan 的 in_progress 步)', () => {
  assert.equal(planStepLabel('用 mock LLM 驱动完整循环  ◀ 编写测试中'), '编写测试中');
});

test('planStepLabel: 老 plan 裸 content 行为不变', () => {
  assert.equal(planStepLabel('用 mock LLM 驱动完整循环'), '用 mock LLM 驱动完整循环');
});

test('plan_update normalizeArguments: label/heading 别名归一到 title 并删除原字段', () => {
  // 必须删除:items.additionalProperties=false,残留别名会让随后的 schema 校验拒收。
  const step = normalizeStep({ label: '短', content: '长', status: 'pending' });
  assert.equal(step.title, '短');
  assert.equal(step.content, '长');
  assert.equal('label' in step, false);

  const alt = normalizeStep({ heading: '短2', content: '长2', status: 'pending' });
  assert.equal(alt.title, '短2');
  assert.equal('heading' in alt, false);
});

test('plan_update normalizeArguments: title 与 content 共存时互不覆盖', () => {
  const step = normalizeStep({ title: '短', content: '长', status: 'pending' });
  assert.equal(step.title, '短');
  assert.equal(step.content, '长');
});

test('plan_update normalizeArguments: 只有 title 时兜底 content,并清掉 title(避免 `**A** — A`)', () => {
  const step = normalizeStep({ title: '只有短标签', status: 'pending' });
  assert.equal(step.content, '只有短标签');
  assert.equal(step.title, undefined);
});
