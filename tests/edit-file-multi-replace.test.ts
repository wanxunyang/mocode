/**
 * edit_file 多替换模式(replacements[]):
 * 一个调用里对同一文件原子地做多处替换。所有 old_string 必须在「原文」上各唯一命中、
 * 区间互不重叠;任一项不满足整体拒绝、一条都不改。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToolOutcome } from '../src/tools/registry.js';
import { contentHash } from '../src/changeset/index.js';
import type { ToolOutcome } from '../src/tools/types.js';
import '../src/tools/builtins/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mocode-edit-multi-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function edit(args: Record<string, unknown>): Promise<ToolOutcome> {
  const prev = setSandboxRoot(root);
  try {
    return await executeToolOutcome('edit_file', JSON.stringify(args));
  } finally {
    setSandboxRoot(prev);
  }
}

function seed(name: string, content: string): string {
  writeFileSync(join(root, name), content);
  return name;
}

function read(name: string): string {
  return readFileSync(join(root, name), 'utf8');
}

const R = (old_string: string, new_string: string) => ({ old_string, new_string });

test('multi: 多处不相邻替换一次成功', async () => {
  const f = seed('a.txt', 'alpha\nbeta\ngamma\ndelta\n');
  const out = await edit({ path: f, replacements: [R('alpha', 'ALPHA'), R('gamma', 'GAMMA')] });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'ALPHA\nbeta\nGAMMA\ndelta\n');
  assert.equal(out.changedFiles?.length, 1);
});

test('multi: 允许删除(new_string 空串)', async () => {
  const f = seed('b.txt', 'keep\nremove\nkeep2\n');
  const out = await edit({ path: f, replacements: [R('remove\n', '')] });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'keep\nkeep2\n');
});

test('multi: 顺序应用,后项可引入前项替换出的文本', async () => {
  // 两项在原文上各自唯一且不重叠;应用后 'X1' 再被第二项... 这里验证从后向前应用不串位。
  const f = seed('c.txt', 'foo bar baz\n');
  const out = await edit({ path: f, replacements: [R('foo', 'FOO'), R('baz', 'BAZ')] });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'FOO bar BAZ\n');
});

test('multi: 某项 old_string 未找到 → 整体拒绝,文件不变', async () => {
  const original = 'one\ntwo\nthree\n';
  const f = seed('d.txt', original);
  const out = await edit({ path: f, replacements: [R('one', '1'), R('nope', 'x'), R('three', '3')] });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.match(out.output, /replacements\[1\]/);
  assert.match(out.output, /未找到/);
  assert.equal(read(f), original);
});

test('multi: 某项 old_string 多次命中 → 整体拒绝,文件不变', async () => {
  const original = 'dup\ndup\nother\n';
  const f = seed('e.txt', original);
  const out = await edit({ path: f, replacements: [R('other', 'o'), R('dup', 'd')] });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.match(out.output, /replacements\[1\]/);
  assert.match(out.output, /出现 2 次/);
  assert.equal(read(f), original);
});

test('multi: 命中区间重叠 → 整体拒绝,文件不变', async () => {
  const original = 'abcdef\n';
  const f = seed('f.txt', original);
  // 'abc' 与 'bc' 区间重叠(后者落在前者内部)。
  const out = await edit({ path: f, replacements: [R('abc', 'X'), R('bc', 'Y')] });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.match(out.output, /重叠/);
  assert.equal(read(f), original);
});

test('multi: 相邻(首尾相接)区间允许,各自唯一不重叠', async () => {
  const f = seed('g.txt', 'abcdef\n');
  // 'abc'=[0,3) 与 'def'=[3,6) 首尾相接,start(3) 不 < 前项 end(3),允许。
  const out = await edit({ path: f, replacements: [R('abc', 'ABC'), R('def', 'DEF')] });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'ABCDEF\n');
});

test('multi: 空数组被拒绝', async () => {
  const f = seed('h.txt', 'x\n');
  const out = await edit({ path: f, replacements: [] });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'INVALID_ARGUMENTS');
  assert.equal(read(f), 'x\n');
});

test('multi: 元素缺字段被拒绝', async () => {
  const f = seed('i.txt', 'x\n');
  const out = await edit({ path: f, replacements: [{ old_string: 'x' }] });
  assert.equal(out.status, 'error');
  assert.equal(read(f), 'x\n');
});

test('multi: old_string 与 replacements 互斥', async () => {
  const f = seed('j.txt', 'a\nb\n');
  const out = await edit({ path: f, old_string: 'a', new_string: 'A', replacements: [R('b', 'B')] });
  assert.equal(out.status, 'error');
  assert.match(out.output, /互斥/);
  assert.equal(read(f), 'a\nb\n');
});

test('multi: replacements 与行号模式互斥', async () => {
  const f = seed('k.txt', 'a\nb\n');
  const out = await edit({
    path: f,
    replacements: [R('a', 'A')],
    line_start: 1,
    line_end: 1,
    new_string: 'z',
    expected_hash: contentHash('a\nb\n'),
  });
  assert.equal(out.status, 'error');
  assert.match(out.output, /互斥/);
  assert.equal(read(f), 'a\nb\n');
});

test('multi: 省略 expected_hash 也能成功(内容前置条件)', async () => {
  const f = seed('l.txt', 'one\ntwo\n');
  const out = await edit({ path: f, replacements: [R('one', '1'), R('two', '2')] });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), '1\n2\n');
});

test('multi: CRLF 文件编辑后保持 CRLF', async () => {
  const f = seed('m.txt', 'a\r\nb\r\nc\r\n');
  const out = await edit({ path: f, replacements: [R('a', 'A'), R('c', 'C')] });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'A\r\nb\r\nC\r\n');
});

test('multi: 带过期 hash 仍严格拒绝,文件不变', async () => {
  const f = seed('n.txt', 'cur\nrent\n');
  const out = await edit({
    path: f,
    replacements: [R('cur', 'x'), R('rent', 'y')],
    expected_hash: contentHash('stale\n'),
  });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.equal(read(f), 'cur\nrent\n');
});
