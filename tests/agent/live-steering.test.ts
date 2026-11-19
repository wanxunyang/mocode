import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCore } from '../../src/agent/core.js';
import { __setChatCreateImpl, type ChatMessage } from '../../src/llm/index.js';
import { createContextState } from '../../src/session/compact.js';
import { defaultAgentRuntimeContext } from '../../src/agent/runtime-context.js';
import { t } from '../../src/i18n/index.js';
import '../../src/tools/builtins/index.js';

for (const pipeline of ['legacy', 'staged'] as const) {
  test(`${pipeline}: live updates during a final stream continue the same run in FIFO order`, async () => {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const pending: string[] = [];
    let requests = 0;
    __setChatCreateImpl(async (body) => {
      requests++;
      const requestMessages = body.messages as ChatMessage[];
      const systemText = requestMessages
        .filter((m) => m.role === 'system')
        .map((m) => String(m.content))
        .join('\n');
      if (requests === 1) assert.doesNotMatch(systemText, /## Live user updates/);
      else {
        assert.match(systemText, /original request and all subsequent user updates together/);
        assert.match(systemText, /preserving earlier requirements/);
        assert.match(systemText, /continue from the current progress/);
      }
      if (requests === 2) {
        assert.deepEqual(
          history.filter((m) => m.role === 'user').map((m) => m.content),
          ['original', 'use Chinese', 'add captcha'],
        );
      }
      return (async function* () {
        yield { choices: [{ delta: { content: requests === 1 ? 'working' : 'done' } }] };
        if (requests === 1) pending.push('use Chinese', 'add captcha');
        if (requests === 2) pending.push('keep the original scope');
      })();
    });
    try {
      const result = await runAgentCore({
        pipeline,
        history,
        userInput: 'original',
        maxSteps: 3,
        hooks: {},
        toolsOverride: [],
        contextState: createContextState(),
        drainUserMessages: () => pending.splice(0),
        suppressOpeningAnalysis: true,
        suppressSessionState: true,
      });
      assert.equal(result.completed, true);
      assert.equal(requests, 3);
      assert.deepEqual(
        history.filter((m) => m.role === 'user').map((m) => m.content),
        ['original', 'use Chinese', 'add captcha', 'keep the original scope'],
      );
      assert.equal(result.finalText, 'done');
    } finally {
      __setChatCreateImpl(null);
    }
  });

  test(`${pipeline}: messages received during tools follow all paired results`, async () => {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const pending: string[] = [];
    let requests = 0;
    __setChatCreateImpl(async () => {
      requests++;
      if (requests === 2) {
        assert.deepEqual(
          history.map((m) => m.role),
          ['system', 'user', 'assistant', 'tool', 'user'],
        );
        assert.equal(history.at(-1)?.content, 'new requirement');
      }
      return (async function* () {
        yield {
          choices: [
            {
              delta:
                requests === 1
                  ? {
                      tool_calls: [
                        { index: 0, id: 'read', function: { name: 'read_file', arguments: '{"path":"package.json"}' } },
                      ],
                    }
                  : { content: 'done' },
            },
          ],
        };
      })();
    });
    try {
      const result = await runAgentCore({
        pipeline,
        history,
        userInput: 'original',
        maxSteps: 3,
        hooks: {
          onToolResult: () => {
            pending.push('new requirement');
          },
        },
        runtimeContext: { ...defaultAgentRuntimeContext, checkPermission: async () => 'allow' },
        contextState: createContextState(),
        drainUserMessages: () => pending.splice(0),
        suppressOpeningAnalysis: true,
        suppressSessionState: true,
      });
      assert.equal(result.completed, true);
      assert.equal(requests, 2);
    } finally {
      __setChatCreateImpl(null);
    }
  });

  test(`${pipeline}: 一批引导只在下一次工具执行前开场，后续恢复静默`, async () => {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const pending: string[] = [];
    const seen: string[] = [];
    let requests = 0;
    __setChatCreateImpl(async (body) => {
      const step = ++requests;
      const tail = String((body.messages as ChatMessage[]).at(-1)?.content ?? '');
      if (step === 1) assert.match(tail, /## Opening analysis/);
      else if (step === 2) {
        assert.match(tail, /## Steering opening/);
        assert.match(tail, /## Live user updates/);
        assert.doesNotMatch(tail, /## Silent work|## Opening analysis/);
        assert.deepEqual(
          history.filter((message) => message.role === 'user').map((message) => message.content),
          ['original', '要能交互', '用户能点'],
        );
      } else {
        assert.match(tail, /## Silent work/);
        assert.match(tail, /## Live user updates/);
        assert.doesNotMatch(tail, /## Steering opening/);
      }
      return (async function* () {
        if (step === 1) yield { choices: [{ delta: { content: '我先查看配置。' } }] };
        if (step < 4) {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `read-${step}`,
                      function: { name: 'read_file', arguments: '{"path":"package.json"}' },
                    },
                  ],
                },
              },
            ],
          };
        }
        // 网关可以先发工具名，再发正文；另一条 pipeline 验证缺少模型开场时的兜底。
        if (step === 2 && pipeline === 'staged') {
          yield { choices: [{ delta: { content: '我先找图表入口，确认点击交互可以接在哪里。' } }] };
        }
        if (step === 4) yield { choices: [{ delta: { content: '完成。' } }] };
      })();
    });
    try {
      const result = await runAgentCore({
        pipeline,
        history,
        userInput: 'original',
        maxSteps: 4,
        hooks: {
          onText: (text) => seen.push(`text:${text}`),
          onToolCall: (name) => seen.push(`prepare:${name}`),
          onToolHeader: (call) => seen.push(`start:${call.id}`),
          onToolResult: (call) => {
            if (call.id === 'read-1') pending.push('要能交互', '用户能点');
          },
        },
        runtimeContext: { ...defaultAgentRuntimeContext, checkPermission: async () => 'allow' },
        contextState: createContextState(),
        drainUserMessages: () => pending.splice(0),
        suppressSessionState: true,
      });
      const steeringText =
        pipeline === 'staged'
          ? '我先找图表入口，确认点击交互可以接在哪里。'
          : t('agent.openingSteered', { action: t('agent.openingRead', { file: '"package.json"' }) });
      assert.equal(result.finalText, '完成。');
      assert.deepEqual(seen, [
        'text:我先查看配置。',
        'prepare:read_file',
        'start:read-1',
        `text:${steeringText}`,
        'prepare:read_file',
        'start:read-2',
        'prepare:read_file',
        'start:read-3',
        'text:完成。',
      ]);
      assert.equal(requests, 4);
    } finally {
      __setChatCreateImpl(null);
    }
  });
}

test('accepted steering survives cancellation of the following model request', async () => {
  const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  const pending: string[] = [];
  const controller = new AbortController();
  let requests = 0;
  __setChatCreateImpl(async () => {
    requests++;
    return (async function* () {
      if (requests === 1) pending.push('keep this update');
      else controller.abort();
      yield { choices: [{ delta: { content: 'partial' } }] };
    })();
  });
  try {
    await runAgentCore({
      history,
      userInput: 'original',
      maxSteps: 3,
      hooks: {},
      toolsOverride: [],
      signal: controller.signal,
      contextState: createContextState(),
      drainUserMessages: () => pending.splice(0),
      suppressOpeningAnalysis: true,
      suppressSessionState: true,
    });
    assert.deepEqual(
      history.filter((m) => m.role === 'user').map((m) => m.content),
      ['original', 'keep this update'],
    );
  } finally {
    __setChatCreateImpl(null);
  }
});

test('TUI accepts live updates and never submits slash commands to the agent', async () => {
  const { submitSteeringMessage, drainSteeringMessages } = await import('../../src/repl/running-input.js');
  drainSteeringMessages();
  submitSteeringMessage('use Chinese');
  submitSteeringMessage('/clear');
  submitSteeringMessage('add captcha');
  assert.deepEqual(drainSteeringMessages(), ['use Chinese', 'add captcha']);
  assert.deepEqual(drainSteeringMessages(), []);
});

test('unconsumed TUI updates become a draft on stop instead of starting another turn', async () => {
  const { submitSteeringMessage, stopRunningListener, getRunningInput, clearRunningInput, drainSteeringMessages } =
    await import('../../src/repl/running-input.js');
  clearRunningInput();
  drainSteeringMessages();
  try {
    submitSteeringMessage('first update');
    submitSteeringMessage('second update');
    stopRunningListener();
    assert.equal(getRunningInput(), 'first update\nsecond update');
    assert.deepEqual(drainSteeringMessages(), []);
  } finally {
    clearRunningInput();
  }
});
