/**
 * write_file 事务化写入 + append 追加模式。
 *
 * 背景:write_file 此前**零测试覆盖**,且只有「全量覆盖」一种写法 —— 模型想给日志/长文档加一段,
 * 必须把整个文件重发一遍(烧 token,且长文件极易在重述中丢字符)。现加 append=true:
 * 工具层读现状 + 拼接 + 以 update 提交,完全复用 ChangeSet 事务机器。
 *
 * 重点锁的行为:
 * - append 不需要 expected_hash、不需要先 read_file(hash 由工具自己算)
 * - append 是 VERBATIM:不自动补换行(尊重 shell `>>` 语义,不擅自改数据)
 * - append 拒绝二进制(全量覆盖坏一次,append 会把解码坏掉的旧内容永久写回 = 静默损毁)
 * - hash 不匹配 → CHANGE_CONFLICT(fail-loud),绝不静默覆盖别人的追加
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeFileTool } from '../src/tools/builtins/write-file.js';
import { executeToolOutcome } from '../src/tools/registry.js';
import { contentHash } from '../src/changeset/index.js';
import type { ToolOutcome } from '../src/tools/types.js';
import '../src/tools/builtins/index.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mocode-write-append-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * write_file 在 SANDBOX_PATH_TOOLS 里:生产路径由 enforceSandbox 把相对 path 重写成牢内绝对路径,
 * 且 ChangeSet 内部走 jailResolve —— 故必须设沙箱根,且走 executeToolOutcome(真实链路)。
 * 沙箱根在**调用点**设置而非文件级 before():共享进程(--experimental-test-isolation=none)下
 * 所有文件的 before() 先于任何测试执行,后加载的文件会覆盖全局根,造成假失败。
 */
async function write(args: Record<string, unknown>): Promise<ToolOutcome> {
  const prev = setSandboxRoot(root);
  try {
    return await executeToolOutcome('write_file', JSON.stringify(args));
  } finally {
    setSandboxRoot(prev);
  }
}

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/**
 * enforceSandbox 会把 args.path 重写成牢内绝对路径,故 changedFiles / staleFiles 里是绝对路径。
 * 断言统一转回相对 root 的路径再比较(跨平台分隔符由 path.relative 归一),既锁住语义又不把 tmp 根写死。
 */
function rel(actual: string): string {
  return relative(root, actual).replace(/\\/g, '/');
}

function assertTouches(actual: string[] | undefined, expected: string): void {
  assert.equal(actual?.length, 1, `应恰好触及 1 个文件,实际 ${JSON.stringify(actual)}`);
  assert.equal(rel(actual![0]), expected);
}

// ── 基础写入(此前零覆盖,一并锁住)────────────────────────────────────────

test('write_file: 新建文件(expected_hash 省略 = create-only),落盘内容与 changeSet 齐全', async () => {
  const outcome = await write({ path: 'new.txt', content: 'hello\n' });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('new.txt'), 'hello\n');
  assertTouches(outcome.changedFiles, 'new.txt');
  assert.equal(outcome.changeSet?.changes[0]?.operation, 'create');
  assert.match(outcome.output, /ChangeSet [0-9a-f-]{36}/);
});

test('write_file: 已存在的文件不给 expected_hash 时拒绝覆盖(create-only 语义,防误抹内容)', async () => {
  writeFileSync(join(root, 'exists.txt'), 'original\n');
  const outcome = await write({ path: 'exists.txt', content: 'overwritten\n' });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'CHANGE_CONFLICT');
  assert.equal(read('exists.txt'), 'original\n', '冲突时必须一字未动');
  assertTouches(outcome.staleFiles, 'exists.txt');
});

test('write_file: 带正确 expected_hash 时全量替换成功', async () => {
  writeFileSync(join(root, 'replace.txt'), 'v1\n');
  const outcome = await write({
    path: 'replace.txt',
    content: 'v2\n',
    expected_hash: contentHash('v1\n'),
  });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('replace.txt'), 'v2\n');
  assert.equal(outcome.changeSet?.changes[0]?.operation, 'update');
});

test('write_file: expected_hash 过期 → CHANGE_CONFLICT,文件保持原样', async () => {
  writeFileSync(join(root, 'stale.txt'), 'current\n');
  const outcome = await write({
    path: 'stale.txt',
    content: 'next\n',
    expected_hash: contentHash('something else\n'),
  });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'CHANGE_CONFLICT');
  assert.equal(read('stale.txt'), 'current\n');
});

test('write_file: 写入内容未变化时不产生 changedFiles(幂等,不污染 rollback/diff)', async () => {
  writeFileSync(join(root, 'same.txt'), 'unchanged\n');
  const outcome = await write({
    path: 'same.txt',
    content: 'unchanged\n',
    expected_hash: contentHash('unchanged\n'),
  });
  assert.equal(outcome.status, 'success');
  assert.deepEqual(outcome.changedFiles, [], '内容相同不该记成一次改动');
  assert.match(outcome.output, /内容未变化/);
});

test('write_file: 自动创建缺失的父目录', async () => {
  const outcome = await write({ path: 'deep/nested/dir/file.txt', content: 'x\n' });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('deep/nested/dir/file.txt'), 'x\n');
});

// ── append 模式 ──────────────────────────────────────────────────────────

test('append: 追加到已有文件,且**不需要** expected_hash / 先 read_file', async () => {
  writeFileSync(join(root, 'log.txt'), 'line one\n');
  const outcome = await write({ path: 'log.txt', content: 'line two\n', append: true });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('log.txt'), 'line one\nline two\n');
  assertTouches(outcome.changedFiles, 'log.txt');
  assert.equal(outcome.changeSet?.changes[0]?.operation, 'update', 'append 以 update 提交,复用事务机器');
});

test('append: 连续多次追加 = 分段写长文件的正确姿势(内容累积、每次调用只传增量)', async () => {
  writeFileSync(join(root, 'staged.md'), '# Title\n');
  for (const chunk of ['\n## Section A\n', 'body A\n', '\n## Section B\n', 'body B\n']) {
    const outcome = await write({ path: 'staged.md', content: chunk, append: true });
    assert.equal(outcome.status, 'success', outcome.output);
  }
  assert.equal(read('staged.md'), '# Title\n\n## Section A\nbody A\n\n## Section B\nbody B\n');
});

test('append: VERBATIM 语义 —— 文件不以换行结尾时,不自动补换行(最后两行会黏在一起)', async () => {
  writeFileSync(join(root, 'no-newline.txt'), 'first');
  const outcome = await write({ path: 'no-newline.txt', content: 'second', append: true });
  assert.equal(outcome.status, 'success');
  assert.equal(read('no-newline.txt'), 'firstsecond', '必须原样拼接;补换行由模型在 content 里自己带');
  assert.match(writeFileTool.description, /start your content with "\\n"/, 'description 必须把这个坑告诉模型');
});

test('append: 目标不存在时创建(等同 shell >> 的语义)', async () => {
  assert.equal(existsSync(join(root, 'fresh-append.txt')), false);
  const outcome = await write({ path: 'fresh-append.txt', content: 'born here\n', append: true });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('fresh-append.txt'), 'born here\n');
  assert.equal(outcome.changeSet?.changes[0]?.operation, 'create');
});

test('append: 空内容追加到已有文件 → 内容未变化,不记 changedFiles', async () => {
  writeFileSync(join(root, 'noop.txt'), 'keep\n');
  const outcome = await write({ path: 'noop.txt', content: '', append: true });
  assert.equal(outcome.status, 'success');
  assert.deepEqual(outcome.changedFiles, []);
  assert.equal(read('noop.txt'), 'keep\n');
});

test('append: 保留 CRLF 行尾(不做任何换行归一化)', async () => {
  writeFileSync(join(root, 'crlf.txt'), 'a\r\nb\r\n');
  const outcome = await write({ path: 'crlf.txt', content: 'c\r\n', append: true });
  assert.equal(outcome.status, 'success');
  assert.equal(readFileSync(join(root, 'crlf.txt'), 'utf8'), 'a\r\nb\r\nc\r\n');
});

test('append: 拒绝二进制目标(否则 utf8 往返会把原有字节永久写坏)', async () => {
  const binary = Buffer.concat([Buffer.from('\x7fELF\x02\x01\x01\x00'), Buffer.alloc(64, 0x00)]);
  writeFileSync(join(root, 'prog.bin'), binary);
  const outcome = await write({ path: 'prog.bin', content: 'text\n', append: true });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'INVALID_ARGUMENTS');
  assert.match(outcome.output, /二进制/);
  assert.match(outcome.output, /run_command/, '必须给出替代路径');
  assert.equal(readFileSync(join(root, 'prog.bin')).equals(binary), true, '原文件必须一字未动');
});

test('append: 图片文件(PNG 魔数)同样拒绝', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
  writeFileSync(join(root, 'img.png'), png);
  const outcome = await write({ path: 'img.png', content: 'x', append: true });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'INVALID_ARGUMENTS');
});

test('append: 显式传了过期 expected_hash 时仍按 CHANGE_CONFLICT 拒绝(模型给的 hash 优先)', async () => {
  writeFileSync(join(root, 'guarded.txt'), 'current\n');
  const outcome = await write({
    path: 'guarded.txt',
    content: 'more\n',
    append: true,
    expected_hash: contentHash('wrong\n'),
  });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'CHANGE_CONFLICT');
  assert.equal(read('guarded.txt'), 'current\n', '冲突时不得写入');
});

test('append: 显式传正确 expected_hash 时正常追加', async () => {
  writeFileSync(join(root, 'guarded-ok.txt'), 'current\n');
  const outcome = await write({
    path: 'guarded-ok.txt',
    content: 'more\n',
    append: true,
    expected_hash: contentHash('current\n'),
  });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('guarded-ok.txt'), 'current\nmore\n');
});

test('append: 并发追加不丢数据 —— 要么都成功累积,要么后来者 CHANGE_CONFLICT(绝不静默覆盖)', async () => {
  writeFileSync(join(root, 'race.txt'), 'base\n');
  const results = await Promise.all([
    write({ path: 'race.txt', content: 'A\n', append: true }),
    write({ path: 'race.txt', content: 'B\n', append: true }),
  ]);
  const final = read('race.txt');
  const succeeded = results.filter((r) => r.status === 'success');
  const conflicted = results.filter((r) => r.code === 'CHANGE_CONFLICT');
  assert.equal(succeeded.length + conflicted.length, 2, '只允许成功或冲突,不允许其它失败形态');
  // 核心不变量:base 一定在,且每个成功的追加都必须在最终文件里可见(没有被覆盖丢失)。
  assert.ok(final.startsWith('base\n'), `原始内容不得丢失: ${JSON.stringify(final)}`);
  for (const outcome of succeeded) {
    assert.match(outcome.output, /已追加到|内容未变化/);
  }
  // 两个都成功时必须两段都在;一个成功一个冲突时必须只有那一段在。
  if (succeeded.length === 2) {
    assert.match(final, /A\n/);
    assert.match(final, /B\n/);
  } else {
    assert.equal(succeeded.length, 1);
    assert.equal(conflicted.length, 1, '冲突方必须明确报 CHANGE_CONFLICT,让模型重读重试');
  }
});

test('append: 超过 32MiB 上限拒绝并指路 shell 重定向(整文件载入内存是固有成本)', async () => {
  // 造一个刚好超线的文件成本高,这里直接验证上限常量与文案:用一个 >32MiB 的稀疏内容。
  const big = 'x'.repeat(32 * 1024 * 1024 + 1);
  writeFileSync(join(root, 'big.txt'), big);
  const outcome = await write({ path: 'big.txt', content: 'tail\n', append: true });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'INVALID_ARGUMENTS');
  assert.match(outcome.output, /32\.0 MB 上限/);
  assert.match(outcome.output, />>/, '必须给出 shell 重定向这条可行替代路径');
});

test('append: 越界路径被沙箱拒绝,不落盘到工作区外', async () => {
  const outcome = await write({ path: '../escape-append.txt', content: 'x\n', append: true });
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.code, 'SANDBOX_DENIED');
  assert.equal(existsSync(join(root, '..', 'escape-append.txt')), false);
});

test('append: 失败/冲突时不留 .tmp / .bak 残留文件(ChangeSet 事务收尾)', async () => {
  writeFileSync(join(root, 'clean.txt'), 'v1\n');
  await write({ path: 'clean.txt', content: 'v2\n', append: true });
  // 再来一次故意冲突的写入,确认失败路径也清理干净。
  await write({ path: 'clean.txt', content: 'v3\n', append: true, expected_hash: contentHash('wrong\n') });
  const leftovers = readdirSync(root).filter((name) => name.includes('.tmp') || name.includes('.bak'));
  assert.deepEqual(leftovers, [], `工作区不应留下事务临时文件: ${leftovers.join(', ')}`);
  assert.equal(read('clean.txt'), 'v1\nv2\n', '冲突那次不得写入');
});

test('append: 目录目标报错而非静默创建', async () => {
  mkdirSync(join(root, 'a-directory'), { recursive: true });
  const outcome = await write({ path: 'a-directory', content: 'x\n', append: true });
  assert.equal(outcome.status, 'error');
  assert.ok(existsSync(join(root, 'a-directory')), '目录本身不能被破坏');
});

test('write_file schema: append 是可选 boolean,required 仍只有 path/content(向后兼容旧调用)', () => {
  const params = writeFileTool.parameters as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(params.required, ['path', 'content'], '不能把 append 变成必填,否则旧调用全部失效');
  assert.equal((params.properties.append as { type: string }).type, 'boolean');
  // 实现里用 `args.append === true` 判定:缺省 / false / 任何非 true 值都走覆盖语义。
  assert.match(writeFileTool.description, /append=true/, 'description 必须说明 append 的用法');
});

test('write_file: append 缺省(false)时行为与旧版完全一致 —— 全量覆盖需 hash', async () => {
  writeFileSync(join(root, 'compat.txt'), 'old\n');
  // 不给 append、不给 hash:必须按 create-only 语义报冲突,而不是当成 append。
  const outcome = await write({ path: 'compat.txt', content: 'new\n' });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'CHANGE_CONFLICT');
  assert.equal(read('compat.txt'), 'old\n');
});

test('write_file: append=false 显式传值时仍是覆盖语义', async () => {
  writeFileSync(join(root, 'explicit-false.txt'), 'old\n');
  const outcome = await write({
    path: 'explicit-false.txt',
    content: 'new\n',
    append: false,
    expected_hash: contentHash('old\n'),
  });
  assert.equal(outcome.status, 'success', outcome.output);
  assert.equal(read('explicit-false.txt'), 'new\n', 'append=false 必须是替换,不是追加');
});
