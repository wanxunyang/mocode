import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../packages/work-app/src/plan.js';
import { planPanelHtml } from '../../packages/work-app/src/renderer/plan-panel.js';

const labels = {
  expand: 'Show steps',
  collapse: 'Hide steps',
  dismiss: 'Dismiss plan panel',
  progress: '1/3',
  subtitle: 'Replacing token check',
};

const plan = parsePlan({
  title: 'Login rework',
  steps: [
    { title: 'Explore', content: 'Read src/auth.ts', status: 'completed' },
    { title: 'Implement', content: 'Replace token check', status: 'in_progress', active_form: 'Replacing token check' },
    { title: 'Tests', content: 'Add a regression test', status: 'pending' },
  ],
});
assert.ok(plan);

test('收起态：一行说清标题 / 当前步 / n/m，进度条按比例，步骤清单隐藏', () => {
  const html = planPanelHtml(plan, false, labels);
  assert.match(html, /class="plan-card"/);
  assert.match(html, /class="plan-title">Login rework</);
  assert.match(html, /class="plan-current"[^>]*>Replacing token check</);
  assert.match(html, /class="plan-count">1\/3</);
  assert.match(html, /aria-valuenow="33"/);
  assert.match(html, /style="width:33%"/);
  // 收起态步骤必须仍在 DOM 里（切展开不用重算），但带 hidden。
  assert.match(html, /class="plan-steps hidden"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Show steps/);
});

test('展开态：完整清单带序号与状态类，进行中步骤显示 activeForm', () => {
  const html = planPanelHtml(plan, true, labels);
  assert.match(html, /class="plan-steps"/);
  assert.doesNotMatch(html, /plan-steps hidden/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Hide steps/);
  const steps = html.match(/<li class="plan-step[^"]*"/g) ?? [];
  assert.equal(steps.length, 3);
  assert.match(html, /plan-step is-done[\s\S]*?Explore/);
  assert.match(html, /plan-step is-current[\s\S]*?Replacing token check/);
  // 进行中的步骤用 activeForm，不重复展示 title；详情行给出正文。
  assert.doesNotMatch(html, /plan-step-label">Implement</);
  assert.match(html, /plan-step-detail">Replace token check</);
});

test('完成态：对勾、完成类、100% 进度，且不再显示当前步', () => {
  const done = parsePlan({
    title: 'Done plan',
    steps: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'completed' },
    ],
  });
  assert.ok(done);
  const html = planPanelHtml(done, false, { ...labels, progress: '2/2', subtitle: 'All 2 steps done' });
  assert.match(html, /class="plan-card is-done"/);
  assert.match(html, /class="plan-mark"><svg/);
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /All 2 steps done/);
});

test('转义与截断：标题里的尖括号不会变成标签，超长文案压平截断', () => {
  const risky = parsePlan({
    title: '<img src=x onerror=alert(1)>',
    steps: [{ content: 'A\n\nB'.repeat(200), status: 'pending' }],
  });
  assert.ok(risky);
  const html = planPanelHtml(risky, true, labels);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /…</);
  // 换行必须被压平，否则面板高度会跳。
  assert.doesNotMatch(html, /plan-step-detail">[^<]*\n/);
});
