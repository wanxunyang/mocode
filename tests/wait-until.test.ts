/**
 * wait_until 纯逻辑单测(design-notes/computer-use-rpa.md §3.1/§3.2)。
 * 用合成 PngImage 序列 + 假时钟,不碰屏幕/进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCondition,
  parseSelectorText,
  parseWaitCondition,
  pickTypeMethod,
  waitUntil,
  type WaitCondition,
  type WaitDeps,
} from '../src/runtime/wait-until.js';
import type { PngImage } from '../src/runtime/screen-pipeline.js';

/** 纯色 64×64 帧;gray 不同则 diff 明显。 */
function frame(gray: number, size = 64): PngImage {
  const data = Buffer.alloc(size * size * 4, gray);
  return { width: size, height: size, data };
}

/** 假时钟:sleep 直接推进 now,不真等。 */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function seqDeps(frames: PngImage[], extra: Partial<WaitDeps> = {}): WaitDeps {
  const c = clock();
  let i = 0;
  return {
    captureFrame: async () => frames[Math.min(i++, frames.length - 1)],
    elementExists: async () => false,
    ...c,
    ...extra,
  };
}

const STABLE: WaitCondition = { kind: 'stable', frames: 2, intervalMs: 400, threshold: 0.005 };

test('parseSelectorText: role:"name"、仅 "name"、转义引号、非法输入', () => {
  assert.deepEqual(parseSelectorText('Button:"确定"'), { role: 'Button', name: '确定' });
  assert.deepEqual(parseSelectorText('  "OK"  '), { name: 'OK' });
  assert.deepEqual(parseSelectorText('Edit:"a \\"b\\""'), { role: 'Edit', name: 'a "b"' });
  assert.equal(parseSelectorText('Button:确定'), null);
  assert.equal(parseSelectorText('Button:""'), null);
  assert.equal(parseSelectorText(''), null);
});

test('parseWaitCondition: stable 默认值与范围校验', () => {
  const ok = parseWaitCondition({ kind: 'stable' }, 0.005);
  assert.deepEqual(ok, { ok: true, condition: { kind: 'stable', frames: 2, intervalMs: 400, threshold: 0.005 } });
  assert.equal(parseWaitCondition({ kind: 'stable', frames: 1 }, 0.005).ok, false);
  assert.equal(parseWaitCondition({ kind: 'stable', frames: 6 }, 0.005).ok, false);
  assert.equal(parseWaitCondition({ kind: 'stable', interval_ms: 100 }, 0.005).ok, false);
  assert.equal(parseWaitCondition({ kind: 'stable', interval_ms: 2001 }, 0.005).ok, false);
  assert.equal(parseWaitCondition({ kind: 'changed', threshold: 1.5 }, 0.005).ok, false);
  const t = parseWaitCondition({ kind: 'changed', threshold: 0.1, interval_ms: 500 }, 0.005);
  assert.deepEqual(t, { ok: true, condition: { kind: 'changed', intervalMs: 500, threshold: 0.1 } });
});

test('parseWaitCondition: 非对象 / 未知 kind / element 目标二选一', () => {
  assert.equal(parseWaitCondition(undefined, 0.005).ok, false);
  assert.equal(parseWaitCondition('stable', 0.005).ok, false);
  assert.equal(parseWaitCondition([], 0.005).ok, false);
  assert.equal(parseWaitCondition({ kind: 'nope' }, 0.005).ok, false);
  // 都没给 / 都给了
  assert.equal(parseWaitCondition({ kind: 'element_present' }, 0.005).ok, false);
  assert.equal(parseWaitCondition({ kind: 'element_present', ref: 'e1', selector_text: '"x"' }, 0.005).ok, false);
  // ref 格式
  assert.equal(parseWaitCondition({ kind: 'element_absent', ref: 'foo' }, 0.005).ok, false);
  const byRef = parseWaitCondition({ kind: 'element_absent', ref: 'e3' }, 0.005);
  assert.deepEqual(byRef, { ok: true, condition: { kind: 'element_absent', intervalMs: 400, target: { ref: 'e3' } } });
  const byText = parseWaitCondition({ kind: 'element_present', selector_text: 'Button:"确定"' }, 0.005);
  assert.equal(byText.ok, true);
  if (byText.ok && byText.condition.kind === 'element_present' && 'step' in byText.condition.target) {
    assert.deepEqual(byText.condition.target.step, { role: 'Button', name: '确定' });
  } else {
    assert.fail('expected selector_text target');
  }
  assert.equal(parseWaitCondition({ kind: 'element_present', selector_text: 'bad' }, 0.005).ok, false);
});

test('describeCondition', () => {
  assert.equal(describeCondition(STABLE), 'stable');
  assert.equal(
    describeCondition({ kind: 'element_present', intervalMs: 400, target: { ref: 'e5' } }),
    'element_present e5',
  );
  assert.equal(
    describeCondition({ kind: 'element_absent', intervalMs: 400, target: { step: { name: 'x' }, text: '"x"' } }),
    'element_absent "x"',
  );
});

test('waitUntil stable: 先变化后连续静止 → met,且需要 frames 次连续静止', async () => {
  // 第 1 帧基准;第 2 帧变化(run=0);第 3、4 帧与前一帧相同 → run=2 满足。
  const r = await waitUntil(STABLE, 10000, seqDeps([frame(10), frame(200), frame(200), frame(200)]));
  assert.equal(r.outcome, 'met');
  assert.equal(r.polls, 4);
  assert.equal(r.lastDiff, 0);
});

test('waitUntil stable: 静止中途被打断则计数清零', async () => {
  const frames = [frame(10), frame(10), frame(200), frame(200), frame(200)];
  const r = await waitUntil(STABLE, 10000, seqDeps(frames));
  assert.equal(r.outcome, 'met');
  // 第 2 帧 run=1,第 3 帧变化清零,第 4 帧 run=1,第 5 帧 run=2。
  assert.equal(r.polls, 5);
});

test('waitUntil stable: 持续变化 → timeout,带 lastDiff 与已用时间', async () => {
  const frames = Array.from({ length: 50 }, (_, i) => frame(i % 2 === 0 ? 0 : 255));
  const r = await waitUntil(STABLE, 2000, seqDeps(frames));
  assert.equal(r.outcome, 'timeout');
  assert.ok(r.elapsedMs >= 2000);
  assert.ok((r.lastDiff ?? 0) > 0.5);
});

test('waitUntil stable: 帧尺寸变化按"有变化"处理而不抛错', async () => {
  const frames = [frame(10, 64), frame(10, 128), frame(10, 128), frame(10, 128)];
  const r = await waitUntil(STABLE, 10000, seqDeps(frames));
  assert.equal(r.outcome, 'met');
});

test('waitUntil changed: 以注入的 baseline 为基准,出现差异即 met', async () => {
  const cond: WaitCondition = { kind: 'changed', intervalMs: 400, threshold: 0.005 };
  const r = await waitUntil(cond, 10000, seqDeps([frame(10), frame(10), frame(220)], { baseline: frame(10) }));
  assert.equal(r.outcome, 'met');
  assert.equal(r.polls, 3);
});

test('waitUntil changed: 无 baseline 时第一帧作基准', async () => {
  const cond: WaitCondition = { kind: 'changed', intervalMs: 400, threshold: 0.005 };
  const r = await waitUntil(cond, 10000, seqDeps([frame(10), frame(10), frame(220)]));
  assert.equal(r.outcome, 'met');
  assert.equal(r.polls, 3);
});

test('waitUntil changed: 始终不变 → timeout', async () => {
  const cond: WaitCondition = { kind: 'changed', intervalMs: 400, threshold: 0.005 };
  const r = await waitUntil(cond, 1000, seqDeps([frame(10)], { baseline: frame(10) }));
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.lastDiff, 0);
});

test('waitUntil element_present / element_absent', async () => {
  const target = { ref: 'e1' };
  let calls = 0;
  const present = await waitUntil(
    { kind: 'element_present', intervalMs: 200, target },
    10000,
    seqDeps([frame(0)], { elementExists: async () => ++calls >= 3 }),
  );
  assert.equal(present.outcome, 'met');
  assert.equal(present.polls, 3);

  calls = 0;
  const absent = await waitUntil(
    { kind: 'element_absent', intervalMs: 200, target },
    10000,
    seqDeps([frame(0)], { elementExists: async () => ++calls < 2 }),
  );
  assert.equal(absent.outcome, 'met');
  assert.equal(absent.polls, 2);

  const never = await waitUntil(
    { kind: 'element_present', intervalMs: 200, target },
    600,
    seqDeps([frame(0)], { elementExists: async () => false }),
  );
  assert.equal(never.outcome, 'timeout');
});

test('waitUntil: abort 立即返回 aborted,不再继续轮询', async () => {
  const ac = new AbortController();
  let captures = 0;
  const deps = seqDeps([frame(0)], {
    signal: ac.signal,
    captureFrame: async () => {
      captures++;
      if (captures === 2) ac.abort();
      return frame(captures % 2 ? 0 : 255);
    },
  });
  const r = await waitUntil(STABLE, 10000, deps);
  assert.equal(r.outcome, 'aborted');
  assert.equal(captures, 2);

  const pre = new AbortController();
  pre.abort();
  const r2 = await waitUntil(STABLE, 10000, seqDeps([frame(0)], { signal: pre.signal }));
  assert.equal(r2.outcome, 'aborted');
  assert.equal(r2.polls, 0);
});

test('pickTypeMethod: 阈值 200、换行、显式 method 优先', () => {
  assert.equal(pickTypeMethod('hello'), 'keys');
  assert.equal(pickTypeMethod('a'.repeat(200)), 'keys');
  assert.equal(pickTypeMethod('a'.repeat(201)), 'paste');
  assert.equal(pickTypeMethod('line1\nline2'), 'paste');
  assert.equal(pickTypeMethod('line1\r\nline2'), 'paste');
  assert.equal(pickTypeMethod('a'.repeat(500), 'keys'), 'keys');
  assert.equal(pickTypeMethod('hi', 'paste'), 'paste');
});
