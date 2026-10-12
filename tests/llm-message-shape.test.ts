/**
 * sanitizeAssistantContent:transport 边界把「无文本、无 tool_calls」的 assistant
 * `content: null` 改写成 ""（speedbear 实测整请求 400：`messages[N].content 不能为 null`）。
 *
 * 触发事故:会话 20261012-175457-664 第 12 条消息落成 {role:'assistant',content:null},
 * 之后每轮 model_start 都 HTTP_400，换会话同模型正常 —— 毒消息每轮重发，/resume 也救不回来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAssistantContent } from '../src/llm/message-shape.js';
import { createLegacyHistoryManager, createStagedHistoryManager } from '../src/agent/stages/history-manager.js';
import type { ChatMessage } from '../src/llm/index.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });

test('sanitizeAssistantContent: 无 tool_calls 的 assistant content:null 改写为 ""', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('hi'),
    { role: 'assistant', content: null } as ChatMessage,
    user('say ok'),
  ];
  const out = sanitizeAssistantContent(messages);
  assert.equal(out[2].role, 'assistant');
  assert.equal((out[2] as { content?: unknown }).content, '', '必须改写成空字符串');
  assert.notEqual(out, messages, '有改动时必须返回新数组');
  assert.equal((messages[2] as { content?: unknown }).content, null, '原消息必须保持不变(不改写入参)');
  assert.equal(out[1], messages[1], '未受影响的消息必须复用原引用');
});

test('sanitizeAssistantContent: 带 tool_calls 的 null content 原样保留(OpenAI 规范形状)', () => {
  const call = { id: 'c1', type: 'function' as const, function: { name: 'x', arguments: '{}' } };
  const messages: ChatMessage[] = [
    user('hi'),
    { role: 'assistant', content: null, tool_calls: [call] } as ChatMessage,
    { role: 'tool', tool_call_id: 'c1', content: 'ok' } as ChatMessage,
  ];
  assert.equal(sanitizeAssistantContent(messages), messages, '合法形状必须原引用返回');
});

test('sanitizeAssistantContent: tool_calls 为空数组时视为无 tool_calls,仍需改写', () => {
  // 实测:content:null + tool_calls:[] 会被网关拒(null 只在「携带 tool_calls」时合法)。
  const messages: ChatMessage[] = [
    user('hi'),
    { role: 'assistant', content: null, tool_calls: [] } as unknown as ChatMessage,
    user('next'),
  ];
  const out = sanitizeAssistantContent(messages);
  assert.equal((out[1] as { content?: unknown }).content, '');
});

test('sanitizeAssistantContent: 干净历史原引用返回(前缀缓存逐字节稳定)', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('hi'),
    { role: 'assistant', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    } as ChatMessage,
    { role: 'tool', tool_call_id: 'c1', content: 'ok' } as ChatMessage,
  ];
  assert.equal(sanitizeAssistantContent(messages), messages, '干净历史必须原引用返回');
});

test('sanitizeAssistantContent: 非 assistant 消息一律不动(user/tool/system)', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: null } as unknown as ChatMessage,
    { role: 'user', content: null } as unknown as ChatMessage,
    { role: 'tool', tool_call_id: 'c1', content: null } as unknown as ChatMessage,
  ];
  assert.equal(sanitizeAssistantContent(messages), messages);
});

test('构造点回归:两条 history 路径都不再生产 content:null 的无工具 assistant', () => {
  for (const create of [createLegacyHistoryManager, createStagedHistoryManager]) {
    const backing: ChatMessage[] = [];
    const manager = create({ messages: backing });
    manager.appendAssistantTurn({ content: null, toolCalls: [] });
    assert.equal(backing.length, 1);
    assert.equal(
      (backing[0] as { content?: unknown }).content,
      '',
      `${create.name}: 空回复轮次必须落成 ""，不能是 null`,
    );
    // 构造点收敛后，transport 兜底对该消息无感知（幂等）。
    assert.equal(sanitizeAssistantContent(backing), backing);
  }
});

test('构造点回归:带 tool_calls 的轮次仍保留 null content(OpenAI 规范形状)', () => {
  const backing: ChatMessage[] = [];
  const manager = createLegacyHistoryManager({ messages: backing });
  manager.appendAssistantTurn({ content: null, toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] });
  const message = backing[0] as { content?: unknown; tool_calls?: unknown };
  assert.equal(message.content, null, '带 tool_calls 时 null 合法且应保留');
  assert.equal(Array.isArray(message.tool_calls), true);
});

test('端到端回归:被污染的 session history 经 transport 消毒后不再有裸 null', () => {
  // 复刻事故会话形状:正常工具轮之后跟一条「流被掐断」产生的空 assistant。
  const poisoned: ChatMessage[] = [
    { role: 'system', content: 'sys' } as ChatMessage,
    user('你好'),
    { role: 'assistant', content: null } as ChatMessage,
    user('？？'),
    user('321'),
  ];
  const healed = sanitizeAssistantContent(poisoned);
  const bare = healed.filter(
    (m) =>
      m.role === 'assistant' &&
      (m as { content?: unknown }).content === null &&
      !((m as { tool_calls?: unknown[] }).tool_calls ?? []).length,
  );
  assert.equal(bare.length, 0, '消毒后不得残留任何会被网关 400 的 assistant 形状');
});
