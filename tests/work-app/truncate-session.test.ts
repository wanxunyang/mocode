import test from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateSessionAfterUser,
  truncateSessionAtUser,
  type RawSessionRecord,
} from '../../packages/work-app/src/truncate-session.js';

/**
 * 分叉的边界条件（truncateSessionAfterUser）是「保留到第 N 轮结束」，与回滚的
 * 「砍掉第 N 轮及之后」只差一条边界 —— 而这条边界错了不会报错，只会让新分支多带
 * 或少带一整轮对话。所以两条都钉在这里，尤其要钉住合成 user 消息不占轮次。
 */

const MESSAGES = { noHistory: 'no-history', compacted: 'compacted' };

/** 一条 [user, assistant] 的对话轮，外加可选的工具往返。 */
function turn(text: string): Array<Record<string, unknown>> {
  return [
    { role: 'user', content: text },
    { role: 'assistant', content: `answer to ${text}` },
  ];
}

function record(history: Array<Record<string, unknown>>, queryHistory: string[] = []): RawSessionRecord {
  return { history, queryHistory, lastToolGroups: [], firstUser: '' };
}

test('truncateSessionAfterUser：保留目标轮（含其回答），丢掉之后的轮次', () => {
  const rec = record([...turn('q1'), ...turn('q2'), ...turn('q3')], ['q1', 'q2', 'q3']);
  const result = truncateSessionAfterUser(rec, 1, MESSAGES);
  assert.equal(result.ok, true);
  // 第 0 轮与第 1 轮都在，第 2 轮整轮消失。
  assert.deepEqual(
    rec.history.map((m) => m.content),
    ['q1', 'answer to q1', 'q2', 'answer to q2'],
  );
  // queryHistory 与 user 消息一一对应，留到第 1 条（含）。
  assert.deepEqual(rec.queryHistory, ['q1', 'q2']);
});

test('truncateSessionAfterUser：最后一轮分叉 = 整段保留', () => {
  const rec = record([...turn('q1'), ...turn('q2')], ['q1', 'q2']);
  const result = truncateSessionAfterUser(rec, 1, MESSAGES);
  assert.equal(result.ok, true);
  assert.equal(rec.history.length, 4);
  assert.deepEqual(rec.queryHistory, ['q1', 'q2']);
});

test('truncateSessionAfterUser：一轮里的工具往返跟着这一轮一起保留', () => {
  const rec = record(
    [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file body' },
      { role: 'assistant', content: 'answer to q1' },
      ...turn('q2'),
    ],
    ['q1', 'q2'],
  );
  const result = truncateSessionAfterUser(rec, 0, MESSAGES);
  assert.equal(result.ok, true);
  // 整轮的四条（user / tool_call / tool / 总结）都要在，q2 那条 user 不能带过来。
  assert.equal(rec.history.length, 4);
  assert.equal(rec.history[3]!.content, 'answer to q1');
  assert.deepEqual(rec.queryHistory, ['q1']);
});

test('truncateSessionAfterUser：合成 user 消息（工具附件 / 剪枝占位）不算一轮', () => {
  const attachmentPreamble = 'The read_file tool loaded the following visual input: ';
  const rec = record(
    [
      { role: 'user', content: 'q1' },
      { role: 'user', content: [{ type: 'text', text: `${attachmentPreamble}image.png`, attachment: true }] },
      { role: 'assistant', content: 'answer to q1' },
      { role: 'user', content: '[screenshot omitted: screen · step 3]' },
      ...turn('q2'),
    ],
    ['q1', 'q2'],
  );
  const result = truncateSessionAfterUser(rec, 0, MESSAGES);
  assert.equal(result.ok, true);
  // 第 0 轮的真实边界是 q1..answer to q1；两条合成消息都属于这一轮的尾部（它们都在 q2 之前）。
  assert.equal(rec.history.length, 4);
  assert.deepEqual(rec.queryHistory, ['q1']);
});

test('truncateSessionAfterUser：越界索引报错且不改动记录', () => {
  const history = [...turn('q1')];
  const rec = record(history, ['q1']);
  for (const index of [-1, 1, 99, 0.5, Number.NaN]) {
    const result = truncateSessionAfterUser(rec, index, MESSAGES);
    assert.equal(result.ok, false, `index=${index} 应当失败`);
    assert.equal(result.message, 'compacted');
    assert.equal(rec.history.length, 2);
    assert.deepEqual(rec.queryHistory, ['q1']);
  }
});

test('truncateSessionAfterUser：history 缺失时报 noHistory', () => {
  const result = truncateSessionAfterUser({} as RawSessionRecord, 0, MESSAGES);
  assert.equal(result.ok, false);
  assert.equal(result.message, 'no-history');
});

test('两条截断互补：回滚到 N 之前 + 分叉到 N 之后 = 原会话不重不漏', () => {
  const before = record([...turn('q1'), ...turn('q2'), ...turn('q3')], ['q1', 'q2', 'q3']);
  const after = record([...turn('q1'), ...turn('q2'), ...turn('q3')], ['q1', 'q2', 'q3']);
  assert.equal(truncateSessionAtUser(before, 1, MESSAGES).ok, true);
  assert.equal(truncateSessionAfterUser(after, 1, MESSAGES).ok, true);
  // 回滚保留第 1 轮之前的 1 轮；分叉保留到第 1 轮结束的 2 轮。
  assert.deepEqual(
    before.history.map((m) => m.content),
    ['q1', 'answer to q1'],
  );
  assert.deepEqual(
    after.history.map((m) => m.content),
    ['q1', 'answer to q1', 'q2', 'answer to q2'],
  );
});
