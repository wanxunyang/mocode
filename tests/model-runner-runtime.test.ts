import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatClientState, createChatTransport, type ModelRuntimeConfig } from '../src/llm/index.js';
import { createLegacyModelRunner, createStagedModelRunner } from '../src/agent/stages/model-runner.js';
function openAITextStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}
function anthropicTextResponse(text: string): Response {
  const records = [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2 } },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
  ];
  return new Response(`${records.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
test('runtime-bound ModelRunners keep provider and outbound configuration isolated', async () => {
  const openAIConfig: ModelRuntimeConfig = {
    provider: 'openai',
    baseURL: 'https://runtime-openai.example/v1',
    apiKey: 'openai-runtime-key',
    maxTokens: 101,
    includeUsage: true,
    anthropicPromptCache: false,
  };
  const anthropicConfig: ModelRuntimeConfig = {
    provider: 'anthropic',
    baseURL: 'https://runtime-anthropic.example/gateway',
    apiKey: 'anthropic-runtime-key',
    maxTokens: 202,
    includeUsage: false,
    anthropicPromptCache: true,
  };
  let openAICalls = 0;
  let anthropicCalls = 0;
  let crossedToAnthropic = 0;
  let crossedToOpenAI = 0;
  let openAIBody: Record<string, unknown> | undefined;
  let anthropicRequest: { input: string; init: RequestInit } | undefined;
  const openAIState = createChatClientState(openAIConfig, {
    openAICreateImpl: async (body) => {
      openAICalls++;
      openAIBody = body;
      return openAITextStream('openai-result');
    },
    anthropicFetchImpl: async () => {
      crossedToAnthropic++;
      throw new Error('OpenAI runtime dispatched through Anthropic');
    },
  });
  const anthropicState = createChatClientState(anthropicConfig, {
    openAICreateImpl: async () => {
      crossedToOpenAI++;
      throw new Error('Anthropic runtime dispatched through OpenAI');
    },
    anthropicFetchImpl: async (input, init) => {
      anthropicCalls++;
      anthropicRequest = { input, init };
      return anthropicTextResponse('anthropic-result');
    },
  });
  const openAIRunner = createLegacyModelRunner(
    createChatTransport({ config: openAIConfig, getModel: () => 'runtime-openai-model', clientState: openAIState }),
  );
  const anthropicRunner = createStagedModelRunner(
    createChatTransport({
      config: anthropicConfig,
      getModel: () => 'runtime-anthropic-model',
      clientState: anthropicState,
    }),
  );
  const [openAIResult, anthropicResult] = await Promise.all([
    openAIRunner.run({ history: [{ role: 'user', content: 'openai turn' }], tools: [], handlers: {} }),
    anthropicRunner.run({ history: [{ role: 'user', content: 'anthropic turn' }], tools: [], handlers: {} }),
  ]);
  assert.equal(openAIResult.content, 'openai-result');
  assert.equal(anthropicResult.content, 'anthropic-result');
  assert.equal(openAICalls, 1);
  assert.equal(anthropicCalls, 1);
  assert.equal(crossedToAnthropic, 0);
  assert.equal(crossedToOpenAI, 0);
  assert.equal(openAIBody?.model, 'runtime-openai-model');
  assert.equal(openAIBody?.max_tokens, 101);
  assert.deepEqual(openAIBody?.stream_options, { include_usage: true });
  assert.equal(anthropicRequest?.input, 'https://runtime-anthropic.example/gateway/v1/messages');
  const headers = anthropicRequest?.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'anthropic-runtime-key');
  const anthropicBody = JSON.parse(String(anthropicRequest?.init.body)) as {
    model: string;
    max_tokens: number;
    messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
  };
  assert.equal(anthropicBody.model, 'runtime-anthropic-model');
  assert.equal(anthropicBody.max_tokens, 202);
  assert.deepEqual(anthropicBody.messages[0]?.content[0]?.cache_control, { type: 'ephemeral' });
});
