/** 子 agent 递归深度闸测试(#token-efficiency P4 闸2)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAgent, type SpawnResult } from '../src/agent/spawn.js';
import { __setChatCreateImpl, type ChatCreateImpl } from '../src/llm/index.js';
import '../src/tools/builtins/index.js';

function textStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
  })();
}

/**
 * 递归 chat stub:每次「模型响应」前先派生下一层子 agent。
 * stub 在 spawnDepthScope ALS scope 内执行,故嵌套 spawnAgent 读到的深度逐层 +1。
 */
function recursiveStub(depth: number, outcomes: SpawnResult[]): ChatCreateImpl {
  const impl: ChatCreateImpl = async (_body, _opts) => {
    if (depth < 4) {
      const nested = await spawnAgent({ prompt: `nested@${depth + 1}`, maxSteps: 1 });
      outcomes.push(nested);
      if (nested.status === 'failed') return textStream(`blocked@${depth}: ${nested.summary ?? ''}`);
      return textStream(`done@${depth}`);
    }
    return textStream('bottom');
  };
  return impl;
}

test('spawnAgent 深度闸: 默认上限 3, 第 4 层结构化失败且不发请求', async () => {
  const previousSubagent = process.env.MOCODE_SUBAGENT_ENABLED;
  process.env.MOCODE_SUBAGENT_ENABLED = 'true';
  const outcomes: SpawnResult[] = [];
  let requestCount = 0;
  const counting: ChatCreateImpl = async (body) => {
    requestCount++;
    return recursiveStub(1, outcomes)(body, undefined);
  };
  __setChatCreateImpl(counting);

  try {
    // 根 → depth1;其 stub 内派生 depth2 → depth3 → depth4(拦截)。
    const root = await spawnAgent({ prompt: 'root', maxSteps: 1 });

    // depth1/2/3 成功;depth4 在 outcomes 里最后一个且 failed。
    assert.equal(root.status, 'completed');
    const byStatus: Record<'completed' | 'failed' | 'aborted', number> = {
      completed: 0,
      failed: 0,
      aborted: 0,
    };
    for (const o of outcomes) byStatus[o.status]++;
    assert.equal(byStatus.completed, 2, 'depth2/depth3 成功');
    assert.equal(byStatus.failed, 1, 'depth4 被拦截');

    const blocked = outcomes.find((o) => o.status === 'failed');
    assert.match(blocked?.summary ?? '', /depth limit 3/);
    assert.deepEqual(blocked?.changedFiles, []);

    // 被拦截的一层没有真正发 LLM 请求:只有 depth1/2/3 各 1 次 = 3。
    assert.equal(requestCount, 3);
  } finally {
    __setChatCreateImpl(null);
    if (previousSubagent === undefined) delete process.env.MOCODE_SUBAGENT_ENABLED;
    else process.env.MOCODE_SUBAGENT_ENABLED = previousSubagent;
  }
});
