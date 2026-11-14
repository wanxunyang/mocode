/**
 * 源代码管理面板的「暂存的更改 / 更改」折叠行为。
 *
 * 为什么能在这里测：source-control.ts 只依赖注入的 deps + 少量 DOM 入口，用最小桩
 * （localStorage / document / HTMLTextAreaElement / 几个假按钮）就能跑到真实渲染与点击路径，
 * 不需要 jsdom。
 *
 * 两条要防的回归：
 *   1) 面板每 5 秒轮询重绘，折叠状态若只存在 DOM 里，重绘就把它弹回展开；
 *   2) 折叠偏好必须落 localStorage —— 关掉面板再打开（甚至重启）还是收起的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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
  relativeTime: () => '刚刚',
  repos: async () => ({ ok: true, repos: [repo] }),
  // 顶部「最近提交」的数据源：这些用例不关心历史，给空列表即可。
  log: async () => ({ ok: true, commits: [], truncated: false }),
  openCommit: () => {},
  diff: async () => ({ ok: true }),
  stage: async () => ({ ok: true }),
  unstage: async () => ({ ok: true }),
  commit: async () => ({ ok: true }),
  generate: async () => ({ type: 'event' }),
};

/** 一个假分组标题按钮：收集点击监听，记录它所在分组被切成了什么。 */
function fakeToggle(group: 'staged' | 'changes') {
  const handlers: Array<() => void> = [];
  const attrs = new Map<string, string>();
  const classes: boolean[] = [];
  const button = {
    dataset: { scmToggle: group, scmRepo: 'F:/proj' },
    addEventListener: (_type: string, handler: () => void) => handlers.push(handler),
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    closest: () => ({ classList: { toggle: (_cls: string, on: boolean) => classes.push(on) } }),
    // 箭头是已注入的 SVG，点击时整颗替换；桩里只需能接住赋值。
    querySelector: () => ({ set outerHTML(_value: string) {} }),
  };
  return { button, click: () => handlers.forEach((handler) => handler()), attrs, classes };
}

/** 容器桩：innerHTML 落在一个字符串字段上，querySelectorAll 只回「分组标题按钮」。 */
function makeContainer(toggles: Array<ReturnType<typeof fakeToggle>>) {
  return {
    scrollTop: 0,
    html: '',
    get innerHTML() {
      return this.html;
    },
    set innerHTML(value: string) {
      this.html = value;
    },
    querySelectorAll: (selector: string) =>
      selector === '[data-scm-toggle]' ? toggles.map((item) => item.button) : [],
    querySelector: () => null,
  };
}

test('分组默认展开；点标题折叠后重绘仍收起，且偏好落盘可跨会话恢复', async () => {
  const saved = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const before = { localStorage: g.localStorage, document: g.document, HTMLTextAreaElement: g.HTMLTextAreaElement };
  g.localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
  };
  g.HTMLTextAreaElement = class {};
  g.document = { activeElement: null, hidden: false };

  // 第一次必须用字面量 import：tsc 只靠字面量才会把 source-control.ts 一并编译进 dist-tests
  //（用变量拼路径它不追，测试就 ERR_MODULE_NOT_FOUND）。第二份用变量 + query 绕过同一实例的缓存，
  // 模拟「新进程读同一份 localStorage」。
  const modulePath = '../../packages/work-app/src/renderer/source-control.js';
  try {
    // ① 首次打开：两个分组都展开，计数取各自文件数。
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const first = makeContainer([]);
    await scm.refreshSourceControl(first as unknown as HTMLElement);
    assert.equal((first.innerHTML.match(/data-scm-toggle="(staged|changes)"/g) ?? []).length, 2);
    assert.doesNotMatch(first.innerHTML, /scm-group is-collapsed/);
    assert.equal((first.innerHTML.match(/data-n="chevron-down"/g) ?? []).length, 2);
    assert.match(first.innerHTML, /scm-group-count">1</);
    assert.match(first.innerHTML, /scm-group-count">2</);
    // 标题不能是 <h3>：button 里只允许 phrasing content。
    assert.doesNotMatch(first.innerHTML, /<button[^>]*><h3/);

    // ② 点「暂存的更改」的标题：分组收起、箭头换向、偏好落 localStorage。
    const staged = fakeToggle('staged');
    const toggled = makeContainer([staged]);
    await scm.refreshSourceControl(toggled as unknown as HTMLElement);
    staged.click();
    assert.deepEqual(staged.classes, [true], '分组被加上 is-collapsed');
    assert.equal(staged.attrs.get('aria-expanded'), 'false');
    assert.deepEqual(JSON.parse(saved.get(STORAGE_KEY) ?? '[]'), ['proj-1#F:/proj#staged']);

    // ③ 轮询重绘（同一模块实例）：仍是收起的 —— 状态不在 DOM 里。
    const redrawn = makeContainer([]);
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
    const reopened = makeContainer([]);
    await fresh.refreshSourceControl(reopened as unknown as HTMLElement);
    assert.equal((reopened.innerHTML.match(/scm-group is-collapsed/g) ?? []).length, 1);
    assert.equal((reopened.innerHTML.match(/data-n="chevron-right"/g) ?? []).length, 1);
    fresh.closeSourceControl();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  }
});
