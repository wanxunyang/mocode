import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCommitFile, gitCommitFiles, gitLog } from '../../packages/work-app/src/git.js';

/**
 * 历史视图的三个读接口：真实仓库（临时目录）跑一遍，确认字段口径与渲染层约定一致。
 * 不 mock git —— 这些函数的全部价值就是「git 输出解析对不对」。
 */

function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...env },
  });
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-history-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'MoCode Test']);
    git(root, ['config', 'user.email', 'mocode-test@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'core.hooksPath', '.test-hooks-disabled']);
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function commit(root: string, message: string, when: string): string {
  const env = {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
    GIT_AUTHOR_NAME: 'MoCode Test',
    GIT_AUTHOR_EMAIL: 'mocode-test@example.invalid',
    GIT_COMMITTER_NAME: 'MoCode Test',
    GIT_COMMITTER_EMAIL: 'mocode-test@example.invalid',
  };
  git(root, ['add', '-A'], env);
  git(root, ['commit', '-q', '-m', message], env);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

test('gitLog：字段齐全、时间序（父在后）、支持分页与 truncated', async () => {
  await withRepo(async (root) => {
    write(root, 'a.txt', 'one');
    const first = commit(root, 'first commit', '2026-01-01T10:00:00+08:00');
    write(root, 'a.txt', 'two');
    const second = commit(root, 'second 提交', '2026-01-02T10:00:00+08:00');

    const page = await gitLog(root, { limit: 10 });
    assert.equal(page.ok, true);
    assert.equal(page.truncated, false);
    assert.deepEqual(
      page.commits.map((entry) => entry.sha),
      [second, first],
    );
    const head = page.commits[0];
    assert.equal(head.subject, 'second 提交');
    assert.equal(head.author, 'MoCode Test');
    assert.deepEqual(head.parents, [first]);
    assert.equal(head.shortSha.length >= 4, true);
    // refs 来自 %D：首条提交带 HEAD -> main。
    assert.ok(page.commits[0].refs.join(' ').includes('main'));
    // 日期是 ISO 字符串，渲染层直接交给 relativeTime。
    assert.ok(!Number.isNaN(Date.parse(head.date)));

    // limit=1 时下一批是否还有内容要由 truncated 告知，否则「加载更多」永远不出现。
    const one = await gitLog(root, { limit: 1 });
    assert.equal(one.commits.length, 1);
    assert.equal(one.truncated, true);
    const rest = await gitLog(root, { limit: 1, skip: 1 });
    assert.deepEqual(
      rest.commits.map((entry) => entry.sha),
      [first],
    );
    assert.equal(rest.truncated, false);
  });
});

test('gitLog：空仓库返回空列表而不是报错', async () => {
  await withRepo(async (root) => {
    // 无 HEAD 的仓库：git log 会失败，界面必须显示「还没有提交」而不是错误。
    const page = await gitLog(root);
    assert.equal(page.ok, false);
    assert.deepEqual(page.commits, []);
  });
});

test('gitCommitFiles：新增/修改/删除/重命名各自的 code 与旧路径', async () => {
  await withRepo(async (root) => {
    write(root, 'keep.txt', 'keep');
    write(root, 'gone.txt', 'bye');
    write(root, 'old-name.txt', 'x');
    commit(root, 'base', '2026-01-01T10:00:00+08:00');

    write(root, 'keep.txt', 'keep changed');
    fs.rmSync(path.join(root, 'gone.txt'));
    write(root, 'added.txt', 'new');
    git(root, ['mv', 'old-name.txt', 'new-name.txt']);
    const sha = commit(root, 'mixed', '2026-01-02T10:00:00+08:00');

    const result = await gitCommitFiles(root, sha);
    assert.equal(result.ok, true);
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    assert.equal(byPath.get('keep.txt')?.code, 'M');
    assert.equal(byPath.get('added.txt')?.code, 'A');
    assert.equal(byPath.get('gone.txt')?.code, 'D');
    const renamed = byPath.get('new-name.txt');
    assert.equal(renamed?.code, 'R');
    // 重命名的旧路径必须带出来：界面用「旧 → 新」展示，否则用户看不懂改了什么。
    assert.equal(renamed?.previousPath, 'old-name.txt');
  });
});

test('gitCommitFile：改动 diff + 该提交时的完整内容；删除的文件没有内容', async () => {
  await withRepo(async (root) => {
    write(root, 'src/app.ts', 'line1\nline2\n');
    commit(root, 'create', '2026-01-01T10:00:00+08:00');
    write(root, 'src/app.ts', 'line1\nline2 changed\nline3\n');
    const sha = commit(root, 'edit', '2026-01-02T10:00:00+08:00');

    const view = await gitCommitFile(root, sha, 'src/app.ts');
    assert.equal(view.ok, true);
    // binary 只在命中时出现（`...(binary ? {binary:true} : {})`），文本文件就是 undefined。
    assert.ok(!view.binary);
    // 内容必须是「这个提交时」的版本，不是工作区当前版本。
    assert.equal(view.content, 'line1\nline2 changed\nline3\n');
    assert.ok(view.diff?.includes('+line2 changed'));
    assert.ok(view.diff?.includes('-line2'));

    // 非法 sha 直接拒绝，不把参数拼进 git 命令。
    const bad = await gitCommitFile(root, 'not-a-sha', 'src/app.ts');
    assert.equal(bad.ok, false);

    // 前一个提交里删除的文件：内容为空、diff 是纯删除。
    write(root, 'tmp.txt', 'bye');
    commit(root, 'add tmp', '2026-01-03T10:00:00+08:00');
    fs.rmSync(path.join(root, 'tmp.txt'));
    const removed = commit(root, 'remove tmp', '2026-01-04T10:00:00+08:00');
    const gone = await gitCommitFile(root, removed, 'tmp.txt');
    assert.equal(gone.ok, true);
    assert.equal((gone.content ?? '').trim(), '');
    assert.ok(gone.diff?.includes('-bye'));
  });
});

test('gitCommitFile：二进制文件标记 binary 且不返回内容', async () => {
  await withRepo(async (root) => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    fs.writeFileSync(path.join(root, 'blob.bin'), bytes);
    const sha = commit(root, 'binary', '2026-01-01T10:00:00+08:00');
    const view = await gitCommitFile(root, sha, 'blob.bin');
    assert.equal(view.ok, true);
    assert.equal(view.binary, true);
    // 二进制不给内容（空串），避免乱码进 DOM。
    assert.equal(view.content, '');
  });
});
