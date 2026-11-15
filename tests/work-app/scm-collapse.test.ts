/**
 * 源代码管理面板的「暂存的更改 / 更改」折叠行为。
 *
 * 为什么能在这里测：source-control.ts 只依赖注入的 deps + 少量 DOM 入口，用最小桩
 * （./dom-stub.ts 的假 DOM + 几个假按钮）就能跑到真实渲染与点击路径，不需要 jsdom。
 *
 * 两条要防的回归：
 *   1) 面板每 5 秒轮询重绘，折叠状态若只存在 DOM 里，重绘就把它弹回展开；
 *   2) 折叠偏好必须落 localStorage —— 关掉面板再打开（甚至重启）还是收起的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeContainer, installGlobals } from './dom-stub.js';

const STORAGE_KEY = 'mocode-work-scm-collapsed';

const repo = {
  root: 'F:/proj',
  name: 'proj',
  relative: '',
  kind: 'workspace' as const,
  status: {
    ok: true,
    isRepo: true,
    root: 'F:/proj',
    branch: 'main',
    hasHead: true,
    // 暂存 1 个、未暂存 2 个：两组计数不同，断言不会互相掩饰。
    staged: [{ path: 'a.ts', code: 'M' }],
    changes: [
      { path: 'b.ts', code: 'M' },
      { path: 'c.ts', code: 'A' },
    ],
    conflicted: false,
  },
};

const deps = {
  t: (key: string) => key,
  icon: (name: string) => `<svg class="icon" data-n="${name}"></svg>`,
  escapeHtml: (value: string) => value,
  toast: () => {},
  currentTaskId: () => 'task-1',
  currentProjectId: () => 'proj-1',
  repos: async () => ({ ok: true, repos: [repo] }),
  diff: async () => ({ ok: true }),
  stage: async () => ({ ok: true }),
  unstage: async () => ({ ok: true }),
  commit: async () => ({ ok: true }),
  generate: async () => ({ type: 'event' }),
};

/** 取某个分组的标题按钮（渲染后按 dataset 挑，不依赖 HTML 里的出现顺序）。 */
function toggleOf(container: FakeContainer, group: 'staged' | 'changes') {
  const found = container.querySelectorAll('[data-scm-toggle]').find((item) => item.dataset.scmToggle === group);
  assert.ok(found, `没渲染出 ${group} 分组的标题按钮`);
  return found;
}

test('分组默认展开；点标题折叠后重绘仍收起，且偏好落盘可跨会话恢复', async () => {
  const stub = installGlobals();
  try {
    // 第一次必须用字面量 import：tsc 只靠字面量才会把 source-control.ts 一并编译进 dist-tests
    //（用变量拼路径它不追，测试就 ERR_MODULE_NOT_FOUND）。第二份用变量 + query 绕过同一实例的缓存，
    // 模拟「新进程读同一份 localStorage」。
    const modulePath = '../../packages/work-app/src/renderer/source-control.js';
    // ① 首次打开：两个分组都展开，计数取各自文件数。
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const first = new FakeContainer();
    await scm.refreshSourceControl(first as unknown as HTMLElement);
    assert.equal((first.innerHTML.match(/data-scm-toggle="(staged|changes)"/g) ?? []).length, 2);
    assert.doesNotMatch(first.innerHTML, /scm-group is-collapsed/);
    assert.equal((first.innerHTML.match(/data-n="chevron-down"/g) ?? []).length, 2);
    assert.match(first.innerHTML, /scm-group-count">1</);
    assert.match(first.innerHTML, /scm-group-count">2</);
    // 标题不能是 <h3>：button 里只允许 phrasing content。
    assert.doesNotMatch(first.innerHTML, /<button[^>]*><h3/);

    // ② 点「暂存的更改」的标题：分组收起、箭头换向、偏好落 localStorage。
    const toggled = new FakeContainer();
    await scm.refreshSourceControl(toggled as unknown as HTMLElement);
    const staged = toggleOf(toggled, 'staged');
    toggled.click('[data-scm-toggle]', 'staged');
    assert.deepEqual(
      staged.toggleCalls.map((call) => `${call.className}:${call.on}`),
      ['is-collapsed:true'],
      '分组被加上 is-collapsed',
    );
    assert.equal(staged.attrs.get('aria-expanded'), 'false');
    assert.deepEqual(JSON.parse(stub.storage.get(STORAGE_KEY) ?? '[]'), ['proj-1#F:/proj#staged']);

    // ③ 轮询重绘（同一模块实例）：仍是收起的 —— 状态不在 DOM 里。
    const redrawn = new FakeContainer();
    await scm.refreshSourceControl(redrawn as unknown as HTMLElement);
    assert.equal((redrawn.innerHTML.match(/scm-group is-collapsed/g) ?? []).length, 1);
    assert.match(redrawn.innerHTML, /scm-group is-collapsed[\s\S]{0,400}?data-scm-toggle="staged"/);
    assert.match(redrawn.innerHTML, /class="scm-group"[\s\S]{0,400}?data-scm-toggle="changes"/);
    scm.closeSourceControl();

    // ④ 新会话（缓存键加 query 重新加载模块 = 新进程读同一份 localStorage）：还是收起的。
    const fresh = (await import(
      `${modulePath}?reload=1`
    )) as typeof import('../../packages/work-app/src/renderer/source-control.js');
    fresh.initSourceControl(deps);
    const reopened = new FakeContainer();
    await fresh.refreshSourceControl(reopened as unknown as HTMLElement);
    assert.equal((reopened.innerHTML.match(/scm-group is-collapsed/g) ?? []).length, 1);
    assert.equal((reopened.innerHTML.match(/data-n="chevron-right"/g) ?? []).length, 1);
    fresh.closeSourceControl();
    // 轮询定时器全部被 closeSourceControl 清掉，测试不会被 5 秒心跳吊住。
    assert.equal(stub.timers.size, 0, '关闭面板后不该留下轮询定时器');
  } finally {
    stub.restore();
  }
});
