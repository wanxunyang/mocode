// 运行态「消息预加载/排队」状态机的初始契约测试。
// 键盘处理(onRunningKey)与 TTY/布局强绑定、不便在无 stdin 的测试里驱动;
// 这里验证可导出的队列存取初始为空且消费幂等——键盘入队逻辑由手动交互覆盖。
//
// 测试形态:TS 源码编译到 dist-tests/ 后用 node --test 跑;不触盘、不读 stdin。

import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeQueuedTurn, getRunningInput, clearRunningInput } from '../src/repl/running-input.js';

test('初始无排队消息,消费返回 null 且可重复调用', () => {
  assert.equal(consumeQueuedTurn(), null);
  assert.equal(consumeQueuedTurn(), null);
});

test('typeahead 草稿槽清空幂等', () => {
  clearRunningInput();
  assert.equal(getRunningInput(), '');
  clearRunningInput();
  assert.equal(getRunningInput(), '');
});
