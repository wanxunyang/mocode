/**
 * 历史视图的渲染与事件接线（不需要真实 DOM）。
 *
 * 为什么值得测：这个面板的价值全在「点得动」——提交 → 文件 → 内容三级跳，
 * 每级都是整块 innerHTML 重建 + 重挂监听。写错一处，界面看起来正常但点下去毫无反应，
 * 或者「返回」把用户弹回顶部列表。
 *
 * 泳道连线本身（几何/颜色/跨页续算）由 git-graph.test.ts 覆盖，这里只断言它被画出来了。
 * 每个用例用不同的 projectId：模块状态（repoRoot / commits / 分页游标）按工作空间隔离，
 * 换 id 就等价于「重新打开面板」，用例之间不会互相污染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initHistory, refreshHistory, closeHistory } from '../../packages/work-app/src/renderer/history-panel.js';

interface FakeButton {
  dataset: Record<string, string>;
  addEventListener: (type: string, handler: () => void) => void;
  click: () => void;
}

/** selector → HTML 属性名。属性既是渲染的接线契约，也是桩解析的依据。 */
const ATTR: Record<string, string> = {
  '[data-history-repo]': 'data-history-repo',
  '[data-history-commit]': 'data-history-commit',
  '[data-history-file]': 'data-history-file',
  '[data-history-back]': 'data-history-back',
  '[data-history-more]': 'data-history-more',
  '[data-history-refresh]': 'data-history-refresh',
};

/**
 * 容器桩：`innerHTML` 一写就等同真实 DOM 的整块重建 —— 旧的按钮与其监听全部作废，
 * 之后 `querySelectorAll` 从新的 HTML 里解析出按钮（同一实例缓存，这样 wire 挂上的监听
 * 和测试 click 的是同一个对象）。
 *
 * 不做成「测试手动 mount」：那样 wire() 与 mount() 的先后顺序会变成隐式约定，
 * 与浏览器的行为不符，也正是这一版最先写错的地方。
 */
function makeContainer() {
  const cache = new Map<string, FakeButton>();
  const container = {
    scrollTop: 0,
    html: '',
    get innerHTML() {
      return this.html;
    },
    set innerHTML(value: string) {
      this.html = value;
      cache.clear();
    },
    querySelectorAll(selector: string) {
      const attr = ATTR[selector];
      if (!attr) return [];
      const pattern = new RegExp(`${attr}="([^"]*)"`, 'g');
      const values = [...container.html.matchAll(pattern)].map((match) => match[1]);
      // 无值标记（加载更多 / 刷新）只出现一次，其余按出现次数逐个给。
      const list = values.length ? values : container.html.includes(attr) ? [''] : [];
      return list.map((value) => {
        const key = `${attr}|${value}`;
        const existing = cache.get(key);
        if (existing) return existing;
        const handlers: Array<() => void> = [];
        const datasetKey = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_all, char: string) => char.toUpperCase());
        const created: FakeButton = {
          dataset: { [datasetKey]: value },
          addEventListener: (_type, handler) => handlers.push(handler),
          click: () => handlers.forEach((handler) => handler()),
        };
        cache.set(key, created);
        return created;
      });
    },
    /** 点当前视图里的某个按钮。 */
    click(selector: string, value = '') {
      const attr = ATTR[selector];
      const target = cache.get(`${attr}|${value}`);
      if (!target) throw new Error(`按钮不存在：${selector} ${value}`);
      target.click();
    },
    /** 等一轮宏任务：面板的点击处理是 void 出去的 async。 */
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return container;
}

const SHA_TIP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_MID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_BASE = 'cccccccccccccccccccccccccccccccccccccccc';

function commitOf(sha: string, shortSha: string, subject: string, parents: string[], refs: string[] = []) {
  return {
    sha,
    shortSha,
    parents,
    author: 'Wan',
    email: 'wan@example.invalid',
    date: new Date().toISOString(),
    refs,
    subject,
  };
}

/** 同一份仓库/提交数据，但工作空间 id 由参数指定（用例隔离）。 */
function makeDeps(projectId: string) {
  const logCalls: Array<{ limit: number; skip: number }> = [];
  const fileCalls: string[] = [];
  return {
    logCalls,
    fileCalls,
    deps: {
      t: (key: string) => key,
      icon: (name: string) => `<svg class="icon" data-n="${name}"></svg>`,
      escapeHtml: (value: string) => value,
      relativeTime: () => '刚刚',
      currentTaskId: () => undefined,
      currentProjectId: () => projectId,
      repos: async () => ({
        ok: true,
        repos: [
          {
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
              staged: [],
              changes: [],
              conflicted: false,
            },
          },
        ],
      }),
      log: async (_target: unknown, options: { limit: number; skip: number }) => {
        logCalls.push(options);
        // 合并提交（两个父）+ 分叉 + 汇合：泳道图上要同时出现曲线与直通线。
        return {
          ok: true,
          commits: [
            commitOf(SHA_TIP, 'aaaaaaa', 'merge feature', [SHA_MID, SHA_BASE], ['HEAD -> main']),
            commitOf(SHA_MID, 'bbbbbbb', 'work on feature', [SHA_BASE]),
            commitOf(SHA_BASE, 'ccccccc', 'base commit', []),
          ],
          truncated: false,
        };
      },
      commitFiles: async (_target: unknown, sha: string) => {
        fileCalls.push(`files:${sha}`);
        return {
          ok: true,
          files: [
            { path: 'src/app.ts', code: 'M' },
            { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', code: 'R' },
          ],
        };
      },
      commitFile: async (_target: unknown, sha: string, path: string) => {
        fileCalls.push(`file:${sha}:${path}`);
        return { ok: true, content: 'line1\nline2\n', diff: '@@ -1 +1 @@\n-line1\n+line2\n' };
      },
    },
  };
}

test('提交列表：每行一根泳道 SVG，合并提交有标记，refs 可见', async () => {
  const { deps, logCalls } = makeDeps('proj-list');
  initHistory(deps);
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.deepEqual(logCalls, [{ limit: 100, skip: 0 }]);
  const html = container.innerHTML;
  assert.equal((html.match(/class="history-row"/g) ?? []).length, 3);
  // 每行都画出泳道：一根 SVG + 一个节点。
  assert.equal((html.match(/class="history-graph"/g) ?? []).length, 3);
  assert.equal((html.match(/class="lane-node lane-\d"/g) ?? []).length, 3);
  assert.ok(html.includes('history-merge'), '合并提交必须标出来');
  // 注入的 escapeHtml 是恒等桩，所以这里看到的是原字符；转义本身由真实 escapeHtml 负责。
  assert.ok(html.includes('HEAD -> main'), 'refs 要显示出来');
  assert.ok(html.includes('history-subject'));
  // 日期交给注入的 relativeTime，面板不自己格式化时间。
  assert.ok(html.includes('刚刚'));
  closeHistory();
});

test('三级跳：点提交列文件、点文件看 diff + 内容、返回逐级退回且不重拉列表', async () => {
  const { deps, logCalls, fileCalls } = makeDeps('proj-nav');
  initHistory(deps);

  // ① 列表 → 某提交：只拉这一次的文件列表。
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  container.click('[data-history-commit]', SHA_TIP);
  await container.settle();
  assert.deepEqual(fileCalls, [`files:${SHA_TIP}`]);
  assert.equal((container.innerHTML.match(/class="history-file"/g) ?? []).length, 2);
  // 重命名必须显示「旧 → 新」，否则用户看不出这个文件被改名了。
  assert.ok(container.innerHTML.includes('src/old-name.ts → src/new-name.ts'));
  assert.ok(container.innerHTML.includes('history-code-M'));

  // ② 文件列表 → 文件内容：diff 与该提交时的完整内容一起给。
  container.click('[data-history-file]', 'src/app.ts');
  await container.settle();
  assert.deepEqual(fileCalls.at(-1), `file:${SHA_TIP}:src/app.ts`);
  assert.ok(container.innerHTML.includes('history.diffTitle'));
  // diff 走行级渲染：删行/加行各自成行、前缀剥到 gutter、代码留在 code 里。
  assert.equal((container.innerHTML.match(/udiff-row del/g) ?? []).length, 1);
  assert.equal((container.innerHTML.match(/udiff-row add/g) ?? []).length, 1);
  assert.ok(container.innerHTML.includes('<code>line2</code>'), 'diff 内容原样展示在代码列');
  assert.ok(container.innerHTML.includes('line1\nline2'), '该提交时的文件内容原样展示');
  assert.ok(container.innerHTML.includes('history.contentTitle'));

  // ③ 返回：文件 → 文件列表。文件列表不缓存，按 sha 重拉；提交列表的游标不受影响。
  container.click('[data-history-back]', 'files');
  await container.settle();
  assert.equal(fileCalls.at(-1), `files:${SHA_TIP}`);
  assert.equal(logCalls.length, 1, '返回不能把提交列表从头再拉一遍');

  // ④ 再返回一级：回到列表，完全用内存里的提交（不再请求 git）。
  container.click('[data-history-back]', 'log');
  await container.settle();
  assert.equal((container.innerHTML.match(/class="history-row"/g) ?? []).length, 3);
  assert.equal(logCalls.length, 1);
  closeHistory();
});

test('「加载更多」用 skip 游标续拉，并接着上一页的泳道继续画', async () => {
  const { deps } = makeDeps('proj-more');
  const calls: Array<{ limit: number; skip: number }> = [];
  initHistory({
    ...deps,
    // 第一页两条且 truncated，第二页一条。
    log: async (_target, options) => {
      calls.push(options);
      if (options.skip === 0) {
        return {
          ok: true,
          commits: [commitOf(SHA_TIP, 'aaaaaaa', 'tip', ['mid']), commitOf('mid', 'bbbbbbb', 'mid', [])],
          truncated: true,
        };
      }
      return { ok: true, commits: [commitOf(SHA_BASE, 'ccccccc', 'base', [])], truncated: false };
    },
  });
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.equal((container.innerHTML.match(/class="history-row"/g) ?? []).length, 2);
  assert.ok(container.innerHTML.includes('history.loadMore'));
  container.click('[data-history-more]');
  await container.settle();
  assert.deepEqual(calls, [
    { limit: 100, skip: 0 },
    { limit: 100, skip: 2 },
  ]);
  assert.equal((container.innerHTML.match(/class="history-row"/g) ?? []).length, 3);
  // 加载完之后按钮消失，避免对着已到底的列表反复点。
  assert.equal(container.innerHTML.includes('history.loadMore'), false);
  closeHistory();
});

test('点「刷新」丢掉已有分页，从最新一条重来', async () => {
  const { deps, logCalls } = makeDeps('proj-refresh');
  initHistory(deps);
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.equal(logCalls.length, 1);
  container.click('[data-history-refresh]');
  await container.settle();
  assert.deepEqual(logCalls, [
    { limit: 100, skip: 0 },
    { limit: 100, skip: 0 },
  ]);
  closeHistory();
});

test('多仓库工作空间：顶部按钮切换仓库，切过去从第一页重新拉', async () => {
  const { deps, logCalls } = makeDeps('proj-multi');
  const repoRoots: string[] = [];
  initHistory({
    ...deps,
    repos: async () => ({
      ok: true,
      repos: [
        {
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
            staged: [],
            changes: [],
            conflicted: false,
          },
        },
        {
          root: 'F:/proj/packages/sub',
          name: 'sub',
          relative: 'packages/sub',
          kind: 'nested' as const,
          status: {
            ok: true,
            isRepo: true,
            root: 'F:/proj/packages/sub',
            branch: 'main',
            hasHead: true,
            staged: [],
            changes: [],
            conflicted: false,
          },
        },
      ],
    }),
    log: async (target, options) => {
      logCalls.push(options);
      // 两次调用的 repoRoot 必须不同 —— 否则切了按钮还在读同一个仓库。
      repoRoots.push(String((target as { repoRoot?: string }).repoRoot));
      return { ok: true, commits: [commitOf(SHA_TIP, 'aaaaaaa', `log for ${repoRoots.length}`, [])], truncated: false };
    },
  });
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.ok(container.innerHTML.includes('history-repos'));
  container.click('[data-history-repo]', 'F:/proj/packages/sub');
  await container.settle();
  assert.deepEqual(repoRoots, ['F:/proj', 'F:/proj/packages/sub']);
  assert.deepEqual(logCalls, [
    { limit: 100, skip: 0 },
    { limit: 100, skip: 0 },
  ]);
  closeHistory();
});

test('没有提交的仓库显示空态，而不是空白面板', async () => {
  const { deps } = makeDeps('proj-empty');
  initHistory({ ...deps, log: async () => ({ ok: true, commits: [], truncated: false }) });
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.ok(container.innerHTML.includes('history.empty'));
  closeHistory();
});

test('工作空间里没有 git 仓库时给出可读空态', async () => {
  const { deps } = makeDeps('proj-norepo');
  initHistory({ ...deps, repos: async () => ({ ok: true, repos: [] }) });
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.ok(container.innerHTML.includes('history.noRepo'));
  closeHistory();
});

test('git log 失败时显示错误文案，不是假装空历史', async () => {
  const { deps } = makeDeps('proj-error');
  initHistory({
    ...deps,
    log: async () => ({ ok: false, commits: [], truncated: false, message: 'fatal: bad object' }),
  });
  const container = makeContainer();
  await refreshHistory(container as unknown as HTMLElement);
  assert.ok(container.innerHTML.includes('fatal: bad object'));
  closeHistory();
});
