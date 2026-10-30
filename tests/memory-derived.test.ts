/**
 * R14 级联失效(读时标记方案)。
 *
 * 设计取舍见 store.ts 的 `MemoryEntry.derivedFrom` 注释:不新增 `stale-derived` 状态,
 * 而是在读取时按源条目的**当前**状态现算。因此这里要钉的是三件事:
 *  1. 派生关系本身能存住(含自引用/重复/编造 id 的过滤);
 *  2. 源的三种失效形态(superseded / archived / 硬删)都能传导,且源复活后自动恢复;
 *  3. 失效必须**可见**(检索打标、索引标记),而不是被悄悄藏掉。
 *
 * 另有一条实测缺陷的回归:`status:'any'` 时 archived 条目曾凭标题分挤掉 active,
 * 且输出里没有任何标记——模型会把过期事实当现状读。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveEntry,
  forgetEntry,
  supersedeEntry,
  loadAll,
  listEntries,
  searchEntries,
  loadStalenessMap,
  __resetPendingRecallForTests,
} from '../src/memory/store.js';
import { memorySearchTool } from '../src/tools/builtins/memory-search.js';

/**
 * 隔离到临时 home + 临时 cwd。
 * home 与 cwd 必须分离:`$HOME/.mocode` 是 global、`$cwd/.mocode` 是 project,
 * 同目录会让 loadAll 把同一文件读两遍。
 */
function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-derived-'));
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
    try {
      await fn();
    } finally {
      __resetPendingRecallForTests(); // 召回脏集是模块级内存,不清会串到下一个用例
      process.chdir(cwd);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 造一条源条目,返回 id。 */
function mkSrc(name: string, summary = 'source note'): string {
  const r = saveEntry({ name, summary, body: `${name} body`, type: 'pitfall' });
  assert.ok(r.ok, `saveEntry 应成功: ${name}`);
  return (r as { ok: true; id: string }).id;
}

/** 造一条派生条目,返回 id。 */
function mkDerived(name: string, derivedFrom: string[], summary = 'derived note'): string {
  const r = saveEntry({ name, summary, body: `${name} body`, type: 'decision', derivedFrom });
  assert.ok(r.ok, `saveEntry 应成功: ${name}`);
  return (r as { ok: true; id: string }).id;
}

const projFile = (): string => join(process.cwd(), '.mocode', 'memory.jsonl');

/** 直接改盘上的 status,模拟"源复活"。没有 unarchive API,这是唯一能表达该场景的写法。 */
function reviveOnDisk(id: string): void {
  const p = projFile();
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out = lines.map((l) => {
    const e = JSON.parse(l) as { id: string; status: string; supersededBy?: string | null };
    if (e.id === id) {
      e.status = 'active';
      e.supersededBy = null;
    }
    return JSON.stringify(e);
  });
  writeFileSync(p, out.join('\n'), 'utf8');
}

// ── 1. 字段与归一 ───────────────────────────────────────────────────────────

test(
  'derivedFrom 落盘并可读回,顺序与去重符合预期',
  isolated(() => {
    const a = mkSrc('源甲');
    const b = mkSrc('源乙');
    const d = mkDerived('归纳结论', [a, b]);
    const e = loadAll().find((x) => x.id === d)!;
    assert.deepEqual(e.derivedFrom, [a, b]);
    // 洗一次盘再读,确认不是仅存于内存。
    assert.deepEqual(loadAll().find((x) => x.id === d)!.derivedFrom, [a, b]);
  }),
);

test(
  'derivedFrom 过滤自引用(自引用会让该条永远 stale)',
  isolated(() => {
    // id 由 name 确定性派生(ASCII 名 = 小写连字符),所以调用方能预先知道自己的 id。
    // 模型偶尔会把新 id 写进 derivedFrom,那样 computeStaleness 会把它判成 active
    // 以外的自己,或者干脆永远算作"源已失效"。
    const src = mkSrc('self-ref-source');
    const r = saveEntry({
      name: 'self-ref-note',
      summary: 'self ref note',
      body: 'self ref body',
      type: 'decision',
      derivedFrom: ['self-ref-note', src, 'self-ref-note', '  ', ''],
    });
    assert.ok(r.ok);
    const id = (r as { ok: true; id: string }).id;
    assert.equal(id, 'self-ref-note');
    const e = loadAll().find((x) => x.id === id)!;
    assert.deepEqual(e.derivedFrom, [src], '自引用/空串/重复都必须被滤掉');
    // 唯一真正的源仍 active → 不该 stale。
    assert.equal(loadStalenessMap().get(id)?.stale, false);
  }),
);

test(
  'derivedFrom 超过 8 条时截断(否则「任一源失效即 stale」会退化成恒 stale)',
  isolated(() => {
    const srcs = Array.from({ length: 10 }, (_, i) => mkSrc(`源${i + 1}号`));
    const d = mkDerived('归纳十条', srcs);
    assert.equal(loadAll().find((x) => x.id === d)!.derivedFrom!.length, 8);
  }),
);

test(
  '无 derivedFrom 的普通条目:stale 恒为 false,不进 staleness 表',
  isolated(() => {
    const a = mkSrc('普通条目甲');
    assert.equal(loadAll().find((x) => x.id === a)!.derivedFrom, undefined);
    assert.equal(loadStalenessMap().size, 0);
  }),
);

// ── 2. 三种源失效形态 ───────────────────────────────────────────────────────

test(
  '源被 superseded → 派生条目 stale,且不改派生条目自身的 status',
  isolated(() => {
    const a = mkSrc('会被取代的源');
    const b = mkSrc('取代者');
    const d = mkDerived('派生自会被取代的源', [a]);
    assert.equal(loadStalenessMap().get(d)?.stale, false);

    supersedeEntry(a, b, 'newer wins');
    const st = loadStalenessMap().get(d)!;
    assert.equal(st.stale, true);
    assert.deepEqual(st.inactive, [a]);
    assert.deepEqual(st.missing, []);
    // 关键:派生条目自己仍是 active —— 它可能依然成立,只是需要复核。
    assert.equal(loadAll().find((x) => x.id === d)!.status, 'active');
  }),
);

test(
  '源被 archive → 派生条目 stale(inactive)',
  isolated(() => {
    const a = mkSrc('会被归档的源');
    const d = mkDerived('派生自会被归档的源', [a]);
    forgetEntry(a, 'archive');
    const st = loadStalenessMap().get(d)!;
    assert.equal(st.stale, true);
    assert.deepEqual(st.inactive, [a]);
  }),
);

test(
  '源被硬删 → 派生条目 stale(missing),与 inactive 区分开',
  isolated(() => {
    const a = mkSrc('会被删掉的源');
    const d = mkDerived('派生自会被删掉的源', [a]);
    forgetEntry(a, 'delete');
    assert.equal(
      loadAll().some((x) => x.id === a),
      false,
    );
    const st = loadStalenessMap().get(d)!;
    assert.equal(st.stale, true);
    assert.deepEqual(st.missing, [a], '硬删必须落在 missing,而不是 inactive');
    assert.deepEqual(st.inactive, []);
  }),
);

test(
  '多条源只要有一条失效就 stale,并同时列出失效与缺失',
  isolated(() => {
    const a = mkSrc('源A号');
    const b = mkSrc('源B号');
    const c = mkSrc('源C号');
    const d = mkDerived('归纳三条', [a, b, c]);
    supersedeEntry(a, b, 'a 被 b 取代');
    forgetEntry(c, 'delete');
    const st = loadStalenessMap().get(d)!;
    assert.equal(st.stale, true);
    assert.deepEqual(st.inactive, [a]);
    assert.deepEqual(st.missing, [c]);
    assert.equal(st.inactive.includes(b), false, 'b 仍 active,不该被列出');
  }),
);

test(
  '源复活 → 派生条目自动解除 stale(读时现算的核心收益)',
  isolated(() => {
    const a = mkSrc('会复活的源');
    const d = mkDerived('派生自会复活的源', [a]);
    forgetEntry(a, 'archive');
    assert.equal(loadStalenessMap().get(d)?.stale, true);

    reviveOnDisk(a);
    assert.equal(loadAll().find((x) => x.id === a)!.status, 'active');
    assert.equal(loadStalenessMap().get(d)?.stale, false, '复活后不应留下永久脏标记');
  }),
);

test(
  '级联不递归: A 失效 → B(派生自 A)stale,但不波及 C(派生自 B)',
  isolated(() => {
    const a = mkSrc('链条源A');
    const b = mkDerived('链条中间B', [a]);
    const c = mkDerived('链条末端C', [b]);
    forgetEntry(a, 'archive');
    const map = loadStalenessMap();
    assert.equal(map.get(b)?.stale, true, 'B 的直接源失效 → B stale');
    assert.equal(map.get(c)?.stale, false, 'C 的直接源 B 仍是 active → C 不 stale');
  }),
);

// ── 3. 可见性:索引 / 检索 / 打标 ───────────────────────────────────────────

test(
  'listEntries 给失效派生条目带 stale 标记,普通条目不写该字段',
  isolated(() => {
    const a = mkSrc('索引源');
    const d = mkDerived('索引派生', [a]);
    const plain = mkSrc('索引普通条目');

    let items = listEntries();
    assert.equal(items.find((i) => i.id === d)?.stale, undefined, '未失效时不应有 stale 字段');
    assert.equal(items.find((i) => i.id === plain)?.stale, undefined);

    forgetEntry(a, 'archive');
    items = listEntries();
    assert.equal(items.find((i) => i.id === d)?.stale, true);
    assert.equal(items.find((i) => i.id === plain)?.stale, undefined, '非派生条目永远不带 stale');
  }),
);

test(
  'status="any" 时 active 永远排在非 active 之前(回归:archived 曾凭标题分挤掉 active)',
  isolated(() => {
    // 造 6 条 archived,标题里满是 cache(权重 10);1 条 active,只在 summary 命中(权重 5)。
    // 按 BM25 原序,active 会被彻底挤出 limit=5。
    // 注意 summary/body 必须逐条不同:saveEntry 的 dedupKey 是 summary+body 的哈希,
    // 六条内容一样会被判成同一条(这是 R0.1 的设计,不是 bug)。
    for (let i = 1; i <= 6; i++) {
      const r = saveEntry({
        name: `cache-redis-${i}`,
        summary: `旧笔记第 ${i} 版`,
        body: `旧内容 ${i}`,
        type: 'reference',
      });
      assert.ok(r.ok, `第 ${i} 条应保存成功`);
      forgetEntry((r as { ok: true; id: string }).id, 'archive');
    }
    const live = saveEntry({
      name: 'policy-note',
      summary: 'cache 写入策略定为写穿',
      body: '写穿覆盖',
      type: 'decision',
    });
    assert.ok(live.ok);
    const liveId = (live as { ok: true; id: string }).id;

    const any = searchEntries('cache', { status: 'any', limit: 5 });
    assert.equal(any.length, 5, '仍应返回满 limit 条');
    assert.equal(any[0].status, 'active', `active 必须排第一,实际: ${any.map((e) => e.status).join(',')}`);
    assert.equal(any[0].id, liveId);

    // 默认 active 路径不受影响:只回那一条,且没有非 active 混入。
    const onlyActive = searchEntries('cache', { limit: 5 });
    assert.equal(onlyActive.length, 1);
    assert.equal(onlyActive[0].id, liveId);
  }),
);

test(
  '默认 active 检索输出零噪音:不带任何状态前缀',
  isolated(async () => {
    const a = mkSrc('安静条目');
    mkDerived('安静派生', [a]);
    const out = String(await memorySearchTool.execute({ query: '安静' }, {} as never));
    assert.ok(!out.includes('SUPERSEDED'), out.slice(0, 300));
    assert.ok(!out.includes('ARCHIVED'), out.slice(0, 300));
    assert.ok(!out.includes('STALE-DERIVED'), out.slice(0, 300));
  }),
);

test(
  'memory_search status="any" 时对 superseded / archived / stale-derived 分别打标',
  isolated(async () => {
    const oldSrc = mkSrc('退役组件文档');
    const newSrc = mkSrc('现行组件文档');
    supersedeEntry(oldSrc, newSrc, 'docs rewritten');

    const archivedSrc = mkSrc('归档组件笔记');
    forgetEntry(archivedSrc, 'archive');

    const liveSrc = mkSrc('存活组件说明');
    const derived = mkDerived('组件综述', [liveSrc]);
    forgetEntry(liveSrc, 'archive'); // 让派生条目变 stale

    const out = String(await memorySearchTool.execute({ query: '组件', status: 'any', limit: 20 }, {} as never));

    assert.match(out, /SUPERSEDED/, '被取代的条目必须标 SUPERSEDED');
    assert.ok(out.includes(`SUPERSEDED → ${newSrc}`), '应指出被谁取代');
    assert.match(out, /ARCHIVED/, '归档条目必须标 ARCHIVED');
    assert.ok(out.includes(`STALE-DERIVED`), '失效派生条目必须标 STALE-DERIVED');
    assert.ok(out.includes(`源已失效: ${liveSrc}`), `应说明失效原因,实际片段: ${out.slice(0, 600)}`);
    // 派生条目本身仍是 active,不该被同时标成 superseded/archived。
    const derivedBlock = out.split('---').find((b) => b.includes(derived)) ?? '';
    assert.ok(derivedBlock.includes('STALE-DERIVED'));
    assert.ok(!derivedBlock.includes('SUPERSEDED'));
    assert.ok(!derivedBlock.includes('ARCHIVED]'));
  }),
);

test(
  '源被硬删时 memory_search 标出「源已被删除」',
  isolated(async () => {
    const src = mkSrc('将被删除的源');
    mkDerived('引用已删源的结论', [src]);
    forgetEntry(src, 'delete');
    const out = String(await memorySearchTool.execute({ query: '引用已删源', status: 'any' }, {} as never));
    assert.ok(out.includes('源已被删除'), out.slice(0, 400));
    assert.ok(out.includes(src));
  }),
);

// ── 4. 不破坏既有语义 ───────────────────────────────────────────────────────

test(
  '派生条目不因源失效而被排除出默认 active 检索(降权提示而非隐藏)',
  isolated(() => {
    const a = mkSrc('源头之甲');
    const d = mkDerived('抽象结论乙', [a], '抽象结论乙的摘要');
    forgetEntry(a, 'archive');
    const hits = searchEntries('抽象结论乙', { limit: 5 });
    assert.ok(
      hits.some((e) => e.id === d),
      '派生结论仍可被默认检索命中——它可能依然正确,不该因源失效而消失',
    );
  }),
);

test(
  'GC 不受 derivedFrom 影响:派生条目的去留仍按自身 recall/时间决定',
  isolated(() => {
    const a = mkSrc('gc-source-note');
    const d = mkDerived('gc-derived-note', [a]);
    forgetEntry(a, 'archive');
    // 派生条目自身状态未被改成 archived(读时判定不写库)。
    assert.equal(existsSync(projFile()), true);
    assert.equal(loadAll().find((x) => x.id === d)!.status, 'active');
  }),
);
