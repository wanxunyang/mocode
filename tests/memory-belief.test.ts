/**
 * M1-M3 记忆信念系统护栏(临时 HOME + chdir 隔离双 scope,不碰开发者真实记忆库):
 *  - 单值画像关系:换 dst(换城市/工作)旧边时序失效,新旧值不并存;多值关系并存
 *  - invalidateEdge / promoteEdge / 遗留画像边溯源迁移
 *  - isInternalizedEdge 分级:reflection 0.4 不内化、user_said/高 β 后验内化
 *  - 候选/内化列表对称;promoteEdge 是候选→About you 的晋升通道
 *  - supersedeEntry 回填取代链;gcMemories 可独立于反思运行(启动接线解耦)
 *  - kickoffReflection 自动节流(每进程上限 + 实质转录闸门),manual 绕过
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import {
  addTriple,
  ensurePrimaryPerson,
  invalidateEdge,
  promoteEdge,
  voteEdge,
  migrateLegacyProfileProvenance,
  __resetLegacyMigrationForTests,
  loadScopeGraph,
  PRIMARY_PERSON_ID,
  type GraphEdge,
} from '../src/memory/graph.js';
import {
  buildAboutYouSection,
  isInternalizedEdge,
  listProfileCandidates,
  listInternalizedProfile,
} from '../src/memory/persona.js';
import { saveEntry, supersedeEntry, loadAll, listEntries, gcMemories } from '../src/memory/store.js';
import {
  kickoffReflection,
  runReflection,
  drainMemoryBackground,
  hasSubstantialUserContent,
  __resetReflectThrottleForTests,
} from '../src/memory/reflect.js';

function isolated(fn: (t: TestContext) => void | Promise<void>): (t: TestContext) => Promise<void> {
  return async (t) => {
    // home/proj 必须分离:$HOME/.mocode 是 global 记忆,$cwd/.mocode 是 project 记忆,
    // 同目录会让 loadAll 把同一文件读两遍(scope 各归一化一次),衰减计数翻倍。
    const root = mkdtempSync(join(tmpdir(), 'mocode-belief-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    process.env.MEMORY_ENABLED = 'true';
    __resetLegacyMigrationForTests();
    try {
      await fn(t);
    } finally {
      __setChatCreateImpl(null);
      __resetReflectThrottleForTests();
      process.env.HOME = home ?? '';
      process.env.USERPROFILE = up ?? '';
      if (home === undefined) delete process.env.HOME;
      if (up === undefined) delete process.env.USERPROFILE;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
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

const EMPTY_PLAN = '{"saves":[],"updates":[],"forgets":[],"triples":[],"profile":[],"corrections":[]}';

test(
  '单值画像关系:换城市旧边时序失效,About you 只含新值',
  isolated(() => {
    ensurePrimaryPerson('万');
    const first = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'located_in',
      dst: 'hangzhou',
      fact: '用户常住杭州',
      scope: 'global',
      prov: 'user_said',
      confidence: 0.9,
    });
    assert.ok(first.ok);
    const second = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'located_in',
      dst: 'shanghai',
      fact: '用户已搬到上海',
      scope: 'global',
      prov: 'user_confirmed',
      confidence: 1,
    });
    assert.ok(second.ok);
    assert.equal(second.superseded, 1, '换 dst 也必须失效旧的单值边');

    const g = loadScopeGraph('global');
    const oldEdge = g.edges.find((e) => e.id === first.edgeId);
    assert.ok(oldEdge?.invalidAt, '旧边时序失效(保留可审计),不是删除');
    assert.equal(oldEdge?.invalidReason, 'single-value-replaced');
    const newEdges = g.edges.filter((e) => !e.invalidAt && e.relation === 'located_in');
    assert.equal(newEdges.length, 1);
    assert.equal(newEdges[0]!.dst, 'shanghai');

    const section = buildAboutYouSection(true);
    assert.match(section, /上海/);
    assert.doesNotMatch(section, /杭州/, 'About you 不允许新旧城市并存');
  }),
);

test(
  '多值画像关系(prefers):不同取值并存,不互相失效',
  isolated(() => {
    ensurePrimaryPerson('万');
    addTriple({ src: PRIMARY_PERSON_ID, relation: 'prefers', dst: '简洁回复', scope: 'global', prov: 'user_said' });
    addTriple({ src: PRIMARY_PERSON_ID, relation: 'prefers', dst: '休闲旅行', scope: 'global', prov: 'user_said' });
    const active = loadScopeGraph('global').edges.filter((e) => !e.invalidAt && e.relation === 'prefers');
    assert.equal(active.length, 2, 'prefers 是多值关系,两条都活着');
  }),
);

test(
  'invalidateEdge:撤销一条边;已失效边重复撤销 → not-found',
  isolated(() => {
    const r = addTriple({ src: 'auth', relation: 'depends_on', dst: 'jwt', scope: 'project' });
    assert.ok(r.ok);
    const gone = invalidateEdge(r.edgeId, 'test-withdraw');
    assert.equal(gone.ok, true);
    const e = loadScopeGraph('project').edges.find((x) => x.id === r.edgeId);
    assert.ok(e?.invalidAt);
    assert.equal(e?.invalidReason, 'test-withdraw');
    const again = invalidateEdge(r.edgeId);
    assert.equal(again.ok, false);
  }),
);

test(
  'L2 内化分级:反思推断不常驻,确认后晋升;β 后验达阈值可内化',
  isolated(() => {
    ensurePrimaryPerson('万');
    const inferred = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'has_hobby',
      dst: '摄影',
      fact: '用户可能喜欢摄影',
      scope: 'global',
      prov: 'reflection',
      confidence: 0.4,
    });
    assert.ok(inferred.ok);
    const inferredEdge = loadScopeGraph('global').edges.find((e) => e.id === inferred.edgeId)!;
    assert.equal(isInternalizedEdge(inferredEdge), false);
    assert.equal(buildAboutYouSection(true), '', '低置信推断不允许零确认常驻');
    assert.equal(listProfileCandidates().length, 1);
    assert.equal(listInternalizedProfile().length, 0);

    const promoted = promoteEdge(inferred.edgeId);
    assert.equal(promoted.ok, true);
    const promotedEdge = loadScopeGraph('global').edges.find((e) => e.id === inferred.edgeId)!;
    assert.equal(promotedEdge.prov, 'user_confirmed');
    assert.match(buildAboutYouSection(true), /摄影/);
    assert.equal(listInternalizedProfile().length, 1);
    assert.equal(listProfileCandidates().length, 0);

    // β 后验路径:5 次确认 0 次反驳 → 6/7≈0.857 内化;1 确认 1 反驳 → 0.5 不内化。
    const strong: GraphEdge = {
      id: 'edge-test-strong',
      src: PRIMARY_PERSON_ID,
      dst: 'x',
      relation: 'related_to',
      fact: '',
      validAt: '',
      invalidAt: null,
      sourceEntry: null,
      scope: 'global',
      evidence: { confirmed: 5, contradicted: 0 },
    };
    const weak: GraphEdge = { ...strong, id: 'edge-test-weak', evidence: { confirmed: 1, contradicted: 1 } };
    assert.equal(isInternalizedEdge(strong), true);
    assert.equal(isInternalizedEdge(weak), false);
  }),
);

test(
  '遗留画像边迁移:无 prov 的旧边一次性保守补 user_said 后进 About you;幂等',
  isolated(() => {
    ensurePrimaryPerson('万');
    // 旧路径:不带 prov(升级前的反思/手工边)。
    addTriple({ src: PRIMARY_PERSON_ID, relation: 'constraint', dst: '不可绕过 edit_file', scope: 'global' });
    assert.equal(buildAboutYouSection(true), '', '无 prov 边不自动内化');
    const r1 = migrateLegacyProfileProvenance(true);
    assert.ok(r1.migrated >= 1);
    assert.match(buildAboutYouSection(true), /edit_file/);
    const g = loadScopeGraph('global');
    const edge = g.edges.find((e) => e.relation === 'constraint' && !e.invalidAt)!;
    assert.equal(edge.prov, 'user_said');
    assert.equal(edge.confidence, 0.9);
    // 幂等:已有 prov 的边不动,第二次 0 迁移。
    const r2 = migrateLegacyProfileProvenance(true);
    assert.equal(r2.migrated, 0);
  }),
);

test(
  'supersedeEntry:旧条目标 superseded + supersededBy,从默认索引消失但仍可审计',
  isolated(() => {
    const a = saveEntry({ name: '旧决策', summary: '旧', body: '旧方案', type: 'decision' });
    const b = saveEntry({ name: '新决策', summary: '新', body: '新方案', type: 'decision' });
    assert.ok(a.ok && b.ok);
    const r = supersedeEntry(a.id, b.id, 'replaced');
    assert.equal(r.ok, true);
    const oldE = loadAll().find((e) => e.id === a.id)!;
    assert.equal(oldE.status, 'superseded');
    assert.equal(oldE.supersededBy, b.id);
    assert.ok(!listEntries().some((i) => i.id === a.id), '默认 active 索引不含被取代条目');
    assert.ok(
      listEntries({ status: 'any' }).some((i) => i.id === a.id),
      'any 视图仍可审计',
    );
  }),
);

test(
  'gcMemories 独立于反思:31 天未召回的 active 条目启动 GC 即衰减归档',
  isolated(() => {
    const r = saveEntry({ name: '陈旧记忆', summary: 's', body: 'b' });
    assert.ok(r.ok);
    // 手工把文件里该条目的时间回拨 31 天(> DECAY_DAYS 30)。
    const file = join(process.cwd(), '.mocode', 'memory.jsonl');
    assert.ok(existsSync(file));
    const old = JSON.parse(readFileSync(file, 'utf8')) as {
      id: string;
      createdAt: string;
      lastRecalledAt: string | null;
    };
    const oldDate = new Date(Date.now() - 31 * 86400000).toISOString();
    old.createdAt = oldDate;
    old.lastRecalledAt = null;
    writeFileSync(file, JSON.stringify(old), 'utf8');

    const gc = gcMemories(); // 不经过 runReflection,直接调用(模拟启动接线)
    assert.equal(gc.decayed, 1);
    assert.equal(loadAll().find((e) => e.id === r.id)?.status, 'archived');
  }),
);

test('hasSubstantialUserContent:短/无 user 内容不触发,足量原话触发', () => {
  assert.equal(hasSubstantialUserContent('assistant: 好的\nuser: 好'), false);
  assert.equal(hasSubstantialUserContent('user: 帮我改一下这个'), false);
  const long = 'user: ' + '我们来讨论一下记忆系统到底应该怎么做比较合适'.repeat(2);
  assert.equal(hasSubstantialUserContent(long), true);
});

test(
  'kickoffReflection:自动反思受每进程次数上限约束,/reflect 手动可绕过',
  isolated(async (t) => {
    // config.autoReflect 是启动快照;显式关了自动反思的环境不适合本测试。
    if (process.env.AUTO_REFLECT === 'false') t.skip();
    let calls = 0;
    __setChatCreateImpl(async () => {
      calls++;
      return sse(EMPTY_PLAN);
    });
    const transcript = 'user: ' + '这是一段足够长的真实用户发言,包含值得反思的实质内容。'.repeat(3);
    for (let i = 0; i < 5; i++) {
      kickoffReflection(transcript); // 自动
      await drainMemoryBackground();
    }
    assert.equal(calls, 3, '每进程自动反思至多 3 次,后续自动触发被节流');

    kickoffReflection(transcript, true); // 手动 /reflect 绕过节流
    await drainMemoryBackground();
    assert.equal(calls, 4, '手动反思不受自动次数上限约束');

    // 实质内容闸门:空转录即便还有手动……自动次数已耗尽,这里直接验证纯函数已覆盖;
    // 重置后空转录不应发起请求。
    __resetReflectThrottleForTests();
    calls = 0;
    kickoffReflection('assistant: [tool_call]\nuser: 嗯');
    await drainMemoryBackground();
    assert.equal(calls, 0, '用户原话不足阈值时自动反思不触发');
  }),
);

// ── evidence 行为证据投票通道(M2 增量)──────────────────────────────────────

test(
  'voteEdge: 只累计证据不改 prov/置信;非画像边/失效边拒绝;返回 β 后验',
  isolated(() => {
    ensurePrimaryPerson('万');
    const prof = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'located_in',
      dst: 'hangzhou',
      fact: '用户常住杭州',
      scope: 'global',
      prov: 'reflection',
      confidence: 0.4,
    });
    assert.ok(prof.ok);
    const v1 = voteEdge(prof.edgeId, 'confirm');
    assert.equal(v1.ok, true);
    assert.equal(v1.confirmed, 1);
    assert.ok(Math.abs((v1.posterior ?? 0) - 2 / 3) < 1e-9);
    const edge = loadScopeGraph('global').edges.find((e) => e.id === prof.edgeId)!;
    assert.equal(edge.prov, 'reflection', '投票不改 prov(转正与否由 persona 统一判定)');
    assert.equal(edge.confidence, 0.4, '投票不改初始置信');

    // project triples 不是画像边,拒绝投票。
    const proj = addTriple({ src: 'auth', relation: 'depends_on', dst: 'jwt', scope: 'project' });
    assert.ok(proj.ok);
    assert.equal(voteEdge(proj.edgeId, 'confirm').ok, false);
    // 失效边拒绝。
    invalidateEdge(prof.edgeId);
    assert.equal(voteEdge(prof.edgeId, 'confirm').reason, 'edge-invalid');
    assert.equal(voteEdge('edge-nope', 'confirm').reason, 'not-found');
  }),
);

test(
  '行为印证自动转正:反思候选跨轮累计 3 次确认零反驳 → 进 About you(无需手 confirm)',
  isolated(async () => {
    ensurePrimaryPerson('万');
    const cand = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'has_hobby',
      dst: '摄影',
      fact: '用户喜欢摄影',
      scope: 'global',
      prov: 'reflection',
      confidence: 0.4,
    });
    assert.ok(cand.ok);
    assert.equal(buildAboutYouSection(true), '', '前置:候选不常驻');

    const votePlan = (id: string) =>
      JSON.stringify({
        saves: [],
        updates: [],
        forgets: [],
        triples: [],
        profile: [],
        corrections: [],
        evidence: [{ edgeId: id, vote: 'confirm', reason: '又聊到摄影相关' }],
      });
    // 第 1、2 轮印证:β 分别 2/3、3/4,且确认数 <3 → 仍不转正。
    __setChatCreateImpl(async () => sse(votePlan(cand.edgeId)));
    let r = await runReflection('user: 周末去拍照片了');
    assert.equal(r.evidenceVotes, 1);
    assert.equal(r.promotions, 0);
    r = await runReflection('user: 相机到手了');
    assert.equal(r.promotions, 0, '2 次印证还不够,不能轻易转正');
    assert.equal(buildAboutYouSection(true), '');
    // 第 3 轮印证:3 确认零反驳 → 自动转正。
    r = await runReflection('user: 修图修到半夜');
    assert.equal(r.evidenceVotes, 1);
    assert.equal(r.promotions, 1);
    assert.match((r.promotionFacts ?? []).join(';'), /摄影/);
    assert.match(buildAboutYouSection(true), /摄影/);
  }),
);

test(
  '自我强化护栏:本轮反思新建的 profile 边收不到票;票只认轮前快照白名单',
  isolated(async () => {
    ensurePrimaryPerson('万');
    // 预置一条轮前已存在的候选(合法投票目标)。
    const pre = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'prefers',
      dst: '简洁回复',
      fact: '用户偏好简洁回复',
      scope: 'global',
      prov: 'reflection',
      confidence: 0.4,
    });
    assert.ok(pre.ok);
    // 同一轮:既新建画像(模型不可能知道其真实 edge id),又试图给"新边"投票,
    // 同时给预置边投合法票。新边 id 只能靠猜 → 必不在轮前快照白名单。
    const plan = JSON.stringify({
      saves: [],
      updates: [],
      forgets: [],
      triples: [],
      profile: [{ relation: 'located_in', dst: 'hangzhou', fact: '用户在杭州' }],
      corrections: [],
      evidence: [
        { edgeId: 'edge-guessed-new-id', vote: 'confirm', reason: '想给自己刚建的边刷票' },
        { edgeId: pre.edgeId, vote: 'confirm', reason: '用户再次要求长话短说' },
      ],
    });
    __setChatCreateImpl(async () => sse(plan));
    const r = await runReflection('user: 我在杭州,说重点就行');
    assert.equal(r.evidenceVotes, 1, '只有白名单内的预置边得票,臆造 id 被丢弃');
    assert.equal(r.promotions, 0);
    // 本轮新建的杭州边必须仍是 0 证据的候选(没有被自我投票推近门槛)。
    const newEdge = loadScopeGraph('global').edges.find((e) => e.relation === 'located_in' && !e.invalidAt)!;
    assert.equal(newEdge.evidence, undefined);
    assert.equal(buildAboutYouSection(true), '');
  }),
);

test(
  '强反证降级:内化边需 ≥3 次行为相悖才退回候选(单次反对不翻盘),promote 可恢复',
  isolated(async () => {
    ensurePrimaryPerson('万');
    const held = addTriple({
      src: PRIMARY_PERSON_ID,
      relation: 'prefers',
      dst: '周末爬山',
      fact: '用户周末喜欢爬山',
      scope: 'global',
      prov: 'user_said',
      confidence: 0.9,
    });
    assert.ok(held.ok);
    assert.match(buildAboutYouSection(true), /爬山/, '前置:亲述信念已内化');

    const plan = JSON.stringify({
      saves: [],
      updates: [],
      forgets: [],
      triples: [],
      profile: [],
      corrections: [],
      evidence: [{ edgeId: held.edgeId, vote: 'contradict', reason: '行为与偏好相悖' }],
    });
    __setChatCreateImpl(async () => sse(plan));
    let r = await runReflection('user: 这周末绝不爬山,在家打游戏');
    assert.equal(r.demotions, 0, '1 次相悖不足以推翻亲述信念(β=1/3 但需 ≥3 次)');
    assert.match(buildAboutYouSection(true), /爬山/);
    r = await runReflection('user: 连续第二周躺平不运动');
    assert.equal(r.demotions, 0, '2 次相悖仍保留(β=0.5)');
    assert.match(buildAboutYouSection(true), /爬山/);
    r = await runReflection('user: 第三次表示根本不喜欢户外');
    assert.equal(r.evidenceVotes, 1);
    assert.equal(r.demotions, 1, '3 次相悖且 β=0.2 → 自动降回候选');
    assert.doesNotMatch(buildAboutYouSection(true), /爬山/);
    assert.ok(
      listProfileCandidates().some((c) => c.edge.id === held.edgeId),
      '降级后进候选列表而非删除',
    );
    // 用户显式确认 → 翻案恢复。
    assert.equal(promoteEdge(held.edgeId).ok, true);
    assert.match(buildAboutYouSection(true), /爬山/);
  }),
);
