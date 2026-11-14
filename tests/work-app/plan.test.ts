import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlanStatus, parsePlan, planForRestore } from '../../packages/work-app/src/plan.js';

test('parsePlan 读标准入参：进度、当前步、全部完成', () => {
  const plan = parsePlan(
    JSON.stringify({
      title: '登录改造',
      goal: '换掉旧鉴权',
      steps: [
        { title: '探查', content: '读 src/auth.ts 找入口', status: 'completed' },
        { title: '改实现', content: '替换 token 校验', status: 'in_progress', active_form: '替换 token 校验' },
        { title: '补测试', content: '加一条回归', status: 'pending' },
      ],
    }),
  );
  assert.ok(plan);
  assert.equal(plan.title, '登录改造');
  assert.equal(plan.done, 1);
  assert.equal(plan.total, 3);
  assert.equal(plan.allDone, false);
  assert.equal(plan.current?.title, '改实现');
  // 面板一行显示 activeForm（进行时文案），而不是「改实现」。
  assert.equal(plan.currentLabel, '替换 token 校验');
});

test('parsePlan 吃模型常见的字段与状态变体', () => {
  const plan = parsePlan({
    name: '变体计划',
    steps: [
      { label: '第一步', text: '做 A', status: 'done' },
      { heading: '第二步', task: '做 B', status: 'doing', activeForm: '正在做 B' },
      { step_title: '第三步', description: '做 C', status: 'todo' },
    ],
  });
  assert.ok(plan);
  // title 缺失时退到 name，再退到首步短标签。
  assert.equal(plan.title, '变体计划');
  assert.deepEqual(
    plan.steps.map((step) => [step.title, step.status]),
    [
      ['第一步', 'completed'],
      ['第二步', 'in_progress'],
      ['第三步', 'pending'],
    ],
  );
  assert.equal(plan.currentLabel, '正在做 B');
  assert.equal(plan.done, 1);
});

test('无 steps / 非法 JSON / 空计划一律返回 null，不显示半份计划', () => {
  assert.equal(parsePlan('{"title":"空"}'), null);
  assert.equal(parsePlan('{"steps":[]}'), null);
  assert.equal(parsePlan('not json'), null);
  assert.equal(parsePlan(''), null);
  assert.equal(parsePlan(null), null);
  // 只有裸对象没有可识别正文的步骤，也不能瞎编。
  assert.equal(parsePlan({ steps: [{ status: 'pending' }] }), null);
});

test('全部完成时 allDone 为真且不再给 current', () => {
  const plan = parsePlan({
    title: '收尾',
    steps: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
    ],
  });
  assert.ok(plan);
  assert.equal(plan.allDone, true);
  assert.equal(plan.done, 2);
  assert.equal(plan.current, undefined);
  assert.equal(plan.currentLabel, undefined);
});

test('signature 含状态（进度更新可识别），identity 不含状态（换计划才重开）', () => {
  const before = parsePlan({ title: 'P', steps: [{ content: 'A', status: 'in_progress' }] });
  const progress = parsePlan({ title: 'P', steps: [{ content: 'A', status: 'completed' }] });
  const replaced = parsePlan({ title: 'P', steps: [{ content: 'B', status: 'pending' }] });
  assert.ok(before && progress && replaced);
  assert.notEqual(before.signature, progress.signature);
  assert.equal(before.identity, progress.identity);
  assert.notEqual(before.identity, replaced.identity);
});

test('normalizePlanStatus 对未知值保守退回 pending', () => {
  assert.equal(normalizePlanStatus('IN-PROGRESS'), 'in_progress');
  assert.equal(normalizePlanStatus('finished'), 'completed');
  assert.equal(normalizePlanStatus('blocked'), 'pending');
  assert.equal(normalizePlanStatus(undefined), 'pending');
});

test('planForRestore：复原时丢掉已完成计划，进行中的照常还原', () => {
  const running = parsePlan({
    title: '在跑',
    steps: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ],
  });
  assert.ok(running);
  // 复原路径接受未完的计划（切任务回来要接着看进度）。
  assert.equal(planForRestore(running), running);

  // 全部完成：实时路径靠 PLAN_DONE_LINGER_MS 自动收起，复原路径必须同样不收，
  // 否则重开窗口 / 切回任务时已完成计划会被重新钉在会话顶部。
  const done = parsePlan({
    title: '收尾',
    steps: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
    ],
  });
  assert.ok(done);
  assert.equal(done.allDone, true);
  assert.equal(planForRestore(done), null);

  assert.equal(planForRestore(null), null);
});
