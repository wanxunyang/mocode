/**
 * runAgentCore 最小集成测试:用 __setChatCreateImpl 把 chat() 的 OpenAI create 桩掉,
 * 驱动完整的「流式 → tool_call → 执行 → 回灌 → 再流式 → 文本收尾」循环。
 *
 * 目的不是测模型质量,而是给后续拆分 runAgentCore(core.ts 940 行巨型函数)提供
 * 行为安全网:拆分前后,history 结构、hooks 触发顺序、最终文本必须字节级一致。
 *
 * 关键设计:
 *  - mock 的 SSE chunk 形状必须对齐 src/llm/index.ts chatOnce() 的解析逻辑
 *    (choices[0].delta.content / .tool_calls[].function.{name,arguments},usage 在末尾 chunk)。
 *  - 工具选 read_file:risk=safe,checkPermission 直接放行,不触发权限弹窗。
 *  - 沙箱根用临时目录并自带 fixture(--test-isolation=none 下与其它测试共享进程,
 *    sandbox.test.ts 会改全局根,故必须自带根且不依赖项目文件);after 恢复 null。
 *  - hooks 全部注入为记录器,验证执行顺序。
 */

import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentCore, type AgentHooks } from '../src/agent/core.js';
import { __setChatCreateImpl, type ChatMessage } from '../src/llm/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
// 装配官方默认工具包(提供本测试真执行的 read_file):registry 不再顶层 import builtins,须显式装配。
import '../src/tools/builtins/index.js';

/** 构造一个符合 chatOnce() 解析预期的异步 SSE chunk 流。 */
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
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }>,
): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [], ...(chunk.usage ? { usage: chunk.usage } : {}) };
    }
  })();
}

test('runAgentCore: 单 tool_call → 文本回复,history 与 hooks 字节级可复现', async () => {
  // 自带沙箱根 + fixture:--experimental-test-isolation=none 下所有测试共享进程,
  // sandbox.test.ts 会把全局沙箱根改到它的临时目录,故本测试必须自带根、
  // 不依赖项目根的 package.json。
  const root = mkdtempSync(join(tmpdir(), 'mocode-agent-core-test-'));
  writeFileSync(join(root, 'fixture.txt'), 'mocode-fixture-content', 'utf8');
  const prevRoot = setSandboxRoot(root);

  let createCallCount = 0;

  // 第一次 chat:模型要求 read_file fixture.txt;第二次:返回纯文本 "done"。
  __setChatCreateImpl(async () => {
    createCallCount++;
    if (createCallCount === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
              },
            ],
          },
        },
        { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      ]);
    }
    return sseStream([
      { delta: { content: 'done' } },
      { usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205 } },
    ]);
  });

  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const events: string[] = [];
    const hooks: AgentHooks = {
      onStepStart: () => events.push('step_start'),
      onToolCall: (name) => events.push(`tool_call:${name}`),
      onToolHeader: (tc) => events.push(`tool_header:${tc.name}`),
      onToolStart: (name) => events.push(`tool_start:${name}`),
      onToolResult: (tc, output) => events.push(`tool_result:${tc.name}:${output.length > 0 ? 'ok' : 'empty'}`),
      onToolDone: () => events.push('tool_done'),
      onToolBatchEnd: () => events.push('batch_end'),
      onChatDone: () => events.push('chat_done'),
      onText: (delta) => events.push(`text:${delta}`),
      onTextEnd: () => events.push('text_end'),
      onDone: () => events.push('done'),
    };

    const result = await runAgentCore({
      history,
      userInput: 'hi',
      hooks,
      // 禁用真实权限弹窗;read_file 是 safe 不会走到,但显式传一个更稳。
      permissionPrompt: () => Promise.resolve({ action: 'cancelled' }),
    });

    // ── 结果断言 ──
    assert.equal(result.completed, true, '应正常完成');
    assert.equal(result.terminationReason, 'completed');
    assert.equal(result.finalText, 'done');
    assert.equal(result.usage?.totalTokens, 315, '两步 usage 应累加');

    // ── history 结构断言:[system, user, assistant(tool_call), tool, assistant(text)] ──
    assert.equal(history.length, 5, `history 应 5 条,实际 ${history.length}`);
    assert.equal(history[0].role, 'system');
    assert.equal(history[1].role, 'user');
    assert.equal((history[1] as { content?: string }).content, 'hi');

    assert.equal(history[2].role, 'assistant');
    const assistantMsg = history[2] as { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
    assert.equal(assistantMsg.tool_calls?.[0]?.function.name, 'read_file');

    assert.equal(history[3].role, 'tool');
    const toolMsg = history[3] as { content?: string; tool_call_id?: string };
    assert.equal(toolMsg.tool_call_id, 'call-1');
    assert.ok(toolMsg.content?.includes('mocode-fixture-content'), '工具结果应含 fixture.txt 内容');

    assert.equal(history[4].role, 'assistant');
    assert.equal((history[4] as { content?: string }).content, 'done');

    // ── hooks 顺序断言:验证执行编排未变 ──
    // 流式解析顺序:onToolCall(生成中 spinner)在 chunk 到达时即发,先于 onChatDone;
    // onText 同理(chunk 到达即回调),先于 onChatDone。
    // 第一次 chat 完成 → tool header → tool start → tool result → tool done → batch end
    // 第二次 chat 文本流 → text → chat done → text_end → done
    const expectedSequence = [
      'step_start',
      'tool_call:read_file',
      'chat_done',
      'tool_header:read_file',
      'tool_start:read_file',
      'tool_result:read_file:ok',
      'tool_done',
      'batch_end',
      'step_start',
      'text:done',
      'chat_done',
      'text_end',
      'done',
    ];
    assert.deepEqual(events, expectedSequence, `hooks 顺序不一致:\n实际: ${JSON.stringify(events)}`);
  } finally {
    __setChatCreateImpl(null);
    setSandboxRoot(prevRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAgentCore: 无工具直接文本回复', async () => {
  __setChatCreateImpl(async () =>
    sseStream([
      { delta: { content: 'hello' } },
      { usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 } },
    ]),
  );

  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const events: string[] = [];
    const result = await runAgentCore({
      history,
      userInput: 'hi',
      hooks: {
        onText: (d) => events.push(`text:${d}`),
        onDone: () => events.push('done'),
      },
    });

    assert.equal(result.completed, true);
    assert.equal(result.finalText, 'hello');
    assert.equal(history.length, 3); // system + user + assistant
    assert.deepEqual(events, ['text:hello', 'done']);
  } finally {
    __setChatCreateImpl(null);
  }
});

test('runAgentCore: abort 在第一步前还原 history', async () => {
  const controller = new AbortController();
  controller.abort(); // 立即中止

  __setChatCreateImpl(async () => {
    throw new Error('不应被调用:signal 已中止');
  });

  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const result = await runAgentCore({
      history,
      userInput: 'hi',
      signal: controller.signal,
      hooks: {},
    });

    assert.equal(result.completed, false);
    assert.equal(result.terminationReason, 'aborted');
    assert.equal(result.finalText, null);
    // abort 还原:history 应只剩 system + user(循环顶的 signal.aborted 检查触发 abortRestore)
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'system');
    assert.equal(history[1].role, 'user');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('runAgentCore: 自定义 runtimeContext 生效(参数化可用,非仅绑定全局单例)', async () => {
  // 注入一个自定义 context:覆盖 getCurrentSessionId(进 trace sessionId)与
  // getActiveModel(进 model_start trace / chat model 字段)。其余成员沿用全局默认。
  // 验证 runAgentCore 确实经 ctx 读取这两个值,而非直读模块级单例。
  __setChatCreateImpl(async () =>
    sseStream([{ delta: { content: 'ok' } }, { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }]),
  );

  const traceEvents: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];

  try {
    const { defaultAgentRuntimeContext } = await import('../src/agent/runtime-context.js');
    const customCtx = {
      ...defaultAgentRuntimeContext,
      getCurrentSessionId: () => 'custom-session-xyz',
      getActiveModel: () => 'custom-model-abc',
    };

    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const result = await runAgentCore({
      history,
      userInput: 'hi',
      hooks: {},
      runtimeContext: customCtx,
      onTraceEvent: (e) => traceEvents.push({ sessionId: e.sessionId, type: e.type, data: e.data }),
    });

    assert.equal(result.completed, true);
    assert.equal(result.finalText, 'ok');

    // 所有 trace 事件的 sessionId 必须来自自定义 context,而非全局 getCurrentSessionId()
    assert.ok(traceEvents.length > 0, '应有 trace 事件');
    for (const e of traceEvents) {
      assert.equal(e.sessionId, 'custom-session-xyz', `trace 事件 ${e.type} 的 sessionId 应来自自定义 context`);
    }
    // model_start 事件的 model 字段必须来自自定义 getActiveModel()
    const modelStart = traceEvents.find((e) => e.type === 'model_start');
    assert.ok(modelStart, '应有 model_start 事件');
    assert.equal(modelStart.data.model, 'custom-model-abc', 'model_start.model 应来自自定义 context');
  } finally {
    __setChatCreateImpl(null);
  }
});
