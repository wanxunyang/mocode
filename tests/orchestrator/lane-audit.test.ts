// git lane 的改动审计：mocode 自己写出的运行时文件不能算成 Worker 的改动。
//
// 真实事故：`F:\MemoryBear-Enterprise` 里三个只读调研任务连续失败，报的改动是
// `.mocode/memory-adoption.jsonl`、`.mocode/sessions/*` 这类 mocode 自己的运行时记录。
// 根因是 worktree 档位的 `snapshotWorktreeChanges` 直接拿 `git add -A` + `git diff` 的
// 全量结果当 changedFiles，完全没过 `isMocodeRuntimeState` 这一层（那个过滤器此前只作用于
// copy / 非 git 档位）。
//
// 为什么那份仓库必然触发：worktree 基于 HEAD 建立，而它的 `.gitignore` 里 `.mocode/` 那条
// 规则只存在于未提交的本地改动里。于是 worktree 内的 `.mocode/**` 既没被跟踪也不被忽略，
// `git add -A` 一定会把它们收进 index。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMocodeRuntimeState } from '../../src/jobs/dir-snapshot.js';
import {
  collectWorktreeChanges,
  createWorktree,
  removeWorktree,
  snapshotWorktreeChanges,
  type Worktree,
} from '../../src/jobs/worktree.js';
import { AUDIT_OPTIONS, LaneSite } from '../../src/orchestrator/lane-site.js';

function withRepo<T>(fn: (repo: string) => T): T {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-audit-'));
  try {
    git(['init'], repo);
    git(['config', 'user.email', 'test@mocode.local'], repo);
    git(['config', 'user.name', 'test'], repo);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n', 'utf8');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init'], repo);
    return fn(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
}

/** 在一份真 worktree 上跑 fn，结束后无论成败都销毁现场。 */
function withWorktree<T>(repo: string, fn: (wt: Worktree, site: LaneSite) => T): T {
  const prevRoot = process.cwd();
  process.chdir(repo);
  const wt = createWorktree(repo);
  try {
    // LaneSite 只用到 worktree.path / repoRoot，不需要真 Run 对象。
    const site = new LaneSite();
    return fn(wt, site);
  } finally {
    process.chdir(prevRoot);
    removeWorktree(wt);
  }
}

/** 模拟 mocode 运行时写盘：这些路径在事故里被当成了「Worker 改了文件」。 */
function writeRuntimeState(root: string): void {
  fs.mkdirSync(path.join(root, '.mocode', 'sessions', 's1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mocode', 'memory-adoption.jsonl'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.mocode', 'memory-proactive-stats.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.mocode', 'sessions', 's1', 'session.json'), '{}\n', 'utf8');
}

test('lane audit: runtime state written by mocode alone is not counted as the worker changing files', () =>
  withRepo((repo) =>
    withWorktree(repo, (wt) => {
      writeRuntimeState(wt.path);

      // 事故现场：不带审计谓词时，这些运行时文件全被算成改动。
      const raw = collectWorktreeChanges(wt);
      assert.equal(raw.changedFiles.length, 3, 'the raw collector does see them, which is the bug');

      // 带谓词后必须是「没有任何改动」——否则 read_only 任务会被自己的会话文件判死。
      const audited = collectWorktreeChanges(wt, AUDIT_OPTIONS);
      assert.deepEqual(audited.changedFiles, []);
      assert.equal(audited.patch, null, 'no patch may be produced for runtime-only changes');
    }),
  ));

test('lane audit: a real code change is still reported, and the patch omits runtime state', () =>
  withRepo((repo) =>
    withWorktree(repo, (wt) => {
      writeRuntimeState(wt.path);
      fs.writeFileSync(path.join(wt.path, 'app.txt'), 'one\ntwo\n', 'utf8');
      fs.writeFileSync(path.join(wt.path, 'feature.ts'), 'export const x = 1;\n', 'utf8');

      const changes = collectWorktreeChanges(wt, AUDIT_OPTIONS);
      assert.deepEqual(changes.changedFiles, ['app.txt', 'feature.ts']);
      assert.ok(changes.patch, 'a real code change must produce a patch');
      assert.match(changes.patch, /\+two/);
      assert.match(changes.patch, /feature\.ts/);
      // patch 会被导出成 lane.patch / attempt.patch，不能夹带 mocode 自己的会话与统计。
      assert.ok(!changes.patch.includes('memory-adoption'), 'runtime files must stay out of the patch');
      assert.ok(!changes.patch.includes('.mocode/sessions'), 'session logs must stay out of the patch');
    }),
  ));

test('lane audit: project-level .mocode assets are still real changes', () =>
  withRepo((repo) =>
    withWorktree(repo, (wt) => {
      // `.mocode/config` 与 `.mocode/skills` 是用户资产，不能被运行时过滤器吞掉。
      fs.mkdirSync(path.join(wt.path, '.mocode', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(wt.path, '.mocode', 'config'), 'MODEL=x\n', 'utf8');
      fs.writeFileSync(path.join(wt.path, '.mocode', 'skills', 'mine.md'), '# mine\n', 'utf8');

      const changes = collectWorktreeChanges(wt, AUDIT_OPTIONS);
      assert.deepEqual(changes.changedFiles, ['.mocode/config', '.mocode/skills/mine.md']);
      assert.equal(isMocodeRuntimeState('.mocode/config'), false);
    }),
  ));

test('lane audit: LaneSite.collect applies the audit rules on the worktree path too', () =>
  withRepo((repo) =>
    withWorktree(repo, (wt) => {
      writeRuntimeState(wt.path);
      const site = new LaneSite();
      const exec = { path: wt.path, repoRoot: repo, mode: 'worktree' as const, created: false };
      const context = {
        run: { id: 'run-audit', workspaceRoot: repo, status: 'running' as const },
        laneId: 'main',
        attempt: 1,
      } as never;

      // 这条断言直接对应事故：LaneSite 是唯二的现场入口（headless 与可视执行器都用它），
      // worktree 分支漏了 AUDIT_OPTIONS，两个执行器就一起中招。
      const onlyRuntime = site.collect(exec, context);
      assert.deepEqual(onlyRuntime.changedFiles, []);
      assert.equal(onlyRuntime.patch, null);

      fs.writeFileSync(path.join(wt.path, 'app.txt'), 'one\ntwo\n', 'utf8');
      const withCode = site.collect(exec, context);
      assert.deepEqual(withCode.changedFiles, ['app.txt']);
    }),
  ));

test('lane audit: an explicit baseline tree still measures only this attempt', () =>
  withRepo((repo) =>
    withWorktree(repo, (wt) => {
      // 第一条 attempt 的成果：改 app.txt。
      fs.writeFileSync(path.join(wt.path, 'app.txt'), 'one\ntwo\n', 'utf8');
      const first = collectWorktreeChanges(wt, AUDIT_OPTIONS);
      assert.deepEqual(first.changedFiles, ['app.txt']);

      // 第二条 attempt 只写了运行时文件：相对上一条 attempt 的 tree，改动必须为空。
      writeRuntimeState(wt.path);
      const second = snapshotWorktreeChanges(wt, first.tree, AUDIT_OPTIONS);
      assert.deepEqual(second.changedFiles, []);
      assert.equal(second.patch, null);
      // `tree` 仍然是整棵 worktree 内容树的真实对象（运行时文件也在里面）：它只作为下一次
      // attempt 的 diff 基线，过滤发生在 changedFiles/patch 这一层。所以这里 tree 会变，
      // 但「本次 attempt 改了什么」必须是空的。
      assert.notEqual(second.tree, first.tree);
    }),
  ));
