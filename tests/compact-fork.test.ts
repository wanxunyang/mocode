/** cache-safe fork 摘要器测试(#token-efficiency P0)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatTool, ChatTransport } from '../src/llm/index.js';
import { compactHistory, createContextState, type CompactionRuntime } from '../src/session/compact.js';
import { config } from '../src/config/index.js';
import { appendTool, system } from './helpers.js';

function bigHistory(): ChatMessage[] {
  const history: ChatMessage[] = [system('parent system prompt')];
  appendTool(history, 'read_file', 'old-read', { path: 'src/old.ts' }, 'x'.repeat(60_000));
  history.push({ role: 'user', content: 'continue' } as ChatMessage);
  appendTool(history, 'run_command', 'latest', { command: 'echo ok' }, 'ok');
  return history;
}

const dummyTools: ChatTool[] = [
  {
    type: 'function',
    function: { name: 'foo_tool', description: 'd', parameters: { type: 'object', properties: {} } },
  },
];

interface Captured {
  messages: ChatMessage[];
  tools: readonly ChatTool[] | undefined;
}

function captureTransport(returnUsage = false): { captured: Captured[]; transport: ChatTransport } {
  const captured: Captured[] = [];
  const transport: ChatTransport = async (messages, _handlers, _signal, tools) => {
    captured.push({ messages, tools });
    return {
      content: '## Completed\nsummary body',
      toolCalls: [],
      ...(returnUsage
        ? {
            usage: {
              promptTokens: 100,
              completionTokens: 20,
              totalTokens: 120,
              cachedTokens: 80,
              reasoningTokens: 5,
            },
          }
        : {}),
    };
  };
  return { captured, transport };
}

async function runOnce(history: ChatMessage[], transport: ChatTransport, window: number) {
  const runtime: CompactionRuntime = {
    config: {
      contextWindowTokens: window,
      autoCompact: true,
      contextBudget: true,
      contextRelprune: false,
      contextOptimize: false,
      lowPressureRatio: 0.6,
      toolClearing: true,
    },
    modelTransport: transport,
  };
  return compactHistory(history, {
    window,
    threshold: 0.8,
    tools: dummyTools,
    contextState: createContextState(),
    runtime,
  });
}

test('fork: 请求复用父 system + 旧消息, 继承 activeTools, 仅尾部追加 compact 指令', async () => {
  const saved = config.compactFork;
  config.compactFork = true;
  try {
    const history = bigHistory();
    const { captured, transport } = captureTransport();
    const result = await runOnce(history, transport, 100_000);

    assert.equal(result.reason, 'summarize');
    assert.equal(captured.length, 1);
    const req = captured[0];
    // 继承父 activeTools(不是 [])。
    assert.strictEqual(req.tools, dummyTools);
    // 前缀:父 system 原样。
    assert.equal(req.messages[0].role, 'system');
    assert.equal(req.messages[0].content, 'parent system prompt');
    // 尾部:compact 指令 user 消息。
    const tail = req.messages[req.messages.length - 1];
    assert.equal(tail.role, 'user');
    assert.match(String(tail.content), /\[COMPACT TASK\]/);
    // 旧区消息(大 tool result)在指令之前。
    assert.ok(
      req.messages.slice(0, -1).some((m) => String((m as { content?: unknown }).content ?? '').includes('xxxx')),
      'old tool result must be part of the fork prefix',
    );
  } finally {
    config.compactFork = saved;
  }
});

test('fork: 后端回传 usage 时不报错, 摘要仍成功', async () => {
  const saved = config.compactFork;
  config.compactFork = true;
  try {
    const { captured, transport } = captureTransport(true);
    const result = await runOnce(bigHistory(), transport, 100_000);
    assert.equal(result.reason, 'summarize');
    assert.equal(captured.length, 1);
  } finally {
    config.compactFork = saved;
  }
});

test('fork 关闭(MOCODE_COMPACT_FORK=false): 回落 legacy 独立 compressor', async () => {
  const saved = config.compactFork;
  config.compactFork = false;
  try {
    const { captured, transport } = captureTransport();
    await runOnce(bigHistory(), transport, 100_000);
    const req = captured[0];
    assert.deepEqual(req.tools, [], 'legacy path sends no tool schemas');
    assert.equal(req.messages[0].role, 'system');
    assert.match(String(req.messages[0].content), /session compressor/);
  } finally {
    config.compactFork = saved;
  }
});

test('buffer 装不下时自动回落 legacy(无需手动关开关)', async () => {
  const saved = config.compactFork;
  config.compactFork = true;
  try {
    const { captured, transport } = captureTransport();
    await runOnce(bigHistory(), transport, 500);
    const req = captured[0];
    assert.deepEqual(req.tools, []);
    assert.match(String(req.messages[0].content), /session compressor/);
  } finally {
    config.compactFork = saved;
  }
});
