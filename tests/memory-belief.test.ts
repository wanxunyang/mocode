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
import {
  saveEntry,
  supersedeEntry,
  loadAll,
  listEntries,
  gcMemories,
  computeDedupKey,
  searchEntries,
  flushRecallStats,
  pendingRecallCount,
  __resetPendingRecallForTests,
  updateEntry,
  wantsTrigger,
} from '../src/memory/store.js';
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
      __resetPendingRecallForTests(); // 召回脏集是模块级内存,不清会串到下一个用例
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

test(
  'saveEntry 去重①:纯中文同名不再产生重复条目(旧实现 slug 带时间戳,同 id 检查失效)',
  isolated(() => {
    const a = saveEntry({ name: '万的语言偏好', summary: '中文对话', body: 'b1' });
    const b = saveEntry({ name: '万的语言偏好', summary: '中文对话', body: 'b2' });
    assert.ok(a.ok);
    assert.equal(b.ok, false, '同一中文名第二次应被拦下');
    // R8.3/R8.5 起 SaveResult 多了 blocked 分支:必须显式收窄到 exists,
    // 否则「被总闸拦下」会被误认成「被去重拦下」——两者对调用方的含义完全不同。
    assert.ok(!b.ok && 'exists' in b, '应是 exists 分支而非 blocked');
    assert.equal(!b.ok && 'exists' in b ? b.exists : '', a.ok ? a.id : '');
    assert.equal(loadAll().filter((e) => e.name === '万的语言偏好').length, 1);
  }),
);

test(
  'saveEntry 去重②:不同名但内容等价 → 命中 dedupKey 拦住(这才是 id 检查覆盖不到的一半)',
  isolated(() => {
    const a = saveEntry({ name: 'user-language-chinese-replies', summary: '要求中文回复', body: 'x' });
    assert.ok(a.ok);
    // **名字不同** → id 不同 → 只能靠 dedupKey 拦;内容归一化后等价
    const b = saveEntry({ name: '万偏好中文回复', summary: '  要求中文回复  ', body: 'X ' });
    assert.equal(b.ok, false, '同名内容应被 dedupKey 拦下');
    assert.ok(!b.ok && 'exists' in b, '应是 exists 分支而非 blocked');
    assert.equal(!b.ok && 'exists' in b ? b.exists : '', a.ok ? a.id : '');

    // 内容不同(哪怕标题一样)→ 不拦,交给 id 检查;换标题则是全新条目
    const c = saveEntry({ name: '另一条独立事实', summary: '要求英文回复', body: 'y' });
    assert.ok(c.ok, '内容不同不应被误拦');
  }),
);

test(
  'saveEntry 去重③:dedupKey 只认内容,name 不参与;scope 内隔离',
  isolated(() => {
    // name 不进哈希:这是 dedupKey 能拦住"换个说法写"的前提
    assert.equal(computeDedupKey('同一摘要', '同一正文'), computeDedupKey('同一摘要', '同一正文'), '同内容 → 同 key');
    assert.equal(
      computeDedupKey(' 同一摘要 ', '同一  正文'),
      computeDedupKey('同一摘要', '同一 正文'),
      '空白归一化后同 key',
    );
    assert.notEqual(computeDedupKey('摘要A', '正文'), computeDedupKey('摘要B', '正文'), '摘要不同 → key 不同');
    assert.notEqual(computeDedupKey('摘要', '正文A'), computeDedupKey('摘要', '正文B'), '正文不同 → key 不同');

    // scope 隔离:global 与 project 各存一份同内容条目是刻意的可见性差异
    const g = saveEntry({ name: 'scope-test-global', summary: '共同摘要', body: '共同正文', scope: 'global' });
    const p = saveEntry({ name: 'scope-test-project', summary: '共同摘要', body: '共同正文', scope: 'project' });
    assert.ok(g.ok, 'global 可存');
    assert.ok(p.ok, 'project 同内容也应可存(dedupKey 只在 scope 内比较)');

    // 同 id 跨 scope 仍全局唯一(历史行为不变)
    const dupId = saveEntry({ name: 'scope-test-global', summary: '别的摘要', body: '别的正文', scope: 'project' });
    assert.equal(dupId.ok, false, '同 id 跨 scope 仍被拦');
  }),
);

test(
  'saveEntry 去重④:updateEntry 改了内容后 dedupKey 必须跟着重算',
  isolated(() => {
    const a = saveEntry({ name: 'dup-after-update', summary: '旧摘要', body: '旧正文' });
    assert.ok(a.ok);
    const id = a.ok ? a.id : '';

    const up = updateEntry(id, { summary: '新摘要', body: '新正文' });
    assert.ok(up.ok);
    const stored = loadAll().find((e) => e.id === id)!;
    assert.equal(
      stored.dedupKey,
      computeDedupKey('新摘要', '新正文'),
      '落盘的 dedupKey 必须等于按新内容算出的 key(旧实现只在 saveEntry 时算一次)',
    );

    // ① 用**新内容**换个名字再存 → 必须被拦(否则同一件事重复入库)。
    const dupNew = saveEntry({ name: 'another-name', summary: '新摘要', body: '新正文' });
    assert.equal(dupNew.ok, false, '更新后的内容应参与去重');
    assert.ok(!dupNew.ok && 'exists' in dupNew, '应是 exists 分支而非 blocked');
    assert.equal(!dupNew.ok && 'exists' in dupNew ? dupNew.exists : '', id);

    // ② 用**更新前的旧内容**再存 → 不该被拦(那条内容已经不存在了,不是重复)。
    const oldContent = saveEntry({ name: 'restore-old', summary: '旧摘要', body: '旧正文' });
    assert.ok(oldContent.ok, '被改掉的旧内容不应再占着 dedupKey');
  }),
);

test(
  'R0.2:memory_search 不再逐次写盘,增量读时可见、flush 后落盘',
  isolated(() => {
    const r = saveEntry({ name: 'recall-target', summary: '目标', body: '正文用于检索' });
    assert.ok(r.ok);
    const file = join(process.cwd(), '.mocode', 'memory.jsonl');
    const before = readFileSync(file, 'utf8');

    searchEntries('recall-target');
    // 关键:搜索是纯读语义,文件内容此刻不应变化(旧实现会整文件重写并 bump 计数)
    assert.equal(readFileSync(file, 'utf8'), before, 'searchEntries 不应写盘');
    assert.equal(pendingRecallCount(), 1, '增量应在脏集里');

    // 读路径仍能看见增量(计数立刻可见,不必等落盘)
    assert.equal(loadAll().find((e) => e.id === (r.ok ? r.id : ''))?.recallCount, 1);
    // 再次搜索 → 脏集内累加,而不是新增一条
    searchEntries('recall-target');
    assert.equal(pendingRecallCount(), 1);
    assert.equal(loadAll().find((e) => e.id === (r.ok ? r.id : ''))?.recallCount, 2, '未落盘增量应累加而非丢失');

    const n = flushRecallStats();
    assert.equal(n, 1);
    assert.equal(pendingRecallCount(), 0);
    // 落盘后从裸文件读出的计数也是 2(没有重复累加)
    const onDisk = JSON.parse(readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]) as {
      recallCount: number;
    };
    assert.equal(onDisk.recallCount, 2);
    assert.equal(loadAll().find((e) => e.id === (r.ok ? r.id : ''))?.recallCount, 2, 'flush 后不得再叠加');
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

// ── R1.5 条件-动作条目形态 ──────────────────────────────────────────────────

test(
  'R1.5:trigger/action 落盘并读回;空值不写空字段',
  isolated(() => {
    const a = saveEntry({
      name: 'r15-with-trigger',
      summary: '带条件的坑',
      body: '正文',
      type: 'pitfall',
      trigger: '构造 kimi-k3 工具 schema 时',
      action: '递归剔除 uniqueItems',
    });
    assert.ok(a.ok);
    const e = loadAll().find((x) => x.id === (a.ok ? a.id : ''));
    assert.equal(e?.trigger, '构造 kimi-k3 工具 schema 时');
    assert.equal(e?.action, '递归剔除 uniqueItems');
    assert.ok(e?.triggerUpdatedAt, '首次写入 trigger 应记时间戳');

    // 空串/空白视为未填:不写字段,避免 JSONL 全是空键
    const b = saveEntry({ name: 'r15-empty', summary: '无触发条件', body: '正文', trigger: '   ', action: '' });
    assert.ok(b.ok);
    const raw = readFileSync(join(process.cwd(), '.mocode', 'memory.jsonl'), 'utf8');
    const line = raw.split('\n').find((l) => l.includes('r15-empty'));
    assert.ok(line);
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    assert.equal('trigger' in parsed, false, '空 trigger 不应写成字段');
    assert.equal('action' in parsed, false, '空 action 不应写成字段');
    assert.equal(parsed.dedupKey !== undefined, true, 'dedupKey 仍照常写');
  }),
);

test(
  'R1.5:事后补 trigger(updateEntry),清空用空串而非真值判断',
  isolated(() => {
    const r = saveEntry({ name: 'r15-late-trigger', summary: '先写后补', body: '正文', type: 'pitfall' });
    assert.ok(r.ok);
    const id = r.ok ? r.id : '';
    assert.equal(loadAll().find((x) => x.id === id)?.trigger, undefined, '前置:首次未填');

    // 事后补:这正是设计预期路径(不在信息最少时逼模型编泛化措辞)
    assert.equal(updateEntry(id, { trigger: '同一后端再次 400 时', action: '先剥 schema' }).ok, true);
    let e = loadAll().find((x) => x.id === id);
    assert.equal(e?.trigger, '同一后端再次 400 时');
    assert.equal(e?.action, '先剥 schema');

    // 清空:空串必须真的删掉,不能被 `if (patch.trigger)` 真值判断吞掉
    assert.equal(updateEntry(id, { trigger: '' }).ok, true);
    e = loadAll().find((x) => x.id === id);
    assert.equal(e?.trigger, undefined, '空串应清空 trigger');
    assert.equal(e?.triggerUpdatedAt, undefined, '清空时时间戳一并移除');
    assert.equal(e?.action, '先剥 schema', '未传 action 时不动它');
  }),
);

test('R1.5:wantsTrigger 只在 pitfall/decision/feedback 为真', () => {
  assert.equal(wantsTrigger('pitfall'), true);
  assert.equal(wantsTrigger('decision'), true);
  assert.equal(wantsTrigger('feedback'), true);
  assert.equal(wantsTrigger('fact'), false);
  assert.equal(wantsTrigger('reference'), false);
});

test(
  'R1.5:旧条目无 trigger 字段仍可正常读、可搜索、可进索引',
  isolated(() => {
    // 直接写一行"老格式"JSON(模拟 R1.5 之前的存量数据)
    const file = join(process.cwd(), '.mocode', 'memory.jsonl');
    mkdirSync(join(process.cwd(), '.mocode'), { recursive: true });
    const legacy = {
      id: 'legacy-entry',
      type: 'fact',
      name: 'legacy-entry',
      summary: '老格式条目',
      body: '没有 trigger 也没有 dedupKey',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastRecalledAt: null,
      recallCount: 0,
      status: 'active',
      supersededBy: null,
      pinned: false,
      scope: 'project',
      source: null,
    };
    writeFileSync(file, JSON.stringify(legacy) + '\n', 'utf8');

    const e = loadAll().find((x) => x.id === 'legacy-entry');
    assert.ok(e, '存量条目必须仍能读出');
    assert.equal(e?.trigger, undefined);
    assert.equal(searchEntries('legacy-entry').length, 1, '缺 trigger 不影响检索');
    assert.ok(
      listEntries().some((i) => i.id === 'legacy-entry'),
      '索引照常收录',
    );
  }),
);
// ── R15.5 相关性下限的接线 ──────────────────────────────────────────────────
//
// 索引层的下限语义由 tests/memory-retrieval.test.ts 钉住;这里钉的是**接线**:
// store.ts:searchEntries 建索引时确实把下限传下去了。不加这条,某次重构把
// `minEvidenceMatched` 参数删掉,索引层单测照样全绿,生产却退回「有词就返回」。

test(
  'R15.4:searchEntries 只重合一个证据词元的条目不算相关',
  isolated(() => {
    // 三个条目分别只命中 alpha、只命中 beta、两者都命中。查询有两个证据词元,
    // 下限要求 2 → 前两个都该被挡掉,只有第三个算相关。
    for (const name of ['alpha 样本一', 'beta 样本二', 'alpha beta 样本三']) {
      assert.ok(saveEntry({ name, summary: `${name} 的摘要`, body: '无关正文' }).ok);
    }

    const hits = searchEntries('alpha beta', { limit: 5 });
    assert.deepEqual(
      hits.map((e) => e.name),
      ['alpha beta 样本三'],
      '各命中 1 个证据词元的条目应被下限挡掉',
    );

    // 对照:查询只有一个证据词元时按实际数量降级(need = min(2, 1) = 1),
    // 所以单词查询仍然能命中——下限不能把短查询一起废掉。
    const single = searchEntries('alpha', { limit: 5 })
      .map((e) => e.name)
      .sort();
    assert.deepEqual(single, ['alpha beta 样本三', 'alpha 样本一']);

    // 完全无关的查询必须空手而归(这正是下限要解决的问题:以前会返回一堆)。
    assert.deepEqual(searchEntries('红烧肉怎么做', { limit: 5 }), []);
  }),
);
