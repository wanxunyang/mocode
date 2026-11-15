/**
 * 源代码管理面板（更改页）的渲染契约。
 *
 * 三条要钉住的行为：
 *   1) 面板里**没有**提交历史：历史只属于「历史」页（那边有分页、泳道、文件级 diff）。
 *      本面板再摆一份残缺的最近提交，等于把同一份信息读两遍 —— 这条用渲染结果双向下钉；
 *   2) 打开面板与 5 秒轮询都只读 status，不额外拉 git log；
 *   3) 渲染抛异常时说「渲染失败」，绝不说成「当前空间不是 Git 仓库」
 *      —— 二者曾共用一个 catch，把渲染 bug 伪装成环境问题，排查时只能靠猜。
 *
 * DOM 桩统一来自 ./dom-stub.ts（字段一次给全）：三份手写桩曾经因为各缺几个字段
 * 而反复让面板渲染在测试里挂掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeContainer, installGlobals } from './dom-stub.js';

const REPO_ROOT = 'F:/proj';

/** 一套最小依赖；repoCalls 用来断言「打开/轮询到底读了几次 status」。 */
function makeDeps(projectId: string) {
  let repoCalls = 0;
  const deps = {
    t: (key: string) => key,
    icon: (name: string) => `<svg class="icon" data-n="${name}"></svg>`,
    escapeHtml: (value: string) => value,
    toast: () => {},
    currentTaskId: () => 'task-1',
    currentProjectId: () => projectId,
    repos: async () => {
      repoCalls += 1;
      return {
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
      };
    },
    diff: async () => ({ ok: true }),
    stage: async () => ({ ok: true }),
    unstage: async () => ({ ok: true }),
    commit: async () => ({ ok: true, commit: 'fffffff' }),
    generate: async () => ({ type: 'event' }),
  };
  return { deps, repoCalls: () => repoCalls };
}

test('更改页不含提交历史：只渲染仓库/分支/暂存区/更改/提交框', async () => {
  const stub = installGlobals();
  try {
    const { deps } = makeDeps('proj-scope');
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = new FakeContainer();
    await scm.refreshSourceControl(container as unknown as HTMLElement);

    const html = container.innerHTML;
    // 仓库头 + 分支 + 两个分组 + 提交框都在。
    assert.ok(html.includes('data-scm-repo-group="F:/proj"'));
    assert.ok(html.includes('scm-repo-branch'));
    assert.equal((html.match(/data-scm-toggle="(staged|changes)"/g) ?? []).length, 2);
    assert.ok(html.includes('data-scm-message'));
    // 历史相关的 DOM 一个都不该有 —— 同一份信息只在「历史」页出现一次。
    assert.equal(html.includes('scm-recent'), false, '更改页不再渲染最近提交');
    assert.equal(html.includes('data-scm-commit'), false, '没有可点的提交行');
    assert.equal(html.includes('scm.recentCommits'), false);
    scm.closeSourceControl();
  } finally {
    stub.restore();
  }
});

test('打开面板与轮询都只读 status，不额外拉历史', async () => {
  const stub = installGlobals();
  try {
    const { deps, repoCalls } = makeDeps('proj-poll');
    const scm = await import('../../packages/work-app/src/renderer/source-control.js');
    scm.initSourceControl(deps);
    const container = new FakeContainer();
    await scm.refreshSourceControl(container as unknown as HTMLElement);
    assert.equal(repoCalls(), 1);

    // 三次轮询重绘：每次重新读 status（工作区会变），没有第二个数据源。
    for (let i = 0; i < 3; i += 1) await scm.refreshSourceControl(container as unknown as HTMLElement);
    assert.equal(repoCalls(), 4, '轮询只重读 status');

    // 点刷新 = 用户主动要最新状态。
    container.click('[data-scm-action]', 'refresh');
    await container.settle();
    assert.equal(repoCalls(), 5);
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
      // 只在渲染路径上炸：读 staged 里的 file.path 时抛 —— 正是当年那次事故的真实形态。
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
