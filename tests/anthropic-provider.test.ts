import test from 'node:test';
import assert from 'node:assert/strict';
import { config, normalizeLlmProvider } from '../src/config/index.js';
import { parsePreset } from '../src/config/presets.js';
import type { ChatMessage, ChatTool } from '../src/llm/index.js';
import {
  __setAnthropicFetchImpl,
  anthropicChatOnce,
  buildAnthropicRequest,
  encodeAnthropicMessages,
  encodeAnthropicTools,
} from '../src/llm/providers/anthropic.js';

const tool: ChatTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

function messages(): ChatMessage[] {
  return [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'inspect the file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'file content' },
    { role: 'system', content: 'dynamic reminder' },
  ] as ChatMessage[];
}

test('旧预设默认使用 OpenAI，新 Anthropic 预设规范化缓存配置', () => {
  assert.equal(normalizeLlmProvider(undefined), 'openai');
  assert.equal(normalizeLlmProvider('OPENAI'), 'openai');
  assert.equal(normalizeLlmProvider('Anthropic'), 'anthropic');

  const legacy = parsePreset(
    JSON.stringify({
      name: 'legacy',
      baseURL: 'https://example.test/v1',
      apiKey: 'key',
      model: 'legacy-model',
      contextWindow: 1000,
    }),
  );
  assert.equal(legacy.provider, 'openai');
  assert.equal(legacy.anthropicPromptCache, false);

  const anthropic = parsePreset(
    JSON.stringify({
      name: 'claude',
      provider: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKey: 'key',
      model: 'claude-test',
      contextWindow: 200000,
    }),
  );
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.anthropicPromptCache, true);
});

test('Anthropic 请求转换工具调用、结果、图片和 Prompt Cache 断点', () => {
  const input = messages();
  input.splice(2, 0, {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGVsbG8=' },
      },
    ],
  } as ChatMessage);

  const encoded = encodeAnthropicMessages(input, true);
  assert.deepEqual(encoded.system, [{ type: 'text', text: 'stable system' }]);
  assert.deepEqual(encoded.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'inspect the file' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ],
  });
  assert.deepEqual(encoded.messages[1].content[0], {
    type: 'tool_use',
    id: 'call-1',
    name: 'read_file',
    input: { path: 'a.ts' },
  });
  assert.deepEqual(encoded.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: 'file content',
    cache_control: { type: 'ephemeral' },
  });
  assert.match(String(encoded.messages[2].content[1].text), /dynamic reminder/);
  assert.equal(encoded.messages[2].content[1].cache_control, undefined);

  const tools = encodeAnthropicTools([tool], true);
  assert.deepEqual(tools[0].input_schema, tool.function.parameters);
  assert.deepEqual(tools[0].cache_control, { type: 'ephemeral' });

  const request = buildAnthropicRequest(input, [tool]);
  assert.equal(request.stream, true);
  assert.ok(Array.isArray(request.system));
  assert.ok(Array.isArray(request.messages));
  assert.ok(Array.isArray(request.tools));
});

test('Anthropic SSE 拼接工具参数并映射 cache usage', async () => {
  const previous = {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    anthropicPromptCache: config.anthropicPromptCache,
  };
  config.baseURL = 'https://api.anthropic.com/';
  config.apiKey = 'test-key';
  config.anthropicPromptCache = true;

  const records = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} },
      },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'a.ts"}' } },
    ],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'done' } }],
    ['message_delta', { type: 'message_delta', usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');

  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const text: string[] = [];
  const calls: string[] = [];
  __setAnthropicFetchImpl(async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return new Response(records, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  try {
    const result = await anthropicChatOnce(
      [{ role: 'user', content: 'go' } as ChatMessage],
      { onText: (value) => text.push(value), onToolCall: (name) => calls.push(name) },
      undefined,
      [tool],
    );
    assert.equal(requestUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal((requestInit?.headers as Record<string, string>)['x-api-key'], 'test-key');
    assert.equal(result.content, 'done');
    assert.deepEqual(text, ['done']);
    assert.deepEqual(calls, ['read_file']);
    assert.deepEqual(result.toolCalls, [{ id: 'tool-1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);
    assert.deepEqual(result.usage, {
      promptTokens: 60,
      completionTokens: 4,
      totalTokens: 64,
      cachedTokens: 20,
      cacheCreationTokens: 30,
      reasoningTokens: 0,
    });
  } finally {
    __setAnthropicFetchImpl(null);
    config.baseURL = previous.baseURL;
    config.apiKey = previous.apiKey;
    config.anthropicPromptCache = previous.anthropicPromptCache;
  }
});
