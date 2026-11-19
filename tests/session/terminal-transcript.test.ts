import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../../src/llm/index.js';
import { compactHistory, createContextState } from '../../src/session/compact.js';
import { planRetention, runRetention } from '../../src/session/retention.js';
import { SessionStore } from '../../src/session/store.js';
import {
  createTerminalTranscript,
  createTerminalTurn,
  rollbackTerminalTranscript,
  TERMINAL_TRANSCRIPT_FILE,
} from '../../src/session/terminal-transcript.js';

test('TUI 保留压缩移出的正文、工具和转向消息，分叉及归档后仍可回放', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-terminal-transcript-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261001-130000-000-deadbeef';
  try {
    const olderText = '这里是会被压缩的完整回复。' + '待保留的文字'.repeat(500);
    const first = createTerminalTurn('先查看文件');
    first.addText(olderText);
    first.addTool({ id: 'call-read', name: 'read_file', arguments: '{"path":"target.js"}' }, '文件结果');
    first.addUser('请继续');
    first.addText('收尾正文');
    const second = createTerminalTurn('下一轮');
    second.compacted();
    second.addText('最新正文');
    const transcript = createTerminalTranscript([{ role: 'system', content: '模型私有系统提示' }]);
    transcript.turns.push({ turnId: 4, messages: first.messages }, { turnId: 5, messages: second.messages });

    const modelHistory: ChatMessage[] = [
      { role: 'system', content: '模型私有系统提示' },
      ...first.messages,
      { role: 'user', content: '下一轮' },
      { role: 'assistant', content: '最新正文' },
    ];
    const result = await compactHistory(modelHistory, {
      window: 300,
      threshold: 100,
      force: true,
      contextState: createContextState(),
      summarize: async () => '旧轮摘要',
    });
    assert.equal(result.historyRebuilt, true);
    assert.ok(!modelHistory.some((message) => message.content === olderText));
    store.save(modelHistory, id);
    store.saveTerminalTranscript(id, transcript);
    const savedModel = readFileSync(join(root, id, 'session.json'), 'utf8');
    assert.ok(!savedModel.includes(olderText));
    assert.equal(store.loadTerminalTranscript(id)?.turns[0].messages[1].content, olderText);
    assert.ok(!JSON.stringify(store.loadTerminalTranscript(id)).includes('模型私有系统提示'));
    const fork = store.forkSession(id);
    assert.ok(fork);
    assert.deepEqual(store.loadTerminalTranscript(fork), transcript);

    const now = Date.now();
    const stale = new Date(now - 45 * 86_400_000);
    utimesSync(join(root, id, 'session.json'), stale, stale);
    await runRetention(root, planRetention(root, undefined, now), now);
    assert.deepEqual(store.loadTerminalTranscript(id), transcript);
    assert.equal(
      store.load(id)?.history.some((message) => message.content === olderText),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回滚按被撤销的第一轮截断，保留比快照窗口更老的回复', () => {
  const transcript = createTerminalTranscript([{ role: 'user', content: '旧会话' }]);
  transcript.turns.push(
    { turnId: 2, messages: createTerminalTurn('早已移出快照窗口').messages },
    { turnId: 10, messages: createTerminalTurn('要撤销的第一轮').messages },
    { turnId: 11, messages: createTerminalTurn('随后撤销').messages },
  );
  assert.deepEqual(rollbackTerminalTranscript(transcript, 10, []).turns, transcript.turns.slice(0, 1));
  assert.deepEqual(rollbackTerminalTranscript(transcript, 1, []).turns, []);
});

test('恢复记录保留图片文件名与类型，坏记录回退而不保留图片原字节', () => {
  const turn = createTerminalTurn(
    [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,PRIVATE_IMAGE_BYTES' } }],
    ['screen.jpg'],
  );
  const serialized = JSON.stringify(turn.messages);
  assert.match(serialized, /screen\.jpg/);
  assert.match(serialized, /image\/jpeg/);
  assert.doesNotMatch(serialized, /PRIVATE_IMAGE_BYTES/);
  const root = mkdtempSync(join(tmpdir(), 'mocode-terminal-invalid-'));
  const store = new SessionStore({ sessionsRoot: root });
  const id = '20261001-140000-000-deadbeef';
  try {
    store.saveTerminalTranscript(id, { base: [], turns: [] });
    writeFileSync(join(root, id, TERMINAL_TRANSCRIPT_FILE), '{"base":[null],"turns":[]}');
    assert.equal(store.loadTerminalTranscript(id), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
