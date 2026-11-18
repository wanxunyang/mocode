import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config/index.js';
import {
  createChatClientState,
  createChatTransport,
  type ChatMessage,
  type ChatTool,
  type ModelRuntimeConfig,
} from '../../src/llm/index.js';

const tools: ChatTool[] = [
  {
    type: 'function',
    function: { name: 'read_file', description: 'test', parameters: { type: 'object', properties: {} } },
  },
];

function stream(chunks: Array<Record<string, unknown>>): AsyncIterable<unknown> {
  return (async function* () {
    for (const delta of chunks) yield { choices: [{ delta }] };
  })();
}

function reasoningStream(): AsyncIterable<unknown> {
  return stream([
    { reasoning_content: 'think-' },
    {
      reasoning_content: 'before-tool',
      tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }],
    },
  ]);
}

function bodyMessages(body: Record<string, unknown>): ChatMessage[] {
  return body.messages as ChatMessage[];
}

/** 独立 runtime：只替换当前 transport 配置和请求桩，不读取/修改真实激活预设。 */
function localTransport(
  baseURL: string,
  model: string,
  onCreate: (body: Record<string, unknown>) => AsyncIterable<unknown>,
) {
  const runtimeConfig: ModelRuntimeConfig = {
    ...config,
    provider: 'openai',
    baseURL,
    apiKey: 'test-only',
    maxTokens: undefined,
  };
  const clientState = createChatClientState(runtimeConfig, {
    openAICreateImpl: async (body) => onCreate(body),
  });
  return createChatTransport({ config: runtimeConfig, getModel: () => model, clientState });
}

test('DeepSeek 官方流式思考拼接到 ChatResult，不进入可见正文', async () => {
  const bodies: Record<string, unknown>[] = [];
  const transport = localTransport('https://api.deepseek.com/v1', 'deepseek-flash', (body) => {
    bodies.push(body);
    return reasoningStream();
  });
  const visible: string[] = [];
  const first = await transport(
    [{ role: 'user', content: 'read' }],
    { onText: (text) => visible.push(text) },
    undefined,
    tools,
  );
  assert.equal(first.reasoningContent, 'think-before-tool');
  assert.equal(first.content, null);
  assert.deepEqual(visible, []);
  assert.equal(first.toolCalls[0]?.id, 'c1');

  const history: ChatMessage[] = [
    { role: 'user', content: 'read' },
    {
      role: 'assistant',
      content: first.content,
      reasoning_content: first.reasoningContent,
      tool_calls: first.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
    { role: 'assistant', content: 'last response', reasoning_content: 'final-turn-thinking' },
    { role: 'user', content: 'continue' },
  ];
  await transport(history, {}, undefined, tools);
  const sent = bodyMessages(bodies[1]!);
  assert.equal(sent[1]?.role, 'assistant');
  assert.equal(sent[1]?.reasoning_content, 'think-before-tool');
  assert.equal(sent[3]?.role, 'assistant');
  assert.equal(sent[3]?.reasoning_content, 'final-turn-thinking');
  assert.equal(history[1]?.role, 'assistant');
  assert.equal(history[1]?.role === 'assistant' ? history[1].reasoning_content : undefined, 'think-before-tool');
});

test('只有官方 DeepSeek + tools 保留思考；DashScope、代理、无工具和 off 都剥离', async () => {
  const cases = [
    { baseURL: 'https://api.deepseek.com/v1', tools, effort: 'auto', expected: true },
    { baseURL: 'https://api.deepseek.com/v1', tools, effort: 'high', expected: true },
    { baseURL: 'https://api.deepseek.com/v1', tools, effort: 'off', expected: false },
    { baseURL: 'https://api.deepseek.com/v1', tools: [], effort: 'high', expected: false },
    { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tools, effort: 'high', expected: false },
    { baseURL: 'https://proxy.example.com/deepseek', tools, effort: 'high', expected: false },
    { baseURL: '', tools, effort: 'high', expected: false },
  ] as const;
  for (const item of cases) {
    let sent: ChatMessage[] = [];
    const transport = localTransport(item.baseURL, 'deepseek-v4.1-flash', (body) => {
      sent = bodyMessages(body);
      return stream([{ content: 'ok' }]);
    });
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer', reasoning_content: 'private chain' },
    ];
    await transport(history, {}, undefined, item.tools, { reasoningEffort: item.effort });
    assert.equal(
      'reasoning_content' in sent[1]!,
      item.expected,
      `${item.baseURL || 'invalid'} effort=${item.effort} tools=${item.tools.length}`,
    );
    assert.equal(history[1]?.role, 'assistant');
    assert.equal(
      history[1]?.role === 'assistant' ? history[1].reasoning_content : undefined,
      'private chain',
      '原 history 始终保留',
    );
  }
});

test('完整 Agent 工具循环：legacy/staged 都把两轮思考写历史并回传', async (t) => {
  const [{ runAgentCore }, { createAgentRuntimeContext }, fs, os, path] = await Promise.all([
    import('../../src/agent/core.js'),
    import('../../src/agent/runtime-context.js'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  for (const pipeline of ['legacy', 'staged'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `mocode-deepseek-agent-${pipeline}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bodies: Array<Record<string, unknown>> = [];
    let executions = 0;
    const runtime = createAgentRuntimeContext({
      sandboxRoot: root,
      configOverrides: {
        provider: 'openai',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'test-only',
        model: 'deepseek-v4-flash-agent-test',
        maxTokens: undefined,
        reasoningEffort: 'high',
        autoCompact: false,
        contextBudget: false,
        permissionEnabled: false,
        sessionDir: path.join(root, 'sessions'),
      },
      tools: [
        {
          name: 'fixture_read',
          description: 'isolated read fixture',
          parameters: { type: 'object', properties: {} },
          capabilities: { effect: 'read', concurrency: 'parallel' },
          async execute() {
            executions++;
            return 'fixture contents';
          },
        },
      ],
      modelClientOverrides: {
        openAICreateImpl: async (body) => {
          bodies.push(structuredClone(body));
          return bodies.length === 1
            ? stream([
                { reasoning_content: 'think-before-tool' },
                {
                  tool_calls: [{ index: 0, id: 'agent-c1', function: { name: 'fixture_read', arguments: '{}' } }],
                },
              ])
            : stream([{ reasoning_content: 'think-final', content: 'done' }]);
        },
      },
    });
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const result = await runAgentCore({
      pipeline,
      history,
      userInput: 'read fixture',
      maxSteps: 3,
      runtimeContext: runtime,
      toolsOverride: [
        {
          type: 'function',
          function: {
            name: 'fixture_read',
            description: 'isolated read fixture',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      runtimeAllowedToolNames: new Set(['fixture_read']),
      hooks: {},
      suppressOpeningAnalysis: true,
      suppressSessionState: true,
    });
    assert.equal(result.finalText, 'done', pipeline);
    assert.equal(executions, 1, pipeline);
    assert.equal(bodies.length, 2, pipeline);
    const second = bodyMessages(bodies[1]!);
    const toolAssistant = second.find((message) => message.role === 'assistant' && !!message.tool_calls?.length);
    assert.equal(toolAssistant?.role, 'assistant');
    assert.equal(
      toolAssistant?.role === 'assistant' ? toolAssistant.reasoning_content : undefined,
      'think-before-tool',
      pipeline,
    );
    assert.equal(
      second.some((message) => message.role === 'tool' && message.content === 'fixture contents'),
      true,
    );
    const final = history.at(-1);
    assert.equal(final?.role, 'assistant');
    assert.equal(final?.role === 'assistant' ? final.reasoning_content : undefined, 'think-final', pipeline);
    assert.equal(final?.content, 'done');
  }
});
