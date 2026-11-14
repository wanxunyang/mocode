import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  commitStaged,
  gitDiff,
  gitStatus,
  parseGitStatus,
  stageFiles,
  stagedDiff,
  unstageFiles,
} from '../../packages/work-app/src/git.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  });
}

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-git-'));
  try {
    git(root, ['init', '-q']);
    // 测试仓库身份/签名/钩子全部隔离，不读取或改动用户仓库。
    git(root, ['config', 'user.name', 'MoCode Test']);
    git(root, ['config', 'user.email', 'mocode-test@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'core.hooksPath', '.test-hooks-disabled']);
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('porcelain v2 保留空格/中文，并消费 rename 旧路径', () => {
  const status = parseGitStatus(
    '/repo',
    [
      '# branch.oid 1234567890',
      '# branch.head main',
      '1 MM N... 100644 100644 100644 abc def src/部分 file.ts',
      '2 R. N... 100644 100644 100644 abc def R100 新 name.ts',
      '旧 name.ts',
      '? --未跟踪 file.txt',
      'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts',
    ].join('\0'),
  );
  assert.equal(status.branch, 'main');
  assert.equal(status.hasHead, true);
  assert.deepEqual(status.staged, [
    { path: 'src/部分 file.ts', code: 'M' },
    { path: '新 name.ts', code: 'R', previousPath: '旧 name.ts' },
  ]);
  assert.deepEqual(status.changes, [
    { path: 'src/部分 file.ts', code: 'M' },
    { path: '--未跟踪 file.txt', code: '?' },
    { path: 'conflict.ts', code: 'U', conflict: true },
  ]);
  assert.equal(status.conflicted, true);
});

test('无 HEAD、未跟踪 diff、中文空格路径、子目录工作空间与全部取消暂存', async () => {
  await withRepo(async (root) => {
    const workspace = path.join(root, 'nested');
    fs.mkdirSync(workspace);
    write(root, 'nested/新 file.txt', '第一行\n第二行\n');
    write(root, '--draft file.txt', 'dash\n');
    const untracked = await gitStatus(workspace);
    assert.equal(untracked.ok, true);
    assert.equal(untracked.hasHead, false);
    assert.equal(path.resolve(untracked.root), path.resolve(root));
    assert.deepEqual(untracked.changes.map((file) => file.path).sort(), ['--draft file.txt', 'nested/新 file.txt']);

    const preview = await gitDiff(workspace, 'nested/新 file.txt', false);
    assert.equal(preview.ok, true, preview.message);
    assert.match(preview.content ?? '', /\+第一行/);
    assert.ok(!(preview.content ?? '').includes(root), 'diff 不应泄漏临时绝对路径');

    assert.equal((await stageFiles(workspace, ['nested/新 file.txt', '--draft file.txt'])).ok, true);
    assert.equal((await gitStatus(root)).staged.length, 2);
    const ai = await stagedDiff(root);
    assert.equal(ai.ok, true, ai.message);
    assert.match(ai.diff, /\+第一行/);
    const cleared = await unstageFiles(root);
    assert.equal(cleared.ok, true, cleared.message);
    assert.equal(cleared.status?.staged.length, 0);
    assert.equal(cleared.status?.changes.length, 2);
    assert.equal(fs.readFileSync(path.join(root, 'nested/新 file.txt'), 'utf8'), '第一行\n第二行\n');
    // 空集合的「全部」操作不能报错。
    assert.equal((await unstageFiles(root)).ok, true);

    assert.equal((await stageFiles(root)).ok, true);
    const committed = await commitStaged(root, 'feat: 添加首次提交');
    assert.equal(committed.ok, true, committed.message);
    assert.match(committed.commit ?? '', /feat: 添加首次提交/);
    assert.equal(committed.status?.hasHead, true);
    assert.equal(committed.status?.changes.length, 0);
    assert.equal((await stageFiles(root)).ok, true);
  });
});

test('部分暂存只提交暂存内容，rename 与继续修改能分别预览/取消', async () => {
  await withRepo(async (root) => {
    write(root, 'a.txt', 'one\ntwo\nthree\n');
    write(root, 'b.txt', 'base\n');
    await stageFiles(root);
    assert.equal((await commitStaged(root, 'chore: fixture')).ok, true);

    write(root, 'a.txt', 'ONE\ntwo\nthree\n');
    assert.equal((await stageFiles(root, ['a.txt'])).ok, true);
    write(root, 'a.txt', 'ONE\ntwo\nTHREE\n');
    write(root, 'b.txt', 'unstaged b\n');
    const partial = await stagedDiff(root);
    assert.equal(partial.ok, true);
    assert.match(partial.diff, /\+ONE/);
    assert.ok(!partial.diff.includes('THREE'));
    assert.ok(!partial.diff.includes('unstaged b'));
    const working = await gitDiff(root, 'a.txt', false);
    assert.match(working.content ?? '', /\+THREE/);

    const committed = await commitStaged(root, 'feat: staged only\n\n保留未暂存修改');
    assert.equal(committed.ok, true, committed.message);
    assert.equal(git(root, ['show', 'HEAD:a.txt']), 'ONE\ntwo\nthree\n');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'ONE\ntwo\nTHREE\n');
    assert.deepEqual((await gitStatus(root)).changes.map((file) => file.path).sort(), ['a.txt', 'b.txt']);

    // rename 期间不让另一个未暂存文件干扰本组断言。
    write(root, 'b.txt', 'base\n');
    git(root, ['mv', 'a.txt', '改名 file.txt']);
    write(root, '改名 file.txt', 'ONE\ntwo\nTHREE\nafter rename\n');
    const renamed = await gitStatus(root);
    assert.equal(renamed.staged[0]?.path, '改名 file.txt');
    assert.equal(renamed.staged[0]?.previousPath, 'a.txt');
    assert.equal(renamed.changes.find((file) => file.path === '改名 file.txt')?.previousPath, 'a.txt');
    assert.match((await gitDiff(root, '改名 file.txt', true)).content ?? '', /rename from a.txt/);
    assert.match((await gitDiff(root, '改名 file.txt', false)).content ?? '', /\+after rename/);

    assert.equal((await unstageFiles(root, ['改名 file.txt'])).ok, true);
    const reset = await gitStatus(root);
    assert.equal(reset.staged.length, 0);
    assert.equal(git(root, ['show', 'HEAD:a.txt']), 'ONE\ntwo\nthree\n');
    assert.match(fs.readFileSync(path.join(root, '改名 file.txt'), 'utf8'), /after rename/);

    write(root, 'b.txt', 'another staged change\n');
    await stageFiles(root, ['b.txt']);
    write(root, 'c.txt', 'c\n');
    await stageFiles(root, ['c.txt']);
    assert.equal((await unstageFiles(root, ['b.txt'])).ok, true);
    assert.deepEqual(
      (await gitStatus(root)).staged.map((file) => file.path),
      ['c.txt'],
    );
    assert.equal((await unstageFiles(root)).ok, true);
    assert.equal((await gitStatus(root)).staged.length, 0);
    assert.equal((await gitDiff(root, '../outside.txt', false)).ok, false);
    assert.equal((await stageFiles(root, ['missing.txt'])).ok, false);
    assert.equal((await commitStaged(root, '   ')).message, 'EMPTY_COMMIT_MESSAGE');
  });
});

test('通配符文件名在暂存、取消暂存与 diff 中都按字面路径处理', async () => {
  await withRepo(async (root) => {
    write(root, '[a].txt', 'bracket base\n');
    write(root, 'a.txt', 'letter base\n');
    git(root, ['add', '--', '[a].txt', 'a.txt']);
    git(root, ['commit', '-q', '-m', 'chore: literal fixtures']);

    write(root, '[a].txt', 'bracket changed\n');
    write(root, 'a.txt', 'letter unchanged\n');
    assert.equal((await stageFiles(root, ['[a].txt'])).ok, true);
    assert.deepEqual(
      (await gitStatus(root)).staged.map((file) => file.path),
      ['[a].txt'],
    );
    assert.equal(git(root, ['show', 'HEAD:a.txt']), 'letter base\n');

    const preview = await gitDiff(root, '[a].txt', true);
    assert.match(preview.content ?? '', /\+bracket changed/);
    assert.ok(!preview.content?.includes('a/a.txt'));
    assert.equal((await unstageFiles(root, ['[a].txt'])).ok, true);
    assert.equal((await gitStatus(root)).staged.length, 0);

    // 反向匹配同样不能借 [a] 的 pathspec 语义碰到字母文件名。
    assert.equal((await stageFiles(root, ['a.txt'])).ok, true);
    assert.deepEqual(
      (await gitStatus(root)).staged.map((file) => file.path),
      ['a.txt'],
    );
    const letterDiff = await gitDiff(root, '[a].txt', false);
    assert.match(letterDiff.content ?? '', /\+bracket changed/);
    assert.ok(!letterDiff.content?.includes('+letter unchanged'));
    assert.equal((await unstageFiles(root, ['a.txt'])).ok, true);
    assert.equal((await gitStatus(root)).staged.length, 0);
  });
});

test('真实未解决冲突禁止提交，也不把冲突吞成空变更', async () => {
  await withRepo(async (root) => {
    write(root, 'a.txt', 'base\n');
    await stageFiles(root);
    assert.equal((await commitStaged(root, 'chore: base')).ok, true);
    git(root, ['checkout', '-q', '-b', 'other']);
    write(root, 'a.txt', 'other\n');
    await stageFiles(root);
    assert.equal((await commitStaged(root, 'feat: other')).ok, true);
    git(root, ['checkout', '-q', '-']);
    write(root, 'a.txt', 'main\n');
    await stageFiles(root);
    assert.equal((await commitStaged(root, 'feat: main')).ok, true);
    assert.throws(() => git(root, ['merge', 'other']));
    const conflict = await gitStatus(root);
    assert.equal(conflict.conflicted, true);
    assert.equal(conflict.changes[0]?.conflict, true);
    assert.equal((await commitStaged(root, 'feat: must not commit')).message, 'UNRESOLVED_CONFLICTS');
    const single = await stageFiles(root, ['a.txt']);
    assert.equal(single.ok, false);
    assert.equal(single.message, 'UNRESOLVED_CONFLICTS');
    assert.equal((await gitStatus(root)).conflicted, true);
    assert.match(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), /<<<<<<</);

    const all = await stageFiles(root);
    assert.equal(all.ok, false);
    assert.equal(all.message, 'UNRESOLVED_CONFLICTS');
    assert.equal((await gitStatus(root)).conflicted, true);
    assert.equal(git(root, ['ls-files', '-u', '--', 'a.txt']).trim().length > 0, true);
    assert.match(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), /<<<<<<</);
  });
});

test('非仓库返回明确错误', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-not-git-'));
  try {
    const status = await gitStatus(root);
    assert.equal(status.ok, false);
    assert.equal(status.isRepo, false);
    assert.equal((await stagedDiff(root)).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
