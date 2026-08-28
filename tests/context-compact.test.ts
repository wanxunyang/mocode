/** compactHistory 单元测试(从 scripts/core-tests/compact.test.ts 迁移到 node:test)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/llm/index.js';
import {
  compactHistory,
  createContextState,
  keyFactsBudgetChars,
  mergeKeyFacts,
  splitSummaryText,
} from '../src/session/compact.js';
import {
  SUMMARY_KEYFACTS_MAX_CHARS,
  SUMMARY_KEYFACTS_MIN_CHARS,
} from '../src/tools/constants.js';
import { appendTool, contentAt, system } from './helpers.js';

function compactableHistory(): { history: ChatMessage[]; oldIdx: number } {
  const history: ChatMessage[] = [system('current system')];
  const oldIdx = appendTool(history, 'read_file', 'old-read', { path: 'src/old.ts' }, 'x'.repeat(2_000));
  history.push({ role: 'user', content: 'continue' } as ChatMessage);
  appendTool(history, 'run_command', 'latest', { command: 'echo ok' }, 'ok');
  return { history, oldIdx };
}

function assertToolCallsHaveProducers(history: ChatMessage[]): void {
  const seen = new Set<string>();
  for (const message of history) {
    if (message.role === 'assistant') {
      const calls = (message as { tool_calls?: { id?: string }[] }).tool_calls ?? [];
      for (const call of calls) if (call.id) seen.add(call.id);
    }
    if (message.role === 'tool') {
      const id = (message as { tool_call_id?: string }).tool_call_id;
      assert.ok(id && seen.has(id), `orphan tool result: ${id ?? '<missing id>'}`);
    }
  }
}

test('splitSummaryText 摘出 Key Facts 段并剥掉头/provenance', () => {
  const raw = [
    '# 会话摘要',
    '## Completed',
    '改了 src/a.ts',
    '## Key Facts',
    '- 所有 Python 代码必须用类型注解',
    '- src/a.ts:42 是入口',
    '',
    '[artifact refs: src/a.ts]',
  ].join('\n');
  const { keyFacts, rest } = splitSummaryText(raw);
  assert.equal(keyFacts, '- 所有 Python 代码必须用类型注解\n- src/a.ts:42 是入口');
  assert.equal(rest, '## Completed\n改了 src/a.ts');
  assert.ok(!keyFacts.includes('artifact refs'), 'provenance 不得混进钉住段');
});

test('splitSummaryText 无 Key Facts 段时整段归叙述', () => {
  const { keyFacts, rest } = splitSummaryText('# 会话摘要\n## Completed\ndid work');
  assert.equal(keyFacts, '');
  assert.equal(rest, '## Completed\ndid work');
});

test('mergeKeyFacts 跨代去重,超预算丢较新条目', () => {
  const old1 = '- 首轮约束:不要用 Any';
  const old2 = '- src/a.ts:42 是入口';
  const merged = mergeKeyFacts(old1, `${old2}\n- 首轮约束:不要用 Any`, 10_000);
  assert.equal(merged, `${old1}\n${old2}`, '重复事实只留一条,且保持老 → 新顺序');

  const capped = mergeKeyFacts(old1, `${old2}\n- 新事实`, old1.length + 2);
  assert.ok(capped.startsWith(old1), '超预算时保最老的(首轮约束)');
  assert.ok(!capped.includes('新事实'), '超预算时丢较新的');
  assert.match(capped, /已省略较新条目/);
});

test('keyFactsBudgetChars 小窗口保下限、大窗口封上限', () => {
  assert.equal(keyFactsBudgetChars(8000), SUMMARY_KEYFACTS_MIN_CHARS);
  assert.equal(keyFactsBudgetChars(1_000_000), SUMMARY_KEYFACTS_MAX_CHARS);
  assert.ok(keyFactsBudgetChars(64_000) > SUMMARY_KEYFACTS_MIN_CHARS);
});

test('连续三代压缩后首轮约束仍存活(Key Facts 钉住,不递归衰减)', async () => {
  // 摘要写在 history[1](role:'system'),groupFromEnd 只排除 history[0] → 旧实现每代
  // 压缩都把它当普通 group 送进摘要器再摘要一遍,首轮约束 2-3 代就没了。
  // 有损摘要器(只从 user/tool 原文摘约束、不保证保留 system 摘要里的事实)模拟这一点。
  const lossySummarizer = (older: ChatMessage[]): string => {
    const facts: string[] = [];
    for (const m of older) {
      if (m.role !== 'user' && m.role !== 'tool') continue;
      const text = typeof m.content === 'string' ? m.content : '';
      for (const line of text.split('\n')) {
        if (line.includes('CONSTRAINT:')) facts.push(line.trim());
      }
    }
    return ['## Completed', 'did work', '## Key Facts', ...facts.map((f) => `- ${f}`)].join('\n');
  };

  const CONSTRAINT = 'CONSTRAINT: 所有 Python 代码必须用类型注解';
  const history: ChatMessage[] = [system()];
  history.push({ role: 'user', content: CONSTRAINT } as ChatMessage);
  const transcripts: string[] = [];

  for (let gen = 1; gen <= 3; gen++) {
    history.push({ role: 'user', content: `round ${gen}` } as ChatMessage);
    appendTool(history, 'read_file', `read-${gen}`, { path: `f${gen}.ts` }, 'y'.repeat(3_000));
    const result = await compactHistory(history, {
      window: 1_200,
      threshold: 100,
      contextState: createContextState(),
      summarize: async (older) => {
        transcripts.push(
          older.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'),
        );
        return lossySummarizer(older);
      },
    });
    assert.equal(result.reason, 'summarize', `第 ${gen} 代应走摘要`);
    assertToolCallsHaveProducers(history);
  }

  // 恒单条摘要:并排多条 system 摘要会触发近因效应,等于白钉。
  assert.equal(history.filter((m) => m.role === 'system').length, 2);
  assert.match(contentAt(history, 1), /^# 会话摘要/);
  assert.ok(
    contentAt(history, 1).includes(CONSTRAINT),
    '首轮约束必须在第 3 代摘要里存活',
  );
  // 叙述段照常滚动:上一代叙述要进 transcript,否则更早的轮次等于被整段丢弃。
  assert.ok(transcripts[1].includes('did work'), '上一代叙述段必须并入转录');
  // 钉住的 Key Facts 不再进摘要器(否则就是又一遍再摘要)。
  assert.ok(
    !transcripts[1].includes('CONSTRAINT:'),
    '已钉住的 Key Facts 不应再喂给摘要器',
  );
  assertToolCallsHaveProducers(history);
});

test('压缩后必须仍有一条非空 user(否则下一步 chat 被 transport 守卫拒)', async () => {
  // 长回合里保留区可能全是 assistant+tool 组:user 只有一个、在很前面,而保留区从尾部
  // 累积,一旦最近的若干组就吃满 keepBudget,user 会全落进旧区被摘要掉。
  // 后果:重建后 history 无 user → chatOnce 的 hasNonEmptyUser 直接抛。
  const history: ChatMessage[] = [system()];
  history.push({ role: 'user', content: 'fix the bug in a.ts' } as ChatMessage);
  appendTool(history, 'read_file', 'big-1', { path: 'a.ts' }, 'x'.repeat(8_000));
  appendTool(history, 'read_file', 'big-2', { path: 'b.ts' }, 'y'.repeat(8_000));
  const result = await compactHistory(history, {
    window: 8_000, // keepBudget = 1200 token:两个 8000 字符的工具组放不下
    threshold: 100,
    contextState: createContextState(),
    summarize: async () => '## Completed\n读了 a.ts 与 b.ts',
  });
  assert.equal(result.reason, 'summarize');
  assert.ok(
    history.some(
      (m) =>
        m.role === 'user' &&
        String((m as { content?: unknown }).content ?? '').trim().length > 0,
    ),
    '压缩后必须仍有非空 user 消息',
  );
  assertToolCallsHaveProducers(history);
});

test('compactHistory 原地摘要并保持尾部 tool-call group 完整', async () => {
  const { history } = compactableHistory();
  const originalRef = history;
  let summarizedIds: string[] = [];
  const state = createContextState();
  const result = await compactHistory(history, {
    window: 100,
    threshold: 100,
    contextState: state,
    summarize: async (older) => {
      summarizedIds = older
        .filter((message) => message.role === 'tool')
        .map((message) => (message as { tool_call_id?: string }).tool_call_id ?? '');
      return 'old work summary';
    },
  });

  assert.equal(history, originalRef);
  assert.equal(result.compacted, true);
  assert.equal(result.summarized, true);
  assert.equal(result.historyRebuilt, true);
  assert.deepEqual(summarizedIds, ['old-read']);
  assert.equal(history[0].role, 'system');
  assert.match(contentAt(history, 1), /^# 会话摘要/);
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'latest'));
  assert.ok(!history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'old-read'));
  assertToolCallsHaveProducers(history);
  assert.equal(state.correction, 1);
});

test('压缩中 Ctrl+C:signal 透传摘要器,AbortError 冒泡而非降级微压缩', async () => {
  // 摘要是几十秒的 LLM 调用。旧实现把 signal 丢了(chat(..., undefined, [])),
  // 且 catch 掉一切异常降级成微压缩——Ctrl+C 后用户还得干等它跑完,然后又被"压缩"一遍。
  const { history } = compactableHistory();
  const snapshot = JSON.stringify(history);
  const ac = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const outcome = await compactHistory(history, {
    window: 100,
    threshold: 100,
    contextState: createContextState(),
    signal: ac.signal,
    summarize: async (_older, _focus, signal) => {
      seenSignal = signal;
      throw new DOMException('This operation was aborted', 'AbortError');
    },
  }).then(
    () => 'resolved',
    (e: unknown) => (e as { name?: string }).name ?? 'unknown',
  );

  assert.equal(seenSignal, ac.signal, 'signal 必须透传给摘要器');
  assert.equal(outcome, 'AbortError', '中断必须冒泡,让 runAgentCore 走 abortRestore');
  // 重建发生在摘要成功之后,中断时 history 必须原样未动(否则 abortRestore 还原不干净)
  assert.equal(JSON.stringify(history), snapshot, '中断后 history 不得被改动');
});

test('压缩前已中断:直接抛,不降级微压缩', async () => {
  // signal 在调用前就 aborted(用户在上一步末尾按的 Ctrl+C)。
  const { history } = compactableHistory();
  const snapshot = JSON.stringify(history);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    compactHistory(history, {
      window: 100,
      threshold: 100,
      contextState: createContextState(),
      signal: ac.signal,
      summarize: async () => '不该被调用',
    }),
    (e: unknown) => (e as { name?: string }).name === 'AbortError',
  );
  assert.equal(JSON.stringify(history), snapshot);
});

test('compactHistory 摘要失败时安全回退微压缩且不改结构', async () => {
  const { history, oldIdx } = compactableHistory();
  const rolesBefore = history.map((message) => message.role);
  const result = await compactHistory(history, {
    window: 100,
    threshold: 100,
    contextState: createContextState(),
    summarize: async () => null,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summarized, false);
  assert.equal(result.reason, 'microcompact');
  assert.deepEqual(history.map((message) => message.role), rolesBefore);
  assert.ok(contentAt(history, oldIdx).length < 2_000);
  assertToolCallsHaveProducers(history);
});

test('compactHistory 对全保护区返回 noop 且不调用摘要器', async () => {
  const history: ChatMessage[] = [system(), { role: 'user', content: 'current turn' } as ChatMessage];
  let called = false;
  const result = await compactHistory(history, {
    window: 100_000,
    threshold: 100,
    contextState: createContextState(),
    summarize: async () => {
      called = true;
      return 'unexpected';
    },
  });
  assert.equal(result.compacted, false);
  assert.equal(result.reason, 'noop-protected');
  assert.equal(called, false);
});

test('compactHistory force: 单 user + 单 tool 组时保 user 不压(noop)', async () => {
  // 首轮形态:user + assistant(tool_calls) + tool;窗口给大,常规切分全进保护区。
  // force 旧实现把 user 丢进摘要 → 重建后 history 无 user → 下一轮 400。
  // 修复后:force 保留最早 user,此时无中间旧区可压 → noop-protected(不丢 user)。
  const history: ChatMessage[] = [system(), { role: 'user', content: 'fix the bug' } as ChatMessage];
  appendTool(history, 'read_file', 'big-read', { path: 'src/a.ts' }, 'x'.repeat(30_000));
  let summarizeCalled = false;
  const result = await compactHistory(history, {
    window: 1_000_000,
    threshold: 100,
    force: true,
    contextState: createContextState(),
    summarize: async () => {
      summarizeCalled = true;
      return 'should not be called';
    },
  });
  // 只有 2 组(user + tool),保留 user 后无旧区 → noop,不调摘要器
  assert.equal(summarizeCalled, false);
  // user 必须还在 history 中
  assert.ok(
    history.some((m) => m.role === 'user' && (m as { content?: unknown }).content === 'fix the bug'),
    'earliest user message must survive force compaction',
  );
  // tool 也在
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'big-read'));
  assertToolCallsHaveProducers(history);
});

test('compactHistory force: 多轮 history 必须保留最早 user 所在 group(防 400)', async () => {
  // 多轮 history:user1 + tool1 + user2 + tool2;窗口给大,常规切分全进保护区。
  // force 旧实现把所有 user 丢进摘要 → 重建后 history 无 user → LLM API 报 400。
  // 修复后 force 必须保留最早 user 所在 group。
  const history: ChatMessage[] = [system()];
  history.push({ role: 'user', content: 'first request' } as ChatMessage);
  appendTool(history, 'read_file', 'read-1', { path: 'a.ts' }, 'content-a');
  history.push({ role: 'user', content: 'second request' } as ChatMessage);
  appendTool(history, 'read_file', 'read-2', { path: 'b.ts' }, 'content-b');
  let summarizedRoles: string[] = [];
  const result = await compactHistory(history, {
    window: 1_000_000,
    threshold: 100,
    force: true,
    contextState: createContextState(),
    summarize: async (older) => {
      summarizedRoles = older.map((message) => message.role);
      return 'multi-turn summary';
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(result.summarized, true);
  assert.equal(result.historyRebuilt, true);
  // 最早 user (first request) 必须保留在重建后的 history 中
  assert.ok(
    history.some((m) => m.role === 'user' && (m as { content?: unknown }).content === 'first request'),
    'earliest user message must survive force compaction',
  );
  // 最后一组 tool 也必须保留
  assert.ok(history.some((message) => (message as { tool_call_id?: string }).tool_call_id === 'read-2'));
  assertToolCallsHaveProducers(history);
});
