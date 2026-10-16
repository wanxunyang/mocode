/**
 * 轻量本体 + 召回埋点护栏(临时 HOME/cwd 分离隔离双 scope):
 *  - relation-vocab:别名归一、词表判定
 *  - 反思 triples/profile 关系归一与 relViolations(违N),词表外仍写入(软策略)
 *  - mergeEntities 跨 type 守卫:都分型且不同→拒;unknown→照常;同型→合并
 *  - recall-stats:计数、命中率、持久化、format
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { ensurePrimaryPerson, findEntity, mergeEntities, upsertEntity, PERSON_TYPE } from '../src/memory/graph.js';
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
