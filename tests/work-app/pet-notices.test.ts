import test from 'node:test';
import assert from 'node:assert/strict';
import { PetTaskNotices, petLookAt } from '../../packages/work-app/src/pet-notices.js';
const task = (id: string, status: string) => ({ id, title: `Task ${id}`, status, updatedAt: '' });

test('startup reports existing human waits but never celebrates old completed history', () => {
  const notices = new PetTaskNotices();
  notices.update([task('old', 'completed'), task('wait', 'waiting')]);
  assert.equal(notices.next()?.taskId, 'wait');
  assert.equal(notices.next(), null);
});

test('every task completion is reported even if another task is running or waiting', () => {
  const notices = new PetTaskNotices();
  notices.update([task('a', 'running'), task('b', 'running'), task('c', 'running')]);
  notices.update([task('a', 'completed'), task('b', 'completed'), task('c', 'waiting')]);
  assert.equal(notices.next()?.taskId, 'c');
  assert.equal(notices.next()?.taskId, 'a');
  assert.equal(notices.next()?.taskId, 'b');
  notices.update([task('a', 'completed'), task('b', 'completed'), task('c', 'waiting')]);
  assert.equal(notices.next(), null);
});

test('resolved waits and deleted or restarted tasks do not leave stale queued notices', () => {
  const notices = new PetTaskNotices();
  notices.update([task('a', 'running'), task('b', 'waiting')]);
  notices.update([task('a', 'completed'), task('b', 'running')]);
  notices.update([task('a', 'running')]);
  assert.equal(notices.next(), null);
});

test('a new wait after resuming and a failed run are both reported', () => {
  const notices = new PetTaskNotices();
  notices.update([task('a', 'waiting')]);
  notices.next();
  notices.update([task('a', 'running')]);
  notices.update([task('a', 'waiting')]);
  assert.equal(notices.next()?.status, 'waiting');
  notices.update([task('a', 'failed')]);
  assert.equal(notices.next()?.status, 'failed');
});

test('disabled pets do not build a backlog, reopening reports current waits only', () => {
  const notices = new PetTaskNotices();
  notices.update([task('a', 'running')], false);
  notices.update([task('a', 'completed')], false);
  assert.equal(notices.next(), null);
  notices.reset();
  notices.update([task('a', 'completed'), task('b', 'waiting')]);
  assert.equal(notices.next()?.taskId, 'b');
  assert.equal(notices.next(), null);
});

test('cursor tracking extends beyond the pet window and clamps distant positions radially', () => {
  assert.deepEqual(petLookAt({ x: 100, y: 100 }, { x: 100, y: 100 }), { x: 0, y: 0 });
  assert.deepEqual(petLookAt({ x: 260, y: 180 }, { x: 100, y: 100 }), { x: 0.5, y: 0.25 });
  assert.deepEqual(petLookAt({ x: -1000, y: 100 }, { x: 100, y: 100 }), { x: -1, y: 0 });
  const diagonal = petLookAt({ x: 2000, y: 2000 }, { x: 0, y: 0 });
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-10);
});
