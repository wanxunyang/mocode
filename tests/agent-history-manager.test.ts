import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ToolCallRef } from '../src/llm/index.js';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { runAgentCore } from '../src/agent/core.js';
import { defaultAgentRuntimeContext } from '../src/agent/runtime-context.js';
import { createLegacyHistoryManager, createStagedHistoryManager } from '../src/agent/stages/history-manager.js';
import type { HistoryManager } from '../src/agent/stages/contracts.js';
import { createContextState } from '../src/session/compact.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
import '../src/tools/builtins/index.js';

function call(id: string, name = 'read_file'): ToolCallRef {
  return { id, name, arguments: '{}' };
}

function toolMessage(id: string, content = id): ChatMessage {
  return { role: 'tool', tool_call_id: id, content };
}

function appendToolAssistant(manager: HistoryManager, calls: readonly ToolCallRef[]): void {
  manager.appendAssistantTurn({ content: null, toolCalls: calls });
}

function sseStream(
  chunks: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>,
): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [] };
  })();
}

test('HistoryManager: checkpoint 浅拷贝、revision 与 backing identity 保持稳定', async () => {
  const system: ChatMessage = { role: 'system', content: 'sys' };
  const backing: ChatMessage[] = [system];
  const identity = backing;
  const manager = createStagedHistoryManager({ messages: backing });

  manager.appendUserTurn('first');
  const checkpoint = manager.createCheckpoint();
  const snapshot = manager.snapshot();
  assert.notEqual(checkpoint.messages, backing);
  assert.equal(checkpoint.messages[0], system, 'checkpoint 必须是 message 引用的浅拷贝');
  assert.equal(snapshot.revision, checkpoint.revision);

  manager.appendAssistantTurn({ content: 'discard', toolCalls: [] });
  manager.restore(checkpoint);
  assert.equal(backing, identity);
  assert.deepEqual(backing, [system, { role: 'user', content: 'first' }]);
  assert.ok(manager.snapshot().revision > checkpoint.revision);

  const replacement: ChatMessage[] = [system, { role: 'assistant', content: 'summary' }];
  manager.replaceAfterCompaction({ messages: replacement });
  assert.equal(backing, identity);
  assert.deepEqual(backing, replacement);

  const beforeBridge = manager.snapshot().revision;
  await manager.withLegacyMutableHistory((messages) => {
    (messages[1] as { content: string }).content = 'microcompact';
  });
  assert.equal(manager.snapshot().revision, beforeBridge + 1);
  assert.equal((backing[1] as { content: string }).content, 'microcompact');
});

test('HistoryManager: staged 按 provider 原序一次提交 results，attachment 严格后置', () => {
  const backing: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  const manager = createStagedHistoryManager({ messages: backing });
  const calls = [call('a'), call('b'), call('c')];
  appendToolAssistant(manager, calls);
  const transaction = manager.beginToolBatch(calls);

  transaction.workingMessages.push(toolMessage('a'));
  transaction.workingMessages.push(toolMessage('b'));
  transaction.workingMessages.push(toolMessage('c'));
  assert.deepEqual(
    backing.map((message) => message.role),
    ['system', 'assistant'],
    'commit 前 backing 不得看见任何部分 tool results',
  );

  const attachment: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'visual input' }] };
  transaction.commit(attachment);
  assert.deepEqual(
    backing.map((message) => message.role),
    ['system', 'assistant', 'tool', 'tool', 'tool', 'user'],
  );
  assert.deepEqual(
    backing.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ['a', 'b', 'c'],
  );
  assert.equal(backing.at(-1), attachment);
});

test('HistoryManager: staged 在 backing 变化前拒绝缺失、多余、乱序、重复和非法 attachment', async (t) => {
  const cases: Array<{
    name: string;
    calls?: ToolCallRef[];
    results: ChatMessage[];
    attachment?: ChatMessage;
    pattern: RegExp;
  }> = [
    { name: 'missing', results: [toolMessage('a')], pattern: /expected 2 result\(s\), received 1/ },
    {
      name: 'extra',
      results: [toolMessage('a'), toolMessage('b'), toolMessage('c')],
      pattern: /expected 2 result\(s\), received 3/,
    },
    { name: 'out of order', results: [toolMessage('b'), toolMessage('a')], pattern: /expected id a, received b/ },
    { name: 'duplicate result', results: [toolMessage('a'), toolMessage('a')], pattern: /duplicate result id: a/ },
    {
      name: 'non-user attachment',
      results: [toolMessage('a'), toolMessage('b')],
      attachment: { role: 'assistant', content: 'bad' },
      pattern: /attachment must be a user message/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const backing: ChatMessage[] = [{ role: 'system', content: 'sys' }];
      const manager = createStagedHistoryManager({ messages: backing });
      const calls = item.calls ?? [call('a'), call('b')];
      appendToolAssistant(manager, calls);
      const before = backing.slice();
      const transaction = manager.beginToolBatch(calls);
      transaction.workingMessages.push(...item.results);
      assert.throws(() => transaction.commit(item.attachment), item.pattern);
      assert.deepEqual(backing, before);
    });
  }

  await t.test('duplicate provider id', () => {
    const backing: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const manager = createStagedHistoryManager({ messages: backing });
    const calls = [call('a'), call('a')];
    const before = backing.slice();
    assert.throws(() => appendToolAssistant(manager, calls), /duplicate tool_call id: a/);
    assert.deepEqual(backing, before);
  });
});

test('HistoryManager: restore 会丢弃 active partial batch，不留下 orphan result', () => {
  for (const create of [createLegacyHistoryManager, createStagedHistoryManager]) {
    const backing: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const manager = create({ messages: backing });
    manager.appendUserTurn('turn');
    const checkpoint = manager.createCheckpoint();
    const calls = [call('a'), call('b')];
    appendToolAssistant(manager, calls);
    const transaction = manager.beginToolBatch(calls);
    transaction.workingMessages.push(toolMessage('a'));

    manager.restore(checkpoint);
    assert.deepEqual(
      backing.map((message) => message.role),
      ['system', 'user'],
    );
    transaction.rollback();
  }
});

test('HistoryManager: legacy/staged 的有效 transaction 最终 history 字节级一致', () => {
  const run = (create: typeof createLegacyHistoryManager): ChatMessage[] => {
    const backing: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const manager = create({ messages: backing });
    manager.appendUserTurn('turn');
    const calls = [call('a', 'one'), call('b', 'two')];
    appendToolAssistant(manager, calls);
    const transaction = manager.beginToolBatch(calls);
    transaction.workingMessages.push(toolMessage('a', 'first'), toolMessage('b', 'second'));
    transaction.commit({ role: 'user', content: 'attachment' });
    manager.appendAssistantTurn({ content: 'done', toolCalls: [] });
    return backing;
  };

  assert.deepEqual(run(createStagedHistoryManager), run(createLegacyHistoryManager));
});

test('runAgentCore staged: commit 前异常会回滚 shadow 并重建 artifact/lifecycle 索引', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-history-batch-failure-'));
  writeFileSync(join(root, 'a.txt'), 'artifact-a', 'utf8');
  writeFileSync(join(root, 'b.txt'), 'artifact-b', 'utf8');
  const previousRoot = setSandboxRoot(root);
  const runtimeContextState = createContextState();
  let toolResultCount = 0;

  __setChatCreateImpl(async () =>
    sseStream([
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'read-a', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
            { index: 1, id: 'read-b', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
          ],
        },
      },
    ]),
  );

  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const failure = new Error('host hook failed after first indexed result');
    await assert.rejects(
      runAgentCore({
        pipeline: 'staged',
        history,
        userInput: 'read both',
        maxSteps: 1,
        contextState: runtimeContextState,
        runtimeContext: {
          ...defaultAgentRuntimeContext,
          config: { ...defaultAgentRuntimeContext.config, contextLifecycle: true },
        },
        toolsOverride: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'read fixture',
              parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
          },
        ],
        runtimeAllowedToolNames: new Set(['read_file']),
        hooks: {
          onToolResult: () => {
            toolResultCount++;
            if (toolResultCount === 2) throw failure;
          },
        },
        suppressOpeningAnalysis: true,
        suppressSessionState: true,
      }),
      (error) => error === failure,
    );

    assert.deepEqual(
      history.map((message) => message.role),
      ['system', 'user', 'assistant'],
      '失败的 staged batch 不得发布部分 tool results',
    );
    assert.equal(runtimeContextState.artifactStats?.fresh, 0);
    assert.equal(runtimeContextState.lifecycleStats?.live, 0);
  } finally {
    __setChatCreateImpl(null);
    setSandboxRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAgentCore staged: 反序完成仍原序回灌，commit 前不可见，attachment checkpoint 完整保留', async () => {
  const { registerToolsExtension, clearToolsExtension } = await import('../src/tools/registry.js');
  const source = 'history-manager-atomic-test';
  const completed: string[] = [];
  registerToolsExtension(source, [
    {
      name: 'mcp__history_slow',
      description: 'slow history test tool',
      parameters: { type: 'object', properties: {} },
      capabilities: { effect: 'read', concurrency: 'parallel', resources: () => ['history-test:slow'] },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed.push('slow');
        return 'slow-result';
      },
    },
    {
      name: 'mcp__history_fast_image',
      description: 'fast history test tool with attachment',
      parameters: { type: 'object', properties: {} },
      capabilities: { effect: 'read', concurrency: 'parallel', resources: () => ['history-test:fast'] },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        completed.push('fast');
        return {
          status: 'success' as const,
          code: 'OK',
          retryable: false,
          output: 'fast-result',
          modelAttachments: [
            {
              type: 'image' as const,
              name: 'pixel.png',
              mime: 'image/png' as const,
              dataUrl: 'data:image/png;base64,AA==',
            },
          ],
        };
      },
    },
  ]);

  const controller = new AbortController();
  let modelCall = 0;
  __setChatCreateImpl(async () => {
    modelCall++;
    if (modelCall === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'slow-id',
                function: { name: 'mcp__history_slow', arguments: '{}' },
              },
              {
                index: 1,
                id: 'fast-id',
                function: { name: 'mcp__history_fast_image', arguments: '{}' },
              },
            ],
          },
        },
      ]);
    }
    return (async function* () {
      yield { choices: [{ delta: { content: 'discard after checkpoint' } }] };
      controller.abort();
      throw new DOMException('cancelled after atomic batch', 'AbortError');
    })();
  });

  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const visibleToolCounts: number[] = [];
    const result = await runAgentCore({
      pipeline: 'staged',
      history,
      userInput: 'run both tools',
      signal: controller.signal,
      maxSteps: 2,
      toolsOverride: ['mcp__history_slow', 'mcp__history_fast_image'].map((name) => ({
        type: 'function' as const,
        function: { name, description: name, parameters: { type: 'object', properties: {} } },
      })),
      runtimeAllowedToolNames: new Set(['mcp__history_slow', 'mcp__history_fast_image']),
      hooks: {
        onToolResult: () => visibleToolCounts.push(history.filter((message) => message.role === 'tool').length),
      },
      suppressOpeningAnalysis: true,
      suppressSessionState: true,
    });

    assert.equal(result.terminationReason, 'aborted');
    assert.deepEqual(completed, ['fast', 'slow'], '工具实际完成顺序应与 provider 顺序相反');
    assert.deepEqual(visibleToolCounts, [0, 0], 'staged commit 前外部 backing 不得看见部分结果');
    assert.deepEqual(
      history.map((message) => message.role),
      ['system', 'user', 'assistant', 'tool', 'tool', 'user'],
    );
    assert.deepEqual(
      history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
      ['slow-id', 'fast-id'],
    );
    const attachment = history.at(-1) as { role: string; content?: unknown[] };
    assert.equal(attachment.role, 'user');
    assert.equal(Array.isArray(attachment.content), true);
    assert.ok(
      !history.some((message) => message.role === 'assistant' && message.content === 'discard after checkpoint'),
    );
  } finally {
    __setChatCreateImpl(null);
    clearToolsExtension(source);
  }
});
