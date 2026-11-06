/**
 * R2.6 存量锚点回填(`/memory anchor`)。
 *
 * R2 的锚点通道在真实库上完全休眠:所有既有条目都是 0 锚点,因为只有新写入才产锚点。
 * 这里钉的是回填的两个边界,它们决定了这条通道会不会变成噪音源:
 *
 *  1. **抽取必须确定性且保守**:只收「像路径 + 扩展名在白名单里 + 工作区里真的存在」
 *     的字面量。`2.01`(相机固件)、`typesafe.ai`(域名)这类「点 + 数字/字母」必须被
 *     挡掉,否则每次回填都会给一批记忆锚上不存在的文件,它们的 `STALE-CODE` 标记
 *     从此永远是亮的——模型会学会无视这个标记,这正是 R2 要避免的失败。
 *  2. **写库必须由用户确认**。`applyAnchorCandidates` 只写被选中的序号,且写入前
 *     重新校验存在性:扫描与确认之间文件可能已被删除,半套锚点会误判 stale。
 *
 * isolated() 同时改 HOME/cwd/sandboxRoot —— 与 memory-anchor.test.ts 同款,三个都要,
 * 缺一个就会写进仓库真实记忆库或把相对路径解析到别人的 tmp 目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectAnchorCandidates,
  applyAnchorCandidates,
  extractAnchorPaths,
  looksLikePath,
  ANCHOR_BACKFILL_MAX_PATHS,
} from '../../src/memory/anchor-backfill.js';
import { loadAll, saveEntry, __resetPendingRecallForTests } from '../../src/memory/store.js';
import { __resetAnchorCacheForTests } from '../../src/memory/anchor.js';
import { setSandboxRoot } from '../../src/sandbox/root.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-anchor-backfill-'));
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

function write(rel: string, text = 'export const x = 1;\n'): void {
  const abs = join(process.cwd(), rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  __resetAnchorCacheForTests();
}

function save(name: string, body: string, over: Record<string, unknown> = {}) {
  const r = saveEntry({ name, summary: body.slice(0, 80), body, type: 'reference', scope: 'project', ...over });
  assert.equal(r.ok, true, `前置:条目 ${name} 应写入成功`);
  return r.ok ? r.id : '';
}

// ── 1. 形状判定 ───────────────────────────────────────────────────────────

test('looksLikePath:认路径,拒版本号与域名', () => {
  assert.equal(looksLikePath('src/memory/store.ts'), true);
  assert.equal(looksLikePath('AGENTS.md'), true, '纯文件名也认(存在性另有检查)');
  assert.equal(looksLikePath('2.01'), false, '相机固件号不是路径');
  assert.equal(looksLikePath('4.00'), false);
  assert.equal(looksLikePath('typesafe.ai'), false, '域名后缀不在白名单');
  assert.equal(looksLikePath('https://example.com/a.ts'), false, 'URL 走独立锚点,不进回填');
  assert.equal(looksLikePath('README'), false, '无扩展名');
});

// ── 2. 抽取 ───────────────────────────────────────────────────────────────

test(
  'extractAnchorPaths:只留工作区内真实存在的文件,顺序稳定',
  isolated(() => {
    write('src/memory/store.ts');
    write('docs/guide.md');
    const paths = extractAnchorPaths(
      {
        name: '关于 store',
        summary: 'store.ts 是记忆库底座',
        body:
          '`src/memory/store.ts` 里 saveEntry 会算 dedupKey;另见 docs/guide.md。\n' + '不存在的 src/gone.ts 应被丢弃。',
      },
      process.cwd(),
    );
    assert.deepEqual(paths, ['src/memory/store.ts', 'docs/guide.md']);
  }),
);

test(
  'extractAnchorPaths:单条最多 4 个路径',
  isolated(() => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    for (const f of files) write(`src/${f}`);
    const paths = extractAnchorPaths(
      { name: 'many', summary: '', body: files.map((f) => `src/${f}`).join(' ') },
      process.cwd(),
    );
    assert.equal(paths.length, ANCHOR_BACKFILL_MAX_PATHS);
    assert.deepEqual(
      paths,
      files.slice(0, 4).map((f) => `src/${f}`),
    );
  }),
);

test(
  'extractAnchorPaths:工作区外的路径不提议(归属机器判断不了)',
  isolated(() => {
    // 造一个工作区外的真实文件
    const outside = join(process.cwd(), '..', 'outside.ts');
    writeFileSync(outside, 'export const y = 2;\n', 'utf8');
    const paths = extractAnchorPaths({ name: 'x', summary: '', body: outside }, process.cwd());
    assert.deepEqual(paths, []);
  }),
);

test(
  'extractAnchorPaths:node_modules 里的路径跳过(装包就消失)',
  isolated(() => {
    write('node_modules/pkg/index.js');
    const paths = extractAnchorPaths({ name: 'x', summary: '', body: 'node_modules/pkg/index.js' }, process.cwd());
    assert.deepEqual(paths, []);
  }),
);

// ── 3. 候选扫描 ───────────────────────────────────────────────────────────

test(
  'collectAnchorCandidates:已锚定与无路径的条目各自计数,不进候选',
  isolated(() => {
    write('src/hit.ts');
    save('has-path', '改 src/hit.ts 时注意 contentHash 口径');
    save('no-path', '一条纯经验,没有任何文件路径');
    // 已锚定:先写一条再手动锚上
    const anchoredId = save('already', '已经锚过 src/hit.ts');
    const all = loadAll();
    assert.ok(all.find((e) => e.id === anchoredId));

    const scan = collectAnchorCandidates(process.cwd());
    // 三条里只有 has-path 该进候选(already 还没锚,所以它也在候选里)——
    // 这里先验证没人被误算,再把 already 真锚上,见下一个用例。
    const ids = scan.candidates.map((c) => c.id);
    assert.ok(ids.includes('has-path'));
    assert.ok(!ids.includes('no-path'), '没路径的不该出现');
    assert.equal(scan.noPath, 1);
  }),
);

test(
  'collectAnchorCandidates:已锚定的条目被跳过(锚点集是替换语义,不做叠加)',
  isolated(() => {
    write('src/hit.ts');
    const id = save('anchored-one', '看 src/hit.ts');
    const scan1 = collectAnchorCandidates(process.cwd());
    assert.equal(scan1.candidates.length, 1, '前置:未锚定时应有 1 条候选');

    const r = applyAnchorCandidates(scan1.candidates, 'all', process.cwd());
    assert.equal(r.saved.length, 1);
    assert.deepEqual(r.saved[0].paths, ['src/hit.ts']);

    const scan2 = collectAnchorCandidates(process.cwd());
    assert.equal(scan2.candidates.length, 0, '锚上之后不该再提议同一条');
    assert.equal(scan2.alreadyAnchored, 1);
    assert.ok(loadAll().find((e) => e.id === id)?.anchors?.length, '锚点应真的落到条目上');
  }),
);

test(
  'collectAnchorCandidates:序号从 1 起连续',
  isolated(() => {
    write('src/a.ts');
    save('one', 'src/a.ts');
    save('two', 'src/a.ts 也说一遍');
    const scan = collectAnchorCandidates(process.cwd());
    assert.deepEqual(
      scan.candidates.map((c) => c.index),
      scan.candidates.map((_, i) => i + 1),
    );
  }),
);

// ── 4. 写入 ───────────────────────────────────────────────────────────────

test(
  'applyAnchorCandidates:只写被选中的序号',
  isolated(() => {
    write('src/a.ts');
    write('src/b.ts');
    save('pick-a', 'src/a.ts');
    save('pick-b', 'src/b.ts');
    const scan = collectAnchorCandidates(process.cwd());
    const target = scan.candidates.find((c) => c.id === 'pick-a');
    assert.ok(target);

    const r = applyAnchorCandidates(scan.candidates, [target.index], process.cwd());
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].id, 'pick-a');

    const all = loadAll();
    assert.equal(all.find((e) => e.id === 'pick-a')?.anchors?.length, 1, '选中的应有锚点');
    assert.equal(all.find((e) => e.id === 'pick-b')?.anchors, undefined, '没选中的不该被动过');
  }),
);

test(
  'applyAnchorCandidates:确认前文件被删 → 该条不写入(不制造半套锚点)',
  isolated(() => {
    write('src/vanishing.ts');
    save('vanishing', 'src/vanishing.ts 里的逻辑');
    const scan = collectAnchorCandidates(process.cwd());
    assert.equal(scan.candidates.length, 1);

    // 模拟「用户看完列表、先改别的」:文件在两次调用之间消失。
    rmSync(join(process.cwd(), 'src/vanishing.ts'));

    const r = applyAnchorCandidates(scan.candidates, 'all', process.cwd());
    assert.equal(r.saved.length, 0);
    assert.equal(r.lost.length, 1);
    assert.match(r.lost[0].paths[0], /vanishing\.ts/);
    assert.equal(loadAll().find((e) => e.id === 'vanishing')?.anchors, undefined, '不该留下锚点');
  }),
);

test(
  'applyAnchorCandidates:锚点写入后 hash 正确 → 立刻可判 fresh',
  isolated(async () => {
    write('src/stable.ts', 'export function stable(): number {\n  return 1;\n}\n');
    save('stable-ref', 'src/stable.ts 的 stable()');
    const scan = collectAnchorCandidates(process.cwd());
    applyAnchorCandidates(scan.candidates, 'all', process.cwd());

    // evaluateAnchors 走生产判定路径:hash 必须是**此刻**的内容。
    // 若这里返回 stale,说明 updateEntry 存的 hash 与文件对不上(整条通道会永久误报)。
    const { evaluateAnchors } = await import('../../src/memory/anchor.js');
    const entry = loadAll().find((e) => e.id === 'stable-ref');
    assert.ok(entry?.anchors?.length);
    assert.equal(evaluateAnchors(entry.anchors, process.cwd()).stale, false);
  }),
);
