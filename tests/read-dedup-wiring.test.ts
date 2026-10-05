/**
 * read_file 重复读短路的**生产路径**接线验证(2026-10-05)。
 *
 * 背景:`ReadDedup` 功能与单测都齐备(`tests/read-file-dedup.test.ts` 覆盖了工具级三场景),
 * 但生产路径从未把它传进工具 —— 默认 pipeline 是 `legacy`,走
 * `run-coordinator.ts` 的内联 dispatch,其 5 个 `executeToolOutcome` 调用点全部漏传
 * `readDedup`(只有 staged 的 `stages/tool-dispatcher.ts` 传了)。于是
 * `config.readDedup`(默认 true)形同虚设,模型重复读同一区间会再次吃满
 * `MAX_HISTORY_RESULT`(8000 字符 ≈ 2k token)。
 *
 * 本测试走完整 runAgentCore 链路(不直接调工具),证明修复后生产路径真的短路。
 * 脚手架约定见 tests/agent-core.test.ts 头部说明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentCore } from '../src/agent/core.js';
import { defaultAgentRuntimeContext } from '../src/agent/runtime-context.js';
import { __setChatCreateImpl, type ChatMessage } from '../src/llm/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { config } from '../src/config/index.js';
import '../src/tools/builtins/index.js';

function sseStream(
  chunks: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>,
): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [] };
    }
  })();
}

test('生产路径: 同一 turn 内重复 read_file 同一区间 → 第二次返短指针', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-dedup-wiring-'));
  const file = join(root, 'target.ts');
  // 足够长,确保首次返回是完整正文(不会被 MAX_HISTORY_RESULT 截断)
  const body = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join('\n');
  writeFileSync(file, body, 'utf8');
  const prevRoot = setSandboxRoot(root);
  const prevDedup = config.readDedup;
  config.readDedup = true;

  const args = JSON.stringify({ path: file, offset: 1, limit: 200 });
  let call = 0;
  try {
    __setChatCreateImpl(async () => {
      call++;
      if (call <= 2) {
        // 前两轮各发一次「读同一区间」的 tool_call
        return sseStream([
          {
            delta: {
              tool_calls: [{ index: 0, id: `dedup-${call}`, function: { name: 'read_file', arguments: args } }],
            },
          },
        ]);
      }
      return sseStream([{ delta: { content: 'done' } }]);
    });

    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const toolOutputs: string[] = [];
    await runAgentCore({
      history,
      userInput: 'read the same range twice',
      maxSteps: 4,
      runtimeAllowedToolNames: new Set(['read_file']),
      runtimeContext: {
        ...defaultAgentRuntimeContext,
        getAgentMode: () => 'auto' as const,
        checkPermission: async () => 'allow' as const,
      },
      hooks: {
        onToolResult: (_tc, output) => {
          toolOutputs.push(output);
        },
      },
    });

    assert.ok(toolOutputs.length >= 2, `应至少执行两次 read_file,实际 ${toolOutputs.length}`);
    const [first, second] = toolOutputs;
    assert.match(first, /const line0/, '首次必须返回完整正文');
    assert.doesNotMatch(first, /unchanged since/, '首次不应短路');

    // 核心断言:生产路径必须短路(修复前这里会是第二份完整正文)
    assert.match(second, /unchanged since step 0/, '生产路径第二次读同一区间应返短指针');
    assert.ok(second.length < first.length / 2, `短指针应显著短于全文:first=${first.length} second=${second.length}`);
  } finally {
    config.readDedup = prevDedup;
    setSandboxRoot(prevRoot);
    __setChatCreateImpl(null);
  }
});
