/**
 * R4.1 记忆健康快照(`src/memory/health.ts`)。
 *
 * 这个文件存在的理由:health 是**唯一**能把"记忆到底有没有在用"变成数字的地方。
 * 它的风险不在崩溃,而在**口径错误** —— 分母算错会让覆盖率永远停在低位、
 * 让人误判"通道坏了",从而去改一个其实没问题的实现。所以每个分母都要被钉住:
 *
 *  1. trigger 覆盖率的分母只含 `wantsTrigger` 的类型(pitfall/decision/feedback),
 *     不能把 fact/reference 算进去(它们本就该没有 trigger);
 *  2. 锚点 stale 率的分母是**已锚定**的条目,不是全部条目;
 *  3. 派生 stale 率同理;且 stale 必须能被源归档驱动出来(R14 的读时判定);
 *  4. 前摄计数是内存累计 + 落盘,必须能跨进程读回;
 *  5. `enabled=false` 时一个文件都不许建(R8.5 同口径)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import {
  buildMemoryHealth,
  writeMemoryHealth,
  readMemoryHealth,
  formatMemoryHealth,
  MEMORY_HEALTH_SCHEMA_VERSION,
} from '../src/memory/health.js';
import { saveEntry, forgetEntry, updateEntry, loadAll, __resetPendingRecallForTests } from '../src/memory/store.js';
import {
  __resetProactiveCountersForTests,
  __resetProactiveForTests,
  flushProactiveStats,
  proactiveCounters,
  proactiveHint,
} from '../src/memory/proactive.js';
import { recordRecallSearch } from '../src/memory/recall-stats.js';
import { recordSessionEpisode } from '../src/memory/episodic.js';

interface Dirs {
  projDir: string;
  homeDir: string;
}

function isolated(fn: (dirs: Dirs) => void | Promise<void>): () => Promise<void> {
  return async () => {
    // 必须同时 chdir 与 setSandboxRoot:
    //  - 记忆库/统计文件路径取 process.cwd()(store.ts、recall-stats.ts、proactive.ts)
    //  - 锚点判定取 sandboxRoot(anchor.ts)
    // 只设一个会让测试读错文件,甚至写进仓库真实库。
    const root = mkdtempSync(join(tmpdir(), 'mocode-health-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    mkdirSync(join(projDir, 'src'), { recursive: true });
    const env = {
      home: process.env.HOME,
      up: process.env.USERPROFILE,
      mem: process.env.MEMORY_ENABLED,
      epi: process.env.MOCODE_MEMORY_EPISODIC,
      pro: process.env.MOCODE_MEMORY_PROACTIVE,
    };
    const cwd = process.cwd();
    const prevRoot = setSandboxRoot(projDir);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.MEMORY_ENABLED = 'true';
    delete process.env.MOCODE_MEMORY_EPISODIC;
    delete process.env.MOCODE_MEMORY_PROACTIVE;
    process.chdir(projDir);
    __resetProactiveForTests();
    __resetProactiveCountersForTests();
    try {
      await fn({ projDir, homeDir });
    } finally {
      __resetPendingRecallForTests();
      __resetProactiveForTests();
      __resetProactiveCountersForTests();
      setSandboxRoot(prevRoot);
      for (const [k, v] of [
        ['HOME', env.home],
        ['USERPROFILE', env.up],
        ['MEMORY_ENABLED', env.mem],
        ['MOCODE_MEMORY_EPISODIC', env.epi],
        ['MOCODE_MEMORY_PROACTIVE', env.pro],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const healthFile = (): string => join(process.cwd(), '.mocode', 'memory-health.json');
const proactiveFile = (): string => join(process.cwd(), '.mocode', 'memory-proactive-stats.json');

// ── 条目与类型 ───────────────────────────────────────────────────────────

test(
  'buildMemoryHealth:条目计数与按类/按 scope 分型只统计 active',
  isolated(() => {
    const a = saveEntry({ type: 'pitfall', name: 'p1', summary: 's1', body: 'b1', scope: 'project' });
    const b = saveEntry({ type: 'fact', name: 'f1', summary: 's2', body: 'b2', scope: 'project' });
    const c = saveEntry({ type: 'reference', name: 'r1', summary: 's3', body: 'b3', scope: 'global' });
    assert.ok(a.ok && b.ok && c.ok);
    // 归档一条 → 不应出现在 active 分型里
    assert.ok(forgetEntry(b.id, 'archive').ok);

    const h = buildMemoryHealth();
    assert.equal(h.schemaVersion, MEMORY_HEALTH_SCHEMA_VERSION);
    assert.equal(h.entries.total, 3, 'total 含归档');
    assert.equal(h.entries.active, 2);
    assert.equal(h.entries.archived, 1);
    assert.equal(h.entries.superseded, 0);
    assert.equal(h.entries.byType.pitfall, 1);
    assert.equal(h.entries.byType.fact, undefined, '归档条目不算 active 分型');
    assert.equal(h.entries.byType.reference, 1);
    assert.equal(h.entries.byScope.project, 1);
    assert.equal(h.entries.byScope.global, 1);
  }),
);

test(
  'buildMemoryHealth:trigger 覆盖率分母只含 pitfall/decision/feedback,不含 fact/reference',
  isolated(() => {
    // 三类该有 trigger 的:只给其中一条 → 1/3
    saveEntry({
      type: 'pitfall',
      name: 'p',
      summary: 's',
      body: 'b',
      trigger: '改 dashscope schema 时',
      action: '剔除 uniqueItems',
    });
    saveEntry({ type: 'decision', name: 'd', summary: 's2', body: 'b2' });
    saveEntry({ type: 'feedback', name: 'f', summary: 's3', body: 'b3' });
    // 两类本就不需要 trigger 的:再多也不该拉低分母
    saveEntry({ type: 'fact', name: 'fa', summary: 's4', body: 'b4' });
    saveEntry({ type: 'reference', name: 're', summary: 's5', body: 'b5' });

    const h = buildMemoryHealth();
    assert.equal(h.trigger.required, 3, 'fact/reference 不进分母');
    assert.equal(h.trigger.withTrigger, 1);
    assert.equal(h.trigger.coverage, 0.333);
  }),
);

test(
  'buildMemoryHealth:episode 不计入 trigger 分母,单独统计巩固率',
  isolated(() => {
    const e1 = recordSessionEpisode({ sessionId: 's1', queries: ['q1'] });
    const e2 = recordSessionEpisode({ sessionId: 's2', queries: ['q2'] });
    assert.ok(e1.ok && e2.ok);
    // 标记其中一条已巩固(R11 的 derivedInto)
    assert.ok(updateEntry(e1.id, { derivedInto: 'some-semantic-id' }).ok);

    const h = buildMemoryHealth();
    assert.equal(h.trigger.required, 0, 'episode 不该要求 trigger');
    assert.equal(h.episodes.active, 2);
    assert.equal(h.episodes.consolidated, 1);
    assert.equal(h.episodes.consolidationRate, 0.5);
  }),
);

// ── 锚点(R2)────────────────────────────────────────────────────────────

test(
  'buildMemoryHealth:锚点 stale 率分母是已锚定条目,文件消失即计为 stale',
  isolated(({ projDir }) => {
    const target = join(projDir, 'src', 'a.ts');
    writeFileSync(target, 'export const a = 1;\n', 'utf8');
    const anchored = saveEntry({
      type: 'reference',
      name: 'a.ts 结构',
      summary: 'a 是入口',
      body: 'b',
      anchors: [{ path: 'src/a.ts' }],
    });
    assert.ok(anchored.ok);
    // 没锚点的条目:不该进分母
    saveEntry({ type: 'fact', name: 'no anchor', summary: 's', body: 'b' });

    const fresh = buildMemoryHealth();
    assert.equal(fresh.anchors.anchored, 1, '只有带 anchors 的条目进分母');
    assert.equal(fresh.anchors.stale, 0);

    // 删掉文件 → missing 也算 stale(记忆描述的东西已经不存在)
    rmSync(target);
    const after = buildMemoryHealth();
    assert.equal(after.anchors.anchored, 1);
    assert.equal(after.anchors.stale, 1);
    assert.equal(after.anchors.staleRate, 1);
  }),
);

// ── 派生(R14)──────────────────────────────────────────────────────────

test(
  'buildMemoryHealth:派生条目在源归档后计为 stale(读时判定,不写库)',
  isolated(() => {
    const src = saveEntry({ type: 'fact', name: 'src', summary: '源', body: 'b' });
    assert.ok(src.ok);
    const derived = saveEntry({
      type: 'fact',
      name: 'abstract',
      summary: '归纳',
      body: 'b2',
      derivedFrom: [src.id],
    });
    assert.ok(derived.ok);

    const before = buildMemoryHealth();
    assert.equal(before.derived.total, 1);
    assert.equal(before.derived.stale, 0);

    assert.ok(forgetEntry(src.id, 'archive').ok);
    const after = buildMemoryHealth();
    assert.equal(after.derived.total, 1, '派生条目本身仍是 active');
    assert.equal(after.derived.stale, 1, '源归档 → 派生条目 stale');
    assert.equal(after.derived.staleRate, 1);
    // 关键:判定是读时的,派生条目本身没被改写
    const stillActive = loadAll().find((e) => e.id === derived.id);
    assert.equal(stillActive?.status, 'active');
  }),
);

// ── 检索与前摄 ──────────────────────────────────────────────────────────

test(
  'buildMemoryHealth:检索数字来自 recall-stats,neverRecalled 反映「只写不读」',
  isolated(() => {
    saveEntry({ type: 'fact', name: 'x', summary: 's', body: 'b' });
    recordRecallSearch(true);
    recordRecallSearch(false);

    const h = buildMemoryHealth();
    assert.equal(h.retrieval.searches, 2);
    assert.equal(h.retrieval.graphHits, 1);
    assert.equal(h.retrieval.graphHitRate, 0.5);
    assert.equal(h.retrieval.neverRecalled, 1, '这条从未被召回');
  }),
);

test(
  'buildMemoryHealth:前摄计数按通道分开累计,落盘后可跨进程读回',
  isolated(() => {
    saveEntry({
      type: 'pitfall',
      name: 'dashscope schema',
      summary: '给 dashscope 构造工具 schema 时要剔 uniqueItems',
      body: 'b',
      trigger: '构造工具 schema 且后端是 dashscope 时',
      action: '递归剔除 uniqueItems',
    });

    // 命中 trigger 通道:轮文本与 trigger 重合
    const hit = proactiveHint('write_file', { path: 'src/a.ts' }, true, '构造工具 schema 发给 dashscope 报错了');
    assert.ok(hit.includes('[proactive memory]'), '应命中 trigger 通道');

    // 未命中:无关文本
    proactiveHint('write_file', { path: 'src/z.ts' }, true, '整理 README 的目录结构');

    const live = proactiveCounters();
    assert.equal(live.toolCalls, 2);
    assert.equal(live.triggerHits, 1);
    assert.equal(live.injections, 1);
    assert.equal(live.anchorHits, 0);

    flushProactiveStats();
    assert.ok(existsSync(proactiveFile()), 'flush 应落盘');

    // 模拟新进程:清掉内存状态,应当从文件读回累计值
    __resetProactiveCountersForTests();
    const reloaded = proactiveCounters();
    assert.equal(reloaded.toolCalls, 2);
    assert.equal(reloaded.injections, 1);
    assert.equal(reloaded.distinctEntries, live.distinctEntries > 0 ? live.distinctEntries : 0);
  }),
);

test(
  'buildMemoryHealth:锚点通道命中计入 anchorHits,stale 命中单独计数',
  isolated(({ projDir }) => {
    const target = join(projDir, 'src', 'b.ts');
    writeFileSync(target, 'export const b = 2;\n', 'utf8');
    const r = saveEntry({
      type: 'reference',
      name: 'b 模块结构',
      summary: 'b 是采集入口',
      body: 'b',
      anchors: [{ path: 'src/b.ts' }],
    });
    assert.ok(r.ok);

    const text = proactiveHint('edit_file', { path: 'src/b.ts' }, true, '随便改点什么');
    assert.ok(text.includes('锚定 src/b.ts'), '应命中锚点通道');
    assert.equal(proactiveCounters().anchorHits, 1);
    assert.equal(proactiveCounters().staleAnchorHits, 0);

    // 文件消失后再来一次(换一条记忆,避免 fired 冷却挡住)
    const r2 = saveEntry({
      type: 'reference',
      name: 'c 模块结构',
      summary: 'c 也是入口',
      body: 'b2',
      anchors: [{ path: 'src/b.ts' }],
    });
    assert.ok(r2.ok);
    rmSync(target);
    proactiveHint('edit_file', { path: 'src/b.ts' }, true, '再改一次');
    assert.equal(proactiveCounters().staleAnchorHits, 1, '已失效的锚点命中要单独计数');
  }),
);

// ── warnings ────────────────────────────────────────────────────────────

test(
  'buildMemoryHealth:warnings 指出「只写不读」与 trigger 覆盖不足',
  isolated(() => {
    // 5 条该带 trigger 的、一条都没有 → 覆盖率 0 且分母 ≥5。
    // 每条 summary/body 必须不同:saveEntry 的第二道去重是 dedupKey(归一化 summary+body),
    // 只换 name 会被折叠成 1 条,分母就够不到阈值(这条测试本身踩过)。
    const types = ['pitfall', 'pitfall', 'decision', 'decision', 'feedback'] as const;
    types.forEach((t, i) => {
      saveEntry({ type: t, name: `n${i}`, summary: `summary-${i}`, body: `body-${i}` });
    });
    const h = buildMemoryHealth();
    const joined = h.warnings.join('\n');
    assert.ok(joined.includes('memory_search 从未被调用'), '零检索要报出来');
    assert.ok(joined.includes('trigger 覆盖率'), '覆盖不足要报出来');
    assert.ok(h.warnings.length <= 6, '最多 6 条,避免刷屏');
  }),
);

test(
  'buildMemoryHealth:空库零警告,不产生噪音',
  isolated(() => {
    const h = buildMemoryHealth();
    assert.equal(h.entries.total, 0);
    assert.deepEqual(h.warnings, []);
  }),
);

// ── 落盘与开关 ──────────────────────────────────────────────────────────

test(
  'writeMemoryHealth:落盘后能读回,且 enabled=false 时一个文件都不建',
  isolated(() => {
    saveEntry({ type: 'fact', name: 'k', summary: 's', body: 'b' });

    assert.equal(writeMemoryHealth(false), null);
    assert.ok(!existsSync(healthFile()), '记忆关闭时不得创建健康快照(R8.5 同口径)');

    const written = writeMemoryHealth(true);
    assert.ok(written);
    assert.ok(existsSync(healthFile()));
    const back = readMemoryHealth();
    assert.ok(back);
    assert.equal(back.schemaVersion, MEMORY_HEALTH_SCHEMA_VERSION);
    assert.equal(back.entries.active, 1);
    // 文件必须是合法 JSON 且以换行结尾(便于 diff 与追加工具处理)
    const raw = readFileSync(healthFile(), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.doesNotThrow(() => JSON.parse(raw));
  }),
);

test(
  'formatMemoryHealth:输出包含各关键指标且无 undefined 泄漏',
  isolated(() => {
    saveEntry({ type: 'pitfall', name: 'p', summary: 's', body: 'b', trigger: 'when x', action: 'do y' });
    const lines = formatMemoryHealth(buildMemoryHealth());
    const joined = lines.join('\n');
    assert.ok(joined.includes('trigger 覆盖'));
    assert.ok(joined.includes('前摄'));
    assert.ok(joined.includes('情节'));
    assert.ok(!joined.includes('undefined'), '渲染不得出现 undefined');
  }),
);
