import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCommitMessage, generateCommitMessage } from '../../src/host/commit-message.js';
import type { ChatTransport } from '../../src/llm/index.js';

test('提交信息清理 Markdown 围栏与外围引号', () => {
  assert.equal(
    cleanCommitMessage('```text\nfeat: add source control\n\n- stage files\n```'),
    'feat: add source control\n\n- stage files',
  );
  assert.equal(cleanCommitMessage('  "fix: preserve drafts"  '), 'fix: preserve drafts');
  assert.equal(cleanCommitMessage('feat: plain message\n\n正文'), 'feat: plain message\n\n正文');
  assert.equal(cleanCommitMessage('```diff\n+not a commit message'), '```diff\n+not a commit message');
});

test('AI 生成只发两条无工具消息，不进入任务 history', async () => {
  let calls = 0;
  const transport: ChatTransport = async (messages, handlers, signal, tools, overrides) => {
    calls += 1;
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[1]?.role, 'user');
    const prompt = messages[1]?.content;
    assert.equal(typeof prompt, 'string');
    assert.match(String(prompt), /\+staged/);
    assert.match(String(prompt), /src\/a.ts/);
    assert.ok(!String(prompt).includes('+unstaged'));
    assert.deepEqual(handlers, {});
    assert.equal(signal, undefined);
    assert.deepEqual(tools, []);
    assert.equal(overrides?.maxAttempts, 3);
    return { content: '```text\nfeat: add staged diff\n```', toolCalls: [] };
  };
  const result = await generateCommitMessage(
    {
      diff: '+staged',
      stat: 'src/a.ts | 1 +',
      files: ['src/a.ts'],
      truncated: true,
      language: 'en-US',
    },
    transport,
  );
  assert.equal(result, 'feat: add staged diff');
  assert.equal(calls, 1);
});

test('取消信号原样传到 transport，避免关闭面板后继续重试', async () => {
  const controller = new AbortController();
  const transport: ChatTransport = async (_messages, _handlers, signal) => {
    assert.equal(signal, controller.signal);
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const pending = generateCommitMessage(
    { diff: '+x', stat: 'a.ts | 1 +', files: ['a.ts'] },
    transport,
    controller.signal,
  );
  controller.abort(new DOMException('Panel closed.', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('模型空响应会失败，不产生空提交信息', async () => {
  const transport: ChatTransport = async () => ({ content: '```\n\n```', toolCalls: [] });
  await assert.rejects(
    generateCommitMessage({ diff: '+x', stat: 'a.ts | 1 +', files: ['a.ts'], language: 'zh-CN' }, transport),
    /模型没有返回提交信息/,
  );
});
