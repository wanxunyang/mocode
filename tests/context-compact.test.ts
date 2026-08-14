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

test('compactHistory force: 全在保护区也强压(首轮/当前轮不豁免)', async () => {
  // 首轮形态:user + assistant(tool_calls) + tool;窗口给大,常规切分全进保护区(oldGroups 空)。
  // force 必须只保最后一组、摘要其余,而不是 noop-protected。
  const history: ChatMessage[] = [system(), { role: 'user', content: 'fix the bug' } as ChatMessage];
  appendTool(history, 'read_file', 'big-read', { path: 'src/a.ts' }, 'x'.repeat(30_000));
  let summarizedRoles: string[] = [];
  const result = await compactHistory(history, {
    window: 1_000_000,
    threshold: 100,
    force: true,
    contextState: createContextState(),
    summarize: async (older) => {
      summarizedRoles = older.map((message) => message.role);
      return 'first turn summary';
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(result.summarized, true);
  assert.equal(result.historyRebuilt, true);
  assert.deepEqual(summarizedRoles, ['user']);
  assert.equal(history[0].role, 'system');
  assert.match(contentAt(history, 1), /^# 会话摘要/);
  // 最后一组(assistant+tool)原样保留且配对完整
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'big-read'));
  assertToolCallsHaveProducers(history);
});
