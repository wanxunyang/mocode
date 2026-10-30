/**
 * R2 代码锚点通道。
 *
 * 设计取舍见 `src/memory/anchor.ts` 顶部注释与 `MemoryEntry.anchors`。这里钉四件事:
 *  1. 哈希口径与 `read_file` 的 artifact hash **完全一致**(不一致就永远对不上,
 *     整条通道会静默恒 stale 或恒 fresh);
 *  2. 判定只降级不删除:代码变了记忆仍然 active、仍然能被检索到,只是带标记;
 *  3. R2.5 的抗误报:仅排版/注释变化不算过期,而**行内** `//` 不能被误剥
 *     (误剥的方向是假 fresh,比假 stale 危险);
 *  4. 回注侧的约束:只回 fresh、最多 3 条、只认 active。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAnchor,
  buildAnchors,
  evaluateAnchor,
  evaluateAnchors,
  evaluateAnchorsAgainst,
  extractSymbolFragment,
  normalizeForHash,
  toAnchorPath,
  MAX_ANCHORS,
  __resetAnchorCacheForTests,
} from '../src/memory/anchor.js';
import { contentHash } from '../src/changeset/index.js';
import {
  saveEntry,
  updateEntry,
  forgetEntry,
  loadAll,
  listEntries,
  searchEntries,
  entriesAnchoredTo,
  loadAnchorStaleMap,
  __resetPendingRecallForTests,
} from '../src/memory/store.js';
import { memorySearchTool } from '../src/tools/builtins/memory-search.js';
import { executeToolOutcome } from '../src/tools/registry.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
import '../src/tools/builtins/index.js';

/**
 * 隔离到临时 home + 临时 cwd。与 memory-derived.test.ts 同款:home 与 cwd 必须分离,
 * 否则 loadAll 会把同一个文件当成 global 和 project 读两遍。
 */
function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-anchor-'));
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
    // 锚点路径按**沙箱根**解析,而沙箱根是共享进程里的全局单例:别的测试文件
    // (read-file-sniff / sandbox …)会 setSandboxRoot 到自己的 tmp 根且未必复原。
    // 不在这里显式接管,本文件的相对路径就会解析到别人的目录里 → buildAnchor 全失败。
    const prevRoot = setSandboxRoot(projDir);
    __resetAnchorCacheForTests();
    try {
      await fn();
    } finally {
      __resetPendingRecallForTests();
      __resetAnchorCacheForTests();
      setSandboxRoot(prevRoot);
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

function write(rel: string, text: string): void {
  const abs = join(process.cwd(), rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  __resetAnchorCacheForTests(); // mtime 粒度可能不够细,写后必须让缓存失效
}

const SRC = `// 文件头注释
export function alpha(x: number): number {
  return x + 1;
}

export function beta(y: number): number {
  return y * 2;
}
`;

// ── 1. 哈希口径 ───────────────────────────────────────────────────────────

test(
  '无 symbol 的锚点:contentHash 与 read_file 的 artifact hash 同口径',
  isolated(() => {
    write('src/a.ts', SRC);
    const r = buildAnchor({ path: 'src/a.ts' });
    assert.ok(r.ok);
    // 整文件锚点必须等于 contentHash(整个文件文本)——这正是 read_file 头部写出的那个值。
    assert.equal(r.anchor.contentHash, contentHash(SRC));
    assert.equal(r.anchor.path, 'src/a.ts');
    assert.equal(r.anchor.symbol, undefined);
  }),
);

test(
  '有 symbol 的锚点:只哈希符号片段,同文件其它函数改动不影响',
  isolated(() => {
    write('src/a.ts', SRC);
    const r = buildAnchor({ path: 'src/a.ts', symbol: 'alpha' });
    assert.ok(r.ok);
    const frag = extractSymbolFragment(SRC, 'alpha');
    assert.ok(frag);
    assert.ok(frag.includes('return x + 1'), '片段应包住函数体');
    assert.ok(!frag.includes('return y * 2'), '片段不该吃到下一个函数');
    assert.equal(r.anchor.contentHash, contentHash(frag));

    // 只改 beta → alpha 锚点仍 fresh。
    const changed = SRC.replace('return y * 2;', 'return y * 3;');
    write('src/a.ts', changed);
    assert.equal(evaluateAnchor(r.anchor).status, 'fresh');

    // 改 alpha → stale。
    write('src/a.ts', changed.replace('return x + 1;', 'return x + 2;'));
    assert.equal(evaluateAnchor(r.anchor).status, 'stale');
  }),
);

// ── 2. 抗格式化误报(R2.5)────────────────────────────────────────────────

test(
  '仅缩进/空白/行首注释变化 → 仍判 fresh(否则一次 npm run format 就标脏全库)',
  isolated(() => {
    write('src/f.ts', `// 顶部注释\nexport function gamma() {\n  return 1;\n}\n`);
    const r = buildAnchor({ path: 'src/f.ts', symbol: 'gamma' });
    assert.ok(r.ok);

    // 重新缩进 + 改注释:字节变了,语义没变。
    write('src/f.ts', `// 换了一句注释\nexport function gamma() {\n    return 1;\n}\n`);
    assert.equal(evaluateAnchor(r.anchor).status, 'fresh');

    // 真改内容 → stale。
    write('src/f.ts', `// 换了一句注释\nexport function gamma() {\n    return 2;\n}\n`);
    assert.equal(evaluateAnchor(r.anchor).status, 'stale');
  }),
);

test(
  'normalizeForHash 不剥行内 `//`:URL 里的 // 被剥掉会造成假 fresh',
  isolated(() => {
    const a = `const u = 'http://example.com/a';`;
    const b = `const u = 'http://example.com/b';`;
    // 只有行首的 // 是注释;行内 // 是字符串内容,必须保留 → 归一后仍不同。
    assert.notEqual(normalizeForHash(a), normalizeForHash(b));
    // 行首注释被剥掉。
    assert.equal(normalizeForHash('  // note\nx'), normalizeForHash('x'));
  }),
);

// ── 3. 消失与不可解析 ─────────────────────────────────────────────────────

test(
  '文件消失 → missing(带说明),而不是静默 fresh',
  isolated(() => {
    write('src/gone.ts', 'export const x = 1;\n');
    const r = buildAnchor({ path: 'src/gone.ts' });
    assert.ok(r.ok);
    rmSync(join(process.cwd(), 'src/gone.ts'));
    __resetAnchorCacheForTests();
    const ev = evaluateAnchor(r.anchor);
    assert.equal(ev.status, 'missing');
    assert.equal(evaluateAnchors([r.anchor]).stale, true);
  }),
);

test(
  '符号被重命名 → missing;文件不存在时 buildAnchor 直接失败(不存空锚点)',
  isolated(() => {
    write('src/h.ts', SRC);
    const r = buildAnchor({ path: 'src/h.ts', symbol: 'alpha' });
    assert.ok(r.ok);
    write('src/h.ts', SRC.replace(/alpha/g, 'alphaRenamed'));
    assert.equal(evaluateAnchor(r.anchor).status, 'missing');

    const bad = buildAnchor({ path: 'src/not-there.ts' });
    assert.equal(bad.ok, false);
    const badSym = buildAnchor({ path: 'src/h.ts', symbol: 'nope' });
    assert.equal(badSym.ok, false);
  }),
);

// ── 4. 归一化与封顶 ───────────────────────────────────────────────────────

test(
  'buildAnchors:按 path+symbol 去重、丢弃不可解析项、封顶 MAX_ANCHORS',
  isolated(() => {
    for (let i = 0; i < MAX_ANCHORS + 3; i++) write(`src/m${i}.ts`, `export const v${i} = ${i};\n`);
    const inputs = [
      ...Array.from({ length: MAX_ANCHORS + 3 }, (_, i) => ({ path: `src/m${i}.ts` })),
      { path: 'src/m0.ts' }, // 重复
      { path: 'src/missing.ts' }, // 不存在
    ];
    const anchors = buildAnchors(inputs);
    assert.equal(anchors.length, MAX_ANCHORS);
    assert.equal(new Set(anchors.map((a) => a.path)).size, MAX_ANCHORS);
    assert.ok(!anchors.some((a) => a.path === 'src/missing.ts'));
  }),
);

test(
  '锚点路径归一:工作区内用相对正斜杠,区外用绝对路径',
  isolated(() => {
    assert.equal(toAnchorPath(join(process.cwd(), 'src', 'a.ts')), 'src/a.ts');
    assert.equal(toAnchorPath('src/b.ts'), 'src/b.ts');
  }),
);

// ── 5. 存储层:落盘、替换、只降级不删除 ──────────────────────────────────

test(
  'anchors 落盘可读回;文件改动后条目仍 active 且仍可检索,只是带 STALE-CODE',
  isolated(async () => {
    write('src/s.ts', SRC);
    const saved = saveEntry({
      name: 'alpha 的契约',
      summary: 'alpha 返回入参 + 1',
      body: 'alpha 是纯函数,返回 x+1。',
      type: 'reference',
      anchors: [{ path: 'src/s.ts', symbol: 'alpha' }],
    });
    assert.ok(saved.ok);
    const id = (saved as { ok: true; id: string }).id;

    const back = loadAll().find((e) => e.id === id)!;
    assert.equal(back.anchors?.length, 1);
    assert.equal(back.anchors![0].path, 'src/s.ts');
    assert.equal(back.anchors![0].symbol, 'alpha');
    assert.equal(loadAnchorStaleMap().get(id)?.stale, false);

    // 改代码 → 锚点失效,但条目本身不被删、不改 status。
    write('src/s.ts', SRC.replace('return x + 1;', 'return x + 10;'));
    const st = loadAnchorStaleMap().get(id)!;
    assert.equal(st.stale, true);
    assert.deepEqual(st.changed, ['src/s.ts#alpha']);
    assert.equal(loadAll().find((e) => e.id === id)!.status, 'active');

    // 仍能被检索到(R2.3:只降级不删除)。
    const hits = searchEntries('alpha 契约');
    assert.ok(hits.some((e) => e.id === id));

    // 检索输出必须带标记,否则模型会把过期事实当现状。
    const text = await memorySearchTool.execute({ query: 'alpha 契约' }, undefined as never);
    assert.match(String(text), /STALE-CODE/);
    assert.match(String(text), /src\/s\.ts#alpha/);
  }),
);

test(
  '记忆文件新建后重算 hash:同一份内容重新锚定即恢复 fresh(源变回来就自动恢复)',
  isolated(() => {
    write('src/r.ts', 'export function delta() { return 1; }\n');
    const saved = saveEntry({
      name: 'delta 行为',
      summary: 'delta 返回 1',
      body: 'delta 返回 1。',
      type: 'reference',
      anchors: [{ path: 'src/r.ts', symbol: 'delta' }],
    });
    assert.ok(saved.ok);
    const id = (saved as { ok: true; id: string }).id;

    write('src/r.ts', 'export function delta() { return 2; }\n');
    assert.equal(loadAnchorStaleMap().get(id)?.stale, true);

    // 改回原样(revert / 切分支回旧版本)→ 自动恢复,不留永久脏标记。
    write('src/r.ts', 'export function delta() { return 1; }\n');
    assert.equal(loadAnchorStaleMap().get(id)?.stale, false);
  }),
);

test(
  'updateEntry:anchors 整体替换([]=清空),旧锚点不会残留',
  isolated(() => {
    write('src/u1.ts', 'export const one = 1;\n');
    write('src/u2.ts', 'export const two = 2;\n');
    const saved = saveEntry({
      name: '可改锚点',
      summary: '改锚点测试',
      body: 'body',
      type: 'reference',
      anchors: [{ path: 'src/u1.ts' }],
    });
    assert.ok(saved.ok);
    const id = (saved as { ok: true; id: string }).id;
    assert.equal(loadAll().find((e) => e.id === id)!.anchors![0].path, 'src/u1.ts');

    updateEntry(id, { anchors: [{ path: 'src/u2.ts' }] });
    const after = loadAll().find((e) => e.id === id)!;
    assert.deepEqual(
      after.anchors!.map((a) => a.path),
      ['src/u2.ts'],
    );

    updateEntry(id, { anchors: [] });
    assert.equal(loadAll().find((e) => e.id === id)!.anchors, undefined);
  }),
);

test(
  'listEntries 暴露 anchorCount / anchorStale(只在有意义时才出现)',
  isolated(() => {
    write('src/l.ts', 'export const l = 1;\n');
    const withAnchor = saveEntry({
      name: '带锚点',
      summary: 's',
      body: 'b',
      type: 'reference',
      anchors: [{ path: 'src/l.ts' }],
    });
    assert.ok(withAnchor.ok);
    const id = (withAnchor as { ok: true; id: string }).id;

    const plain = saveEntry({ name: '不带锚点', summary: 's2', body: 'b2', type: 'reference' });
    assert.ok(plain.ok);

    const items = listEntries();
    const mine = items.find((i) => i.id === id)!;
    assert.equal(mine.anchorCount, 1);
    assert.equal(mine.anchorStale, undefined, 'fresh 时不输出该字段,避免噪音');
    const other = items.find((i) => i.name === '不带锚点')!;
    assert.equal(other.anchorCount, undefined);
    assert.equal(other.anchorStale, undefined);

    write('src/l.ts', 'export const l = 2;\n');
    assert.equal(listEntries().find((i) => i.id === id)!.anchorStale, true);
  }),
);

// ── 6. 回注侧(entriesAnchoredTo + read_file)──────────────────────────────

test(
  'entriesAnchoredTo:只返回锚定该文件的 active 条目,数量受 limit 约束',
  isolated(() => {
    write('src/t.ts', 'export const t = 1;\n');
    for (let i = 0; i < 5; i++) {
      const r = saveEntry({
        name: `锚定同文件的第${i}条`,
        summary: `s${i}`,
        body: `b${i}`,
        type: 'reference',
        anchors: [{ path: 'src/t.ts' }],
      });
      assert.ok(r.ok);
    }
    const archived = saveEntry({
      name: '锚定同文件但已归档',
      summary: 'sa',
      body: 'ba',
      type: 'reference',
      anchors: [{ path: 'src/t.ts' }],
    });
    assert.ok(archived.ok);
    forgetEntry((archived as { ok: true; id: string }).id, 'archive');

    assert.equal(entriesAnchoredTo('src/t.ts', { limit: 3 }).length, 3);
    const all = entriesAnchoredTo('src/t.ts', { limit: 10 });
    assert.equal(all.length, 5, '归档条目不回注——它说的是历史');
    assert.ok(all.every((e) => e.status === 'active'));
  }),
);

test(
  'read_file 尾部回注:≤3 条、只回 fresh、不相关的文件零注入',
  isolated(async () => {
    write('src/note.ts', SRC);
    write('src/other.ts', 'export const unrelated = true;\n');

    for (let i = 0; i < 4; i++) {
      const r = saveEntry({
        name: `关于 alpha 的第${i}条`,
        summary: `summary ${i}`,
        body: `body ${i}`,
        type: 'reference',
        anchors: [{ path: 'src/note.ts', symbol: 'alpha' }],
      });
      assert.ok(r.ok);
    }

    const prevRoot = setSandboxRoot(process.cwd());
    try {
      const out = await executeToolOutcome('read_file', JSON.stringify({ path: 'src/note.ts' }));
      assert.equal(out.status, 'success');
      assert.match(out.output, /## Memory anchored to this file/);
      const bullets = out.output.split('\n').filter((l) => l.startsWith('- ['));
      assert.equal(bullets.length, 3, '回注条数硬上限 3');
      assert.match(out.output, /关于 alpha 的第0条/);

      // 无关文件:零注入。
      const other = await executeToolOutcome('read_file', JSON.stringify({ path: 'src/other.ts' }));
      assert.ok(!other.output.includes('Memory anchored to this file'));

      // 代码改了 → 锚点不再 fresh → 不回注(此刻提示它等于灌旧事实)。
      write('src/note.ts', SRC.replace('return x + 1;', 'return x + 99;'));
      const stale = await executeToolOutcome('read_file', JSON.stringify({ path: 'src/note.ts' }));
      assert.ok(!stale.output.includes('Memory anchored to this file'));
    } finally {
      setSandboxRoot(prevRoot);
    }
  }),
);

test(
  'evaluateAnchorsAgainst 用调用方给的文本判定,不再碰磁盘',
  isolated(() => {
    write('src/v.ts', 'export const v = 1;\n');
    const r = buildAnchor({ path: 'src/v.ts' });
    assert.ok(r.ok);
    assert.equal(evaluateAnchorsAgainst([r.anchor], 'export const v = 1;\n').stale, false);
    assert.equal(evaluateAnchorsAgainst([r.anchor], 'export const v = 2;\n').stale, true);
    assert.equal(evaluateAnchorsAgainst(undefined, 'anything').stale, false);
  }),
);

test(
  'evaluateAnchorsAgainst 传 anchorPath 时只判该文件的锚点(多锚点条目不因别的文件缺席而误判 stale)',
  isolated(() => {
    write('src/m1.ts', 'export const m1 = 1;\n');
    write('src/m2.ts', 'export const m2 = 2;\n');
    const a1 = buildAnchor({ path: 'src/m1.ts' });
    const a2 = buildAnchor({ path: 'src/m2.ts' });
    assert.ok(a1.ok && a2.ok);
    const anchors = [(a1 as { ok: true; anchor: never }).anchor, (a2 as { ok: true; anchor: never }).anchor];

    // 旧行为:拿 m1.ts 的文本去判两条锚点,m2 的锚点必然「符号/内容对不上」→ 整条 stale。
    assert.equal(
      evaluateAnchorsAgainst(anchors, 'export const m1 = 1;\n').stale,
      true,
      '前置:不传 path 时确实会误判(这正是原 bug)',
    );
    // 修复后:只判本文件的锚点。
    assert.equal(evaluateAnchorsAgainst(anchors, 'export const m1 = 1;\n', 'src/m1.ts').stale, false);
    assert.equal(evaluateAnchorsAgainst(anchors, 'export const m2 = 2;\n', 'src/m2.ts').stale, false);
    // 本文件内容真变了 → 仍然 stale。
    assert.equal(evaluateAnchorsAgainst(anchors, 'export const m1 = 9;\n', 'src/m1.ts').stale, true);
    // 该条目未锚定这个文件 → 空状态,不冤枉。
    assert.equal(evaluateAnchorsAgainst(anchors, 'anything', 'src/other.ts').stale, false);
  }),
);

test(
  'read_file 回注:一条记忆锚定多个文件时,读其中任一文件都能回注',
  isolated(async () => {
    write('src/ma.ts', 'export const ma = 1;\n');
    write('src/mb.ts', 'export const mb = 2;\n');
    const r = saveEntry({
      name: 'MULTI-ANCHOR-ENTRY',
      summary: '跨两个文件的结构知识',
      body: 'ma 与 mb 必须成对修改。',
      type: 'reference',
      anchors: [{ path: 'src/ma.ts' }, { path: 'src/mb.ts' }],
    });
    assert.ok(r.ok);
    assert.equal(loadAll().find((e) => e.summary === '跨两个文件的结构知识')?.anchors?.length, 2);

    const prevRoot = setSandboxRoot(process.cwd());
    try {
      for (const p of ['src/ma.ts', 'src/mb.ts']) {
        const out = await executeToolOutcome('read_file', JSON.stringify({ path: p }));
        assert.equal(out.status, 'success');
        assert.match(out.output, /MULTI-ANCHOR-ENTRY/, `读 ${p} 应回注这条多锚点记忆`);
      }
      // 改掉其中一个文件 → 读那个文件时不再回注(它描述的那一侧已经过期)。
      write('src/ma.ts', 'export const ma = 99;\n');
      const stale = await executeToolOutcome('read_file', JSON.stringify({ path: 'src/ma.ts' }));
      assert.ok(!stale.output.includes('MULTI-ANCHOR-ENTRY'));
      // 但另一侧仍然 fresh,照常回注——多锚点不等于整条作废。
      const stillFresh = await executeToolOutcome('read_file', JSON.stringify({ path: 'src/mb.ts' }));
      assert.match(stillFresh.output, /MULTI-ANCHOR-ENTRY/);
    } finally {
      setSandboxRoot(prevRoot);
    }
  }),
);

test(
  'read_file 回注:先过滤 fresh 再截 3 条(前 3 条全 stale 时第 4 条仍能出现)',
  isolated(async () => {
    write('src/q.ts', 'export const q = 1;\n');
    for (let i = 0; i < 3; i++) {
      const r = saveEntry({
        name: `过期条目 ${i}`,
        summary: `stale ${i}`,
        body: `b ${i}`,
        type: 'reference',
        anchors: [{ path: 'src/q.ts' }],
      });
      assert.ok(r.ok);
    }
    // 让上面三条都变 stale,再写一条与当前内容一致的。
    write('src/q.ts', 'export const q = 2;\n');
    const fresh = saveEntry({
      name: '仍然有效的条目',
      summary: 'FRESH-AFTER-STALE',
      body: 'b fresh',
      type: 'reference',
      anchors: [{ path: 'src/q.ts' }],
    });
    assert.ok(fresh.ok);

    const prevRoot = setSandboxRoot(process.cwd());
    try {
      const out = await executeToolOutcome('read_file', JSON.stringify({ path: 'src/q.ts' }));
      assert.match(out.output, /FRESH-AFTER-STALE/, '先截断再过滤会让这条静默消失(原 bug)');
      assert.ok(!out.output.includes('过期条目'), 'stale 条目不该回注');
    } finally {
      setSandboxRoot(prevRoot);
    }
  }),
);

test(
  'markdown 文件的 `#` 是标题不是注释:改标题必须判 stale(否则是假 fresh)',
  isolated(() => {
    write('doc.md', '# 旧标题\n\n正文不变。\n');
    const r = buildAnchor({ path: 'doc.md' });
    assert.ok(r.ok);
    assert.equal(evaluateAnchor((r as { ok: true; anchor: never }).anchor).status, 'fresh');

    // 只改标题、正文不动:归一化后若把 `#` 行当注释剥掉就会判 fresh(假 fresh)。
    write('doc.md', '# 完全不同的标题\n\n正文不变。\n');
    assert.equal(evaluateAnchor((r as { ok: true; anchor: never }).anchor).status, 'stale');

    // 对照:Python 文件里的 `#` 确实是注释,改了不算过期。
    write('src/p.py', '# 注释一\ndef f():\n    return 1\n');
    const py = buildAnchor({ path: 'src/p.py', symbol: 'f' });
    assert.ok(py.ok);
    write('src/p.py', '# 注释二\ndef f():\n    return 1\n');
    assert.equal(evaluateAnchor((py as { ok: true; anchor: never }).anchor).status, 'fresh');
  }),
);

test(
  '无锚点条目:anchorStale 恒 false,evaluateAnchors 返 NOT_ANCHOR_STALE',
  isolated(() => {
    const r = saveEntry({ name: '无锚点条目', summary: 's', body: 'b', type: 'fact' });
    assert.ok(r.ok);
    const id = (r as { ok: true; id: string }).id;
    assert.equal(loadAll().find((e) => e.id === id)!.anchors, undefined);
    assert.equal(loadAnchorStaleMap().size, 0);
    assert.equal(evaluateAnchors(undefined).stale, false);
  }),
);
