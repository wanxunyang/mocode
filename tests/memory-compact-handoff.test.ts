/**
 * R13 压缩 → 记忆交接。
 *
 * 要解决的真问题:上下文压缩每轮都在发生,被丢掉的推理链里藏着决策与坑,
 * 而这些恰恰是"踩坑前提醒"最有价值的原料。但压缩器不知道库里有哪条旧记忆、
 * 也不知道反思的六桶规则,所以它产出的只能是**未裁决的候选**,不能直接进库。
 *
 * 三层各自测:
 *  1. pending.ts —— 队列语义(去重/上限/截断已裁决部分/开关)
 *  2. compact.ts —— 候选段被切走(不污染摘要)、只在主 agent + 开关开启时入队
 *  3. reflect.ts —— 候选进 prompt、成功才消费、失败保留
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ChatTransport } from '../src/llm/index.js';
import { compactHistory, createContextState, type CompactionRuntime } from '../src/session/compact.js';
import { contextState } from '../src/session/compact.js';
import {
  appendPendingCandidates,
  extractMemoryCandidates,
  isCompactHandoffEnabled,
  loadPendingCandidates,
  memoryCandidatesInstruction,
  MEMORY_CANDIDATES_HEADING,
  pendingCandidateCount,
  trimPendingCandidates,
} from '../src/memory/pending.js';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { runReflection } from '../src/memory/reflect.js';
import { appendTool, system } from './helpers.js';

/**
 * 隔离到临时 cwd + HOME。候选队列落在 `<cwd>/.mocode/memory-pending.jsonl`,
 * 记忆库落在 `~/.mocode` 与 `<cwd>/.mocode`,三者都必须指到 tmp,
 * 否则测试会写进开发者真实记忆库。
 */
function isolated<T>(fn: () => Promise<T> | T): () => Promise<T> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-handoff-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    const handoffEnv = process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    delete process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
    try {
      return await fn();
    } finally {
      __setChatCreateImpl(null);
      process.chdir(cwd);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      if (handoffEnv === undefined) delete process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
      else process.env.MOCODE_MEMORY_COMPACT_HANDOFF = handoffEnv;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function sse(content: string | null): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
  };
}

// ── 1. 候选段协议 ───────────────────────────────────────────────────────────

test('extractMemoryCandidates: 切走候选段,摘要正文保持干净', () => {
  const raw = [
    '## Objective',
    '把 x 改好',
    '## Completed',
    '改了 a.ts',
    '',
    MEMORY_CANDIDATES_HEADING,
    '- [pitfall] dashscope 会在 uniqueItems 上 400,发送前必须递归剔除',
    '- [decision] 用 fork 摘要而非独立 compressor,为了命中 prompt cache',
    '',
  ].join('\n');
  const { summary, candidates } = extractMemoryCandidates(raw);
  assert.ok(!summary.includes('Memory Candidates'), '摘要正文不得残留候选段标题');
  assert.ok(!summary.includes('dashscope'), '候选内容不得混进摘要');
  assert.match(summary, /## Completed\n改了 a\.ts/, '叙述段必须原样保留');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].kind, 'pitfall');
  assert.match(candidates[0].text, /uniqueItems/);
  assert.equal(candidates[1].kind, 'decision');
});

test('extractMemoryCandidates: 无候选段时原样返回(常态,不得报错)', () => {
  const raw = '## Completed\njust a summary';
  const { summary, candidates } = extractMemoryCandidates(raw);
  assert.equal(summary, raw);
  assert.deepEqual(candidates, []);
});

test('extractMemoryCandidates: 标题大小写/星号列表/占位词都应容错', () => {
  const raw = '## Done\nbody\n## memory candidates\n* [fact] 真实候选\n* 无\n';
  const { candidates } = extractMemoryCandidates(raw);
  assert.equal(candidates.length, 1, '"无"这类占位不该变成候选');
  assert.equal(candidates[0].kind, 'fact');
  assert.equal(candidates[0].text, '真实候选');
});

test('extractMemoryCandidates: 候选段在中间时,后续标题内容不得被吞', () => {
  const raw = '## A\na\n## Memory Candidates\n- [pitfall] p\n## B\nb\n';
  const { summary, candidates } = extractMemoryCandidates(raw);
  assert.equal(candidates.length, 1);
  assert.match(summary, /## B\nb/, '候选段之后的正文必须保留');
});

test('memoryCandidatesInstruction: 明确允许空段(否则模型会凑数)', () => {
  const text = memoryCandidatesInstruction();
  assert.ok(text.includes(MEMORY_CANDIDATES_HEADING));
  assert.match(text, /EMPTY section is the normal/i);
});

// ── 2. 队列语义 ─────────────────────────────────────────────────────────────

test(
  'pending: 追加去重、空文本与占位被滤掉',
  isolated(() => {
    assert.equal(appendPendingCandidates([]), 0);
    const n = appendPendingCandidates([
      { kind: 'pitfall', text: '同一句话' },
      { kind: 'pitfall', text: '同一句话 ' }, // 归一后重复
      { kind: 'fact', text: '   ' },
      { kind: 'decision', text: '另一句' },
    ]);
    assert.equal(n, 2, '只应新增两条');
    assert.equal(pendingCandidateCount(), 2);

    // 再追加一次完全相同的内容 → 幂等,不应重复入队
    assert.equal(appendPendingCandidates([{ kind: 'pitfall', text: '同一句话' }]), 0);
    assert.equal(pendingCandidateCount(), 2);
  }),
);

test(
  'pending: 超过上限丢最旧的(压缩是高频路径,队列不能无限长)',
  isolated(() => {
    for (let i = 0; i < 45; i++) appendPendingCandidates([{ kind: 'fact', text: `候选 ${i}` }]);
    const all = loadPendingCandidates();
    assert.equal(all.length, 40);
    assert.ok(
      all.some((c) => c.text.includes('候选 44')),
      '最新的一条必须还在',
    );
    assert.ok(!all.some((c) => c.text.includes('候选 0')), '最旧的应被丢弃');
  }),
);

test(
  'pending: trimPendingCandidates 只删被裁决的那批,保留反思期间新增的',
  isolated(() => {
    appendPendingCandidates([{ text: '已裁决 A' }, { text: '已裁决 B' }]);
    // 模拟:反思正在跑(几十秒),主 agent 又压了一次上下文
    appendPendingCandidates([{ text: '反思期间新增 C' }]);
    // 反思手里的快照就是它实际看过的那两条
    trimPendingCandidates([{ text: '已裁决 A' }, { text: '已裁决 B' }]);
    const left = loadPendingCandidates().map((c) => c.text);
    assert.deepEqual(left, ['反思期间新增 C'], '只有被裁决过的两条该消失');
  }),
);

test(
  'pending: 队列已满时 trim 仍保留反思期间新增的候选(按身份切,不按条数)',
  isolated(() => {
    // 灌满 40 条上限
    for (let i = 0; i < 40; i++) appendPendingCandidates([{ text: `旧候选 ${i}` }]);
    assert.equal(pendingCandidateCount(), 40);
    const snapshot = loadPendingCandidates(); // 反思这一轮读到的快照

    // 反思跑着的时候主 agent 又压了一次上下文:新增把最旧的 3 条挤出队列,
    // 队列长度仍是 40 —— 这正是「按前 N 条切」会整队清空并删掉新候选的场景。
    appendPendingCandidates([{ text: '期间新增 X' }, { text: '期间新增 Y' }, { text: '期间新增 Z' }]);
    assert.equal(pendingCandidateCount(), 40, '前置:满队后追加不改变长度');

    trimPendingCandidates(snapshot);
    const left = loadPendingCandidates().map((c) => c.text);
    assert.deepEqual(
      left.sort(),
      ['期间新增 X', '期间新增 Y', '期间新增 Z'],
      '这一轮没被看过的三条必须全部留下;已裁决的 37 条删除,被 cap 挤掉的 3 条本就不在队列里',
    );
  }),
);

test(
  'pending: trim 传入不在队列里的候选时安全无操作,不抛',
  isolated(() => {
    appendPendingCandidates([{ text: 'only' }]);
    trimPendingCandidates([{ text: '从未入队' }]);
    assert.equal(pendingCandidateCount(), 1, '身份不匹配 → 不删任何东西');
    trimPendingCandidates([]);
    assert.equal(pendingCandidateCount(), 1);
    trimPendingCandidates([{ text: 'only' }]);
    assert.equal(pendingCandidateCount(), 0);
  }),
);

test('pending: 开关默认开启,可用 env 关闭', () => {
  const saved = process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
  delete process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
  assert.equal(isCompactHandoffEnabled(), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    process.env.MOCODE_MEMORY_COMPACT_HANDOFF = v;
    assert.equal(isCompactHandoffEnabled(), false, `=${v} 应关闭`);
  }
  if (saved === undefined) delete process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
  else process.env.MOCODE_MEMORY_COMPACT_HANDOFF = saved;
});

// ── 3. 压缩端到端 ───────────────────────────────────────────────────────────

function compactableHistory(): ChatMessage[] {
  const history: ChatMessage[] = [system('current system')];
  appendTool(history, 'read_file', 'old-read', { path: 'src/old.ts' }, 'x'.repeat(2_000));
  history.push({ role: 'user', content: 'continue' } as ChatMessage);
  appendTool(history, 'run_command', 'latest', { command: 'echo ok' }, 'ok');
  return history;
}

/** 摘要返回体:正文 + 候选段。 */
const SUMMARY_WITH_CANDIDATES =
  '## Completed\n改了 a.ts\n\n' +
  `${MEMORY_CANDIDATES_HEADING}\n` +
  '- [pitfall] dashscope uniqueItems 会 400,发送前递归剔除\n' +
  '- [decision] 摘要走 fork 以命中 prompt cache\n';

function transportReturning(content: string): { transport: ChatTransport; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  const transport: ChatTransport = async (messages) => {
    seen.push(messages);
    return { content, toolCalls: [] };
  };
  return { transport, seen };
}

function runtimeFor(transport: ChatTransport, window = 100): CompactionRuntime {
  return {
    config: {
      contextWindowTokens: window,
      autoCompact: true,
      contextBudget: true,
      contextRelprune: false,
      contextOptimize: false,
      lowPressureRatio: 0.6,
      toolClearing: true,
    },
    modelTransport: transport,
  };
}

test(
  'compact: 走默认摘要器时把候选段切走并入库,摘要里不留候选',
  isolated(async () => {
    process.env.MEMORY_ENABLED = 'true';
    const history = compactableHistory();
    const { transport, seen } = transportReturning(SUMMARY_WITH_CANDIDATES);
    const result = await compactHistory(history, {
      window: 100,
      threshold: 0.0,
      tools: [],
      contextState: contextState, // 主 agent 状态 = 入队前提
      runtime: runtimeFor(transport),
    });
    assert.equal(result.reason, 'summarize');
    assert.ok(seen.length >= 1, '摘要器应被调用一次');

    const summaryMsg = history.find((m) => m.role === 'system' && String(m.content).startsWith('# 会话摘要'));
    assert.ok(summaryMsg, '应有摘要消息');
    const body = String(summaryMsg!.content);
    assert.ok(!body.includes(MEMORY_CANDIDATES_HEADING), '摘要里不得残留候选段(白占上下文)');
    assert.ok(!body.includes('uniqueItems'), '候选内容不得混进摘要正文');

    const queued = loadPendingCandidates();
    assert.equal(queued.length, 2, '两条候选应入队');
    assert.equal(queued[0].kind, 'pitfall');
    assert.equal(queued[1].kind, 'decision');
  }),
);

test(
  'compact: MOCODE_MEMORY_COMPACT_HANDOFF=0 时切走但不入库',
  isolated(async () => {
    process.env.MEMORY_ENABLED = 'true';
    process.env.MOCODE_MEMORY_COMPACT_HANDOFF = '0';
    const history = compactableHistory();
    const { transport } = transportReturning(SUMMARY_WITH_CANDIDATES);
    await compactHistory(history, {
      window: 100,
      threshold: 0.0,
      tools: [],
      contextState: contextState,
      runtime: runtimeFor(transport),
    });
    assert.equal(pendingCandidateCount(), 0, '开关关闭时不得入队');
    const summaryMsg = history.find((m) => m.role === 'system' && String(m.content).startsWith('# 会话摘要'));
    assert.ok(!String(summaryMsg!.content).includes(MEMORY_CANDIDATES_HEADING), '仍须切走,不能污染摘要');
  }),
);

test(
  'compact: MEMORY_ENABLED=false 时不入队(总开关 veto)',
  isolated(async () => {
    process.env.MEMORY_ENABLED = 'false';
    const history = compactableHistory();
    const { transport } = transportReturning(SUMMARY_WITH_CANDIDATES);
    await compactHistory(history, {
      window: 100,
      threshold: 0.0,
      tools: [],
      contextState: contextState,
      runtime: runtimeFor(transport),
    });
    assert.equal(pendingCandidateCount(), 0);
  }),
);

test(
  'compact: 子 agent(独立 contextState)的压缩不入队',
  isolated(async () => {
    process.env.MEMORY_ENABLED = 'true';
    const history = compactableHistory();
    const { transport } = transportReturning(SUMMARY_WITH_CANDIDATES);
    await compactHistory(history, {
      window: 100,
      threshold: 0.0,
      tools: [],
      contextState: createContextState(), // != contextState → 子 agent
      runtime: runtimeFor(transport),
    });
    assert.equal(pendingCandidateCount(), 0, '子 agent 的中间推理不该污染项目级候选队列');
  }),
);

test(
  'compact: 注入的 summarize 走调用方实现,不受候选逻辑影响',
  isolated(async () => {
    process.env.MEMORY_ENABLED = 'true';
    const history = compactableHistory();
    let called = 0;
    await compactHistory(history, {
      window: 100,
      threshold: 0.0,
      contextState: contextState,
      summarize: async () => {
        called++;
        return SUMMARY_WITH_CANDIDATES;
      },
    });
    assert.equal(called, 1);
    // 注入路径绕过了 finalizeSummaryOutput,候选不会入队——这是刻意的:
    // 该钩子是测试/嵌入方接管摘要的入口,不该被我们的副作用悄悄改动。
    assert.equal(pendingCandidateCount(), 0);
  }),
);

test('compact: 候选段超出摘要硬上限时仍能先被切走(顺序不能反)', async () => {
  // 回归:若先 capSummaryOutput 再解析,写在正文之后、超长的候选段会被整段截掉,
  // 通道静默失效。这里造一个"正文很短但候选段让总长超上限"的极端输入。
  const history = compactableHistory();
  const longCandidate = `- [pitfall] ${'很长的候选说明'.repeat(200)}`;
  const { transport } = transportReturning(`## Completed\n短正文\n\n${MEMORY_CANDIDATES_HEADING}\n${longCandidate}\n`);
  process.env.MEMORY_ENABLED = 'true';
  await isolated(async () => {
    await compactHistory(history, {
      window: 100,
      threshold: 0.0,
      tools: [],
      contextState: contextState,
      runtime: runtimeFor(transport),
    });
    assert.equal(pendingCandidateCount(), 1, '超长候选段也必须先被切走再封顶');
  })();
});

// ── 4. 反思消费 ─────────────────────────────────────────────────────────────

test(
  'reflect: 候选进 prompt,成功裁决后队列被消费',
  isolated(async () => {
    appendPendingCandidates([
      { kind: 'pitfall', text: 'dashscope 的 uniqueItems 会 400' },
      { kind: 'decision', text: '摘要走 fork 以命中 cache' },
    ]);
    let promptSeen = '';
    __setChatCreateImpl(async (params) => {
      const msgs = (params as unknown as { messages: ChatMessage[] }).messages;
      promptSeen = msgs.map((m) => String(m.content ?? '')).join('\n');
      return sse('{"saves":[],"updates":[],"forgets":[],"triples":[]}');
    });
    const r = await runReflection('user: hi');
    assert.equal(r.error, undefined);
    assert.match(promptSeen, /Candidates salvaged from context compaction/, 'prompt 应带候选节');
    assert.match(promptSeen, /uniqueItems/, '候选内容应出现在 prompt 里');
    assert.match(promptSeen, /UNVERIFIED/, '必须标明候选未经裁决(否则模型会当既定事实)');
    assert.equal(r.pendingConsumed, 2, '应记录消费条数');
    assert.equal(pendingCandidateCount(), 0, '成功裁决后队列应被切空');
  }),
);

test(
  'reflect: 反思失败时候选必须原样保留(下次还能再试)',
  isolated(async () => {
    appendPendingCandidates([{ kind: 'pitfall', text: '不能丢的坑' }]);
    __setChatCreateImpl(async () => sse('完全不是 JSON'));
    const r = await runReflection('user: hi');
    assert.equal(r.error, 'parse-failed');
    assert.equal(r.pendingConsumed, undefined);
    assert.equal(pendingCandidateCount(), 1, '失败不得消费候选——否则一次网络抖动就永久丢掉');
    assert.equal(loadPendingCandidates()[0].text, '不能丢的坑');
  }),
);

test(
  'reflect: 无候选时 prompt 不出现该节(常态零开销)',
  isolated(async () => {
    let promptSeen = '';
    __setChatCreateImpl(async (params) => {
      const msgs = (params as unknown as { messages: ChatMessage[] }).messages;
      promptSeen = msgs.map((m) => String(m.content ?? '')).join('\n');
      return sse('{"saves":[],"updates":[],"forgets":[],"triples":[]}');
    });
    const r = await runReflection('user: hi');
    assert.equal(r.error, undefined);
    assert.ok(!promptSeen.includes('Candidates salvaged'), '无候选时不该多出这一节');
    assert.equal(r.pendingConsumed, undefined);
  }),
);

test(
  'reflect: 坏行候选文件不会让反思崩(队列是 best-effort 通道)',
  isolated(async () => {
    const dir = join(process.cwd(), '.mocode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory-pending.jsonl'), '{ 这不是 json }\n{"text":"好的候选","kind":"pitfall"}', 'utf8');
    __setChatCreateImpl(async () => sse('{"saves":[],"updates":[],"forgets":[],"triples":[]}'));
    const r = await runReflection('user: hi');
    assert.equal(r.error, undefined, '坏行应被跳过而不是抛错');
    assert.equal(r.pendingConsumed, 1, '只有合法那一行算消费');
  }),
);
