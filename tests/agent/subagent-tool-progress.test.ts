/**
 * sub-agent 工具的进度接线：`ctx.onOutput` → `spawnAgent({ progress })`。
 *
 * 单独钉这条线的原因：spawn 的 progress 通道只是「有回调就吐」，
 * 真正决定 GUI 能不能看见子 agent 内部动作的是 task.ts 有没有把 ctx.onOutput 接上去。
 * 漏接时类型检查、单测、终端体验全都正常，只有 GUI 上那张卡片永远是静止的 —— 很难事后定位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { subAgentTool } from '../../src/tools/builtins/task.js';
import { __setChatCreateImpl } from '../../src/llm/index.js';
import { clearToolsExtension, registerToolsExtension } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/types.js';
import '../../src/tools/builtins/index.js';

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

const wireEcho: Tool = {
  name: 'wire_echo',
  description: 'echo',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  capabilities: { effect: 'read', concurrency: 'parallel' },
  async execute(args) {
    return `read ${String(args.path)}`;
  },
};

test('sub-agent 工具把 ctx.onOutput 作为子 agent 的 progress 通道', async () => {
  const previous = process.env.MOCODE_SUBAGENT_ENABLED;
  process.env.MOCODE_SUBAGENT_ENABLED = 'true';
  const source = 'subagent-tool-progress';
  registerToolsExtension(source, [wireEcho]);
  let call = 0;
  __setChatCreateImpl(async () => {
    call++;
    if (call === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [{ index: 0, id: 'w1', function: { name: 'wire_echo', arguments: '{"path":"src/a.ts"}' } }],
          },
        },
      ]);
    }
    return sseStream([{ delta: { content: '子任务完成' } }]);
  });
  const chunks: string[] = [];
  try {
    const outcome = await subAgentTool.execute({ prompt: '读 src/a.ts' }, {
      onOutput: (chunk: string) => chunks.push(chunk),
      delegation: {
        history: [
          { role: 'system', content: 'PARENT' },
          { role: 'user', content: 'go' },
        ] as never[],
        tools: [{ type: 'function', function: { name: 'wire_echo', description: 'echo', parameters: {} } }] as never[],
      },
    } as never);
    const text = typeof outcome === 'string' ? outcome : outcome.output;
    assert.match(text, /子任务完成/);
    assert.ok(chunks.length > 0, '子 agent 内部工具调用必须经 ctx.onOutput 到达宿主');
    assert.match(chunks.join(''), /▸ wire_echo/, `实际进度: ${JSON.stringify(chunks)}`);
  } finally {
    __setChatCreateImpl(null);
    clearToolsExtension(source);
    if (previous === undefined) delete process.env.MOCODE_SUBAGENT_ENABLED;
    else process.env.MOCODE_SUBAGENT_ENABLED = previous;
  }
});
