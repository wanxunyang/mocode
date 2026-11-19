import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RollbackStore } from '../../src/rollback/store.js';
import { createRuntime } from '../../src/runtime/index.js';
import { builtinTools } from '../../src/tools/builtins/index.js';

async function createWorkspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mocode-rollback-scan-'));
  t.after(async () => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    await rm(target, { recursive: true, force: true });
  });
  return root;
}

test('工作区扫描保留自定义会话目录边界，回滚以本次调用前的最新内容为准', async (t) => {
  const root = await createWorkspace(t);
  const sessions = join(root, 'state', 'sessions');
  const sibling = join('other', 'sessions', 'code.txt');
  const removed = join('src', 'old.txt');
  const created = join('src', 'new.txt');
  for (const dir of [sessions, dirname(join(root, sibling)), join(root, 'src'), join(root, 'node_modules')]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(root, sibling), 'original text');
  const originalTime = new Date('2020-01-01T00:00:00Z');
  await utimes(join(root, sibling), originalTime, originalTime);
  await writeFile(join(root, removed), 'keep');
  await writeFile(join(sessions, 'history'), 'private');
  const store = new RollbackStore(root, sessions);
  const warm = await store.beginWorkspaceMutation();
  assert.deepEqual(
    [...warm.entries.keys()].sort(),
    ['other', join('other', 'sessions'), sibling, 'src', removed, 'state'].sort(),
  );
  await store.endWorkspaceMutation(warm, 'observe');

  await writeFile(join(root, sibling), 'external edit');
  const editedTime = new Date('2020-01-02T00:00:00Z');
  await utimes(join(root, sibling), editedTime, editedTime);
  store.beginTurn('change');
  const capture = await store.beginWorkspaceMutation();
  await writeFile(join(root, sibling), 'tool edit');
  await rm(join(root, removed));
  await writeFile(join(root, created), 'new');
  await writeFile(join(sessions, 'history'), 'updated');
  await store.endWorkspaceMutation(capture, 'run_command');
  const changed = store.getCurrentTurnMutationState().changedFiles.map((f) => f.path);
  assert.deepEqual(changed.sort(), [sibling, created, removed].sort());
  const history = [{ role: 'user' as const, content: 'change' }];
  const result = store.applyRollback(store.planRollback(0, history), history, new Set(changed));
  assert.deepEqual(result.conflictedFiles, []);
  assert.equal(await readFile(join(root, sibling), 'utf8'), 'external edit');
  assert.equal(await readFile(join(root, removed), 'utf8'), 'keep');
  await assert.rejects(readFile(join(root, created)), { code: 'ENOENT' });
  assert.equal(await readFile(join(sessions, 'history'), 'utf8'), 'updated');
});

test('run_command 非零退出时也能回滚目录改名和二进制内容，并保留后续外部修改', async (t) => {
  const root = await createWorkspace(t);
  const oldDir = join('src', 'old');
  const newDir = join('src', 'new');
  const binary = join(oldDir, 'deep', 'frame.bin');
  const original = Buffer.from([0, 255, 128, 42]);
  await mkdir(join(root, oldDir, 'deep'), { recursive: true });
  await writeFile(join(root, binary), original);
  if (process.platform !== 'win32') await chmod(join(root, binary), 0o640);
  const mode = (await stat(join(root, binary))).mode & 0o777;
  await writeFile(join(root, 'local.txt'), 'before command');
  await writeFile(
    join(root, 'mutate.cjs'),
    [
      'const fs = require("node:fs");',
      'fs.renameSync("src/old", "src/new");',
      'fs.writeFileSync("src/new/deep/frame.bin", Buffer.from([255, 0, 42, 128]));',
      'fs.writeFileSync("local.txt", "agent edit");',
      'process.exitCode = 7;',
    ].join('\n'),
  );

  const runtime = createRuntime({ sandboxRoot: root, tools: builtinTools });
  t.after(() => runtime.close());
  runtime.context.beginTurn('rename directory');
  const outcome = await runtime.context.runInScope(() =>
    runtime.context.toolRuntime.executeToolOutcome(
      'run_command',
      JSON.stringify({ command: 'node mutate.cjs', shell: process.platform === 'win32' ? 'cmd' : 'bash' }),
    ),
  );
  assert.equal(outcome.code, 'PROCESS_FAILED', outcome.output);
  const expected = [
    'local.txt',
    oldDir,
    join(oldDir, 'deep'),
    binary,
    newDir,
    join(newDir, 'deep'),
    join(newDir, 'deep', 'frame.bin'),
  ];
  assert.ok(outcome.changedFiles);
  assert.deepEqual([...outcome.changedFiles].sort(), expected.sort());

  await writeFile(join(root, 'local.txt'), 'user edit after command');
  const history = [{ role: 'user' as const, content: 'rename directory' }];
  const result = runtime.rollback.apply(runtime.rollback.plan(0, history), history, new Set(expected));
  assert.deepEqual(result.conflictedFiles, ['local.txt']);
  assert.deepEqual(await readFile(join(root, binary)), original);
  assert.equal((await stat(join(root, binary))).mode & 0o777, mode);
  await assert.rejects(stat(join(root, newDir)), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'local.txt'), 'utf8'), 'user edit after command');
});
