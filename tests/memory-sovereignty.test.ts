/**
 * R8 用户主权 + R16.5 记忆写入保护(临时 HOME + chdir 双 scope 隔离,不碰真实记忆库)。
 *
 * 覆盖:
 *  - R8.2 purgeEntries:真删(非 archived)、dryRun 不落盘、pinned 豁免、无条件调用不清库
 *  - R8.1/R9.2 导出→清空→导入 的完整回还(条目 + 图谱),以及同 id 时"更近的胜"
 *  - R8.3 暂停:所有写入口 no-op,读路径完全正常
 *  - R8.5 MEMORY_ENABLED=false:不建任何记忆文件(连空文件都不建)
 *  - 审计行:批量删除/导出/导入/暂停各写一行,且不含正文
 *  - R16.5 沙箱拦 write_file/edit_file 改记忆状态文件,放行 read_file 与同目录其它文件
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveEntry,
  loadAll,
  purgeEntries,
  importEntries,
  searchEntries,
  gcMemories,
  flushRecallStats,
  setMemoryWritesPaused,
  isMemoryWritesPaused,
  memoryWriteBlockReason,
  __resetMemoryPauseForTests,
  __resetPendingRecallForTests,
  type MemoryEntry,
} from '../src/memory/store.js';
import { addTriple, invalidateEdge, loadAllGraph } from '../src/memory/graph.js';
// R8.4 的渲染函数导出仅为测试断言用(命令 handler 本身依赖 TUI 上下文,不易直测)。
import { sourceMark, renderEntryDetail } from '../src/repl/commands/memory.js';
import { buildPack, writePack, importPackFile, parsePack } from '../src/memory/portable.js';
import { appendAudit, readAudit, auditPath } from '../src/memory/audit.js';
import { appendPendingCandidates, loadPendingCandidates } from '../src/memory/pending.js';
import { enforceSandbox } from '../src/sandbox/policy.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

/**
 * 双隔离:home(global 库)与 proj(project 库 + cwd)必须分开——
 * 同目录会让 store 把同一文件按两个 scope 各读一遍。
 */
function isolated(fn: (t: TestContext, dirs: { home: string; proj: string }) => void | Promise<void>) {
  return async (t: TestContext) => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-sovereignty-'));
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
    process.env.MEMORY_ENABLED = 'true';
    process.chdir(projDir);
    __resetMemoryPauseForTests();
    __resetPendingRecallForTests();
    try {
      await fn(t, { home: homeDir, proj: projDir });
    } finally {
      setMemoryWritesPaused(false);
      __resetMemoryPauseForTests();
      __resetPendingRecallForTests();
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

const projectFile = (proj: string): string => join(proj, '.mocode', 'memory.jsonl');

function seed(n: number, prefix = 'e'): void {
  for (let i = 0; i < n; i++) {
    const r = saveEntry({
      name: `${prefix}-${i}`,
      summary: `摘要 ${prefix}${i}`,
      body: `正文 ${prefix}${i} 描述唯一内容 ${i}${prefix}`,
      type: 'fact',
      scope: 'project',
    });
    assert.equal(r.ok, true, `seed ${prefix}-${i} 应成功`);
  }
}

// ── R8.2 批量遗忘 ─────────────────────────────────────────────────────────

test(
  'purgeEntries: --dry-run 只列名单不落盘',
  isolated((_t, { proj }) => {
    seed(3);
    const before = readFileSync(projectFile(proj), 'utf8');
    const r = purgeEntries({ all: true, scope: 'project', dryRun: true });
    assert.equal('blocked' in r, false);
    if ('blocked' in r) return;
    assert.equal(r.ids.length, 3);
    assert.equal(r.dryRun, true);
    // 预览与执行不许不一致,但预览本身绝不能改文件。
    assert.equal(readFileSync(projectFile(proj), 'utf8'), before);
    assert.equal(loadAll().length, 3);
  }),
);

test(
  'purgeEntries: 真删是硬删(不是 archived),只留未命中的',
  isolated(() => {
    seed(3, 'keep');
    saveEntry({ name: 'scratch-1', summary: '临时', body: '待清理的内容', type: 'fact', scope: 'project' });
    saveEntry({ name: 'scratch-2', summary: '临时', body: '待清理的内容二', type: 'fact', scope: 'project' });

    const r = purgeEntries({ match: 'scratch' });
    assert.equal('blocked' in r, false);
    if ('blocked' in r) return;
    assert.deepEqual(r.ids.sort(), ['scratch-1', 'scratch-2']);

    const all = loadAll();
    // 硬删:连 archived 都不留一条——用户说"删",就不能只是藏起来。
    assert.equal(all.length, 3);
    assert.equal(
      all.some((e) => e.id.startsWith('scratch')),
      false,
    );
    assert.equal(
      all.every((e) => e.status === 'active'),
      true,
    );
  }),
);

test(
  'purgeEntries: pinned 永不删,报告保留条数',
  isolated(() => {
    saveEntry({ name: 'pin-me', summary: '钉住', body: '钉住的正文', type: 'fact', scope: 'project', pinned: true });
    saveEntry({ name: 'drop-me', summary: '可删', body: '可删正文', type: 'fact', scope: 'project' });

    const r = purgeEntries({ all: true, scope: 'project' });
    assert.equal('blocked' in r, false);
    if ('blocked' in r) return;
    assert.deepEqual(r.ids, ['drop-me']);
    assert.equal(r.pinned, 1);
    const all = loadAll();
    assert.deepEqual(
      all.map((e) => e.id),
      ['pin-me'],
    );
  }),
);

test(
  'purgeEntries: 无条件调用不清库(防手滑)',
  isolated(() => {
    seed(2);
    const r = purgeEntries({});
    assert.equal('blocked' in r, false);
    if ('blocked' in r) return;
    assert.deepEqual(r.ids, []);
    assert.equal(loadAll().length, 2);
  }),
);

test(
  'purgeEntries: --since 按创建时刻过滤,--scope 限定只动一个库',
  isolated((_t, { home, proj }) => {
    saveEntry({ name: 'g-old', summary: '旧全局', body: '全局正文一', type: 'fact', scope: 'global' });
    saveEntry({ name: 'p-new', summary: '新项目', body: '项目正文一', type: 'fact', scope: 'project' });
    // 把全局条目回拨到很久以前(直接改盘上 JSONL,不经 store)。
    const gp = join(home, '.mocode', 'memory.jsonl');
    const lines = readFileSync(gp, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const e = JSON.parse(l) as MemoryEntry;
        e.createdAt = '2020-01-01T00:00:00.000Z';
        e.updatedAt = '2020-01-01T00:00:00.000Z';
        return JSON.stringify(e);
      });
    writeFileSync(gp, lines.join('\n'), 'utf8');

    const scoped = purgeEntries({ all: true, scope: 'project' });
    assert.equal('blocked' in scoped, false);
    if ('blocked' in scoped) return;
    assert.deepEqual(scoped.ids, ['p-new']);
    // global 那条必须还在(scope 过滤生效)。
    assert.equal(
      loadAll().some((e) => e.id === 'g-old'),
      true,
    );

    // --since 的语义是「只删**不早于**该时刻的条目」,所以 2020 年的条目对 since=2021 不命中。
    const sinceFuture = purgeEntries({ since: '2021-01-01', scope: 'global', dryRun: true });
    assert.equal('blocked' in sinceFuture, false);
    if ('blocked' in sinceFuture) return;
    assert.deepEqual(sinceFuture.ids, [], '2020 年的条目早于 since=2021,不应命中');

    // 对照组:since 早于创建时刻 → 命中。这条把上面的空集钉成"语义正确"而非"筛选坏了"。
    const sincePast = purgeEntries({ since: '2019-01-01', scope: 'global', dryRun: true });
    assert.equal('blocked' in sincePast, false);
    if ('blocked' in sincePast) return;
    assert.deepEqual(sincePast.ids, ['g-old']);
    assert.equal(existsSync(projectFile(proj)), true);
  }),
);

// ── 审计 ──────────────────────────────────────────────────────────────────

test(
  '审计:批量删除写一行,只记 id 不记正文',
  isolated(() => {
    saveEntry({
      name: 'secret-x',
      summary: '敏感摘要',
      body: '这是应当被彻底忘掉的敏感正文',
      type: 'fact',
      scope: 'project',
    });
    purgeEntries({ match: 'secret-x' });
    const recs = readAudit(10);
    const purge = recs.filter((r) => r.action === 'purge');
    assert.equal(purge.length, 1);
    assert.deepEqual(purge[0].ids, ['secret-x']);
    // 审计文件同样落在磁盘上:正文与摘要一个字都不能进去。
    const raw = readFileSync(auditPath(), 'utf8');
    assert.equal(raw.includes('敏感摘要'), false);
    assert.equal(raw.includes('彻底忘掉'), false);
    assert.equal(raw.includes('secret-x'), true);
  }),
);

test(
  '审计:读回时序追加,坏行不连累其余',
  isolated(() => {
    appendAudit({ at: '2026-01-01T00:00:00.000Z', action: 'pause', detail: 'a' });
    appendAudit({ at: '2026-01-02T00:00:00.000Z', action: 'resume', detail: 'b' });
    writeFileSync(auditPath(), readFileSync(auditPath(), 'utf8') + '{坏行\n', 'utf8');
    const recs = readAudit(10);
    assert.deepEqual(
      recs.map((r) => r.action),
      ['pause', 'resume'],
    );
    assert.deepEqual(
      readAudit(1).map((r) => r.action),
      ['resume'],
      'limit 取最近的',
    );
  }),
); // ── R8.1 / R9.2 导出 → 清空 → 导入 回还 ──────────────────────────────────

test(
  '导出/导入:清空后从包还原条目与图谱(R8.1 验收)',
  isolated((_t, { proj }) => {
    saveEntry({
      name: 'pack-a',
      summary: '包内条目 A',
      body: '正文 A 的唯一内容',
      type: 'decision',
      scope: 'project',
      trigger: '当 A 发生时',
      action: '做 A 的动作',
    });
    saveEntry({ name: 'pack-b', summary: '包内条目 B', body: '正文 B 的唯一内容', type: 'pitfall', scope: 'project' });
    const tri = addTriple({ src: 'pack-a', relation: 'uses', dst: 'pack-b', fact: 'A 用 B', scope: 'project' });
    assert.equal(tri.ok, true);

    const pack = buildPack();
    assert.equal(pack.entries.length, 2);
    assert.equal(pack.graph.entities.length >= 2, true);
    const packPath = writePack(pack);
    assert.equal(existsSync(packPath), true);

    // 清空(真删),模拟"换机 / 误删后还原"。
    const wiped = purgeEntries({ all: true });
    assert.equal('blocked' in wiped, false);
    assert.equal(loadAll().length, 0);

    const res = importPackFile(packPath);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.added, 2);

    const restored = loadAll();
    assert.deepEqual(restored.map((e) => e.id).sort(), ['pack-a', 'pack-b']);
    // trigger/action 这类可选字段必须原样回来——否则还原出来的是一份"形似"的记忆。
    const a = restored.find((e) => e.id === 'pack-a');
    assert.equal(a?.trigger, '当 A 发生时');
    assert.equal(a?.action, '做 A 的动作');
    assert.equal(
      loadAllGraph().edges.some((e) => e.fact === 'A 用 B'),
      true,
    );
    assert.equal(existsSync(projectFile(proj)), true);
  }),
);

test(
  '导入:同 id 时更新时刻更晚的胜出,更早的不覆盖本地',
  isolated(() => {
    const base = saveEntry({ name: 'conflict', summary: '本地版本', body: '本地正文', type: 'fact', scope: 'project' });
    assert.equal(base.ok, true);
    const local = loadAll()[0];
    assert.equal(local.summary, '本地版本');

    // 更早的包:必须被跳过(不能用"最后写入者胜",那会拿旧数据顶掉当前看到的)。
    const older: MemoryEntry = { ...local, summary: '更旧版本', updatedAt: '2020-01-01T00:00:00.000Z' };
    const r1 = importEntries([older]);
    assert.equal('blocked' in r1, false);
    if ('blocked' in r1) return;
    assert.equal(r1.skipped, 1);
    assert.equal(loadAll()[0].summary, '本地版本');

    // 更新的包:胜出。
    const newer: MemoryEntry = { ...local, summary: '更新版本', updatedAt: '2099-01-01T00:00:00.000Z' };
    const r2 = importEntries([newer]);
    assert.equal('blocked' in r2, false);
    if ('blocked' in r2) return;
    assert.equal(r2.updated, 1);
    assert.equal(loadAll()[0].summary, '更新版本');
  }),
);

test(
  'parsePack:schemaVersion 高于支持版本时拒收,低于时按惰性迁移放行',
  isolated(() => {
    const tooNew = parsePack(JSON.stringify({ schemaVersion: 999, entries: [], graph: { entities: [], edges: [] } }));
    assert.equal(tooNew.ok, false);
    if (!tooNew.ok) assert.match(tooNew.reason, /schemaVersion/);

    const noVersion = parsePack(JSON.stringify({ entries: [] }));
    assert.equal(noVersion.ok, false);

    const ok = parsePack(JSON.stringify({ schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', entries: [] }));
    assert.equal(ok.ok, true);

    const badJson = parsePack('{not json');
    assert.equal(badJson.ok, false);
  }),
);

// ── R8.3 暂停 ─────────────────────────────────────────────────────────────

test(
  '暂停:所有写入口 no-op,读/检索/GC 语义正常',
  isolated((_t, { proj }) => {
    saveEntry({ name: 'before-pause', summary: '暂停前', body: '暂停前的正文内容', type: 'fact', scope: 'project' });
    const before = readFileSync(projectFile(proj), 'utf8');

    setMemoryWritesPaused(true);
    assert.equal(isMemoryWritesPaused(), true);
    assert.equal(memoryWriteBlockReason(), 'paused');

    const r = saveEntry({
      name: 'during-pause',
      summary: '暂停中',
      body: '暂停中的正文内容',
      type: 'fact',
      scope: 'project',
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && 'blocked' in r && r.blocked === 'paused');

    const tri = addTriple({ src: 'x', relation: 'uses', dst: 'y', scope: 'project' });
    assert.equal(tri.ok, false);
    assert.equal(appendPendingCandidates([{ kind: 'fact', text: '暂停中不该进队' }]), 0);
    assert.equal(loadPendingCandidates().length, 0);
    assert.deepEqual(gcMemories(), { decayed: 0, capped: 0, gced: 0 });
    assert.equal(flushRecallStats(), 0);

    // 文件一个字节都不能变(不只是"逻辑上没写")。
    assert.equal(readFileSync(projectFile(proj), 'utf8'), before);

    // 读路径完全正常:检索仍能命中暂停前那条。
    const hits = searchEntries('暂停前的正文内容', { status: 'any' });
    assert.equal(
      hits.some((e) => e.id === 'before-pause'),
      true,
    );

    setMemoryWritesPaused(false);
    const after = saveEntry({
      name: 'after-resume',
      summary: '恢复后',
      body: '恢复后的正文内容',
      type: 'fact',
      scope: 'project',
    });
    assert.equal(after.ok, true);
  }),
);

test(
  '暂停:批量删除(dry-run 除外)被拦,预览仍可用',
  isolated(() => {
    seed(2);
    setMemoryWritesPaused(true);
    const blocked = purgeEntries({ all: true, scope: 'project' });
    assert.equal('blocked' in blocked, true);
    if ('blocked' in blocked) assert.equal(blocked.blocked, 'paused');
    assert.equal(loadAll().length, 2);

    // dryRun 只是预演,不该被暂停挡住——被封口时更需要先看看会删什么。
    const preview = purgeEntries({ all: true, scope: 'project', dryRun: true });
    assert.equal('blocked' in preview, false);
    if ('blocked' in preview) return;
    assert.equal(preview.ids.length, 2);
  }),
);

// ── R8.5 关闭即无文件 ─────────────────────────────────────────────────────

test(
  'MEMORY_ENABLED=false:不建任何记忆文件(连空文件都不建)',
  isolated((_t, { home, proj }) => {
    process.env.MEMORY_ENABLED = 'false';
    assert.equal(memoryWriteBlockReason(), 'disabled');

    const r = saveEntry({ name: 'nope', summary: '不该落盘', body: '不该落盘的正文', type: 'fact', scope: 'project' });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && 'blocked' in r && r.blocked === 'disabled');
    addTriple({ src: 'a', relation: 'uses', dst: 'b', scope: 'project' });
    assert.equal(appendPendingCandidates([{ kind: 'fact', text: '也不该进队' }]), 0);
    gcMemories();

    assert.equal(existsSync(join(proj, '.mocode', 'memory.jsonl')), false);
    assert.equal(existsSync(join(proj, '.mocode', 'memory-graph.json')), false);
    assert.equal(existsSync(join(proj, '.mocode', 'memory-pending.jsonl')), false);
    assert.equal(existsSync(join(home, '.mocode', 'memory.jsonl')), false);
    assert.equal(existsSync(join(home, '.mocode', 'memory-graph.json')), false);
    // 注意:审计文件不受 MEMORY_ENABLED 影响(它记录的是"用户动作"而非记忆内容),
    // 这里只断言记忆本体不落地。
  }),
);

// ── R16.5 沙箱写入保护 ────────────────────────────────────────────────────

test(
  'R16.5:写入工具不能改 .mocode 下的记忆状态文件',
  isolated((_t, { proj }) => {
    const prev = setSandboxRoot(proj);
    try {
      for (const file of [
        '.mocode/memory.jsonl',
        '.mocode/memory-graph.json',
        '.mocode/memory-pending.jsonl',
        '.mocode/memory-audit.jsonl',
        '.mocode/memory-health.json',
        '.mocode/memory-recall-stats.json',
        // 原子写的半成品同样不能碰
        '.mocode/memory.jsonl.tmp',
      ]) {
        for (const tool of ['write_file', 'edit_file']) {
          const err = enforceSandbox(tool, { path: file });
          assert.ok(typeof err === 'string' && err.length > 0, `${tool} ${file} 应被拒`);
          assert.match(err, /记忆/, `${tool} ${file} 的拒绝文案应点明记忆`);
          assert.match(err, /memory_/, `${tool} ${file} 的拒绝文案应指向 memory_* 工具`);
        }
        // 读取必须放行:诊断、导出、自查都依赖它。
        assert.equal(enforceSandbox('read_file', { path: file }), null, `read_file ${file} 应放行`);
      }

      // 同目录下的非记忆文件、以及名字相似但不在 .mocode 目录下的,都不该被误伤。
      assert.equal(enforceSandbox('write_file', { path: '.mocode/notes.md' }), null);
      assert.equal(enforceSandbox('write_file', { path: 'src/memory.jsonl' }), null);
      assert.equal(enforceSandbox('write_file', { path: '.mocode-spec/memory.jsonl' }), null);
    } finally {
      setSandboxRoot(prev);
    }
  }),
);

test(
  'R16.5:路径逃逸变体(.mocode/../.mocode/)也拦得住',
  isolated((_t, { proj }) => {
    const prev = setSandboxRoot(proj);
    try {
      const err = enforceSandbox('write_file', { path: '.mocode/../.mocode/memory.jsonl' });
      assert.ok(typeof err === 'string', '归一化后仍是 .mocode/memory.jsonl,应被拒');
    } finally {
      setSandboxRoot(prev);
    }
  }),
); // ── R8.4 来源展示(渲染层断言,不只是"函数存在")────────────────────────────

test(
  'R8.4:概览来源标记区分工具写入与后台产生',
  isolated(() => {
    const tool = saveEntry({
      name: 'by-tool',
      summary: '工具写的',
      body: '工具写的正文',
      type: 'fact',
      scope: 'project',
    });
    assert.equal(tool.ok, true);
    saveEntry({
      name: 'by-episode',
      summary: '后台写的',
      body: '后台写的正文',
      type: 'episode',
      scope: 'project',
      source: { session: 'sess-abcdef123456' },
    });

    const all = loadAll();
    const toolEntry = all.find((e) => e.id === 'by-tool')!;
    const bgEntry = all.find((e) => e.id === 'by-episode')!;
    assert.equal(sourceMark(toolEntry), '[tool]');
    assert.equal(sourceMark(bgEntry), '[reflection]');
    // 空 source 也按工具写入算:反思/情节必然带 session,没有 session 就是会话内写的。
    assert.equal(sourceMark({ ...toolEntry, source: null }), '[tool]');
  }),
);

test(
  'R8.4:/memory show 展示来源、作用域、召回次数,并带出图谱边的 prov',
  isolated(() => {
    saveEntry({
      name: 'show-me',
      summary: '待展示的摘要',
      body: '待展示的正文内容',
      type: 'decision',
      scope: 'global',
      trigger: '当 X 发生时',
      action: '执行 Y',
    });
    addTriple({
      src: 'show-me',
      relation: 'uses',
      dst: 'some-target',
      fact: '展示用事实',
      sourceEntry: 'show-me',
      scope: 'global',
      prov: 'user_said',
      confidence: 0.9,
    });

    const e = loadAll().find((x) => x.id === 'show-me')!;
    const out = renderEntryDetail(e);

    assert.match(out, /show-me/);
    assert.match(out, /decision/);
    assert.match(out, /global\(跨项目\)/, '作用域要说清是哪个库');
    assert.match(out, /会话内工具写入|后台产生/, '必须回答"凭什么信它"');
    assert.match(out, /当 X 发生时/, 'trigger 要展示(它是这条何时响应的唯一线索)');
    assert.match(out, /执行 Y/);
    // 条目自身没有 confidence,真置信在边上——必须从图谱里带出来,而不是编一个。
    assert.match(out, /user_said/);
    assert.match(out, /conf 0\.9/);
    assert.match(out, /待展示的摘要/);
  }),
);

test(
  'R8.4:/memory show 对失效的关联边标注原因',
  isolated(() => {
    saveEntry({ name: 'stale-edge', summary: '摘要', body: '正文内容', type: 'fact', scope: 'global' });
    const tri = addTriple({
      src: 'stale-edge',
      relation: 'uses',
      dst: 'old-target',
      fact: '会被取代的事实',
      sourceEntry: 'stale-edge',
      scope: 'global',
    });
    assert.equal(tri.ok, true);
    if (!tri.ok) return;
    const dead = invalidateEdge(tri.edgeId, 'user-correction');
    assert.equal(dead.ok, true);

    const e = loadAll().find((x) => x.id === 'stale-edge')!;
    const out = renderEntryDetail(e);
    assert.match(out, /已失效/, '失效边不能当作仍然成立的事实展示');
    assert.match(out, /user-correction/, '失效原因要可见,否则用户无法判断该不该信');
  }),
);
