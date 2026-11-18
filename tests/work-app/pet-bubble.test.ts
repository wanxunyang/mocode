import test from 'node:test';
import assert from 'node:assert/strict';
import { PetBubble } from '../../packages/work-app/src/pet-bubble.js';

test('idle startup stays silent', () => {
  const bubble = new PetBubble();
  assert.equal(bubble.observeTask({ id: '', status: 'idle' }), false);
  assert.equal(bubble.visible(0), false);
});

test('task notice expires even when the same task is polled repeatedly', () => {
  const bubble = new PetBubble();
  const task = { id: 'work', status: 'running', updatedAt: 'first' };
  assert.equal(bubble.observeTask(task), true);
  bubble.show(1000, 5000);
  const polledTask = { ...task, updatedAt: 'new timestamp' };
  assert.equal(bubble.observeTask(polledTask), false);
  assert.equal(bubble.visible(5999), true);
  assert.equal(bubble.visible(6000), false);
  assert.equal(bubble.observeTask(task), false);
});

test('new plan step and attention status trigger new notices', () => {
  const bubble = new PetBubble();
  const task = { id: 'work', status: 'running', plan: { done: 1, total: 3 } };
  assert.equal(bubble.observeTask(task), true);
  assert.equal(bubble.observeTask(task), false);
  assert.equal(bubble.observeTask({ ...task, plan: { done: 2, total: 3 } }), true);
  assert.equal(bubble.observeTask({ ...task, status: 'waiting' }), true);
  assert.equal(bubble.observeTask({ ...task, id: 'another task' }), true);
});

test('a repeated interaction reopens the bubble and then automatically hides', () => {
  const bubble = new PetBubble();
  bubble.show(1000);
  assert.equal(bubble.visible(4500), false);
  bubble.show(5000);
  assert.equal(bubble.visible(6000), true);
  assert.equal(bubble.visible(8500), false);
});

test('returning to idle does not cancel an interaction notice or create a new notice', () => {
  const bubble = new PetBubble();
  bubble.observeTask({ id: 'work', status: 'completed' });
  bubble.show(1000);
  assert.equal(bubble.observeTask({ id: '', status: 'idle' }), false);
  assert.equal(bubble.visible(2000), true);
  assert.equal(bubble.visible(4500), false);
});
