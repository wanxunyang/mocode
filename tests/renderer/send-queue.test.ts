import test from 'node:test';
import assert from 'node:assert/strict';
import { SendQueue } from '../../packages/work-app/src/renderer/send-queue.js';

/**
 * work-app 的发送队列是纯逻辑（无 DOM / 无 Electron），所以能在这里直接测。
 * 它替换了旧的「运行中点发送 = 取消当前运行」行为，错了会吞掉用户输入，值得钉住。
 */
test('SendQueue: 同一任务 FIFO，跨任务互不干扰', () => {
  const queue = new SendQueue<string>();
  assert.equal(queue.enqueue('a', 'first'), 1);
  assert.equal(queue.enqueue('a', 'second'), 2);
  assert.equal(queue.enqueue('b', 'other'), 1, 'B 任务独立计数');
  assert.equal(queue.totalSize(), 3);

  assert.equal(queue.dequeue('a')?.payload, 'first');
  assert.equal(queue.dequeue('a')?.payload, 'second');
  assert.equal(queue.dequeue('a'), undefined, '空队列返回 undefined');
  assert.equal(queue.size('a'), 0);
  assert.equal(queue.size('b'), 1, '出队 A 不影响 B');
});

test('SendQueue: 出队顺序号单调递增（用于「第 n 条」文案）', () => {
  const queue = new SendQueue<string>();
  queue.enqueue('a', 'x');
  const first = queue.dequeue('a');
  queue.enqueue('a', 'y');
  const second = queue.dequeue('a');
  assert.ok(first && second);
  assert.ok(second.seq > first.seq);
});

test('SendQueue: clear 返回丢弃条数，清空后 size 归零', () => {
  const queue = new SendQueue<string>();
  queue.enqueue('a', '1');
  queue.enqueue('a', '2');
  assert.equal(queue.clear('a'), 2, '丢弃条数必须可观测——静默丢用户输入不可接受');
  assert.equal(queue.size('a'), 0);
  assert.equal(queue.clear('a'), 0, '重复 clear 不报错');
  assert.equal(queue.dequeue('a'), undefined);
});

test('SendQueue: snapshot 按 FIFO 返回且不泄漏内部数组', () => {
  const queue = new SendQueue<string>();
  queue.enqueue('a', 'first');
  queue.enqueue('a', 'second');
  const snapshot = queue.snapshot('a');
  assert.deepEqual(
    snapshot.map((item) => item.payload),
    ['first', 'second'],
    '排队面板按入队顺序展示',
  );

  // 面板只能读：改快照不能改队列（否则渲染层一次误改就吞掉用户的排队消息）。
  snapshot.pop();
  snapshot.push({ seq: 99, payload: 'injected' });
  assert.equal(queue.size('a'), 2);
  assert.deepEqual(
    queue.snapshot('a').map((item) => item.payload),
    ['first', 'second'],
  );
  assert.deepEqual(queue.snapshot('missing'), [], '没有队列的任务返回空数组');
});
