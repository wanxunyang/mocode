/** read_file 重复读短路 scope 测试(#token-efficiency P2)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadDedup } from '../src/tools/read-dedup.js';

test('record + find: 同区间(或覆盖区间)同 hash 命中', () => {
  const dedup = createReadDedup();
  dedup.beginStep(0);
  dedup.record('a.ts', 1, 300, 'h1');

  assert.deepEqual(dedup.findUnchanged('a.ts', 1, 300, 'h1'), { step: 0, hash: 'h1' });
  // 请求区间被已读区间覆盖。
  assert.deepEqual(dedup.findUnchanged('a.ts', 50, 120, 'h1'), { step: 0, hash: 'h1' });
});

test('不命中: 不同 hash / 区间超出 / 路径不同', () => {
  const dedup = createReadDedup();
  dedup.beginStep(1);
  dedup.record('a.ts', 1, 100, 'h1');

  assert.equal(dedup.findUnchanged('a.ts', 1, 100, 'h2'), null);
  assert.equal(dedup.findUnchanged('a.ts', 90, 130, 'h1'), null);
  assert.equal(dedup.findUnchanged('b.ts', 1, 100, 'h1'), null);
  assert.equal(dedup.findUnchanged('a.ts', 101, 200, 'h1'), null);
});

test('trim 变更内容后全部失活(hot=false), 新读取恢复命中', () => {
  const dedup = createReadDedup();
  dedup.beginStep(2);
  dedup.record('a.ts', 1, 100, 'h1');

  dedup.markContextChanged();
  assert.equal(dedup.findUnchanged('a.ts', 1, 100, 'h1'), null);

  dedup.beginStep(3);
  dedup.record('a.ts', 1, 100, 'h1');
  assert.deepEqual(dedup.findUnchanged('a.ts', 1, 100, 'h1'), { step: 3, hash: 'h1' });
});

test('命中展示记录时的 step(不更新为当前 step)', () => {
  const dedup = createReadDedup();
  dedup.beginStep(7);
  dedup.record('a.ts', 1, 10, 'h');
  dedup.beginStep(9);
  assert.equal(dedup.findUnchanged('a.ts', 1, 10, 'h')?.step, 7);
});

test('每路径区间数封顶, 旧区间被淘汰', () => {
  const dedup = createReadDedup();
  dedup.beginStep(0);
  for (let i = 0; i < 8; i++) dedup.record('a.ts', i * 10 + 1, i * 10 + 10, 'h');
  assert.equal(dedup.findUnchanged('a.ts', 1, 10, 'h'), null);
  assert.ok(dedup.findUnchanged('a.ts', 71, 80, 'h'));
});
