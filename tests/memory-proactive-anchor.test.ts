/**
 * R3.6 锚点派生弱触发:trigger 没命中时,用「这次要动哪个文件」把记忆捞出来。
 *
 * 这条通道存在的理由是 R2 暴露的一个结构事实:锚定 `anchors` 的条目多是
 * `reference` 型结构知识("resultEvent 是 history 回灌的唯一汇聚点"),而
 * `wantsTrigger` 只认 pitfall/decision/feedback——**这类记忆通常没有 trigger**,
 * 所以只靠 trigger 索引,它在你要改那个文件时永远不会出现。
 *
 * 覆盖点:
 *  - 路径白名单只认操作目标键(`path`/`files`…),不扫 `content`/`old_string`
 *  - 路径相等匹配(不是模糊重合),无关路径零注入
 *  - `read_file` 不重复弹(R2.4 已在结果尾部回注同样的信息)
 *  - stale 锚点仍弹但带标记(用户正要在同一文件动手,最该知道「这里有过一条过期记忆」)
 *  - 复用 fired 冷却与每轮上限
 *  - 归档条目不进锚点索引
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAnchorPaths,
  proactiveFiredIds,
  proactiveHint,
  proactiveTurnCount,
  resetProactiveTurn,
  __resetProactiveForTests,
} from '../src/memory/proactive.js';
import { saveEntry, forgetEntry } from '../src/memory/store.js';
import { __resetAnchorCacheForTests } from '../src/memory/anchor.js';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { __resetPendingRecallForTests } from '../src/memory/store.js';

function isolated(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mocode-proactive-anchor-'));
    const homeDir = join(root, 'home');
    const projDir = join(root, 'proj');
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const home = process.env.HOME;
    const up = process.env.USERPROFILE;
    const cwd = process.cwd();
    const memEnv = process.env.MEMORY_ENABLED;
    const proEnv = process.env.MOCODE_MEMORY_PROACTIVE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projDir);
    process.env.MEMORY_ENABLED = 'true';
    delete process.env.MOCODE_MEMORY_PROACTIVE;
    // 锚点路径按沙箱根解析;共享进程里别的测试文件可能留下自己的根,必须显式接管。
    const prevRoot = setSandboxRoot(projDir);
    __resetProactiveForTests();
    __resetAnchorCacheForTests();
    try {
      await fn();
    } finally {
      __resetProactiveForTests();
      __resetAnchorCacheForTests();
      __resetPendingRecallForTests();
      setSandboxRoot(prevRoot);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = up;
      if (memEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = memEnv;
      if (proEnv === undefined) delete process.env.MOCODE_MEMORY_PROACTIVE;
      else process.env.MOCODE_MEMORY_PROACTIVE = proEnv;
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function write(rel: string, text: string): void {
  const abs = join(process.cwd(), rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  __resetAnchorCacheForTests();
}

/** 造一条 `reference` 型条目:**没有 trigger**,只有锚点。 */
function seedAnchored(name: string, path: string): string {
  const r = saveEntry({
    name,
    summary: `${name} 的结构说明`,
    body: 'resultEvent 是 history 回灌前的唯一汇聚点',
    type: 'reference',
    anchors: [{ path, symbol: 'alpha' }],
  });
  assert.ok(r.ok, '前置:带锚点条目应写入成功');
  return (r as { ok: true; id: string }).id;
}

const FILE = 'src/target.ts';
const SRC = `export function alpha(x: number): number {
  return x + 1;
}
`;

// ── 路径抽取 ──────────────────────────────────────────────────────────────

test('extractAnchorPaths: 只认操作目标键,不扫 content/old_string 里的路径', () => {
  const paths = extractAnchorPaths({
    path: 'src/a.ts',
    // 这两个是**文本内容**,里面的路径不是本次操作对象——扫进去会大量误命中。
    content: 'see src/b.ts for details',
    old_string: 'import x from "src/c.ts"',
  });
  assert.deepEqual(paths, ['src/a.ts']);
});

test('extractAnchorPaths: 支持字符串数组与多个键名;空值/超长值丢弃', () => {
  const paths = extractAnchorPaths({
    files: ['src/a.ts', '  ', 'src/b.ts'],
    target: 'src/c.ts',
    path: 'x'.repeat(600),
  });
  assert.deepEqual(paths, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(extractAnchorPaths(null), []);
  assert.deepEqual(extractAnchorPaths({}), []);
});

// ── 命中 ──────────────────────────────────────────────────────────────────

test(
  'R3.6: reference 型条目(无 trigger)在操作其锚定文件时被捞出',
  isolated(() => {
    write(FILE, SRC);
    const id = seedAnchored('resultEvent 汇聚点', FILE);
    // 关键:没有 trigger 的条目走不到 trigger 索引,只能靠锚点通道。
    const hint = proactiveHint('write_file', { path: FILE }, true, '随便说点什么');
    assert.ok(hint.includes(id), `应命中 ${id},实际: ${hint}`);
    assert.match(hint, /锚定了你即将操作的文件/);
    assert.match(hint, /锚定 src\/target\.ts/);
  }),
);

test(
  'R3.6: 路径相等匹配 —— 无关文件零注入',
  isolated(() => {
    write(FILE, SRC);
    write('src/other.ts', 'export const other = 1;\n');
    seedAnchored('目标文件说明', FILE);
    assert.equal(proactiveHint('write_file', { path: 'src/other.ts' }, true, ''), '');
    assert.equal(proactiveHint('edit_file', { path: 'src/nonexistent.ts' }, true, ''), '');
  }),
);

test(
  'R3.6: read_file 不重复弹(R2.4 已在结果尾部回注)',
  isolated(() => {
    write(FILE, SRC);
    seedAnchored('目标文件说明', FILE);
    assert.equal(proactiveHint('read_file', { path: FILE }, true, ''), '');
    // 但同一文件换成编辑类工具时仍要弹——那才是"即将改动"的时刻。
    assert.ok(proactiveHint('edit_file', { path: FILE }, true, '').length > 0);
  }),
);

// ── stale 标注 ─────────────────────────────────────────────────────────────

test(
  'R3.6: 锚点已失效仍弹,但带 STALE-CODE 标记',
  isolated(() => {
    write(FILE, SRC);
    const id = seedAnchored('会过期的说明', FILE);
    write(FILE, SRC.replace('return x + 1;', 'return x + 99;'));

    const hint = proactiveHint('edit_file', { path: FILE }, true, '');
    assert.ok(hint.includes(id), '过期也要弹 —— 用户正要在同一文件动手');
    assert.match(hint, /STALE-CODE/);
    assert.match(hint, /代码已变更/);
  }),
);

test(
  'R3.6: 锚点仍 fresh 时不带 STALE-CODE(默认零噪音)',
  isolated(() => {
    write(FILE, SRC);
    seedAnchored('当前有效说明', FILE);
    const hint = proactiveHint('edit_file', { path: FILE }, true, '');
    assert.ok(!hint.includes('STALE-CODE'));
  }),
);

// ── 冷却与限额 ─────────────────────────────────────────────────────────────

test(
  'R3.6: 同一条只弹一次(复用 fired 冷却)',
  isolated(() => {
    write(FILE, SRC);
    seedAnchored('目标文件说明', FILE);
    const first = proactiveHint('edit_file', { path: FILE }, true, '');
    assert.ok(first.length > 0);
    const second = proactiveHint('edit_file', { path: FILE }, true, '');
    assert.equal(second, '', '同一条不应重复弹');
    assert.equal(proactiveFiredIds().length, 1);
  }),
);

test(
  'R3.6: 锚点注入也计入每轮上限 3 次',
  isolated(() => {
    for (let i = 0; i < 5; i++) {
      const p = `src/m${i}.ts`;
      write(p, `export function alpha${i}() { return ${i}; }\n`);
      const r = saveEntry({
        name: `说明${i}`,
        summary: `s${i}`,
        body: 'b',
        type: 'reference',
        anchors: [{ path: p }],
      });
      assert.ok(r.ok);
    }
    let injected = 0;
    for (let i = 0; i < 5; i++) {
      if (proactiveHint('edit_file', { path: `src/m${i}.ts` }, true, '')) injected++;
    }
    assert.equal(injected, 3, '每轮最多 3 次,锚点通道同样受限');
    assert.equal(proactiveTurnCount(), 3);

    resetProactiveTurn();
    assert.equal(proactiveTurnCount(), 0);
    // 新的一轮可以继续弹此前没弹过的条目(同条仍受进程级冷却)。
    assert.ok(proactiveHint('edit_file', { path: 'src/m3.ts' }, true, '').length > 0);
  }),
);

// ── 索引资格 ───────────────────────────────────────────────────────────────

test(
  'R3.6: 归档条目不进锚点索引(它说的是历史)',
  isolated(() => {
    write(FILE, SRC);
    const id = seedAnchored('已归档的说明', FILE);
    forgetEntry(id, 'archive');
    assert.equal(proactiveHint('edit_file', { path: FILE }, true, ''), '');
  }),
);

test(
  'R3.6: enabled=false 时锚点通道同样零注入',
  isolated(() => {
    write(FILE, SRC);
    seedAnchored('目标文件说明', FILE);
    assert.equal(proactiveHint('edit_file', { path: FILE }, false, ''), '');
    assert.equal(proactiveTurnCount(), 0, '关闭时不消耗限额');
  }),
);

test(
  'R3.6: 无锚点库时锚点通道零成本返回空',
  isolated(() => {
    write(FILE, SRC);
    assert.equal(proactiveHint('edit_file', { path: FILE }, true, ''), '');
  }),
);
