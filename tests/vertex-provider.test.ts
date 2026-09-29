import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatTool } from '../src/llm/index.js';
import { buildGeminiRequest, encodeGeminiMessages, vertexChatOnce } from '../src/llm/providers/vertex.js';

const weatherTool: ChatTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

function sseResponse(records: object[], status = 200): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const rec of records) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(rec)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('encodeGeminiMessages: history 中 tool_call 的 thoughtSignature 原样回灌到 functionCall part', () => {
  const messages = [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'gemini-1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          thoughtSignature: 'SIG-ABC',
        },
      ],
    },
    { role: 'tool', tool_call_id: 'gemini-1', content: '{"temp":26}' },
  ] as unknown as ChatMessage[];

  const { contents } = encodeGeminiMessages(messages);
  const modelContent = contents.find((c) => c.role === 'model');
  assert.equal(modelContent?.parts[0]?.thoughtSignature, 'SIG-ABC');
  assert.deepEqual(modelContent?.parts[0]?.functionCall, {
    name: 'get_weather',
    args: { city: 'Tokyo' },
  });
});

test('buildGeminiRequest: 无签名的历史（旧会话/OpenAI 模型）不构造 thoughtSignature 字段', () => {
  const req = buildGeminiRequest(
    [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ] as ChatMessage[],
    [weatherTool],
  );
  const modelPart = (req.contents as Array<{ parts: Array<Record<string, unknown>> }>).find(
    (c) => (c as { role?: string }).role === 'model',
  )?.parts[0];
  assert.equal(modelPart?.thoughtSignature, undefined);
});

test('vertexChatOnce: 捕获 functionCall part 上的 thoughtSignature', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'get_weather', args: { city: 'Tokyo' } },
                  thoughtSignature: 'SIG-CAPTURED',
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      },
    ])) as unknown as typeof fetch;

  try {
    const result = await vertexChatOnce([{ role: 'user', content: 'weather?' }], {}, undefined, [weatherTool]);
    assert.equal(result.toolCalls[0]?.name, 'get_weather');
    assert.equal(result.toolCalls[0]?.thoughtSignature, 'SIG-CAPTURED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vertexChatOnce: thought:true 的思考文本不入正文、不触发 onText', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'secret reasoning', thought: true }, { text: 'final answer' }],
            },
          },
        ],
      },
    ])) as unknown as typeof fetch;

  try {
    const seen: string[] = [];
    const result = await vertexChatOnce(
      [{ role: 'user', content: 'hi' }],
      { onText: (d) => seen.push(d) },
      undefined,
      [],
    );
    assert.equal(result.content, 'final answer');
    assert.deepEqual(seen, ['final answer']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('encodeGeminiMessages: functionResponse 后的 system reminder 独立成 user 轮，不合并（回归 model turn 报错）', () => {
  const messages = [
    { role: 'user', content: 'search news' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'gemini-1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"ai"}' },
          thoughtSignature: 'SIG',
        },
      ],
    },
    { role: 'tool', tool_call_id: 'gemini-1', content: '[1] result' },
    { role: 'system', content: 'ephemeral reminder' },
  ] as unknown as ChatMessage[];

  const { contents } = encodeGeminiMessages(messages);
  // 末尾必须是两个 user 轮：干净 FR 轮 + 独立 reminder 轮；不能合成一个 FR+text 轮。
  const lastTwo = contents.slice(-2);
  assert.equal(lastTwo[0]?.role, 'user');
  assert.ok(lastTwo[0]?.parts.some((p) => !!p.functionResponse));
  assert.equal(lastTwo[0]?.parts.length, 1, 'FR 轮必须纯净');
  assert.equal(lastTwo[1]?.role, 'user');
  assert.equal(lastTwo[1]?.parts[0]?.text, '[System reminder]\nephemeral reminder');
});
