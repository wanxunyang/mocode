/**
 * R12.2 双时间轴读侧:`asOf` 把「现在认为什么」变成「那一刻认为什么」。
 *
 * 全部用例**直接写图文件**而不是调 addTriple:addTriple 用 `nowIso()` 打时间戳,
 * 要造出"三个月前成立、上个月失效"的历史只能靠 sleep 或改盘,两者都让测试变得
 * 又慢又脆。直接写 JSON 反而更贴近这个特性的真实输入——历史边的 validAt/invalidAt
 * 本来就是过去某次写入留下的,不会因为读它而改变。
 *
 * 判定语义(与 graph.ts 的 edgeActiveAt 同口径):
 *   validAt <= asOf < invalidAt(∞)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeActiveAt, neighborsOf, parseAsOf, pathBetween, type GraphEdge } from '../../src/memory/graph.js';
import { memoryGraphTool } from '../../src/tools/builtins/memory-graph.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-asof-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(projDir, '.mocode'), { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    try {
      await fn();
    } finally {
      process.env.HOME = home ?? '';
      process.env.USERPROFILE = up ?? '';
      if (home === undefined) delete process.env.HOME;
      if (up === undefined) delete process.env.USERPROFILE;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const ENTITIES = [
  { id: 'person-primary', name: 'person-primary', aliases: [], summary: '', scope: 'project' },
  { id: 'hangzhou', name: 'hangzhou', aliases: [], summary: '', scope: 'project' },
  { id: 'shanghai', name: 'shanghai', aliases: [], summary: '', scope: 'project' },
  { id: 'beijing', name: 'beijing', aliases: [], summary: '', scope: 'project' },
];

/** 杭州(1/1–3/1)→ 上海(3/1–∞):一次典型的搬家时间线。 */
const EDGES: GraphEdge[] = [
  {
    id: 'e-hz',
    src: 'person-primary',
    dst: 'hangzhou',
    relation: 'located_in',
    fact: '',
    validAt: '2026-01-01T00:00:00.000Z',
    invalidAt: '2026-03-01T00:00:00.000Z',
    invalidReason: 'single-value-replaced',
    sourceEntry: null,
    scope: 'project',
  },
  {
    id: 'e-sh',
    src: 'person-primary',
    dst: 'shanghai',
    relation: 'located_in',
    fact: '',
    validAt: '2026-03-01T00:00:00.000Z',
    invalidAt: null,
    sourceEntry: null,
    scope: 'project',
  },
];

function writeGraph(): void {
  writeFileSync(
    join(process.cwd(), '.mocode', 'memory-graph.json'),
    JSON.stringify({ entities: ENTITIES, edges: EDGES }, null, 2),
    'utf8',
  );
}

const T = (iso: string): number => Date.parse(iso);

test('edgeActiveAt:validAt <= T < invalidAt(左闭右开)', () => {
  const e = EDGES[0];
  assert.equal(edgeActiveAt(e, T('2026-01-01T00:00:00.000Z')), true, 'validAt 那一刻算成立(左闭)');
  assert.equal(edgeActiveAt(e, T('2026-02-15T00:00:00.000Z')), true);
  assert.equal(edgeActiveAt(e, T('2026-03-01T00:00:00.000Z')), false, 'invalidAt 那一刻不算(右开)');
  // 无 invalidAt 的边一直成立。
  assert.equal(edgeActiveAt(EDGES[1], T('2030-01-01T00:00:00.000Z')), true);
});

test('edgeActiveAt:validAt 之前不成立——「那时还没这么认为」', () => {
  assert.equal(edgeActiveAt(EDGES[0], T('2025-12-31T23:59:59.000Z')), false);
});

test('edgeActiveAt:缺 validAt / 坏时间戳的历史边按「一直在」处理（unknown 不冤枉）', () => {
  const legacy = { ...EDGES[1], validAt: undefined as unknown as string };
  assert.equal(edgeActiveAt(legacy, T('2000-01-01T00:00:00.000Z')), true);
  const broken = { ...EDGES[1], validAt: 'not-a-date' };
  assert.equal(edgeActiveAt(broken, T('2000-01-01T00:00:00.000Z')), true);
  // 坏 invalidAt 同样不该让边永远消失。
  const badInvalid = { ...EDGES[0], invalidAt: 'nonsense' };
  assert.equal(edgeActiveAt(badInvalid, T('2026-06-01T00:00:00.000Z')), true);
});

test('parseAsOf:空 → 当前视图(null)；坏值 → 报错而不是静默当成现在', () => {
  assert.deepEqual(parseAsOf(undefined), { ok: true, ms: null });
  assert.deepEqual(parseAsOf(''), { ok: true, ms: null });
  assert.deepEqual(parseAsOf(null), { ok: true, ms: null });
  assert.equal(parseAsOf('2026-03-01').ok, true);
  const bad = parseAsOf('三月一号');
  assert.equal(bad.ok, false);
  // 静默当成"现在"是最坏的失败模式:查询者以为看到了历史,实际看的是现状。
  assert.ok(!bad.ok && /无法解析/.test(bad.reason));
});

test('parseAsOf:纯日期按**本地**零点,不是 UTC 零点', () => {
  const r = parseAsOf('2026-03-01');
  assert.ok(r.ok);
  const d = new Date(r.ok ? (r.ms as number) : 0);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 0, '本地零点:用户说「3 月 1 日」想的是自己那天');
});

test(
  'neighborsOf(asOf):同一实体在不同时刻给出不同的邻居——这就是双时间轴的价值',
  isolated(() => {
    writeGraph();
    const now = neighborsOf('person-primary', 1);
    const nowTargets = now.edges.map((e) => e.dst).sort();
    assert.deepEqual(nowTargets, ['shanghai'], '现在只住在上海');

    const before = neighborsOf('person-primary', 1, undefined, T('2026-02-01T00:00:00.000Z'));
    assert.deepEqual(
      before.edges.map((e) => e.dst),
      ['hangzhou'],
      '二月时只住在杭州',
    );

    // 边界:3/1 零点那一刻,旧边已失效、新边刚开始 → 只有上海。
    const at = neighborsOf('person-primary', 1, undefined, T('2026-03-01T00:00:00.000Z'));
    assert.deepEqual(
      at.edges.map((e) => e.dst),
      ['shanghai'],
    );

    // 两条边都没成立的时刻(1/1 之前):实体在,但那一刻没有关系。
    const none = neighborsOf('person-primary', 1, undefined, T('2025-06-01T00:00:00.000Z'));
    assert.equal(none.edges.length, 0);
    assert.ok(none.center, '实体本身仍要返回——「那时没关系」不等于「没这个人」');
  }),
);

test(
  'pathBetween(asOf):路径也按时刻筛边,不是只在端点上做样子',
  isolated(() => {
    writeFileSync(
      join(process.cwd(), '.mocode', 'memory-graph.json'),
      JSON.stringify(
        {
          entities: ENTITIES,
          edges: [
            // a→b 一月成立、二月失效;b→c 二月才出现。
            {
              id: 'e-ab',
              src: 'person-primary',
              dst: 'hangzhou',
              relation: 'located_in',
              fact: '',
              validAt: '2026-01-01T00:00:00.000Z',
              invalidAt: '2026-02-01T00:00:00.000Z',
              sourceEntry: null,
              scope: 'project',
            },
            {
              id: 'e-bc',
              src: 'hangzhou',
              dst: 'shanghai',
              relation: 'near',
              fact: '',
              validAt: '2026-02-01T00:00:00.000Z',
              invalidAt: null,
              sourceEntry: null,
              scope: 'project',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    // 两条边在时间上不重叠 → 任何时刻都没有路径;但"现在"也没有(第一条已失效)。
    assert.equal(pathBetween('person-primary', 'shanghai'), null);
    assert.equal(pathBetween('person-primary', 'shanghai', T('2026-01-15T00:00:00.000Z')), null);
    // 边确实存在过,只是不同时成立——这点必须能从结果里区分出来。
    const mid = neighborsOf('hangzhou', 1, undefined, T('2026-02-15T00:00:00.000Z'));
    assert.ok(mid.edges.some((e) => e.id === 'e-bc'));
  }),
);

test(
  'memory_graph 工具:asOf 传坏值报错，不静默降级成"现在"',
  isolated(async () => {
    writeGraph();
    const bad = await memoryGraphTool.execute({ action: 'neighbors', query: 'person-primary', asOf: '上周三' });
    assert.match(String(bad), /错误/);
    assert.match(String(bad), /无法解析/);
  }),
);

test(
  'memory_graph 工具:输出必须标明 asOf，否则会被当成现状读',
  isolated(async () => {
    writeGraph();
    const out = String(
      await memoryGraphTool.execute({
        action: 'neighbors',
        query: 'person-primary',
        asOf: '2026-02-01T00:00:00.000Z',
      }),
    );
    assert.match(out, /asOf 2026-02-01/);
    assert.match(out, /hangzhou/);
    assert.ok(!out.includes('shanghai'), '二月时还没有上海这条边');
  }),
);

test(
  'memory_graph 工具:该时刻没有边要说清，不能让人误以为实体不存在',
  isolated(async () => {
    writeGraph();
    const out = String(
      await memoryGraphTool.execute({
        action: 'neighbors',
        query: 'person-primary',
        asOf: '2025-06-01T00:00:00.000Z',
      }),
    );
    assert.match(out, /那时还没有这条关系/);
  }),
);

test(
  'memory_graph 工具:不传 asOf 时输出与旧版一致（零行为变化）',
  isolated(async () => {
    writeGraph();
    const out = String(await memoryGraphTool.execute({ action: 'neighbors', query: 'person-primary' }));
    assert.match(out, /shanghai/);
    assert.ok(!/asOf/.test(out), '当前视图不该出现 asOf 字样');
  }),
);
