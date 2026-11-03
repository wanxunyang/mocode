/**
 * R18 每轮静默召回:把「这轮问的东西」和旧记忆对上,不看模型有没有主动检索。
 *
 * 钉的是七件事(对应 src/memory/turn-recall.ts 头注释与 memory.md §R18):
 *  1. 相关查询 → 段非空、带 id/summary/body 截断;无关查询 → **空串**(走 R15.5 下限);
 *  2. 开关关闭 / 查询过短 → 空串,且不计数;
 *  3. excludeIds 排除(R17 尾注已播过的条目不再重复);
 *  4. episode 永不进——它只在会话结束时写,算进来等于让上次会话冒充本轮须知;
 *  5. **纯读**:不改 recallCount、不写库文件。这条是硬约束:静默注入若顺手 bump,
 *     索引 policy 的 `recallCount>=1` 会把这些条目永久钉在顶部,「真被检索过」就失去意义;
 *  6. 计数 turns/hits 分开计(不能因"命中才计"退化成恒等式);
 *  7. stale 锚点打 STALE-CODE —— 与 memory_search 的口径一致。
 *
 * isolated() 必须同时改 HOME 与 cwd:store 的 global 路径读 HOME、project 路径读
 * process.cwd(),只改一个会让测试写进仓库真实记忆库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildTurnRecallSection,
  flushTurnRecallStats,
  isTurnRecallEnabled,
  turnRecallCounters,
  __resetTurnRecallForTests,
} from '../src/memory/turn-recall.js';
import { __resetPendingRecallForTests, loadAll, saveEntry } from '../src/memory/store.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-turn-recall-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const enabledEnv = process.env.MOCODE_MEMORY_TURN_RECALL;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    delete process.env.MOCODE_MEMORY_TURN_RECALL;
    __resetTurnRecallForTests();
    __resetPendingRecallForTests();
    try {
      await fn();
    } finally {
      __resetTurnRecallForTests();
      __resetPendingRecallForTests();
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (enabledEnv === undefined) delete process.env.MOCODE_MEMORY_TURN_RECALL;
      else process.env.MOCODE_MEMORY_TURN_RECALL = enabledEnv;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 一条"关于 dashscope 拒收 uniqueItems"的记忆——查询侧用它的词就能命中。 */
function seedRelevant(name = 'kimi-k3-uniqueitems'): void {
  const r = saveEntry({
    name,
    summary: 'dashscope compatible-mode 拒收 uniqueItems',
    body: '工具 schema 里带 uniqueItems 会整请求 400,必须递归剔除后再发送。',
    type: 'pitfall',
    scope: 'project',
  });
  assert.equal(r.ok, true, '前置:种子条目应写入成功');
}

const RELEVANT_QUERY = 'dashscope compatible-mode 报 400,是不是 uniqueItems 的问题';

function projectStorePath(): string {
  return join(process.cwd(), '.mocode', 'memory.jsonl');
}

test(
  'R18:相关查询 → 段非空,带 id / summary / body',
  isolated(() => {
    seedRelevant();
    const out = buildTurnRecallSection(RELEVANT_QUERY);
    assert.match(out, /## Possibly relevant memory \(recalled for this turn\)/);
    assert.match(out, /kimi-k3-uniqueitems/);
    assert.match(out, /\[pitfall\]/, '应标出条目类型');
    assert.match(out, /递归剔除/, 'body 也要带(截断后的)');
    assert.match(out, /memory_search/, '应提示如何取全文');
  }),
);

test(
  'R18:无关查询 → 空串(走 R15.5 证据词元下限,不硬凑结果)',
  isolated(() => {
    seedRelevant();
    const out = buildTurnRecallSection('红烧肉怎么炖才不腻');
    assert.equal(out, '', '没有证据词元重合时不注入任何东西');
    // 但这一轮仍然算"检索过":下限过滤发生在取回之后。
    assert.equal(turnRecallCounters().turns, 1);
    assert.equal(turnRecallCounters().hits, 0);
  }),
);

test(
  'R18:enabled=false → 空串,且零计数',
  isolated(() => {
    seedRelevant();
    assert.equal(buildTurnRecallSection(RELEVANT_QUERY, { enabled: false }), '');
    assert.deepEqual(
      { turns: turnRecallCounters().turns, hits: turnRecallCounters().hits },
      { turns: 0, hits: 0 },
      '关掉时不该产生任何观测数字',
    );
  }),
);

test(
  'R18:查询过短 → 空串(短查询没有证据词元,下限会退化成不过滤)',
  isolated(() => {
    seedRelevant();
    assert.equal(buildTurnRecallSection('改'), '');
    assert.equal(turnRecallCounters().turns, 0, '过短查询不算检索');
  }),
);

test(
  'R18:excludeIds 排除 R17 已播报的条目',
  isolated(() => {
    seedRelevant();
    assert.notEqual(buildTurnRecallSection(RELEVANT_QUERY), '', '前置:不排除时应命中');
    const out = buildTurnRecallSection(RELEVANT_QUERY, { excludeIds: new Set(['kimi-k3-uniqueitems']) });
    assert.equal(out, '', '被排除的条目不得再出现');
  }),
);

test(
  'R18:episode 永不进召回',
  isolated(() => {
    // 直接写一条 episode:saveEntry 不暴露 type=episode 的正常入口,用同样的底层格式落盘。
    const p = projectStorePath();
    mkdirSync(dirname(p), { recursive: true });
    const now = new Date().toISOString();
    const entry = {
      id: 'episode-probe',
      type: 'episode',
      name: '上一轮会话摘要 dashscope 400',
      summary: 'dashscope compatible-mode 400 的排查经过',
      body: 'uniqueItems 导致 400,递归剔除后恢复。',
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
      recallCount: 0,
      status: 'active',
      supersededBy: null,
      pinned: false,
      scope: 'project',
      source: null,
    };
    writeFileSync(p, JSON.stringify(entry) + '\n', 'utf8');

    assert.equal(buildTurnRecallSection(RELEVANT_QUERY), '', 'episode 不该以"本轮须知"的姿态出现');
  }),
);

test(
  'R18:纯读 —— 不改 recallCount,也不写库文件',
  isolated(() => {
    seedRelevant();
    const before = readFileSync(projectStorePath(), 'utf8');
    const beforeEntry = loadAll().find((e) => e.id === 'kimi-k3-uniqueitems');
    assert.equal(beforeEntry?.recallCount, 0, '前置:种子条目召回次数为 0');

    const out = buildTurnRecallSection(RELEVANT_QUERY);
    assert.notEqual(out, '', '前置:应命中');

    assert.equal(
      loadAll().find((e) => e.id === 'kimi-k3-uniqueitems')?.recallCount,
      0,
      '静默召回不得 bump recallCount(否则索引 policy 会把它永久钉在顶部)',
    );
    assert.equal(readFileSync(projectStorePath(), 'utf8'), before, '不该产生任何写盘');
  }),
);

test(
  'R18:最多 3 条,body 超长截断',
  isolated(() => {
    for (let i = 0; i < 6; i++) {
      const r = saveEntry({
        name: `dashscope-probe-${i}`,
        summary: `第 ${i} 条 dashscope compatible-mode uniqueItems 记录`,
        body: `uniqueItems ${i} `.repeat(200),
        type: 'pitfall',
        scope: 'project',
      });
      assert.equal(r.ok, true);
    }
    const out = buildTurnRecallSection(RELEVANT_QUERY);
    const bulletCount = out.split('\n').filter((l) => l.startsWith('- [')).length;
    assert.equal(bulletCount, 3, `上限应恰好 3 条,实际 ${bulletCount}`);
    assert.match(out, /…/, '超长 body 应被截断并留省略号');
  }),
);

test(
  'R18:stale 锚点打 STALE-CODE(与 memory_search 同口径)',
  isolated(() => {
    seedRelevant('anchored-probe');
    const p = projectStorePath();
    const lines = readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    const out = lines.map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>;
      if (e.id !== 'anchored-probe') return l;
      // 指向一个不存在的文件 → missing → stale
      e.anchors = [{ path: 'src/definitely-not-here.ts', contentHash: 'deadbeef' }];
      return JSON.stringify(e);
    });
    writeFileSync(p, out.join('\n') + '\n', 'utf8');

    const section = buildTurnRecallSection(RELEVANT_QUERY);
    assert.match(section, /anchored-probe/);
    assert.match(section, /STALE-CODE/, '锚点失效的条目必须自曝其短');
  }),
);

test(
  'R18:观测 —— turns 与 hits 分开计,entries 累加',
  isolated(() => {
    seedRelevant();
    buildTurnRecallSection(RELEVANT_QUERY); // 命中
    buildTurnRecallSection('红烧肉怎么炖才不腻'); // 未命中
    buildTurnRecallSection(RELEVANT_QUERY); // 命中
    const c = turnRecallCounters();
    assert.equal(c.turns, 3, '检索过 3 轮');
    assert.equal(c.hits, 2, '其中 2 轮拿到东西');
    assert.equal(c.entries, 2, '累计送出 2 条');
  }),
);

test(
  'R18:flush 落盘到 .mocode/memory-turn-recall-stats.json',
  isolated(() => {
    seedRelevant();
    buildTurnRecallSection(RELEVANT_QUERY);
    flushTurnRecallStats();
    const p = join(process.cwd(), '.mocode', 'memory-turn-recall-stats.json');
    assert.equal(existsSync(p), true, '计数应在轮末落盘');
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { turns: number; hits: number; updatedAt: string };
    assert.equal(parsed.turns, 1);
    assert.equal(parsed.hits, 1);
    assert.ok(parsed.updatedAt, 'updatedAt 应存在');
  }),
);

test('R18:开关默认开,MOCODE_MEMORY_TURN_RECALL=0 关', () => {
  const prev = process.env.MOCODE_MEMORY_TURN_RECALL;
  try {
    delete process.env.MOCODE_MEMORY_TURN_RECALL;
    assert.equal(isTurnRecallEnabled(), true);
    process.env.MOCODE_MEMORY_TURN_RECALL = '0';
    assert.equal(isTurnRecallEnabled(), false);
    process.env.MOCODE_MEMORY_TURN_RECALL = 'off';
    assert.equal(isTurnRecallEnabled(), false);
    process.env.MOCODE_MEMORY_TURN_RECALL = '1';
    assert.equal(isTurnRecallEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.MOCODE_MEMORY_TURN_RECALL;
    else process.env.MOCODE_MEMORY_TURN_RECALL = prev;
  }
});
