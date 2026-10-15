/**
 * edit_file:old_string 模式下 expected_hash 可选;行号模式仍必填。
 *
 * 背景:长会话经压缩/read 去重/剪枝后,模型上下文里的 64 位 hash 常常丢失或过期,
 * 导致 edit_file 反复因 hash 失败,模型转而用 write_file 写补丁脚本绕路。
 * old_string 必须唯一命中本身就是基于内容的前置条件,提交时 ChangeSet 仍会复核读到的内容 hash。
 *
 * 重点锁的行为:
 * - old_string 模式不带 hash:成功
 * - old_string 模式带正确 hash:成功;带过期 hash:仍严格拒绝(显式传入即严格校验)
 * - old_string 0 次 / 多次命中:拒绝且不改文件
 * - 行号模式缺 hash:拒绝;带正确 hash:成功
 * - CRLF 文件编辑后保持 CRLF
 * - 二进制文件拒绝
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
  root = mkdtempSync(join(tmpdir(), 'mocode-edit-optional-hash-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 沙箱根在调用点设置并还原(共享进程下全局单例不能依赖文件级 before)。 */
async function edit(args: Record<string, unknown>): Promise<ToolOutcome> {
  const prev = setSandboxRoot(root);
  try {
    return await executeToolOutcome('edit_file', JSON.stringify(args));
  } finally {
    setSandboxRoot(prev);
  }
}

function seed(name: string, content: string | Buffer): string {
  writeFileSync(join(root, name), content);
  return name;
}

function read(name: string): string {
  return readFileSync(join(root, name), 'utf8');
}

test('edit_file: old_string 模式省略 expected_hash 也能成功', async () => {
  const f = seed('a.txt', 'alpha\nbeta\ngamma\n');
  const out = await edit({ path: f, old_string: 'beta', new_string: 'BETA' });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'alpha\nBETA\ngamma\n');
  assert.equal(out.changedFiles?.length, 1);
});

test('edit_file: old_string 模式 expected_hash 为 null/空串视为未提供', async () => {
  const f = seed('b.txt', 'one\ntwo\n');
  const out1 = await edit({ path: f, old_string: 'one', new_string: '1', expected_hash: null });
  assert.equal(out1.status, 'success', out1.output);
  const out2 = await edit({ path: f, old_string: 'two', new_string: '2', expected_hash: '' });
  assert.equal(out2.status, 'success', out2.output);
  assert.equal(read(f), '1\n2\n');
});

test('edit_file: old_string 模式带正确 hash 成功', async () => {
  const content = 'x = 1\ny = 2\n';
  const f = seed('c.txt', content);
  const out = await edit({
    path: f,
    old_string: 'y = 2',
    new_string: 'y = 3',
    expected_hash: contentHash(content),
  });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'x = 1\ny = 3\n');
});

test('edit_file: 显式传入过期 hash 仍严格拒绝,文件不变', async () => {
  const f = seed('d.txt', 'current\n');
  const out = await edit({
    path: f,
    old_string: 'current',
    new_string: 'changed',
    expected_hash: contentHash('some older version\n'),
  });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.equal(read(f), 'current\n');
});

test('edit_file: 格式错误的 hash 被拒绝', async () => {
  const f = seed('e.txt', 'hello\n');
  const out = await edit({ path: f, old_string: 'hello', new_string: 'bye', expected_hash: 'not-a-hash' });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.equal(read(f), 'hello\n');
});

test('edit_file: old_string 未找到 → 冲突,文件不变', async () => {
  const f = seed('f.txt', 'abc\n');
  const out = await edit({ path: f, old_string: 'zzz', new_string: 'y' });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.match(out.output, /未找到/);
  assert.equal(read(f), 'abc\n');
});

test('edit_file: old_string 多次出现 → 冲突,文件不变', async () => {
  const f = seed('g.txt', 'dup\ndup\n');
  const out = await edit({ path: f, old_string: 'dup', new_string: 'x' });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.match(out.output, /出现 2 次/);
  assert.equal(read(f), 'dup\ndup\n');
});

test('edit_file: 行号模式缺 hash 被拒绝,文件不变', async () => {
  const f = seed('h.txt', 'l1\nl2\nl3\n');
  const out = await edit({ path: f, line_start: 2, line_end: 2, new_string: 'L2' });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.match(out.output, /行号模式必须提供 expected_hash/);
  assert.equal(read(f), 'l1\nl2\nl3\n');
});

test('edit_file: 行号模式带正确 hash 成功', async () => {
  const content = 'l1\nl2\nl3\n';
  const f = seed('i.txt', content);
  const out = await edit({
    path: f,
    line_start: 2,
    line_end: 2,
    new_string: 'L2',
    expected_hash: contentHash(content),
  });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'l1\nL2\nl3\n');
});

test('edit_file: 行号模式带过期 hash 被拒绝', async () => {
  const f = seed('j.txt', 'l1\nl2\n');
  const out = await edit({
    path: f,
    line_start: 1,
    line_end: 1,
    new_string: 'X',
    expected_hash: contentHash('stale\n'),
  });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.equal(read(f), 'l1\nl2\n');
});

test('edit_file: CRLF 文件无 hash 编辑后保持 CRLF', async () => {
  const f = seed('k.txt', 'a\r\nb\r\nc\r\n');
  const out = await edit({ path: f, old_string: 'b', new_string: 'B' });
  assert.equal(out.status, 'success', out.output);
  assert.equal(read(f), 'a\r\nB\r\nc\r\n');
});

test('edit_file: 二进制文件拒绝按文本编辑', async () => {
  const f = seed('l.bin', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x00, 0x41, 0x42]));
  const out = await edit({ path: f, old_string: 'AB', new_string: 'CD' });
  assert.equal(out.status, 'error');
  assert.match(out.output, /二进制/);
});

test('edit_file: old_string 与 line 参数互斥仍然生效', async () => {
  const f = seed('m.txt', 'q\n');
  const out = await edit({ path: f, old_string: 'q', line_start: 1, line_end: 1, new_string: 'r' });
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'CHANGE_CONFLICT');
  assert.equal(read(f), 'q\n');
});
