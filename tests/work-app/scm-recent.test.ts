/**
 * 源代码管理顶部的「最近提交」列表。
 *
 * 三条要钉住的行为：
 *   1) 是**两栏**行：左栏泳道 + 提交信息，右栏时间 + 短 sha —— 340px 面板里右栏不能被挤掉；
 *   2) 点行跳去 Git 历史并带上 (repoRoot, sha)，不在本面板重实现详情；
 *   3) 5 秒轮询**不重读** git log（历史不会自己变），只有提交成功 / 点刷新才重取。
 *
 * 第 3 条是这次改动的核心约束：把它做错不会崩，只会静默地每 5 秒跑一次 git，
 * 面板看起来完全正常 —— 所以必须用调用计数断言，而不是看界面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = 'F:/proj';

interface FakeButton {
  dataset: Record<string, string>;
  disabled: boolean;
  textContent: string;
  innerHTML: string;
  /** textarea 用：提交框的内容由 commit() 从 DOM 读，渲染时还会量高度。 */
  value: string;
  style: Record<string, string>;
  scrollHeight: number;
  selectionStart: number;
  selectionEnd: number;
  addEventListener: (type: string, handler: () => void) => void;
  click: () => void;
  setAttribute: (name: string, value: string) => void;
  closest: () => { classList: { toggle: () => void } };
  querySelector: () => null;
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
}

/**
 * 容器桩：`innerHTML` 一写就等同真实 DOM 的整块重建，旧按钮与其监听全部作废。
 * 之后 querySelectorAll 从新 HTML 里按属性解析按钮（同实例缓存，所以 wire 挂的监听
 * 与测试 click 的是同一个对象）。
 */
function makeContainer() {
  const cache = new Map<string, FakeButton>();
  const listeners = new Map<string, Array<() => void>>();
  const container = {
    scrollTop: 0,
    html: '',
    get innerHTML() {
      return this.html;
    },
    set innerHTML(value: string) {
      this.html = value;
      cache.clear();
      listeners.clear();
    },
    querySelectorAll(selector: string) {
      if (selector === 'button') return [...cache.values()];
      const attr = /^(?:textarea)?\[(data-[a-z-]+)\]$/.exec(selector)?.[1];
      if (!attr) return [];
      // 按整个开标签解析：dataset 必须带上该按钮的全部 data-* 属性，
      // 只填 selector 指定的那一个会让 handler 里的另一个（如 data-scm-repo）读成空。
      const found: FakeButton[] = [];
      for (const tag of container.html.matchAll(/<(?:button|textarea)([^>]*)>/g)) {
        const attrs = new Map<string, string>();
        for (const item of tag[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)) attrs.set(item[1], item[2]);
        const value = attrs.get(attr.replace(/^data-/, ''));
        if (value === undefined) continue;
        const key = `${attr}|${value}`;
        const cached = cache.get(key);
        if (cached) {
          found.push(cached);
          continue;
        }
        const bound = listeners.get(key) ?? [];
        listeners.set(key, bound);
        const dataset: Record<string, string> = {};
        for (const [name, val] of attrs) {
          dataset[name.replace(/-([a-z])/g, (_all, char: string) => char.toUpperCase())] = val;
        }
        const created: FakeButton = {
          dataset,
          disabled: false,
          textContent: '',
          innerHTML: '',
          // textarea 也要能被这个桩表示：渲染路径会对提交框量高度（resizeCommitBox 读
          // scrollHeight 再写 style.height），缺了这些字段会在渲染中抛错并退化成「不是仓库」。
          value: '',
          style: {} as Record<string, string>,
          scrollHeight: 20,
          selectionStart: 0,
          selectionEnd: 0,
          addEventListener: (_type, handler) => bound.push(handler),
          click: () => bound.forEach((handler) => handler()),
          setAttribute: () => {},
          closest: () => ({ classList: { toggle: () => {} } }),
          querySelector: () => null,
          focus: () => {},
          setSelectionRange: () => {},
        };
        cache.set(key, created);
        found.push(created);
      }
      return found;
    },
    querySelector: () => null,
    /** 点某个按钮：按属性值定位（同 renderSourceControl 的接线契约）。 */
    click(selector: string, value = '') {
      const attr = /^(?:textarea)?\[(data-[a-z-]+)\]$/.exec(selector)?.[1] ?? '';
      const target = cache.get(`${attr}|${value}`);
      if (!target) throw new Error(`按钮不存在：${selector} ${value}`);
      target.click();
    },
    async settle() {
      // 面板的点击处理是 void 出去的 async，跑两轮宏任务把 fetch → 重绘走完。
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return container;
}

function commitOf(sha: string, shortSha: string, subject: string, parents: string[], date: string) {
  return { sha, shortSha, parents, author: 'Wan', email: 'wan@example.invalid', date, refs: [], subject };
}

const SHA_TIP = 'a'.repeat(40);
const SHA_MID = 'b'.repeat(40);

/** 一套最小依赖；logCalls 用来断言「轮询到底有没有再读 git」。 */
function makeDeps(projectId: string) {
  const logCalls: Array<{ limit: number; skip: number; repoRoot?: string }> = [];
  const opened: Array<{ repoRoot: string; sha: string }> = [];
  const deps = {
    t: (key: string) => key,
    icon: (name: string) => `<svg class="icon" data-n="${name}"></svg>`,
    escapeHtml: (value: string) => value,
    toast: () => {},
    currentTaskId: () => 'task-1',
    currentProjectId: () => projectId,
    relativeTime: (iso: string) => `t:${iso}`,
    repos: async () => ({
      ok: true,
      repos: [
        {
          root: REPO_ROOT,
          name: 'proj',
          relative: '',
          kind: 'workspace' as const,
          status: {
            ok: true,
            isRepo: true,
            root: REPO_ROOT,
            branch: 'main',
            hasHead: true,
            staged: [] as Array<{ path: string; code: string }>,
            changes: [] as Array<{ path: string; code: string }>,
            conflicted: false,
          },
        },
      ],
    }),
    log: async (target: { repoRoot?: string }, options: { limit: number; skip: number }) => {
      logCalls.push({ ...options, repoRoot: target.repoRoot });
      return {
        ok: true,
        // 两条：尖端 + 它指向的父提交，泳道图据此画出直通线。
        commits: [
          commitOf(SHA_TIP, 'aaaaaaa', 'fix: first', [SHA_MID], '2026-11-15T00:00:00.000Z'),
          commitOf(SHA_MID, 'bbbbbbb', 'feat: base', [], '2026-11-14T00:00:00.000Z'),
        ],
        truncated: false,
      };
    },
    openCommit: (repoRoot: string, sha: string) => opened.push({ repoRoot, sha }),
    diff: async () => ({ ok: true }),
    stage: async () => ({ ok: true }),
    unstage: async () => ({ ok: true }),
    commit: async () => ({ ok: true, commit: 'fffffff' }),
    generate: async () => ({ type: 'event' }),
  };
  return { deps, logCalls, opened };
}

/** 装上 source-control.ts 需要的浏览器全局（模块里读 document / localStorage / CSS）。 */
function installGlobals() {
  const saved = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const before = {
    localStorage: g.localStorage,
    document: g.document,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
    CSS: g.CSS,
  };
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
  // commit 路径用 CSS.escape 拼选择器；桩里恒等即可（测试用的路径不含需转义字符）。
  g.CSS = { escape: (value: string) => value };
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  };
}

test('顶部最近提交：两栏行（泳道 + 提交信息 | 时间 + 短 sha），点行带着 repoRoot/sha 跳历史', async () => {
  const restore = installGlobals();
  try {
    const { deps, logCalls, opened } = makeDeps('proj-recent-render');
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = makeContainer();
    await scm.refreshSourceControl(container as unknown as HTMLElement);

    assert.deepEqual(logCalls, [{ limit: 12, skip: 0, repoRoot: REPO_ROOT }], '首次打开读一页 12 条');
    const html = container.innerHTML;
    assert.equal((html.match(/class="scm-recent-row"/g) ?? []).length, 2);
    // 每行一根泳道 SVG：两栏里的左栏由它领起。
    assert.equal((html.match(/class="history-graph"/g) ?? []).length, 2);
    // 左栏：提交信息。
    assert.ok(html.includes('scm-recent-subject">fix: first'));
    // 右栏：时间（注入的 relativeTime）+ 短 sha，且右栏整体不参与收缩。
    assert.ok(html.includes('scm-recent-time">t:2026-11-15T00:00:00.000Z'));
    assert.ok(html.includes('scm-recent-sha">aaaaaaa'));
    assert.ok(html.includes('scm-recent-meta'));

    container.click('[data-scm-commit]', SHA_TIP);
    assert.deepEqual(opened, [{ repoRoot: REPO_ROOT, sha: SHA_TIP }], '详情交给 Git 历史面板');
    scm.closeSourceControl();
  } finally {
    restore();
  }
});

test('5 秒轮询不重读 git log；点刷新才重取', async () => {
  const restore = installGlobals();
  try {
    const { deps, logCalls } = makeDeps('proj-recent-poll');
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = makeContainer();
    await scm.refreshSourceControl(container as unknown as HTMLElement);
    assert.equal(logCalls.length, 1);

    // 模拟三次轮询重绘：状态照旧渲染，但一次 git 都不该读。
    for (let i = 0; i < 3; i += 1) await scm.refreshSourceControl(container as unknown as HTMLElement);
    assert.equal(logCalls.length, 1, '轮询命中缓存，不得重复读历史');
    assert.equal((container.innerHTML.match(/class="scm-recent-row"/g) ?? []).length, 2, '缓存命中仍要画出列表');

    // 刷新 = 用户主动要最新状态：失效 + 重取。
    container.click('[data-scm-action]', 'refresh');
    await container.settle();
    assert.equal(logCalls.length, 2);
    scm.closeSourceControl();
  } finally {
    restore();
  }
});

test('提交成功后顶部列表立刻重取（新提交要能看见）', async () => {
  const restore = installGlobals();
  try {
    const { deps, logCalls } = makeDeps('proj-recent-commit');
    // 有暂存改动，提交按钮才可点。
    const base = deps.repos;
    deps.repos = async () => {
      const result = await base();
      result.repos[0].status.staged = [{ path: 'a.ts', code: 'M' }];
      return result;
    };
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = makeContainer();
    // 提交框里的内容由 commit() 从 DOM 读；桩里直接给一个固定值。
    (container as unknown as { querySelector: (selector: string) => unknown }).querySelector = (selector: string) =>
      selector.includes('textarea')
        ? {
            value: 'chore: test commit',
            selectionStart: 0,
            selectionEnd: 0,
            disabled: false,
            dataset: { scmMessage: REPO_ROOT },
            style: {},
            addEventListener: () => {},
            focus: () => {},
            setSelectionRange: () => {},
            scrollHeight: 20,
          }
        : null;

    await scm.refreshSourceControl(container as unknown as HTMLElement);
    assert.equal(logCalls.length, 1);
    container.click('[data-scm-action]', 'commit');
    await container.settle();
    assert.equal(logCalls.length, 2, '提交会改写历史，必须重取');
    scm.closeSourceControl();
  } finally {
    restore();
  }
});
