import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandoffStripper,
  setHandoffDisplaySuppressed,
  handoffDisplaySuppressed,
} from '../../src/ui/handoff-block.js';

const BLOCK =
  '<mocode_handoff>{"summary":"done","validation":[{"command":"npm test","status":"passed"}],"risks":[]}</mocode_handoff>';

test('handoff-block: text without a handoff block passes through unchanged', () => {
  const strip = createHandoffStripper();
  assert.equal(strip.push('plain answer'), 'plain answer');
  assert.equal(strip.push(' continued'), ' continued');
  assert.equal(strip.flush(), '');
});

test('handoff-block: a complete block is dropped, surrounding prose is kept', () => {
  const strip = createHandoffStripper();
  const out = strip.push(`before\n${BLOCK}\nafter`);
  assert.equal(out.includes('mocode_handoff'), false);
  assert.equal(out.includes('"summary"'), false);
  assert.match(out, /before/);
  assert.match(out, /after/);
});

test('handoff-block: a block split across many chunks is still recognized', () => {
  const strip = createHandoffStripper();
  let out = '';
  // 逐字符喂：最容易把标签切碎的方式。
  for (const char of `intro\n${BLOCK}`) out += strip.push(char);
  out += strip.flush();
  assert.equal(out.includes('mocode_handoff'), false);
  assert.equal(out, 'intro\n');
});

test('handoff-block: partial opening tag at the chunk boundary is held back, not leaked', () => {
  const strip = createHandoffStripper();
  // 只发到 `<mocode_han`：这一段绝不能上屏，否则用户会看到半截标签。
  assert.equal(strip.push('done <mocode_han'), 'done ');
  assert.equal(strip.push('doff>{}'), '');
});

test('handoff-block: an unterminated block is discarded on flush instead of leaking JSON', () => {
  const strip = createHandoffStripper();
  const out = strip.push('report\n<mocode_handoff>{"summary":"cut of');
  assert.equal(out, 'report\n');
  // 模型被中断/忘了闭合：残渣必须丢掉，不能因为「没等到闭合」就吐屏。
  assert.equal(strip.flush(), '');
});

test('handoff-block: two blocks in one stream are both removed', () => {
  const strip = createHandoffStripper();
  const out = strip.push(`a${BLOCK}b${BLOCK}c`);
  assert.equal(out.includes('mocode_handoff'), false);
  assert.equal(out, 'abc');
});

test('handoff-block: the display switch is process-wide and defaults to off', () => {
  setHandoffDisplaySuppressed(false);
  assert.equal(handoffDisplaySuppressed(), false);
  setHandoffDisplaySuppressed(true);
  assert.equal(handoffDisplaySuppressed(), true);
  setHandoffDisplaySuppressed(false); // 恢复，避免污染同进程的其它用例
  assert.equal(handoffDisplaySuppressed(), false);
});
