/** compactHistory 单元测试(从 scripts/core-tests/compact.test.ts 迁移到 node:test)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/llm/index.js';
import { compactHistory, createContextState } from '../src/session/compact.js';
import { appendTool, contentAt, system } from './helpers.js';

function compactableHistory(): { history: ChatMessage[]; oldIdx: number } {
  const history: ChatMessage[] = [system('current system')];
  const oldIdx = appendTool(history, 'read_file', 'old-read', { path: 'src/old.ts' }, 'x'.repeat(2_000));
  history.push({ role: 'user', content: 'continue' } as ChatMessage);
  appendTool(history, 'run_command', 'latest', { command: 'echo ok' }, 'ok');
  return { history, oldIdx };
}

function assertToolCallsHaveProducers(history: ChatMessage[]): void {
  const seen = new Set<string>();
  for (const message of history) {
    if (message.role === 'assistant') {
      const calls = (message as { tool_calls?: { id?: string }[] }).tool_calls ?? [];
      for (const call of calls) if (call.id) seen.add(call.id);
    }
    if (message.role === 'tool') {
      const id = (message as { tool_call_id?: string }).tool_call_id;
      assert.ok(id && seen.has(id), `orphan tool result: ${id ?? '<missing id>'}`);
    }
  }
}

test('compactHistory 原地摘要并保持尾部 tool-call group 完整', async () => {
  const { history } = compactableHistory();
  const originalRef = history;
  let summarizedIds: string[] = [];
  const state = createContextState();
  const result = await compactHistory(history, {
    window: 100,
    threshold: 100,
    contextState: state,
    summarize: async (older) => {
      summarizedIds = older
        .filter((message) => message.role === 'tool')
        .map((message) => (message as { tool_call_id?: string }).tool_call_id ?? '');
      return 'old work summary';
    },
  });

  assert.equal(history, originalRef);
  assert.equal(result.compacted, true);
  assert.equal(result.summarized, true);
  assert.equal(result.historyRebuilt, true);
  assert.deepEqual(summarizedIds, ['old-read']);
  assert.equal(history[0].role, 'system');
  assert.match(contentAt(history, 1), /^# 会话摘要/);
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'latest'));
  assert.ok(!history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'old-read'));
  assertToolCallsHaveProducers(history);
  assert.equal(state.correction, 1);
});

test('compactHistory 摘要失败时安全回退微压缩且不改结构', async () => {
  const { history, oldIdx } = compactableHistory();
  const rolesBefore = history.map((message) => message.role);
  const result = await compactHistory(history, {
    window: 100,
    threshold: 100,
    contextState: createContextState(),
    summarize: async () => null,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summarized, false);
  assert.equal(result.reason, 'microcompact');
  assert.deepEqual(history.map((message) => message.role), rolesBefore);
  assert.ok(contentAt(history, oldIdx).length < 2_000);
  assertToolCallsHaveProducers(history);
});

test('compactHistory 对全保护区返回 noop 且不调用摘要器', async () => {
  const history: ChatMessage[] = [system(), { role: 'user', content: 'current turn' } as ChatMessage];
  let called = false;
  const result = await compactHistory(history, {
    window: 100_000,
    threshold: 100,
    contextState: createContextState(),
    summarize: async () => {
      called = true;
      return 'unexpected';
    },
  });
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'noop-protected');
  assert.equal(called, false);
});

test('compactHistory force: 单 user + 单 tool 组时保 user 不压(noop)', async () => {
  // 首轮形态:user + assistant(tool_calls) + tool;窗口给大,常规切分全进保护区。
  // force 旧实现把 user 丢进摘要 → 重建后 history 无 user → 下一轮 400。
  // 修复后:force 保留最早 user,此时无中间旧区可压 → noop-protected(不丢 user)。
  const history: ChatMessage[] = [system(), { role: 'user', content: 'fix the bug' } as ChatMessage];
  appendTool(history, 'read_file', 'big-read', { path: 'src/a.ts' }, 'x'.repeat(30_000));
  let summarizeCalled = false;
  const result = await compactHistory(history, {
    window: 1_000_000,
    threshold: 100,
    force: true,
    contextState: createContextState(),
    summarize: async () => {
      summarizeCalled = true;
      return 'should not be called';
    },
  });
  // 只有 2 组(user + tool),保留 user 后无旧区 → noop,不调摘要器
  assert.equal(summarizeCalled, false);
  // user 必须还在 history 中
  assert.ok(
    history.some((m) => m.role === 'user' && (m as { content?: unknown }).content === 'fix the bug'),
    'earliest user message must survive force compaction',
  );
  // tool 也在
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'big-read'));
  assertToolCallsHaveProducers(history);
});

test('compactHistory force: 多轮 history 必须保留最早 user 所在 group(防 400)', async () => {
  // 多轮 history:user1 + tool1 + user2 + tool2;窗口给大,常规切分全进保护区。
  // force 旧实现把所有 user 丢进摘要 → 重建后 history 无 user → LLM API 报 400。
  // 修复后 force 必须保留最早 user 所在 group。
  const history: ChatMessage[] = [system()];
  history.push({ role: 'user', content: 'first request' } as ChatMessage);
  appendTool(history, 'read_file', 'read-1', { path: 'a.ts' }, 'content-a');
  history.push({ role: 'user', content: 'second request' } as ChatMessage);
  appendTool(history, 'read_file', 'read-2', { path: 'b.ts' }, 'content-b');
  let summarizedRoles: string[] = [];
  const result = await compactHistory(history, {
    window: 1_000_000,
    threshold: 100,
    force: true,
    contextState: createContextState(),
    summarize: async (older) => {
      summarizedRoles = older.map((message) => message.role);
      return 'multi-turn summary';
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(result.summarized, true);
  assert.equal(result.historyRebuilt, true);
  // 最早 user (first request) 必须保留在重建后的 history 中
  assert.ok(
    history.some((m) => m.role === 'user' && (m as { content?: unknown }).content === 'first request'),
    'earliest user message must survive force compaction',
  );
  // 最后一组 tool 也必须保留
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'read-2'));
  assertToolCallsHaveProducers(history);
});
