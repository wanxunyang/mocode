import test from 'node:test';
import assert from 'node:assert/strict';
import { discardableDraftIds, isEmptyDraft } from '../../packages/work-app/src/task-draft.js';

/**
 * 「空草稿任务」的判定。用户报的症状：点「+」开了一个新任务，转头切去别的会话，
 * 空间下面永久留下一条空的「新任务」。
 *
 * 这里钉的是判据本身，尤其是那条安全闸：`user_message`（只推 updatedAt）与 `run`
 * （才推到 running）是两条 IPC，中间任何一次清理都不能把指令已提交的任务当草稿删掉。
 */

const AT = '2026-11-17T08:00:00.000Z';

const draft = (overrides: Partial<Parameters<typeof isEmptyDraft>[0]> = {}) => ({
  id: 'draft',
  status: 'queued',
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

test('isEmptyDraft：queued + 无 session + 从未被写过 = 空草稿', () => {
  assert.equal(isEmptyDraft(draft()), true);
});

test('isEmptyDraft：已有 sessionId 的空任务不算草稿（例如失联的旧任务）', () => {
  assert.equal(isEmptyDraft(draft({ sessionId: '20261117-080000-000-aaaaaaaa' })), false);
});

test('isEmptyDraft：状态已不是 queued 就不算草稿', () => {
  for (const status of ['running', 'waiting', 'completed', 'failed', 'cancelled']) {
    assert.equal(isEmptyDraft(draft({ status })), false, status);
  }
});

test('isEmptyDraft：消息已提交（updatedAt > createdAt）就不算草稿', () => {
  // 渲染层点发送时先发 user_message 推 updatedAt，随后才发 run 把状态推成 running。
  // 这中间的瞬间必须保住这条任务，否则那条指令会被静默丢掉。
  assert.equal(isEmptyDraft(draft({ updatedAt: '2026-11-17T08:00:01.000Z' })), false);
});

test('isEmptyDraft：时间戳缺失或不可解析时不删（没有证据不动数据）', () => {
  assert.equal(isEmptyDraft(draft({ createdAt: '', updatedAt: '' })), false);
  assert.equal(isEmptyDraft(draft({ createdAt: 'not-a-date', updatedAt: 'not-a-date' })), false);
});

test('discardableDraftIds：丢掉除 keepId 外的所有空草稿', () => {
  const tasks = [
    draft({ id: 'a' }),
    draft({ id: 'b' }),
    draft({ id: 'live', sessionId: '20261117-080000-000-aaaaaaaa', status: 'completed' }),
    draft({ id: 'submitted', updatedAt: '2026-11-17T08:00:01.000Z' }),
  ];
  assert.deepEqual(discardableDraftIds(tasks), ['a', 'b']);
  assert.deepEqual(discardableDraftIds(tasks, 'b'), ['a']);
  assert.deepEqual(discardableDraftIds(tasks, 'a'), ['b']);
});

test('discardableDraftIds：没有草稿时返回空数组', () => {
  assert.deepEqual(discardableDraftIds([draft({ id: 'x', status: 'completed' })]), []);
  assert.deepEqual(discardableDraftIds([]), []);
});
