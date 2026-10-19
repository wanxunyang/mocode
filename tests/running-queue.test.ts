// 运行态「消息预加载/排队」状态机的初始契约测试。
// 键盘处理(onRunningKey)与 TTY/布局强绑定、不便在无 stdin 的测试里驱动;
// 这里验证可导出的队列存取:初始为空、多条按 FIFO 入队/消费、消费同步更新剩余条数、
// 撤空返回 null。键盘入队/Ctrl+C 撤回逻辑由手动交互覆盖。
//
// 测试形态:TS 源码编译到 dist-tests/ 后用 node --test 跑;不触盘、不读 stdin
// (enqueueQueuedTurn 同步状态行 chip,但无激活布局时 drawStatusBar 直接 return)。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeQueuedTurn,
  enqueueQueuedTurn,
  queuedTurnCount,
  getRunningInput,
  clearRunningInput,
} from '../src/repl/running-input.js';

test('初始无排队消息,消费返回 null 且可重复调用', () => {
  assert.equal(queuedTurnCount(), 0);
  assert.equal(consumeQueuedTurn(), null);
  assert.equal(consumeQueuedTurn(), null);
});

test('多条排队按 FIFO 入队/消费,条数随消费递减', () => {
  enqueueQueuedTurn('第一条', 'auto');
  enqueueQueuedTurn('第二条', 'plan');
  enqueueQueuedTurn('第三条', 'auto');
  assert.equal(queuedTurnCount(), 3);

  const first = consumeQueuedTurn();
  assert.equal(first?.text, '第一条');
  assert.equal(first?.mode, 'auto');
  assert.equal(queuedTurnCount(), 2);

  const second = consumeQueuedTurn();
  assert.equal(second?.text, '第二条');
  assert.equal(second?.mode, 'plan');
  assert.equal(queuedTurnCount(), 1);

  const third = consumeQueuedTurn();
  assert.equal(third?.text, '第三条');
  assert.equal(queuedTurnCount(), 0);
  assert.equal(consumeQueuedTurn(), null);
});

test('每条排队消息各自快照入队时的模式', () => {
  enqueueQueuedTurn('a', 'auto');
  enqueueQueuedTurn('b', 'plan');
  assert.equal(consumeQueuedTurn()?.mode, 'auto');
  assert.equal(consumeQueuedTurn()?.mode, 'plan');
});

test('typeahead 草稿槽清空幂等', () => {
  clearRunningInput();
  assert.equal(getRunningInput(), '');
  clearRunningInput();
  assert.equal(getRunningInput(), '');
});
