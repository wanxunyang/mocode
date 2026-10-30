/**
 * 轻量本体 + 召回埋点护栏(临时 HOME/cwd 分离隔离双 scope):
 *  - relation-vocab:别名归一、词表判定
 *  - 反思 triples/profile 关系归一与 relViolations(违N),词表外仍写入(软策略)
 *  - mergeEntities 跨 type 守卫:都分型且不同→拒;unknown→照常;同型→合并
 *  - recall-stats:计数、命中率、持久化、format
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import {
  ensurePrimaryPerson,
  findEntity,
  mergeEntities,
  upsertEntity,
  PERSON_TYPE,
  PRIMARY_PERSON_ID,
  addTriple,
  graphStats,
  isRepoSourcePath,
  loadScopeGraph,
  migrateRelationAliases,
  migrateEntityTypes,
} from '../src/memory/graph.js';
import { normalizeRelation, isKnownRelation } from '../src/memory/relation-vocab.js';
import { runReflection } from '../src/memory/reflect.js';
import { readRecallStats, recordRecallSearch, formatRecallStats } from '../src/memory/recall-stats.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-ontolite-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    try {
      await fn();
    } finally {
      __setChatCreateImpl(null);
      process.env.HOME = home ?? '';
      process.env.USERPROFILE = up ?? '';
      if (home === undefined) delete process.env.HOME;
      if (up === undefined) delete process.env.USERPROFILE;
      process.chdir(cwd);
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

test('relation-vocab: 别名归一 + 词表判定', () => {
  assert.equal(normalizeRelation('Employed By'), 'works_at');
  assert.equal(normalizeRelation('depends'), 'depends_on');
  assert.equal(normalizeRelation('custom_weird_rel'), 'custom_weird_rel');
  assert.equal(isKnownRelation('implemented_in', 'project'), true);
  assert.equal(isKnownRelation('custom_weird_rel', 'project'), false);
  assert.equal(isKnownRelation('has_hobby', 'global'), true);
});

test(
  '反思:关系别名归一写入,词表外计 relViolations 但仍落地',
  isolated(async () => {
    const plan = JSON.stringify({
      saves: [],
      updates: [],
      forgets: [],
      triples: [
        { src: 'auth', relation: 'depends', dst: 'jwt', fact: 'auth depends 别名应归一为 depends_on' },
        { src: 'auth', relation: 'totally_custom_rel', dst: 'jwt', fact: '词表外关系仍写' },
      ],
      profile: [],
    });
    __setChatCreateImpl(async () => sse(plan));
    const r = await runReflection('user: hi');
    assert.equal(r.error, undefined);
    assert.equal(r.triples, 2, '软策略:词表外关系也写入');
    assert.equal(r.relViolations, 1);
    const jwt = findEntity('auth');
    assert.ok(jwt, 'auth 实体应存在');
    // 归一后的关系名应落在图里
    assert.doesNotThrow(() => {
      const e = findEntity('jwt');
      assert.ok(e);
    });
  }),
);

test(
  'mergeEntities 跨 type 守卫',
  isolated(() => {
    ensurePrimaryPerson('万'); // person-primary: Person
    const port = upsertEntity('some-port', { scope: 'global', type: 'Port' });
    // 都分型且 Person != Port → 拒绝
    const blocked = mergeEntities('person-primary', port.id, 'global');
    assert.ok(blocked?.rejected, '跨类型合并应被拒绝');
    const stillThere = findEntity('some-port');
    assert.ok(stillThere, '被拒实体不应被并入/消失');

    // 未分型实体(unknown)→ 照常允许并入 Person
    const u = upsertEntity('mocode user', { scope: 'global' });
    const okUnknown = mergeEntities('person-primary', u.id, 'global');
    assert.ok(okUnknown && !okUnknown.rejected, 'unknown 实体应允许并入');

    // 同类型两个实体 → 允许
    const a = upsertEntity('alice', { scope: 'global', type: PERSON_TYPE });
    const b = upsertEntity('bob', { scope: 'global', type: PERSON_TYPE });
    const okSame = mergeEntities(a.id, b.id, 'global');
    assert.ok(okSame && !okSame.rejected, '同类型实体应允许合并');
  }),
);

test(
  'findEntity 跟随 mergedInto:墓碑实体不再被当作活实体返回',
  isolated(() => {
    // 复刻真实事故:碎片被并进 primary 后仍是 name 精确匹配的首个候选,
    // 若 findEntity 直接返回它,后续写入会挂回墓碑,碎片反复重现。
    const frag = upsertEntity('万', { scope: 'global', type: PERSON_TYPE });
    ensurePrimaryPerson('Wan');
    const merged = mergeEntities(PRIMARY_PERSON_ID, frag.id, 'global');
    assert.ok(merged && !merged.rejected, '同类型应允许合并');

    const byName = findEntity('万');
    assert.equal(byName?.id, PRIMARY_PERSON_ID, 'name 命中墓碑时应重定向到 primary');
    assert.equal(byName?.mergedInto, undefined, '不得返回墓碑实体');

    const byId = findEntity(frag.id);
    assert.equal(byId?.id, PRIMARY_PERSON_ID, 'id 命中墓碑时同样重定向');

    // 写入路径同源:upsert 命中墓碑时更新的必须是 primary,而不是新建/更新死实体
    const after = upsertEntity('万', { scope: 'global', summary: '用户' });
    assert.equal(after.id, PRIMARY_PERSON_ID, 'upsert 不得落回墓碑');
    assert.equal(after.created, false);
  }),
);

test('isRepoSourcePath: 只认本仓库源码相对路径', () => {
  assert.equal(isRepoSourcePath('src/llm/reasoning.ts'), true);
  assert.equal(isRepoSourcePath('tests/reasoning.test.ts'), true);
  assert.equal(isRepoSourcePath('./src/config/index.ts'), true);
  assert.equal(isRepoSourcePath('src\\llm\\tool-schema.ts'), true, 'Windows 反斜杠应等价');
  assert.equal(isRepoSourcePath('SRC/llm/reasoning.ts'), true, '大小写不敏感');
  // 跨项目通用知识不是源码路径,必须留在 global
  assert.equal(isRepoSourcePath('hangzhou'), false);
  assert.equal(isRepoSourcePath('user-role-ai-app-dev'), false);
  assert.equal(isRepoSourcePath('a7c2-practice.html'), false);
});

test(
  'scope 守卫:目标为源码路径的 global 写入被改判到 project',
  isolated(() => {
    // 模拟反思把源码结构事实误归画像轨:请求 global,目标却是本仓库文件。
    const r = addTriple({
      src: 'reasoning-effort-adapter',
      relation: 'implemented_in',
      dst: 'src/llm/reasoning.ts',
      fact: '守卫应改判作用域',
      scope: 'global',
      prov: 'reflection',
      confidence: 0.4,
    });
    assert.ok(r.ok, '写入应成功(改判而非拒绝)');
    assert.equal(r.ok && r.scopeEscalated, true, '应标记为改判');

    const g = graphStats();
    assert.equal(g.globalRepoPathEdges, 0, 'global 图不得残留源码路径边');
    // 边确实落在 project 图
    const proj = findEntity('src/llm/reasoning.ts');
    assert.ok(proj, 'project 图应有该实体');
    assert.equal(proj?.scope, 'project');

    // 正常 global 知识不受影响(不能一刀切把 global 全赶走)
    const ok = addTriple({
      src: 'person-primary-guard-test',
      relation: 'prefers',
      dst: 'concise-replies',
      scope: 'global',
    });
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.scopeEscalated, undefined, '非源码路径不应改判');
  }),
);

test(
  'graphStats.globalRepoPathEdges: 能检出绕过守卫的脏数据(正例)',
  isolated(() => {
    // 负例已在上一测试覆盖(恒 0)。但"恒 0"也可能是指标写死造成的假通过——
    // 这里绕过 addTriple 直接往 global 图塞一条源码路径边,验证指标真的会涨。
    // 关键细节:边上的 dst 存的是**实体 id**,必须靠实体名才能判定,写错口径就永远检出不到。
    const gPath = join(process.env.HOME!, '.mocode', 'memory-graph.json');
    const dirty = {
      entities: [
        {
          id: 'dirty-src',
          name: 'dirty_src',
          aliases: [],
          summary: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          scope: 'global',
        },
        {
          id: 'src-llm-dirty-ts',
          name: 'src/llm/dirty.ts',
          aliases: [],
          summary: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          scope: 'global',
        },
      ],
      edges: [
        {
          id: 'edge-dirty-1',
          src: 'dirty-src',
          dst: 'src-llm-dirty-ts',
          relation: 'implemented_in',
          fact: '绕过守卫直接写入',
          validAt: '2026-01-01T00:00:00.000Z',
          invalidAt: null,
          sourceEntry: null,
          scope: 'global',
        },
      ],
    };
    mkdirSync(join(process.env.HOME!, '.mocode'), { recursive: true });
    writeFileSync(gPath, JSON.stringify(dirty, null, 2), 'utf8');

    assert.equal(graphStats().globalRepoPathEdges, 1, '指标必须能检出 global 里的源码路径边');
  }),
);

test(
  'recall-stats: 计数/命中率/持久化/format',
  isolated(() => {
    assert.equal(readRecallStats().searches, 0);
    recordRecallSearch(true);
    recordRecallSearch(true);
    recordRecallSearch(false);
    const s = readRecallStats(); // 重新读盘验证持久化
    assert.equal(s.searches, 3);
    assert.equal(s.graphHits, 2);
    assert.equal(s.graphEmpty, 1);
    assert.ok(s.lastSearchedAt);
    assert.match(formatRecallStats(s), /memory_search 3 次/);
    assert.match(formatRecallStats(), /67%|命中 2/);
    assert.match(formatRecallStats({ searches: 0, graphHits: 0, graphEmpty: 0, lastSearchedAt: null }), /尚无/);
  }),
);

test('relation-vocab: 只收确定性变体,方向/语态反转的一律不收', () => {
  // 拼写错误
  assert.equal(normalizeRelation('cals'), 'calls');
  assert.equal(normalizeRelation('suports_override'), 'supports_override');
  // 同向同语态的复数变体
  assert.equal(normalizeRelation('prefer'), 'prefers');
  assert.equal(normalizeRelation('use'), 'uses');
  assert.equal(normalizeRelation('test'), 'tests');
  // 长尾自定义关系必须原样保留,不能被"猜"成近义词
  assert.equal(normalizeRelation('called_by'), 'called_by');
  assert.equal(normalizeRelation('isolated_from'), 'isolated_from');
  // 三个被否决的映射:方向/语态会颠倒,必须保持原样
  assert.equal(normalizeRelation('implements'), 'implements', 'implements 指向概念,不能被读成 implemented_in');
  assert.equal(normalizeRelation('tested_in'), 'tested_in', 'tested_in 与 tests 主宾对调');
  assert.equal(normalizeRelation('configures'), 'configures', 'configures 与 configured_by 方向相反');
});

test(
  'addTriple 落库前归一:绕过 reflect 的写入路径(memory_save.links / memory_graph add)也会归一',
  isolated(() => {
    const r = addTriple({ src: 'auth', relation: 'cals', dst: 'jwt', fact: 'f', scope: 'project' });
    assert.ok(r.ok);
    const e = findEntity('auth');
    assert.ok(e);
    const g = loadScopeGraph('project');
    const edge = g.edges.find((x) => x.src === e.id && !x.invalidAt);
    assert.equal(edge?.relation, 'calls', '写入即归一,不依赖调用方先调 normalizeRelation');
    // 长尾关系不被误改
    const r2 = addTriple({ src: 'auth', relation: 'calls_into', dst: 'jwt2', fact: 'f', scope: 'project' });
    assert.ok(r2.ok);
    const g2 = loadScopeGraph('project');
    assert.ok(
      g2.edges.some((x) => x.relation === 'calls_into'),
      '词表外长尾原样保留',
    );
  }),
);

test(
  'migrateRelationAliases: 就地改关系名,active 边数守恒,幂等',
  isolated(() => {
    // 模拟历史脏数据:绕开 addTriple 的旧边
    const gPath = join(process.cwd(), '.mocode', 'memory-graph.json');
    const mk = (id: string, name: string) => ({
      id,
      name,
      aliases: [],
      summary: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      scope: 'project',
    });
    const edge = (id: string, relation: string) => ({
      id,
      src: 'a',
      dst: 'b',
      relation,
      fact: `${relation} fact`,
      validAt: '2026-01-01T00:00:00.000Z',
      invalidAt: null,
      sourceEntry: null,
      scope: 'project',
    });
    mkdirSync(join(process.cwd(), '.mocode'), { recursive: true });
    writeFileSync(
      gPath,
      JSON.stringify(
        {
          entities: [mk('a', 'a'), mk('b', 'b')],
          edges: [
            edge('e1', 'cals'),
            edge('e2', 'suports_override'),
            edge('e3', 'prefer'),
            edge('e4', 'isolated_from'),
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const before = loadScopeGraph('project').edges.filter((e) => !e.invalidAt).length;
    const r = migrateRelationAliases('project');
    assert.equal(r.migrated, 3, '三条应改名,长尾不动');
    const after = loadScopeGraph('project').edges.filter((e) => !e.invalidAt);
    assert.equal(after.length, before, 'active 边数必须守恒(只改名,不删不建)');
    const rels = after.map((e) => e.relation).sort();
    assert.deepEqual(rels, ['calls', 'isolated_from', 'prefers', 'supports_override']);

    // 幂等:再跑一次无改动
    assert.equal(migrateRelationAliases('project').migrated, 0);
  }),
);

test(
  'migrateEntityTypes: 只在「关系语义指向文件」且「名字确为仓库路径」时分型,不猜',
  isolated(() => {
    // 正例:implemented_in → 真实源码路径
    addTriple({
      src: 'vision_window',
      relation: 'implemented_in',
      dst: 'src/context/vision-window.ts',
      fact: '',
      scope: 'project',
    });
    // 反例①:同样关系,但目标是概念而非文件 → 不分型
    addTriple({ src: 'provider', relation: 'implemented_in', dst: 'some_concept', fact: '', scope: 'project' });
    // 反例②:名字像路径,但关系语义不指向文件 → 不分型
    addTriple({ src: 'doc', relation: 'related_to', dst: 'src/llm/reasoning.ts', fact: '', scope: 'project' });
    // 反例③:存入日志目录(非 src/tests) → 不分型
    addTriple({ src: 'ledger', relation: 'stored_in', dst: '.mocode/logs', fact: '', scope: 'project' });

    const n = migrateEntityTypes('project').typed;
    assert.equal(n, 1, '只有同时满足两个条件的才分型');

    const file = findEntity('src/context/vision-window.ts');
    assert.equal(file?.type, 'FilePath');
    assert.equal(findEntity('some_concept')?.type, undefined, '概念实体必须保持未分型');
    assert.equal(findEntity('src/llm/reasoning.ts')?.type, undefined, '不靠名字猜:关系不许就不分型');
    assert.equal(findEntity('.mocode/logs')?.type, undefined);
    // stats 能看见分型进展
    assert.equal(graphStats().typedEntities, 1);
  }),
);

test(
  'graphStats: 词表命中率 / prov 分布 / 跨 scope 关系使用',
  isolated(() => {
    addTriple({ src: 'x1', relation: 'depends_on', dst: 'y1', fact: '', scope: 'project' }); // 词表内
    addTriple({ src: 'x2', relation: 'made_up_rel', dst: 'y2', fact: '', scope: 'project' }); // 词表外
    addTriple({ src: 'person-primary', relation: 'prefers', dst: 'z1', fact: '', scope: 'global' }); // 画像词表内
    // global 图里用项目轨关系:实测这往往是合法跨项目结构知识,指标只作观察
    addTriple({ src: 'g1', relation: 'depends_on', dst: 'g2', fact: '', scope: 'global' });

    const s = graphStats();
    assert.equal(s.vocab.project.total, 2);
    assert.equal(s.vocab.project.inVocab, 1);
    assert.equal(s.vocab.project.outVocab, 1);
    assert.equal(s.vocab.global.total, 2);
    assert.equal(s.vocab.global.inVocab, 1);
    // depends_on 在 global 词表外 → 计入 globalUsesProjectRel
    assert.equal(s.crossScopeRelationUse.globalUsesProjectRel, 1);
    assert.equal(s.crossScopeRelationUse.projectUsesProfileRel, 0);
    // prov 分布:无 prov 的边都记到 'none'
    assert.ok((s.provDistribution.none ?? 0) >= 1);
    // related_to 两边词表都有,不应被任一侧计入
    addTriple({ src: 'r1', relation: 'related_to', dst: 'r2', fact: '', scope: 'global' });
    assert.equal(graphStats().crossScopeRelationUse.globalUsesProjectRel, 1, 'related_to 双词表共有,不计');
  }),
);
