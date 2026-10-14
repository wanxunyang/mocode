// /rollback 切点对齐回归测试。
//
// 历史 bug:回滚菜单的轮次按 beginTurn 计数(rollback store 的 turns),
// 而消息切点 findCutoffIndex 按 history 里 role==='user' 计数。两者在以下情况错位,
// 导致"回退一条却连带删掉好几轮真实对话":
//   1. 工具经 modelAttachments 注入的合成 user 消息(computer/screenshot 回灌截图);
//   2. 超过 MAX_SNAPSHOT_TURNS 后 turns 只保留最近 N 条(滚动剪枝),history 却仍是全量;
//   3. /compact 压缩后 turns 尾部对齐收缩,且 user 逐字通道会保留非连续老 user 原文。
// 另外 /resume 无 snapshots.json 时的 rebuildFromHistory 也会把合成消息错算成轮次。
//
// 测试形态:TS 源码编译到 dist-tests/ 后用 node --test 跑;纯内存,不触盘不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { ChatMessage } from '../src/llm/index.js';
import { ATTACHMENT_PREAMBLE } from '../src/agent/tool-turn.js';
import { RollbackStore } from '../src/rollback/store.js';

function user(text: string): ChatMessage {
  return { role: 'user', content: text } as ChatMessage;
}

function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text } as ChatMessage;
}

/** 工具经 modelAttachments 注入的合成 user 消息(tool-turn.ts 的形状)。 */
function attachmentUser(): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${ATTACHMENT_PREAMBLE}shot.png. Analyze the attached image content directly.` },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  } as ChatMessage;
}

/** 附件帧经视觉滑动窗口剪枝后的占位消息(前言已消失,只剩文本占位)。 */
function prunedFrameUser(hint = false): ChatMessage {
  const text =
    `[screenshot omitted: computer-result.png · step 12]` +
    (hint ? ' Call computer{screenshot} if you need the current screen.' : '');
  return { role: 'user', content: [{ type: 'text', text }] } as ChatMessage;
}

/** 用户自己发的多模态消息(无工具前言),必须算真实轮次。 */
function userWithOwnImage(text: string): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  } as ChatMessage;
}

function newStore(): RollbackStore {
  const root = mkdtempSync(path.join(tmpdir(), 'rollback-align-'));
  return new RollbackStore(root, root);
}

test('工具附件合成 user 消息不占轮次:回退最新轮只删该轮', () => {
  const store = newStore();
  store.beginTurn('T1');
  store.beginTurn('T2');
  store.beginTurn('T3');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('T1'),
    assistant('(调用截图工具)'),
    attachmentUser(), // 合成消息:role=user 但不是一个真实轮次
    assistant('图里看到…'),
    user('T2'),
    assistant('改好了'),
    user('T3'),
    assistant('完成'),
  ];

  // 菜单选第 3 项(picked=2):保前 2 轮,只删第 3 轮。
  const plan = store.planRollback(2, history);
  assert.equal(history[plan.cutoffIndex]?.content, 'T3', '切点必须落在 T3');
  const keptRealUsers = history
    .slice(0, plan.cutoffIndex)
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string);
  assert.deepEqual(keptRealUsers, ['T1', 'T2']);
  assert.equal(history.length - plan.cutoffIndex, 2, '只删 T3 + 其 assistant 共 2 条');
});

test('菜单第 2 轮切点不被前面的合成附件消息带偏', () => {
  const store = newStore();
  store.beginTurn('T1');
  store.beginTurn('T2');
  store.beginTurn('T3');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('T1'),
    attachmentUser(),
    assistant('a1'),
    user('T2'),
    assistant('a2'),
    user('T3'),
    assistant('a3'),
  ];
  const plan = store.planRollback(1, history);
  assert.equal(history[plan.cutoffIndex]?.content, 'T2');
});

test('滚动剪枝后(turns 为尾部子集)回退最新轮只删最新轮', () => {
  const store = newStore();
  // 模拟 beginTurn 超过窗口:直接构造 60 轮后 store 内部只留最近 N 条,
  // 这里用 MOCODE_MAX_SNAPSHOT_TURNS=2 触发同等效果更麻烦,改为直接按 50 条窗口构造:
  // 开 52 轮 → turns 只剩最近 50 条(turnId 3..52)。
  for (let i = 1; i <= 52; i++) store.beginTurn(`T${i}`);
  const history: ChatMessage[] = [{ role: 'system', content: 'sys' } as ChatMessage];
  for (let i = 1; i <= 52; i++) {
    history.push(user(`T${i}`));
    history.push(assistant(`a${i}`));
  }
  assert.equal(store.listTurns().length, 50, '滚动窗口只保留最近 50 轮');

  // 菜单最后一项(picked=49)= 第 52 轮,只删 T52。
  const plan = store.planRollback(49, history);
  assert.equal(history[plan.cutoffIndex]?.content, 'T52', '切点必须落在 T52,而不是被 offset 带前 2 轮');
  // 菜单第一项(picked=0)= turnId 3(T3),删 T3 及之后。
  const planFirst = store.planRollback(0, history);
  assert.equal(history[planFirst.cutoffIndex]?.content, 'T3');
});

test('压缩 + user 逐字通道保留非连续老原文时,尾部对齐仍正确', () => {
  const store = newStore();
  store.beginTurn('T58');
  store.beginTurn('T59');
  store.beginTurn('T60');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    { role: 'system', content: '# 会话摘要' } as ChatMessage,
    user('T5 老原文(逐字通道捞回)'), // 非连续保留的旧 user;不属于 turns 尾部三轮
    user('T58'),
    assistant('a58'),
    user('T59'),
    assistant('a59'),
    user('T60'),
    assistant('a60'),
  ];
  // 选最后一项 → 只删 T60;不能被前面多出来的 T5 原文带偏。
  const plan = store.planRollback(2, history);
  assert.equal(history[plan.cutoffIndex]?.content, 'T60');
  // 选第一项 → 删 T58;T5 原文在切点之前,继续保留。
  const planFirst = store.planRollback(0, history);
  assert.equal(history[planFirst.cutoffIndex]?.content, 'T58');
});

test('turnUserMessage 预填定位与菜单轮次一致(含合成消息)', () => {
  const store = newStore();
  store.beginTurn('T1');
  store.beginTurn('T2');
  store.beginTurn('T3');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('T1'),
    attachmentUser(),
    assistant('a1'),
    user('T2'),
    assistant('a2'),
    user('T3'),
    assistant('a3'),
  ];
  assert.equal(store.turnUserMessage(0, history)?.content, 'T1');
  assert.equal(store.turnUserMessage(1, history)?.content, 'T2');
  assert.equal(store.turnUserMessage(2, history)?.content, 'T3');
});

test('rebuildFromHistory 跳过工具附件合成 user 消息', () => {
  const store = newStore();
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('T1'),
    attachmentUser(),
    assistant('a1'),
    user('T2'),
    assistant('a2'),
  ];
  store.rebuildFromHistory(history);
  const turns = store.listTurns();
  assert.deepEqual(
    turns.map((t) => t.firstLine),
    ['T1', 'T2'],
  );
});

test('pruneAfterCompaction 只按真实用户轮计数', () => {
  const store = newStore();
  store.beginTurn('T1');
  store.beginTurn('T2');
  store.beginTurn('T3');
  // 压缩后 history 只剩 2 个真实轮 + 1 个合成附件 user。
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('T2'),
    attachmentUser(),
    assistant('a2'),
    user('T3'),
    assistant('a3'),
  ];
  store.pruneAfterCompaction(history);
  assert.equal(store.listTurns().length, 2, '合成附件消息不应让 turns 保留成 3 条');
});

test('视觉窗口剪枝后的占位消息不占轮次(前言已消失)', () => {
  const store = newStore();
  store.beginTurn('T1');
  store.beginTurn('T2');
  store.beginTurn('T3');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('T1'),
    assistant('(截图)'),
    prunedFrameUser(true), // 剪枝后:role=user,但只剩 "[screenshot omitted: …]" 占位
    assistant('a1'),
    user('T2'),
    assistant('a2'),
    user('T3'),
    assistant('a3'),
  ];
  // 选最后一项 → 只删 T3;占位消息不能被当成一个真实轮。
  const plan = store.planRollback(2, history);
  assert.equal(history[plan.cutoffIndex]?.content, 'T3');
  // 选第 2 项 → 删 T2。
  const planMid = store.planRollback(1, history);
  assert.equal(history[planMid.cutoffIndex]?.content, 'T2');
  // 预填定位同样跳过占位。
  assert.equal(store.turnUserMessage(0, history)?.content, 'T1');
  assert.equal(store.turnUserMessage(2, history)?.content, 'T3');

  // rebuild 也不能把占位算成轮次。
  const rebuilt = newStore();
  rebuilt.rebuildFromHistory(history);
  assert.deepEqual(
    rebuilt.listTurns().map((x) => x.firstLine),
    ['T1', 'T2', 'T3'],
  );
});

test('用户自己发的多模态消息算真实轮次', () => {
  const store = newStore();
  store.beginTurn('看看这张图');
  store.beginTurn('T2');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    userWithOwnImage('看看这张图'),
    assistant('好'),
    user('T2'),
    assistant('好2'),
  ];
  const msg = store.turnUserMessage(0, history);
  assert.equal(msg, history[1], '无工具前言的多模态 user 消息是真实轮次起点');
  const plan = store.planRollback(1, history);
  assert.equal(history[plan.cutoffIndex]?.content, 'T2');
});
