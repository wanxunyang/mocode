import test from 'node:test';
import assert from 'node:assert/strict';
import { measureContextUsage } from '../../src/context/usage-snapshot.js';
import {
  estimateMessagesTokens,
  estimatePromptTokens,
  estimateToolSchemaTokens,
  estimateTokens,
  type ChatMessage,
  type ChatTool,
} from '../../src/llm/index.js';
import { createContextState } from '../../src/session/compact.js';

const tools: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'context_probe',
      description: 'A tool whose schema must be included in the current prompt.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

function history(): ChatMessage[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
  ];
}

test('空对话显示 0；有对话时统计 system、工具 schema 与完整 ephemeral', () => {
  const state = createContextState();
  state.activeTools = tools;
  state.ephemeralText = 'policy and session reminders';
  const messages = history();
  assert.equal(measureContextUsage([messages[0]!], 1_000, state).tokens, 0);

  const snapshot = measureContextUsage(messages, 1_000, state);
  const expected =
    estimateMessagesTokens(messages) + estimateToolSchemaTokens(tools) + estimateTokens(state.ephemeralText);
  assert.deepEqual(snapshot, {
    tokens: expected,
    window: 1_000,
    remaining: 1_000 - expected,
    percent: Math.round(expected / 10),
    messages: 2,
    source: 'estimated',
  });
  assert.equal(measureContextUsage(messages, 1_000, createContextState()).tokens, estimateMessagesTokens(messages));
});

test('实测锚点使用真实请求基线；新增消息只按本地增量外推', () => {
  const messages = history();
  const ephemeralText = 'policy\n\nsession reminder';
  const state = createContextState();
  state.activeTools = tools;
  state.ephemeralText = ephemeralText;
  state.promptAnchor = {
    measuredPromptTokens: 800,
    baseRaw: estimatePromptTokens([...messages, { role: 'system', content: ephemeralText }], tools),
    historyLen: messages.length,
    tools,
    ephemeralText,
  };
  const measured = measureContextUsage(messages, 2_000, state);
  assert.equal(measured.tokens, 800);
  assert.equal(measured.percent, 40);
  assert.equal(measured.source, 'measured');

  messages.push({ role: 'assistant', content: 'a newly appended response' });
  const grown = measureContextUsage(messages, 2_000, state);
  assert.equal(grown.tokens, 800 + estimateMessagesTokens(messages) - estimateMessagesTokens(messages.slice(0, -1)));
  assert.equal(grown.source, 'estimated');

  state.ephemeralText = 'a different next-step reminder';
  assert.notEqual(measureContextUsage(messages, 2_000, state).tokens, grown.tokens);
});

test('压缩替换 history（即使消息数不变）不沿用旧实测锚点，百分比封顶 100', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'x'.repeat(400) },
  ];
  const state = createContextState();
  state.activeTools = [];
  state.promptAnchor = {
    measuredPromptTokens: 20_000,
    baseRaw: estimatePromptTokens(messages, []),
    historyLen: messages.length,
    tools: state.activeTools,
    ephemeralText: '',
  };
  const compacted: ChatMessage[] = [
    { role: 'system', content: 'short summary' },
    { role: 'user', content: 'new request' },
  ];
  const snapshot = measureContextUsage(compacted, 100, state);
  assert.equal(snapshot.source, 'estimated');
  assert.equal(snapshot.tokens, estimateMessagesTokens(compacted));
  assert.equal(measureContextUsage(compacted, 10, state).percent, 100);
  assert.equal(measureContextUsage(compacted, 0, state).percent, 0);
});
