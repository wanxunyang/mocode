/**
 * 源代码管理顶部的「最近提交」列表。
 *
 * 四条要钉住的行为：
 *   1) 是**两栏**行：左栏泳道 + 提交信息，右栏时间 + 短 sha —— 340px 面板里右栏不能被挤掉；
 *   2) 点行跳去 Git 历史并带上 (repoRoot, sha)，不在本面板重实现详情；
 *   3) 5 秒轮询**不重读** git log（历史不会自己变），只有提交成功 / 点刷新才重取；
 *   4) 渲染抛异常时说「渲染失败」，绝不说成「当前空间不是 Git 仓库」
 *      —— 二者曾共用一个 catch，把渲染 bug 伪装成环境问题，排查时只能靠猜。
 *
 * 第 3 条是这次改动的核心约束：把它做错不会崩，只会静默地每 5 秒跑一次 git，
 * 面板看起来完全正常 —— 所以必须用调用计数断言，而不是看界面。
 *
 * DOM 桩统一来自 ./dom-stub.ts（字段一次给全）：三份手写桩曾经因为各缺几个字段
 * 而反复让面板渲染在测试里挂掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeContainer, installGlobals } from './dom-stub.js';

const REPO_ROOT = 'F:/proj';

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

test('顶部最近提交：两栏行（泳道 + 提交信息 | 时间 + 短 sha），点行带着 repoRoot/sha 跳历史', async () => {
  const stub = installGlobals();
  try {
    const { deps, logCalls, opened } = makeDeps('proj-recent-render');
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = new FakeContainer();
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
    stub.restore();
  }
});

test('5 秒轮询不重读 git log；点刷新才重取', async () => {
  const stub = installGlobals();
  try {
    const { deps, logCalls } = makeDeps('proj-recent-poll');
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = new FakeContainer();
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
    stub.restore();
  }
});

test('提交成功后顶部列表立刻重取（新提交要能看见）', async () => {
  const stub = installGlobals();
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
    const container = new FakeContainer();

    await scm.refreshSourceControl(container as unknown as HTMLElement);
    assert.equal(logCalls.length, 1);
    // 提交框里的内容由 commit() 从 DOM 读：渲染后往桩元素里写一个值即可。
    container.querySelector('textarea[data-scm-message]')!.value = 'chore: test commit';
    container.click('[data-scm-action]', 'commit');
    await container.settle();
    assert.equal(logCalls.length, 2, '提交会改写历史，必须重取');
    scm.closeSourceControl();
  } finally {
    stub.restore();
  }
});

test('渲染抛异常时报「渲染失败」，绝不说成「不是 Git 仓库」', async () => {
  const stub = installGlobals();
  try {
    const { deps } = makeDeps('proj-render-crash');
    const base = deps.repos;
    deps.repos = async () => {
      const result = await base();
      // 只在渲染路径上炸：ensureRecentCommits 不读 staged，所以这不是「读仓库失败」。
      // 抛在 fileRows 读 file.path 的时候 —— 正是这次事故的真实形态。
      result.repos[0].status.staged = [
        {
          get path(): string {
            throw new Error('boom-in-render');
          },
          code: 'M',
        },
      ];
      return result;
    };
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = new FakeContainer();
    await scm.refreshSourceControl(container as unknown as HTMLElement);

    const html = container.innerHTML;
    assert.ok(html.includes('scm.paintFailed'), '必须明确说是渲染失败');
    assert.equal(html.includes('scm.notRepo'), false, '不能把渲染 bug 伪装成「不是 Git 仓库」');
    assert.ok(html.includes('boom-in-render'), '真实原因要露在界面上，不能只有一行笼统文案');
    // 栈要留在控制台，供排查（界面给可行动的提示，细节归日志）。
    assert.equal(stub.errors.length, 1, 'console.error 必须收到原始异常');
    scm.closeSourceControl();
  } finally {
    stub.restore();
  }
});
