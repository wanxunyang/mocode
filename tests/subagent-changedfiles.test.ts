/** 子 agent changedFiles 归属测试(P4 闸3 成功路径)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAgent } from '../src/agent/spawn.js';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { clearToolsExtension, registerToolsExtension } from '../src/tools/registry.js';
import type { Tool, ToolOutcome } from '../src/tools/types.js';
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
    for (const chunk of chunks) yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [] };
  })();
}

test('spawnAgent 闸3: 子 agent 工具的 changedFiles 经 onToolOutcome 真实回填 SpawnResult', async () => {
  const previousSubagent = process.env.MOCODE_SUBAGENT_ENABLED;
  process.env.MOCODE_SUBAGENT_ENABLED = 'true';
  const source = 'subagent-changedfiles';

  // 扩展工具:执行后自报 changedFiles。
  const touchTool: Tool = {
    name: 'touch_ext',
    description: 'touches a file',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    capabilities: { effect: 'write', concurrency: 'resource-locked' },
    async execute(args): Promise<ToolOutcome> {
      return {
        status: 'success',
        code: 'OK',
        retryable: false,
        output: `touched ${String(args.path)}`,
        changedFiles: [String(args.path)],
      };
    },
  };
  registerToolsExtension(source, [touchTool]);

  let call = 0;
  __setChatCreateImpl(async () => {
    call++;
    if (call === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [{ index: 0, id: 't1', function: { name: 'touch_ext', arguments: '{"path":"src/gen/a.ts"}' } }],
          },
        },
      ]);
    }
    return sseStream([{ delta: { content: 'task complete' } }]);
  });

  // delegation 前缀:子 agent 复用父工具面(含扩展工具 schema)。
  const parentHistory = [
    { role: 'system', content: 'PARENT' },
    { role: 'user', content: 'do it' },
  ] as never[];
  const parentTools = [
    { type: 'function', function: { name: 'touch_ext', description: 'touch', parameters: {} } },
    { type: 'function', function: { name: 'read_file', description: 'read', parameters: {} } },
  ] as never[];

  try {
    const result = await spawnAgent({
      prompt: 'generate a.ts',
      maxSteps: 3,
      delegation: { history: parentHistory, tools: parentTools },
    });

    assert.equal(result.completed, true);
    assert.deepEqual(result.changedFiles, ['src/gen/a.ts'], '工具自报的改动必须经 onToolOutcome 回填');
  } finally {
    __setChatCreateImpl(null);
    clearToolsExtension(source);
    if (previousSubagent === undefined) delete process.env.MOCODE_SUBAGENT_ENABLED;
    else process.env.MOCODE_SUBAGENT_ENABLED = previousSubagent;
  }
});
