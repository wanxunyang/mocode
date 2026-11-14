import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitRepos, gitStatus, parseGitStatus, stagedDiff, validateRepoRoot } from '../../packages/work-app/src/git.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  });
}

function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  // 宿主机可能把 init.defaultBranch 配成 master；用例断言具体分支名，这里显式固定。
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['config', 'user.name', 'MoCode Test']);
  git(root, ['config', 'user.email', 'mocode-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '.test-hooks-disabled']);
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '-A', '--', '.']);
  git(root, ['commit', '-q', '-m', message]);
}

async function withTemp(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-scm-'));
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('detached HEAD 不冒充同分支：branch 留空、给短 sha', () => {
  const status = parseGitStatus('/repo', ['# branch.oid 53b5817d9f2c4a1b', '# branch.head (detached)'].join('\0'));
  assert.equal(status.detached, true);
  assert.equal(status.branch, '');
  assert.equal(status.head, '53b5817d');
  assert.equal(status.hasHead, true);
  assert.equal(status.upstream, undefined);
  assert.equal(status.ahead, undefined);
});

test('暂无提交的仓库不给 head，面板据 branch 为空提示尚无提交', () => {
  const status = parseGitStatus('/repo', ['# branch.oid (initial)', '# branch.head main'].join('\0'));
  assert.equal(status.hasHead, false);
  assert.equal(status.head, undefined);
  assert.equal(status.branch, 'main');
});

test('一个工作空间发现多仓库：主仓库 + 嵌套仓库', async () => {
  await withTemp(async (root) => {
    const outer = path.join(root, 'outer');
    initRepo(outer);
    write(outer, 'a.txt', 'outer\n');
    commitAll(outer, 'chore: outer');

    const inner = path.join(outer, 'packages', 'inner');
    initRepo(inner);
    write(inner, 'b.txt', 'inner\n');
    commitAll(inner, 'chore: inner');

    // 嵌套仓库的改动只能由它自己看见；外层只看到一条未跟踪目录，看不到里面的文件。
    write(inner, 'b.txt', 'inner changed\n');
    assert.deepEqual(
      (await gitStatus(inner)).changes.map((file) => file.path),
      ['b.txt'],
    );
    assert.deepEqual(
      (await gitStatus(outer)).changes.map((file) => file.path),
      ['packages/inner/'],
    );

    const discovered = await gitRepos(outer);
    assert.equal(discovered.ok, true, discovered.message);
    const repos = discovered.repos;
    assert.equal(repos.length, 2);
    // 主仓库恒定在首位，面板分组顺序稳定。
    assert.equal(repos[0]?.root, path.resolve(outer));
    assert.equal(repos[0]?.kind, 'workspace');
    assert.equal(repos[0]?.name, 'outer');
    const nested = repos.find((repo) => repo.root === path.resolve(inner));
    assert.equal(nested?.kind, 'nested');
    assert.equal(nested?.relative, 'packages/inner');
    assert.equal(nested?.status.branch, 'main');
    assert.deepEqual(
      nested?.status.changes.map((file) => file.path),
      ['b.txt'],
    );
  });
});

test('工作树作为独立仓库被发现，暂存与 AI 生成按各自分支隔离', async () => {
  await withTemp(async (root) => {
    const repo = path.join(root, 'repo');
    initRepo(repo);
    write(repo, 'a.txt', 'base\n');
    // 真实仓库的 .gitignore 忽略 .mocode/，否则工作树目录本身会作为未跟踪项出现在主仓库里。
    write(repo, '.gitignore', '.mocode/\n');
    commitAll(repo, 'chore: base');
    const worktree = path.join(repo, '.mocode', 'worktrees', 'wt-test');
    git(repo, ['worktree', 'add', '--detach', worktree, 'HEAD']);

    write(repo, 'main-only.txt', 'main\n');
    write(worktree, 'wt-only.txt', 'wt\n');

    const discovered = await gitRepos(repo);
    assert.equal(discovered.ok, true, discovered.message);
    const main = discovered.repos.find((item) => item.root === path.resolve(repo));
    const wt = discovered.repos.find((item) => item.root === path.resolve(worktree));
    assert.equal(main?.kind, 'workspace');
    assert.equal(wt?.kind, 'worktree');
    assert.equal(wt?.status.detached, true);
    assert.equal(wt?.status.branch, '');
    assert.ok(wt?.status.head);
    assert.deepEqual(
      main?.status.changes.map((file) => file.path),
      ['main-only.txt'],
    );
    assert.deepEqual(
      wt?.status.changes.map((file) => file.path),
      ['wt-only.txt'],
    );

    // 暂存各自独立：提交信息生成读到的是「这个仓库」的 diff 与分支。
    git(worktree, ['add', '-A', '--', 'wt-only.txt']);
    const wtDiff = await stagedDiff(worktree);
    assert.equal(wtDiff.ok, true, wtDiff.message);
    assert.match(wtDiff.diff, /\+wt/);
    assert.equal(wtDiff.root, path.resolve(worktree));
    assert.equal(wtDiff.branch, wt?.status.head);
    const mainDiff = await stagedDiff(repo);
    assert.equal(mainDiff.ok, false);
    assert.equal(mainDiff.message, 'NO_STAGED_CHANGES');
    assert.equal(mainDiff.root, path.resolve(repo));
    assert.equal(mainDiff.branch, 'main');
  });
});

test('仓库根校验只放行工作空间及其主仓库之内的真实仓库', async () => {
  await withTemp(async (root) => {
    const outer = path.join(root, 'outer');
    initRepo(outer);
    write(outer, 'a.txt', 'a\n');
    commitAll(outer, 'chore: a');
    const inner = path.join(outer, 'inner');
    initRepo(inner);
    const outside = path.join(root, 'outside');
    initRepo(outside);

    assert.equal(await validateRepoRoot(outer, outer), path.resolve(outer));
    assert.equal(await validateRepoRoot(outer, inner), path.resolve(inner));

    // 工作空间之外的另一个仓库、普通子目录、以及上面的上层目录都不能被操作。
    assert.equal(await validateRepoRoot(outer, outside), null);
    assert.equal(await validateRepoRoot(outer, path.join(outer, 'a.txt')), null);
    assert.equal(await validateRepoRoot(outer, root), null);
    assert.equal(await validateRepoRoot(outer, path.join(outer, '..', 'outside')), null);
    assert.equal(await validateRepoRoot(inner, outer), null);
  });
});
