import test from 'node:test';
import assert from 'node:assert/strict';
import { PetGesture, PetInteraction } from '../../packages/work-app/src/pet-interaction.js';

test('small pointer tremors still count as a tap without moving the pet window', () => {
  const gesture = new PetGesture();
  gesture.begin(100, 200);
  assert.equal(gesture.move(103, 202), null);
  assert.equal(gesture.finish(), 'click');
  assert.equal(gesture.finish(), null);
});

test('dragging accumulates threshold movement, then only sends incremental screen deltas', () => {
  const gesture = new PetGesture();
  gesture.begin(100, 200);
  gesture.move(103, 200);
  assert.deepEqual(gesture.move(108, 202), { x: 8, y: 2 });
  assert.deepEqual(gesture.move(114, 205), { x: 6, y: 3 });
  assert.equal(gesture.finish(), 'drag');
});

test('dragging back to the original position does not accidentally trigger a reaction', () => {
  const gesture = new PetGesture();
  gesture.begin(0, 0);
  gesture.move(20, 0);
  gesture.move(0, 0);
  assert.equal(gesture.finish(), 'drag');
  gesture.begin(0, 0);
  gesture.cancel();
  assert.equal(gesture.finish(), null);
});

test('head taps always pat and body taps always hug', () => {
  const interaction = new PetInteraction();
  assert.equal(interaction.tap(true, 100), 'pat');
  assert.equal(interaction.tap(false, 200), 'hug');
  assert.equal(interaction.tap(false, 300), 'hug');
  assert.equal(interaction.tap(false, 400), 'hug');
  assert.equal(interaction.tap(true, 500), 'pat');
});

test('dragging spins continuously without restarting on repeated move events', () => {
  const interaction = new PetInteraction();
  interaction.startDrag(1000);
  interaction.startDrag(1500);
  assert.equal(interaction.current(1700)?.elapsed, 0.7);
  assert.equal(interaction.current(7500)?.action, 'spin');
  assert.equal(interaction.current(7500)?.elapsed, 0.5);
  interaction.endDrag(7500);
  assert.equal(interaction.current(8000)?.elapsed, 1);
  assert.equal(interaction.current(9999)?.action, 'spin');
  assert.equal(interaction.current(10000), null);
});

test('a new tap replaces a finished drag with its own action', () => {
  const interaction = new PetInteraction();
  interaction.startDrag(1000);
  interaction.endDrag(1400);
  assert.equal(interaction.tap(false, 1500), 'hug');
  assert.equal(interaction.current(1600)?.action, 'hug');
  assert.equal(interaction.current(4300), null);
});

test('reaction survives task polling and expires so the latest task animation can resume', () => {
  const interaction = new PetInteraction();
  interaction.trigger('pat', 1000);
  assert.equal(interaction.current(1700)?.action, 'pat');
  assert.equal(interaction.current(3100)?.action, 'pat');
  assert.equal(interaction.current(3400), null);
  interaction.trigger('spin', 4000);
  interaction.trigger('wave', 4500);
  assert.equal(interaction.current(5000)?.action, 'wave');
  assert.equal(interaction.current(6800), null);
});
