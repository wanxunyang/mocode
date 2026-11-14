import test from 'node:test';
import assert from 'node:assert/strict';
import { isWaitingForHuman, pendingByProject, pendingTasks } from '../../packages/work-app/src/attention.js';

const task = (id: string, status: string, projectId: string, updatedAt: string) => ({
  id,
  title: id,
  projectId,
  status,
  updatedAt,
});

test('只有 waiting 算「在等人」：running / completed / failed 都不是', () => {
  assert.equal(isWaitingForHuman({ status: 'waiting' }), true);
  for (const status of ['running', 'queued', 'completed', 'failed', 'cancelled']) {
    assert.equal(isWaitingForHuman({ status }), false);
  }
});

test('pendingTasks 只取 waiting，最久等待的排最前（updatedAt 升序 = 它开始等的时刻）', () => {
  const tasks = [
    task('new', 'waiting', 'p1', '2026-11-15T10:05:00.000Z'),
    task('running', 'running', 'p1', '2026-11-15T09:00:00.000Z'),
    task('old', 'waiting', 'p2', '2026-11-15T08:30:00.000Z'),
    task('done', 'completed', 'p2', '2026-11-15T07:00:00.000Z'),
    task('mid', 'waiting', 'p1', '2026-11-15T09:30:00.000Z'),
  ];
  assert.deepEqual(
    pendingTasks(tasks).map((item) => item.id),
    ['old', 'mid', 'new'],
  );
  // 排序不能改原数组（state 是不可变快照，渲染层直接读）。
  assert.equal(tasks[0]!.id, 'new');
});

test('同一时刻更新时排序稳定（按 id），不随数组顺序抖动', () => {
  const same = '2026-11-15T10:00:00.000Z';
  const forward = pendingTasks([task('b', 'waiting', 'p', same), task('a', 'waiting', 'p', same)]);
  const backward = pendingTasks([task('a', 'waiting', 'p', same), task('b', 'waiting', 'p', same)]);
  assert.deepEqual(
    forward.map((item) => item.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    backward.map((item) => item.id),
    ['a', 'b'],
  );
});

test('pendingByProject 按空间计数，无空间的归到空字符串键', () => {
  const counts = pendingByProject([
    task('a', 'waiting', 'p1', '2026-11-15T10:00:00.000Z'),
    task('b', 'waiting', 'p1', '2026-11-15T10:01:00.000Z'),
    task('c', 'running', 'p1', '2026-11-15T10:02:00.000Z'),
    task('d', 'waiting', '', '2026-11-15T10:03:00.000Z'),
  ]);
  assert.equal(counts.get('p1'), 2);
  assert.equal(counts.get(''), 1);
  // 没有任何 waiting 的空间不该出现在表里（渲染层据此隐藏徽章）。
  assert.equal(counts.has('p2'), false);
  assert.equal(pendingByProject([]).size, 0);
});
