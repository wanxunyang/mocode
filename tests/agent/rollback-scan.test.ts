import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { RollbackStore } from '../../src/rollback/store.js';

test('工作区扫描保留自定义会话目录边界，回滚以本次调用前的最新内容为准', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mocode-rollback-scan-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const sessions = join(root, 'state', 'sessions');
  const sibling = join('other', 'sessions', 'code.txt');
  const removed = join('src', 'old.txt');
  const created = join('src', 'new.txt');
  for (const dir of [sessions, dirname(join(root, sibling)), join(root, 'src'), join(root, 'node_modules')]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(root, sibling), 'initial');
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
