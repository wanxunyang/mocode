/** 子 agent 撞步数上限 salvage 测试:maxSteps 终止前的无工具收尾请求把探索成果带回。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAgent, type SpawnResult } from '../src/agent/spawn.js';
import { __setChatCreateImpl, type ChatMessage } from '../src/llm/index.js';
import { runAgentCore } from '../src/agent/core.js';
import { defaultAgentRuntimeContext } from '../src/agent/runtime-context.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { ToolPolicyController } from '../src/tools/policy.js';
import '../src/tools/builtins/index.js';

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
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>,
): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [], ...(chunk.usage ? { usage: chunk.usage } : {}) };
    }
  })();
}

/**
 * 记录每次请求的 tools,前 N 步回工具调用(read_file fixture),之后纯文本收尾。
 * 用于触发「模型步数耗尽」:maxSteps=2 时,step0 read_file → step1 再 read_file(继续)
 * → 循环结束进入 loop_exhausted → salvage 请求(无 tools)返回摘要文本。
 */
function stubWithStepLog(
  toolCallSteps: number,
  log: Array<{ tools: unknown[] | undefined; messages: ChatMessage[] }>,
): void {
  let call = 0;
  __setChatCreateImpl(async (body) => {
    const b = body as { tools?: unknown[]; messages?: ChatMessage[] };
    log.push({ tools: b.tools, messages: (b.messages ?? []) as ChatMessage[] });
    call++;
    if (call <= toolCallSteps) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `salv-call-${call}`,
                function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
              },
            ],
          },
        },
      ]);
    }
    return sseStream([{ delta: { content: `salvage-summary-step-${call}` } }]);
  });
}

test('runAgentCore: 撞 maxSteps 后 salvage 请求(无工具)带回最终摘要', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-salvage-core-'));
  writeFileSync(join(root, 'fixture.txt'), 'salvage-fixture', 'utf8');
  const previousRoot = setSandboxRoot(root);
  const log: Array<{ tools: unknown[] | undefined; messages: ChatMessage[] }> = [];
  stubWithStepLog(2, log);
  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const result = await runAgentCore({
      history,
      userInput: 'explore then get cut off',
      hooks: {},
      maxSteps: 2,
      toolPolicy: new ToolPolicyController({ id: 'salvage-core', maxExpansions: 0 }),
      runtimeContext: { ...defaultAgentRuntimeContext, getAgentMode: () => 'auto' as const },
    });

    // 语义诚实:撞限仍是 completed=false + terminationReason=max_steps。
    assert.equal(result.completed, false);
    assert.equal(result.terminationReason, 'max_steps');
    // 但成果不再丢弃:finalText 来自 salvage 请求的纯文本回复。
    assert.equal(result.finalText, 'salvage-summary-step-3');
    // salvage 请求无工具 schema(纯文本收尾,不能再发工具调用)。
    const lastRequest = log[log.length - 1];
    assert.ok(lastRequest, '应有 salvage 请求');
    assert.equal(lastRequest.tools?.length ?? 0, 0, 'salvage 请求 tools 必须为空');
    // salvage 指令以尾部 system 注入,不改写既有 history(缓存前缀稳定)。
    const lastMessages = lastRequest.messages;
    assert.equal(lastMessages?.[lastMessages.length - 1]?.role, 'system');
    assert.match(String(lastMessages?.[lastMessages.length - 1]?.content ?? ''), /final summary/);
  } finally {
    __setChatCreateImpl(null);
    setSandboxRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawnAgent: 撞限子 agent 经 salvage 带回摘要,task 结果不再只有「被中断」', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-salvage-spawn-'));
  writeFileSync(join(root, 'fixture.txt'), 'salvage-fixture', 'utf8');
  const previousRoot = setSandboxRoot(root);
  const log: Array<{ tools: unknown[] | undefined; messages: ChatMessage[] }> = [];
  stubWithStepLog(2, log);
  try {
    const result: SpawnResult = await spawnAgent({ prompt: 'explore deeply', maxSteps: 2 });

    // status 语义不变(撞限=failed),但 summary 有真实内容。
    assert.equal(result.status, 'failed');
    assert.equal(result.completed, false);
    assert.equal(result.summary, 'salvage-summary-step-3');
    // 有工具历史 → salvage 发生;无工具时(纯文本撞限)不发。
    assert.equal(log.length, 3, '2 步 + 1 次 salvage 收尾');
    assert.equal(log[2].tools?.length ?? 0, 0, 'salvage 请求无工具');
  } finally {
    __setChatCreateImpl(null);
    setSandboxRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAgentCore: salvage 请求失败时静默回退旧行为(finalText=null 不抛错)', async () => {
  const log: Array<{ tools: unknown[] | undefined; messages: ChatMessage[] }> = [];
  let call = 0;
  __setChatCreateImpl(async (body) => {
    const b = body as { tools?: unknown[]; messages?: ChatMessage[] };
    log.push({ tools: b.tools, messages: (b.messages ?? []) as ChatMessage[] });
    call++;
    // 每步都返回一个工具调用,永远「继续」,但第 3 步(撞限后)直接报错 → 无 salvage 文本。
    if (call <= 2) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `nosalv-${call}`,
                function: { name: 'read_file', arguments: '{"path":"nope.txt"}' },
              },
            ],
          },
        },
      ]);
    }
    // 撞限后的 salvage 请求:抛错,验证失败静默回退。
    throw new Error('salvage transport failure');
  });
  const root = mkdtempSync(join(tmpdir(), 'mocode-salvage-fail-'));
  const previousRoot = setSandboxRoot(root);
  writeFileSync(join(root, 'fixture.txt'), 'x', 'utf8');
  try {
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const result = await runAgentCore({
      history,
      userInput: 'get cut off with failing salvage',
      hooks: {},
      maxSteps: 2,
      toolPolicy: new ToolPolicyController({ id: 'salvage-fail', maxExpansions: 0 }),
      runtimeContext: { ...defaultAgentRuntimeContext, getAgentMode: () => 'auto' as const },
    });

    assert.equal(result.terminationReason, 'max_steps');
    // salvage 失败 → 回退旧行为:finalText=null,不因请求异常抛错。
    assert.equal(result.finalText, null);
  } finally {
    __setChatCreateImpl(null);
    setSandboxRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});
