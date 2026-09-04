/**
 * 沙箱策略单元测试:enforceSandbox 四分支(豁免 / 路径重写 / glob / grep)+ jailResolve 越界。
 * 用 mkdtemp 临时目录作沙箱根,避免污染真实项目目录;after 恢复全局 root。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { enforceSandbox, SANDBOX_EXEMPT_TOOLS, SANDBOX_PATH_TOOLS } from '../src/sandbox/policy.js';
import { jailResolve, jailGlobPattern, isInsideRoot } from '../src/sandbox/jail.js';
import { setSandboxRoot } from '../src/sandbox/root.js';

let sandboxRoot: string;
let outsideDir: string;
let prevRoot: string | null = null;

before(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'mocode-sandbox-test-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'mocode-outside-test-'));
  mkdirSync(join(sandboxRoot, 'sub'), { recursive: true });
  writeFileSync(join(sandboxRoot, 'sub', 'file.txt'), 'hello');
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
  // save/restore 而非清 null：共享进程(--experimental-test-isolation=none)下本文件测试与
  // note-append/session-state-reminder 等交错执行,清 null 会让其它文件 jailResolve 兜底到 cwd。
  prevRoot = setSandboxRoot(sandboxRoot);
});

after(() => {
  setSandboxRoot(prevRoot);
  rmSync(sandboxRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

// ---------- jailResolve ----------

test('jailResolve: 根内相对路径解析为牢内绝对路径', () => {
  const abs = jailResolve('sub/file.txt');
  assert.equal(abs, resolve(sandboxRoot, 'sub', 'file.txt'));
  assert.ok(isInsideRoot(abs));
});

test('jailResolve: 根内绝对路径放行', () => {
  const abs = jailResolve(resolve(sandboxRoot, 'sub', 'file.txt'));
  assert.equal(abs, resolve(sandboxRoot, 'sub', 'file.txt'));
});

test('jailResolve: ../ 越界抛错', () => {
  assert.throws(() => jailResolve('../outside'), /越界|outside/i);
});

test('jailResolve: 根外绝对路径抛错', () => {
  assert.throws(() => jailResolve(join(outsideDir, 'secret.txt')), /越界/);
});

test('jailResolve: 不存在的目标走最近存在祖先拼回,仍在牢内', () => {
  const abs = jailResolve('sub/new/deep/file.ts'); // 中间目录不存在
  assert.equal(abs, resolve(sandboxRoot, 'sub', 'new', 'deep', 'file.ts'));
  assert.ok(isInsideRoot(abs));
});

test('jailResolve: 越界软链出圈被 realpath 拦下', (t) => {
  let link: string;
  try {
    link = join(sandboxRoot, 'link-out');
    symlinkSync(outsideDir, link, 'junction');
  } catch {
    t.skip('Windows 下无建软链权限(需开发者模式),跳过');
    return;
  }
  try {
    assert.throws(() => jailResolve('link-out/secret.txt'), /越界/);
  } finally {
    rmSync(link, { recursive: true, force: true });
  }
});

// ---------- jailGlobPattern ----------

test('jailGlobPattern: 空 pattern 拒绝', () => {
  assert.match(jailGlobPattern('')!, /空/);
});

test('jailGlobPattern: 绝对路径拒绝', () => {
  assert.match(jailGlobPattern(resolve(sandboxRoot, '*.ts'))!, /绝对路径/);
});

test('jailGlobPattern: 含 .. 段拒绝', () => {
  assert.match(jailGlobPattern('../src/*.ts')!, /\.\./);
});

test('jailGlobPattern: 正常 pattern 放行', () => {
  assert.equal(jailGlobPattern('src/**/*.ts'), null);
  assert.equal(jailGlobPattern('*.md'), null);
});

// ---------- enforceSandbox 四分支 ----------

test('enforceSandbox: 豁免工具直接放行且不改 args', () => {
  for (const name of SANDBOX_EXEMPT_TOOLS) {
    const args = { path: '../evil' };
    assert.equal(enforceSandbox(name, args), null, name);
    assert.equal(args.path, '../evil', `${name} 不应改写 args`);
  }
});

test('enforceSandbox: 路径工具相对路径被重写为牢内绝对路径', () => {
  for (const name of SANDBOX_PATH_TOOLS) {
    const args = { path: 'sub/file.txt' };
    assert.equal(enforceSandbox(name, args), null, name);
    assert.equal(args.path, resolve(sandboxRoot, 'sub', 'file.txt'), name);
  }
});

test('enforceSandbox: 路径工具越界返回拒绝字符串且不抛', () => {
  const args = { path: '../outside/x.txt' };
  const err = enforceSandbox('read_file', args);
  assert.ok(typeof err === 'string' && err.length > 0);
  assert.match(err, /越界/);
});

test('enforceSandbox: 路径工具空 path 不重写、不拒绝(参数校验另管)', () => {
  const args = { path: '' };
  assert.equal(enforceSandbox('read_file', args), null);
  assert.equal(args.path, '');
});

test('enforceSandbox: glob 越界 pattern 拒绝', () => {
  const err = enforceSandbox('glob', { pattern: 'C:\\outside\\*.ts' });
  assert.ok(typeof err === 'string');
  assert.match(err, /glob/);
});

test('enforceSandbox: glob 正常 pattern 放行', () => {
  assert.equal(enforceSandbox('glob', { pattern: 'src/**/*.ts' }), null);
});

test('enforceSandbox: grep 越界 glob 字段拒绝', () => {
  const err = enforceSandbox('grep', { pattern: 'foo', glob: '../**/*.ts' });
  assert.ok(typeof err === 'string');
  assert.match(err, /glob/);
});

test('enforceSandbox: grep 未提供 glob 字段时用默认值放行', () => {
  assert.equal(enforceSandbox('grep', { pattern: 'foo' }), null);
});

test('enforceSandbox: 未登记工具(如 run_command 走自有检查)默认放行', () => {
  assert.equal(enforceSandbox('run_command', { command: 'echo hi', path: '../x' }), null);
  assert.equal(enforceSandbox('some_future_tool', { path: '../x' }), null);
});
