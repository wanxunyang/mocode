/**
 * G0/G1 用户画像护栏(临时 HOME 隔离全局图谱,不碰开发者真实 ~/.mocode):
 *  - ensurePrimaryPerson 固定 id 幂等
 *  - canonicalizePrimaryPerson 把 mocode-user / user-name-* / 沿 named 的自称并入
 *    person-primary,重连 located_in 等边;user-role-* 角色值实体不并入
 *  - buildAboutYouSection 渲染常驻画像、≤800 字符、无画像时空串
 *  - 反思 profile 桶落到 global person-primary 并能被 About you 渲染
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { addTriple, ensurePrimaryPerson, canonicalizePrimaryPerson, PRIMARY_PERSON_ID } from '../src/memory/graph.js';
import { buildAboutYouSection, initPersona, __resetPersonaInitForTests } from '../src/memory/persona.js';
import { runReflection } from '../src/memory/reflect.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-persona-'));
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.chdir(root);
    __resetPersonaInitForTests();
    try {
      await fn();
    } finally {
      __setChatCreateImpl(null);
      __resetPersonaInitForTests();
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

test(
  'ensurePrimaryPerson: 固定 id、幂等、改名保留旧名为别名',
  isolated(() => {
    const p1 = ensurePrimaryPerson('万');
    assert.equal(p1.id, PRIMARY_PERSON_ID);
    assert.equal(p1.name, '万');
    const p2 = ensurePrimaryPerson('万');
    assert.equal(p2.id, p1.id);
    const p3 = ensurePrimaryPerson('Wan');
    assert.equal(p3.name, 'Wan');
    assert.ok(p3.aliases.includes('万'), '旧名应进别名');
  }),
);

test(
  'canonicalizePrimaryPerson: 合并碎片、重连属性边、保留角色值实体',
  isolated(async () => {
    // 复刻真实库的碎裂结构。
    addTriple({ src: 'mocode user', relation: 'named', dst: '万', scope: 'global' });
    addTriple({
      src: 'user-name-wanjizhu',
      relation: 'related_to',
      dst: 'user-role-ai-app-dev',
      fact: '万是 AI 应用开发工程师',
      scope: 'global',
    });
    addTriple({ src: 'user-name-wanjizhu', relation: 'located_in', dst: 'hangzhou', scope: 'global' });

    const report = canonicalizePrimaryPerson();
    assert.ok(report.merged.includes('mocode-user'));
    assert.ok(
      report.merged.some((id) => id.startsWith('ent-')),
      '沿 named 找到的"万"实体应并入',
    );
    assert.ok(report.merged.includes('user-name-wanjizhu'));
    assert.ok(!report.merged.includes('user-role-ai-app-dev'), '角色值实体不并入 person');
    assert.equal(report.displayName, '万');

    // located_in 边应重连到 person-primary。重连的是无 prov 历史边,需经遗留迁移
    // (保守视作用户亲述)才达 L2 内化门槛。
    const { migrateLegacyProfileProvenance } = await import('../src/memory/graph.js');
    migrateLegacyProfileProvenance(true);
    const section = buildAboutYouSection(true);
    assert.match(section, /## About you/);
    assert.match(section, /用户:万/);
    assert.match(section, /hangzhou|杭州/, 'located_in 边重连+迁移后仍可渲染');
    assert.ok(section.length <= 800, `画像段超预算:${section.length}`);
  }),
);

test(
  'buildAboutYouSection: 无 person / 关闭开关 → 空串',
  isolated(() => {
    assert.equal(buildAboutYouSection(true), '');
    ensurePrimaryPerson('万');
    assert.equal(buildAboutYouSection(false), '');
  }),
);

test(
  'initPersona: 幂等(多次调用不重复写)',
  isolated(() => {
    initPersona(true);
    const a = buildAboutYouSection(true);
    initPersona(true); // 第二次应为 no-op
    const b = buildAboutYouSection(true);
    assert.equal(a, b);
  }),
);

test(
  '反思 profile 桶:推断画像先作 L1 候选(不进 About you),用户确认后才 L2 内化',
  isolated(async () => {
    const { listProfileCandidates } = await import('../src/memory/persona.js');
    const { promoteEdge } = await import('../src/memory/graph.js');
    const plan = JSON.stringify({
      saves: [],
      updates: [],
      forgets: [],
      triples: [],
      profile: [{ relation: 'located_in', dst: 'hangzhou', fact: '用户目前常住杭州' }],
    });
    __setChatCreateImpl(async () => sse(plan));
    const r = await runReflection('user: 我在杭州');
    assert.equal(r.error, undefined);
    assert.equal(r.profiles, 1);
    // 反思推断 = 低置信候选,不允许零确认常驻。
    assert.equal(buildAboutYouSection(true), '');
    const cands = listProfileCandidates();
    assert.equal(cands.length, 1);
    assert.match(cands[0]!.text, /杭州/);
    // 用户确认 → promoteEdge → 进入 About you。
    promoteEdge(cands[0]!.edge.id);
    const section = buildAboutYouSection(true);
    assert.match(section, /## About you/);
    assert.match(section, /杭州/);
  }),
);

test(
  '反思 corrections 桶:用户纠正直接以 user_confirmed 内化,并时序失效旧值',
  isolated(async () => {
    const { addTriple, ensurePrimaryPerson, loadScopeGraph } = await import('../src/memory/graph.js');
    ensurePrimaryPerson('万');
    const old = addTriple({
      src: 'person-primary',
      relation: 'located_in',
      dst: 'beijing',
      fact: '用户常住北京',
      scope: 'global',
      prov: 'user_said',
      confidence: 0.9,
    });
    assert.ok(old.ok);
    assert.match(buildAboutYouSection(true), /北京/, '前置:旧值已内化');

    const plan = JSON.stringify({
      saves: [],
      updates: [],
      forgets: [],
      triples: [],
      corrections: [{ relation: 'located_in', dst: 'hangzhou', fact: '用户已搬到杭州', old: 'beijing' }],
    });
    __setChatCreateImpl(async () => sse(plan));
    const r = await runReflection('user: 不对,我已经搬到杭州了');
    assert.equal(r.corrections, 1);
    assert.equal(r.profileChanged, true);
    const section = buildAboutYouSection(true);
    assert.match(section, /杭州/);
    assert.doesNotMatch(section, /北京/, '旧值必须被时序失效');
    // 旧边保留但已失效(可审计),不是硬删。
    const g = loadScopeGraph('global');
    const oldEdge = g.edges.find((e) => e.id === old.edgeId);
    assert.ok(oldEdge?.invalidAt, '旧边应被时序失效而非删除');
  }),
);
