/**
 * 子 agent 运行期进度通道（spawnAgent opts.progress）。
 *
 * 为什么需要这条通道：子 agent 内部步骤的实时渲染原本只有 TUI 一条路
 * （spawn.ts 里 `live = isTuiActive() && !quiet`）。host/GUI 不是 TTY，于是
 * 派活之后界面上只有一张静止的「执行中」卡片，用户分不清在跑还是卡死。
 * progress 让宿主用自身通道（work-app 走 tool_output）展示同样的信息。
 *
 * 这里钉两件事：
 *   1. 每次内部工具调用都会吐一行「▸ 工具名  对象」，且不包含本轮正文；
 *   2. 没传 progress 时不崩、也不影响结果（向后兼容旧调用方）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAgent } from '../../src/agent/spawn.js';
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

const echoTool: Tool = {
  name: 'progress_echo',
  description: 'echoes its argument',
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

/** 第一轮发一次工具调用，第二轮结束。 */
function stubOneToolCall(): void {
  let call = 0;
  __setChatCreateImpl(async () => {
    call++;
    if (call === 1) {
      return sseStream([
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'p1', function: { name: 'progress_echo', arguments: '{"path":"src/agent/spawn.ts"}' } },
            ],
          },
        },
      ]);
    }
    return sseStream([{ delta: { content: 'done' } }]);
  });
}

test('spawnAgent progress: 每次内部工具调用回吐一行「▸ 工具名 对象」', async () => {
  const source = 'subagent-progress';
  registerToolsExtension(source, [echoTool]);
  stubOneToolCall();
  const lines: string[] = [];
  try {
    const result = await spawnAgent({
      prompt: '读一个文件',
      maxSteps: 3,
      progress: (line) => lines.push(line),
      delegation: {
        history: [
          { role: 'system', content: 'PARENT' },
          { role: 'user', content: 'go' },
        ] as never[],
        tools: [
          { type: 'function', function: { name: 'progress_echo', description: 'echo', parameters: {} } },
        ] as never[],
      },
    });
    assert.equal(result.completed, true);
    assert.ok(lines.length > 0, '有内部工具调用就必须有进度行');
    assert.match(lines[0]!, /^▸ progress_echo\s+/, `进度行格式: ${JSON.stringify(lines[0])}`);
    assert.match(lines[0]!, /spawn\.ts/, '进度行要带工具对象（用户看不出「在跑什么」等于没给）');
    // 正文不进进度通道：那是 assistant 的最终结论，由工具结果回灌，重复会误导。
    assert.ok(!lines.some((line) => line.includes('done')), '进度通道只承载工具动作');
  } finally {
    __setChatCreateImpl(null);
    clearToolsExtension(source);
  }
});

test('spawnAgent 不传 progress 时结果不变（向后兼容）', async () => {
  const source = 'subagent-progress-none';
  registerToolsExtension(source, [echoTool]);
  stubOneToolCall();
  try {
    const result = await spawnAgent({
      prompt: '读一个文件',
      maxSteps: 3,
      delegation: {
        history: [
          { role: 'system', content: 'PARENT' },
          { role: 'user', content: 'go' },
        ] as never[],
        tools: [
          { type: 'function', function: { name: 'progress_echo', description: 'echo', parameters: {} } },
        ] as never[],
      },
    });
    assert.equal(result.completed, true);
    assert.ok(result.summary, '没有 progress 也必须正常产出摘要');
  } finally {
    __setChatCreateImpl(null);
    clearToolsExtension(source);
  }
});
test('spawnAgent progress: 每次内部调用另吐 start/end 两条 [sub-tool] 机器行（带入参与输出）', async () => {
  const source = 'subagent-progress-structured';
  registerToolsExtension(source, [echoTool]);
  stubOneToolCall();
  const lines: string[] = [];
  try {
    const result = await spawnAgent({
      prompt: '读一个文件',
      maxSteps: 3,
      progress: (line) => lines.push(line),
      delegation: {
        history: [
          { role: 'system', content: 'PARENT' },
          { role: 'user', content: 'go' },
        ] as never[],
        tools: [
          { type: 'function', function: { name: 'progress_echo', description: 'echo', parameters: {} } },
        ] as never[],
      },
    });
    assert.equal(result.completed, true);
    const machine = lines
      .filter((line) => line.startsWith('[sub-tool]'))
      .map((line) => JSON.parse(line.slice('[sub-tool]'.length)) as Record<string, unknown>);
    const start = machine.find((entry) => entry.phase === 'start');
    const end = machine.find((entry) => entry.phase === 'end');
    assert.ok(start, `缺 start 机器行: ${JSON.stringify(lines)}`);
    assert.ok(end, `缺 end 机器行: ${JSON.stringify(lines)}`);
    assert.equal(start.name, 'progress_echo');
    assert.match(String(start.args), /spawn\.ts/, 'start 必须带完整入参（展开区看的就是它）');
    assert.equal(end.name, 'progress_echo');
    assert.match(String(end.output), /read src\/agent\/spawn\.ts/, 'end 必须带该次调用输出');
    assert.equal(end.failed, false);
    // 单行是硬约束：宿主按 \n 累积，多行会把一条机器行劈成两半。
    for (const line of lines) assert.ok(!line.replace(/\n$/, '').includes('\n'), '进度行内不得含裸换行');
  } finally {
    __setChatCreateImpl(null);
    clearToolsExtension(source);
  }
});
