import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPetTask, type PetTask } from '../../packages/work-app/src/pet-state.js';
const now = Date.parse('2026-11-17T12:00:00Z');
const task = (id: string, status: string, age = 0): PetTask => ({
  id,
  title: id,
  status,
  updatedAt: new Date(now - age).toISOString(),
});
test('pet prioritizes oldest human wait over running tasks and celebrations', () => {
  const tasks = [
    task('run', 'running'),
    task('done', 'completed'),
    task('new', 'waiting'),
    task('old', 'waiting', 5000),
  ];
  assert.equal(selectPetTask(tasks, now).id, 'old');
  assert.equal(tasks[0].id, 'run');
});
test('pet keeps active work visible instead of completed task', () => {
  assert.equal(selectPetTask([task('done', 'completed'), task('run', 'running', 50000)], now).id, 'run');
});
test('pet celebrates recent completion and returns idle after twelve seconds', () => {
  assert.equal(selectPetTask([task('done', 'completed', 11999)], now).status, 'completed');
  assert.equal(selectPetTask([task('done', 'completed', 12000)], now).status, 'idle');
  assert.equal(selectPetTask([task('draft', 'queued')], now).status, 'idle');
  assert.equal(selectPetTask([task('future', 'completed', -1000)], now).status, 'idle');
});
test('pet shows latest failure and preserves real plan progress', () => {
  const running = { ...task('run', 'running'), plan: { done: 2, total: 5 } };
  assert.deepEqual(selectPetTask([running], now).plan, { done: 2, total: 5 });
  assert.equal(selectPetTask([task('done', 'completed', 1000), task('fail', 'failed')], now).status, 'failed');
});
