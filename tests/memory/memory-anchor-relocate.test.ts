/**
 * R2.7 锚点重定位（`/memory anchor relocate`）。
 *
 * 这个通道的价值全在**判据**上：同名文件是普遍现象，按 basename 自动重写会把讲 A 的
 * 记忆锚到 B 上，而锚错的代价比缺锚大得多（缺锚只是不校验，锚错是假装校验过）。
 * 所以这里钉住三件事：
 *
 *  1. **父目录守卫**：旧父目录名出现在新路径里才算强证据，父目录不符一律降为 weak；
 *  2. **只动被搬走的那一条**：同一批里其它锚点的 hash 必须原样保留，
 *     否则重定位会顺手把真正 stale 的锚点洗成 fresh；
 *  3. **重算 hash 后必须 fresh**：搬过去的路径要能立刻通过自己的判定，
 *     否则等于把一条 missing 换成另一条 missing。
 *
 * 所有用例都必须「先建旧文件 → 写条目 → 删旧文件 → 建新文件」：
 * `buildAnchor` 对不存在的文件直接失败、静默丢锚点，直接拿不存在的老路径存条目只会得到
 * 一条零锚点记忆，测的就不是重定位了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRelocationProposals, applyRelocations } from '../../src/memory/anchor-relocate.js';
import { evaluateAnchor, __resetAnchorCacheForTests } from '../../src/memory/anchor.js';
import { loadAll, saveEntry, __resetPendingRecallForTests } from '../../src/memory/store.js';
import { setSandboxRoot } from '../../src/sandbox/root.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    // 三个都要改：cwd 决定记忆库落哪，sandboxRoot 决定锚点怎么解析，
    // HOME 防全局库被写进真实用户目录。
    const root = mkdtempSync(join(tmpdir(), 'mocode-anchor-relocate-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const memEnv = process.env.MEMORY_ENABLED;
    const cwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.MEMORY_ENABLED = 'true';
    process.chdir(projDir);
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

const abs = (rel: string): string => join(process.cwd(), rel);

function write(rel: string, text = 'export const x = 1;\n'): void {
  mkdirSync(join(abs(rel), '..'), { recursive: true });
  writeFileSync(abs(rel), text, 'utf8');
  __resetAnchorCacheForTests();
}

function remove(rel: string): void {
  rmSync(abs(rel), { force: true });
  __resetAnchorCacheForTests();
}

function save(name: string, anchors: Array<{ path: string; symbol?: string }>): string {
  const r = saveEntry({
    name,
    summary: `${name} 的结论`,
    body: 'body',
    type: 'reference',
    scope: 'project',
    anchors,
  });
  assert.equal(r.ok, true, `前置:条目 ${name} 应写入成功`);
  const id = r.ok ? r.id : '';
  // 前置断言:锚点真的存下来了(否则整条用例在测空气)。
  const saved = loadAll().find((e) => e.id === id)!;
  assert.equal(saved.anchors?.length, anchors.length, `前置:${name} 的 ${anchors.length} 个锚点都应写入`);
  return id;
}

test(
  'relocate:同名文件唯一且旧父目录名仍在新路径里 → 提议,写入后锚点立刻 fresh',
  isolated(() => {
    write('tests/agent-core.test.ts', 'export const a = 1;\n');
    const id = save('测试搬家', [{ path: 'tests/agent-core.test.ts' }]);
    // 模拟文件搬家(tests/agent-core.test.ts → tests/agent/agent-core.test.ts)。
    remove('tests/agent-core.test.ts');
    write('tests/agent/agent-core.test.ts', 'export const a = 1;\n');

    const before = loadAll().find((e) => e.id === id)!;
    assert.equal(evaluateAnchor(before.anchors![0]).status, 'missing');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 1, 'basename 唯一 + 父目录 tests 命中');
    assert.equal(scan.proposals[0].from, 'tests/agent-core.test.ts');
    assert.equal(scan.proposals[0].to, 'tests/agent/agent-core.test.ts');
    assert.equal(scan.proposals[0].parentMatched, true);

    const r = applyRelocations(scan.proposals, 'all');
    assert.equal(r.saved.length, 1, `重定位应成功(实际失败: ${JSON.stringify(r.failed)})`);
    assert.equal(r.failed.length, 0);
    const after = loadAll().find((e) => e.id === id)!;
    assert.equal(after.anchors![0].path, 'tests/agent/agent-core.test.ts');
    // 关键:重算过 hash,不是「换了路径但 hash 还是旧的」。
    assert.equal(evaluateAnchor(after.anchors![0]).status, 'fresh');
  }),
);

test(
  'relocate:同名但旧父目录名不在新路径里 → 归为 weak,不提议(防锚错)',
  isolated(() => {
    write('src/orchestrator/tail.ts', 'export const t = 1;\n');
    // 真实形态:orchestrator 的 tail 与 memory 的 tail 是两个模块,同名不同义。
    const id = save('orchestrator tail 的行为', [{ path: 'src/orchestrator/tail.ts' }]);
    remove('src/orchestrator/tail.ts');
    write('src/memory/tail.ts', 'export const t = 1;\n');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 0, '只有「同名」一条弱证据,不能提议');
    assert.equal(scan.weak.length, 1);
    assert.equal(scan.weak[0].id, id);
    assert.equal(scan.weak[0].candidate, 'src/memory/tail.ts');

    // 写入通道只认 proposals,所以这一步不会误改。
    const r = applyRelocations(scan.proposals, 'all');
    assert.equal(r.saved.length, 0);
    assert.equal(loadAll().find((e) => e.id === id)!.anchors![0].path, 'src/orchestrator/tail.ts');
  }),
);

test(
  'relocate:工作区里连同名文件都没有 → unresolved(多半是真删了,不是搬家)',
  isolated(() => {
    write('src/gone.ts', 'export const g = 1;\n');
    const id = save('被删的实现', [{ path: 'src/gone.ts' }]);
    remove('src/gone.ts');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 0);
    assert.equal(scan.weak.length, 0);
    assert.equal(scan.unresolved.length, 1);
    assert.equal(scan.unresolved[0].id, id);
  }),
);

test(
  'relocate:多个同名候选 → ambiguous,交人工判断',
  isolated(() => {
    write('tests/helper.ts', 'export const h = 0;\n');
    const id = save('helper 的行为', [{ path: 'tests/helper.ts' }]);
    remove('tests/helper.ts');
    write('tests/a/helper.ts', 'export const h = 1;\n');
    write('tests/b/helper.ts', 'export const h = 2;\n');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 0, '父目录 tests 在两个候选里都出现,无法唯一化');
    assert.equal(scan.ambiguous.length, 1);
    assert.equal(scan.ambiguous[0].id, id);
    assert.equal(scan.ambiguous[0].candidates.length, 2);
  }),
);

test(
  'relocate:只换被搬走的那一条,同批其它锚点(含 hash)原样保留',
  isolated(() => {
    write('src/b.ts', 'export const b = 1;\n');
    write('tests/agent-core.test.ts', 'export const a = 1;\n');
    const id = save('多锚点条目', [{ path: 'src/b.ts' }, { path: 'tests/agent-core.test.ts' }]);
    // b.ts 内容被改 → 它本来就是 stale;重定位不能顺手把它洗成 fresh。
    write('src/b.ts', 'export const b = 2;\n');
    remove('tests/agent-core.test.ts');
    write('tests/agent/agent-core.test.ts', 'export const a = 1;\n');

    const before = loadAll().find((e) => e.id === id)!;
    const bHashBefore = before.anchors!.find((a) => a.path === 'src/b.ts')!.contentHash;
    assert.equal(evaluateAnchor(before.anchors!.find((a) => a.path === 'src/b.ts')!).status, 'stale');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 1);
    const r = applyRelocations(scan.proposals, 'all');
    assert.equal(r.saved.length, 1, `重定位应成功(实际失败: ${JSON.stringify(r.failed)})`);

    const after = loadAll().find((e) => e.id === id)!;
    const bAnchor = after.anchors!.find((a) => a.path === 'src/b.ts')!;
    // 这才是与 updateEntry({anchors}) 的分水岭:整批重算会把 b 洗成「现在的代码」,
    // 而没人核对过 b 讲的结论是否还成立。
    assert.equal(bAnchor.contentHash, bHashBefore, '其它锚点的 hash 必须原样保留');
    assert.equal(evaluateAnchor(bAnchor).status, 'stale');
  }),
);

test(
  'relocate:符号片段在搬家后找不到 → 报失败且不写入(不静默丢锚点)',
  isolated(() => {
    write('tests/old-symbol.ts', 'export function legacyFn() {\n  return 1;\n}\n');
    const id = save('旧符号', [{ path: 'tests/old-symbol.ts', symbol: 'legacyFn' }]);
    remove('tests/old-symbol.ts');
    // 同名文件存在,但符号没了:这是「搬家 + 改名」,路径推断不出来。
    write('tests/agent/old-symbol.ts', 'export const other = 1;\n');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 1, '旧路径父目录 tests 命中新路径 → 会提议');

    const r = applyRelocations(scan.proposals, 'all');
    assert.equal(r.saved.length, 0);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].reason, /找不到符号/);
    const after = loadAll().find((e) => e.id === id)!;
    assert.equal(after.anchors![0].path, 'tests/old-symbol.ts', '失败时锚点原样不动');
  }),
);

test(
  'relocate:目标已被同条目锚定 → 拒绝(避免重复锚点)',
  isolated(() => {
    write('tests/dup.ts', 'export const d = 1;\n');
    write('tests/agent/dup.ts', 'export const d = 1;\n');
    const id = save('重复锚点', [{ path: 'tests/dup.ts' }, { path: 'tests/agent/dup.ts' }]);
    // 旧地址消失 → 会被提议 relocate 到它自己已锚的那条上。
    remove('tests/dup.ts');

    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 1);
    assert.equal(scan.proposals[0].to, 'tests/agent/dup.ts');

    const r = applyRelocations(scan.proposals, 'all');
    assert.equal(r.saved.length, 0);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].reason, /重复/);
    const after = loadAll().find((e) => e.id === id)!;
    assert.equal(after.anchors!.length, 2, '失败时锚点集不变');
  }),
);

test(
  'relocate:dir / url 锚点不参与(它们不是文件搬家问题)',
  isolated(() => {
    write('pkg/index.ts', 'export const i = 1;\n');
    const r = saveEntry({
      name: '目录与网页',
      summary: '目录与网页的结论',
      body: 'body',
      type: 'reference',
      scope: 'project',
      anchors: [
        { kind: 'dir', path: 'pkg' },
        { kind: 'url', path: 'https://example.com/a.ts' },
      ],
    });
    assert.ok(r.ok);
    const scan = collectRelocationProposals();
    assert.equal(scan.proposals.length, 0);
    assert.equal(scan.weak.length, 0);
    assert.equal(scan.unresolved.length, 0, 'dir/url 甚至不该出现在 unresolved 里');
  }),
);
