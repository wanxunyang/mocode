import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSuperviseCli, type SuperviseCliDeps } from '../../src/orchestrator/cli.js';
import { integrateRun, planIntegration, formatIntegration } from '../../src/orchestrator/integrate.js';
import { createInitialRun } from '../../src/orchestrator/state.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import type { OrchestrationDefinition, OrchestrationRun } from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-integrate-'));
  const finish = (): void => fs.rmSync(root, { recursive: true, force: true });
  try {
    const result = fn(root);
    if (result instanceof Promise) return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

/**
 * git apply 在 Windows 上会按 core.autocrlf 写 CRLF。断言只关心内容，不关心中间行尾，
 * 这里统一归一化，避免测试变成「跑在哪台机器上」的函数。
 */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** 建一个只有一次提交的仓库，工作树干净。 */
function initRepo(root: string, files: Record<string, string> = { 'app.txt': 'one\ntwo\nthree\n' }): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content, 'utf8');
  }
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);
  return repo;
}

function writePatch(root: string, name: string, content: string): string {
  const dir = path.join(root, 'patches');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function runWithLanes(
  root: string,
  lanes: Array<{ id: string; workspaceRoot?: string; mode?: 'worktree' | 'copy' | 'inplace'; patchPath?: string }>,
): OrchestrationRun {
  const definition: OrchestrationDefinition = {
    objective: 'integrate work',
    autoClose: true,
    lanes: lanes.map((lane) => ({
      id: lane.id,
      workspaceRoot: lane.workspaceRoot,
      mode: lane.mode ?? 'worktree',
      allowInplace: true,
    })),
    tasks: lanes.map((lane) => ({ id: `task-${lane.id}`, title: lane.id, objective: lane.id, lane: lane.id })),
  };
  const run = createInitialRun(`integrate-${path.basename(root)}`, root, definition);
  for (const lane of lanes) {
    const target = run.lanes[lane.id];
    if (lane.patchPath) {
      target.closed = { reason: 'closed by the operator', patchPath: lane.patchPath, kept: false };
    }
  }
  return run;
}

const CHANGE_APP = `--- a/app.txt
+++ b/app.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const ADD_FILE = `--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+alpha
+beta
`;

// ── 计划 ─────────────────────────────────────────────────────────────────────

test('plan: an open lane is reported instead of integrated', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [{ id: 'one', workspaceRoot: repo }]);
    const plan = planIntegration(run);
    assert.equal(plan.targets[0]?.lanes[0]?.status, 'not-closed');
    assert.equal(plan.targets[0]?.ready, false);
  }));

test('plan: a closed lane with a patch is ready and lists its files', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const patch = writePatch(root, 'one.patch', CHANGE_APP);
    const run = runWithLanes(root, [{ id: 'one', workspaceRoot: repo, patchPath: patch }]);

    const plan = planIntegration(run);
    const lane = plan.targets[0]?.lanes[0];
    assert.equal(lane?.status, 'ready');
    assert.deepEqual(lane?.files, ['app.txt']);
    // gitRoot 用于判断能不能查「目标文件是否已被用户改脏」。
    assert.ok(plan.targets[0]?.gitRoot);
    assert.equal(plan.targets[0]?.ready, true);
  }));

test('plan: in-place lanes need no patch and are skipped by definition', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [{ id: 'one', workspaceRoot: repo, mode: 'inplace' }]);
    const plan = planIntegration(run);
    assert.equal(plan.targets[0]?.lanes[0]?.status, 'inplace');
    // inplace 的改动已经在目标目录里，没有可合的 patch。
    assert.deepEqual(integrateRun(run, { apply: true }).results, [
      { workspaceRoot: plan.targets[0]?.workspaceRoot, status: 'skipped', files: [] },
    ]);
  }));

test('plan: uncommitted target changes block the lane instead of being overwritten', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    // 用户自己先改了同一个文件没提交：这时合 patch 会吞掉他的改动。
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\nlocal edit\nthree\n', 'utf8');
    const patch = writePatch(root, 'one.patch', CHANGE_APP);
    const run = runWithLanes(root, [{ id: 'one', workspaceRoot: repo, patchPath: patch }]);

    const result = integrateRun(run, { apply: true });
    const lane = result.plan.targets[0]?.lanes[0];
    assert.equal(lane?.status, 'conflict');
    assert.match(lane?.error ?? '', /uncommitted changes/);
    assert.equal(result.results[0]?.status, 'skipped');
    // 用户改动原样保留。
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\nlocal edit\nthree\n');
  }));

test('plan: a patch whose context no longer matches is a conflict', () =>
  withRoot((root) => {
    const repo = initRepo(root, { 'app.txt': 'totally\ndifferent\n' });
    const patch = writePatch(root, 'one.patch', CHANGE_APP);
    const run = runWithLanes(root, [{ id: 'one', workspaceRoot: repo, patchPath: patch }]);

    const result = integrateRun(run, { apply: true });
    assert.equal(result.plan.targets[0]?.lanes[0]?.status, 'conflict');
    assert.equal(result.results[0]?.status, 'skipped');
  }));

test('plan: a missing patch file is reported, not guessed', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: path.join(root, 'patches', 'gone.patch') },
    ]);
    const plan = planIntegration(run);
    assert.equal(plan.targets[0]?.lanes[0]?.status, 'missing-patch');
  }));

test('plan: lane.files.json is a manifest, not an appliable patch', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const manifest = writePatch(root, 'lane.files.json', '{"mode":"inplace","changedFiles":["a.txt"]}\n');
    const run = runWithLanes(root, [{ id: 'one', workspaceRoot: repo, patchPath: manifest }]);
    const plan = planIntegration(run);
    assert.equal(plan.targets[0]?.lanes[0]?.status, 'no-changes');
  }));

test('plan: two lanes touching the same file raise a warning', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: writePatch(root, 'one.patch', CHANGE_APP) },
      { id: 'two', workspaceRoot: repo, patchPath: writePatch(root, 'two.patch', ADD_FILE) },
    ]);
    const plan = planIntegration(run);
    assert.equal(plan.targets[0]?.lanes.length, 2);
    assert.equal(plan.warnings.length, 0, 'different files must not warn');

    const overlapping = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: writePatch(root, 'one.patch', CHANGE_APP) },
      { id: 'two', workspaceRoot: repo, patchPath: writePatch(root, 'two.patch', CHANGE_APP) },
    ]);
    assert.match(planIntegration(overlapping).warnings.join(' '), /both touch app\.txt/);
  }));

// ── 执行 ─────────────────────────────────────────────────────────────────────

test('apply: a dry run reports the files and writes nothing', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: writePatch(root, 'one.patch', CHANGE_APP) },
    ]);

    const result = integrateRun(run);
    assert.equal(result.applied, false);
    assert.deepEqual(result.results[0]?.files, ['app.txt']);
    assert.equal(result.results[0]?.status, 'dry-run');
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\ntwo\nthree\n');
    assert.match(formatIntegration(result), /dry run — nothing was written/);
  }));

test('apply: merging two lanes writes both, including a new file', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: writePatch(root, 'one.patch', CHANGE_APP) },
      { id: 'two', workspaceRoot: repo, patchPath: writePatch(root, 'two.patch', ADD_FILE) },
    ]);

    const result = integrateRun(run, { apply: true });
    assert.equal(result.results[0]?.status, 'applied');
    assert.deepEqual(result.results[0]?.files, ['added.txt', 'app.txt']);
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\nTWO\nthree\n');
    assert.equal(readText(path.join(repo, 'added.txt')), 'alpha\nbeta\n');
    // 只写工作树，不替用户提交。
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.match(status, /M app\.txt/);
  }));

test('apply: the second lane failing on the same file rolls the whole group back', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    // 两条 lane 都从同一基线改同一行：各自 --check 都能过，合成一起必撞。
    const run = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: writePatch(root, 'one.patch', CHANGE_APP) },
      {
        id: 'two',
        workspaceRoot: repo,
        patchPath: writePatch(
          root,
          'two.patch',
          `--- a/app.txt\n+++ b/app.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n`,
        ),
      },
    ]);

    const result = integrateRun(run, { apply: true });
    assert.equal(result.results[0]?.status, 'failed');
    assert.match(result.results[0]?.error ?? '', /lane two/);
    // 整批还原：一个文件都不能留在半合状态。
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\ntwo\nthree\n');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
  }));

test('apply: a deleted file is restored on rollback too', () =>
  withRoot((root) => {
    const repo = initRepo(root, { 'app.txt': 'one\ntwo\n', 'gone.txt': 'bye\n' });
    const run = runWithLanes(root, [
      {
        id: 'one',
        workspaceRoot: repo,
        patchPath: writePatch(root, 'one.patch', `--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n`),
      },
      {
        id: 'two',
        workspaceRoot: repo,
        patchPath: writePatch(root, 'two.patch', `--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n`),
      },
    ]);

    const result = integrateRun(run, { apply: true });
    // 第一条删掉文件，第二条再删就失败 → 回滚要把文件放回去。
    assert.equal(result.results[0]?.status, 'failed');
    assert.equal(fs.existsSync(path.join(repo, 'gone.txt')), true);
    assert.equal(readText(path.join(repo, 'gone.txt')), 'bye\n');
  }));

test('apply: a non-git workspace works the same way (git apply needs no repo)', () =>
  withRoot((root) => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'notes.md'), '# old\n', 'utf8');
    const run = runWithLanes(root, [
      {
        id: 'one',
        workspaceRoot: plain,
        mode: 'copy',
        patchPath: writePatch(root, 'one.diff', `--- a/notes.md\n+++ b/notes.md\n@@ -1,1 +1,1 @@\n-# old\n+# new\n`),
      },
    ]);

    const result = integrateRun(run, { apply: true });
    assert.equal(result.plan.targets[0]?.gitRoot, null);
    assert.equal(result.results[0]?.status, 'applied');
    assert.equal(readText(path.join(plain, 'notes.md')), '# new\n');
  }));

test('apply: --lane restricts the merge to one lane', () =>
  withRoot((root) => {
    const repo = initRepo(root);
    const run = runWithLanes(root, [
      { id: 'one', workspaceRoot: repo, patchPath: writePatch(root, 'one.patch', CHANGE_APP) },
      { id: 'two', workspaceRoot: repo, patchPath: writePatch(root, 'two.patch', ADD_FILE) },
    ]);

    const result = integrateRun(run, { apply: true, lanes: ['two'] });
    assert.deepEqual(result.results[0]?.files, ['added.txt']);
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\ntwo\nthree\n');
    assert.equal(fs.existsSync(path.join(repo, 'added.txt')), true);
  }));

// ── CLI ─────────────────────────────────────────────────────────────────────

test('CLI: integrate runs dry by default and --apply writes the workspace', async () => {
  await withRoot(async (root) => {
    const repo = initRepo(root);
    const patch = writePatch(root, 'one.patch', CHANGE_APP);
    const store = OrchestrationStore.create(repo, {
      objective: 'integrate via CLI',
      autoClose: true,
      tasks: [{ id: 'task-1', title: 'task-1', objective: 'task-1' }],
    });
    // 直接落到 lane.closed：CLI 读的是磁盘账本，不要求 Run 处于终态。
    store.append({
      type: 'lane.closed',
      data: { laneId: 'task-1', reason: 'closed by the operator', patchPath: patch, kept: false },
    });

    const out: string[] = [];
    const err: string[] = [];
    const deps: SuperviseCliDeps = {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      worker: () => {
        throw new Error('integrate must not start a worker');
      },
      modelConfigured: async () => true,
    };

    assert.equal(await runSuperviseCli(['integrate', store.current.id, '--sandbox-root', repo], deps), 0, err.join(''));
    assert.match(out.join(''), /✓ ready {2}lane task-1/);
    assert.match(out.join(''), /dry run — nothing was written/);
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\ntwo\nthree\n');

    out.length = 0;
    assert.equal(
      await runSuperviseCli(['integrate', store.current.id, '--sandbox-root', repo, '--apply'], deps),
      0,
      err.join(''),
    );
    assert.match(out.join(''), /result: applied \(1 file\(s\)\)/);
    assert.equal(readText(path.join(repo, 'app.txt')), 'one\nTWO\nthree\n');

    // 审计记录落在 artifacts，而不是事件账本（账本在终态后不可写）。
    const log = fs.readFileSync(path.join(store.directory, 'artifacts', 'integration.jsonl'), 'utf8');
    const lines = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { applied: boolean });
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((item) => item.applied),
      [false, true],
    );
  });
});
