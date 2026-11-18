import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTurnProgressGuard } from '../../src/agent/progress-guard.js';
import { withSandboxRoot } from '../../src/sandbox/index.js';
import { runCommandRaw, runCommandTool } from '../../src/tools/builtins/run-command.js';
import { createReadDedup } from '../../src/tools/read-dedup.js';
import type { ToolOutcome } from '../../src/tools/types.js';

const shell = process.platform === 'win32' ? 'cmd' : 'bash';

test('重复命令每次执行副作用，读取最新状态并保留本次退出码', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mocode-command-'));
  const state = join(root, 'state.txt');
  const count = join(root, 'count.txt');
  t.after(async () => {
    await rm(state, { force: true });
    await rm(count, { force: true });
    await rmdir(root);
  });
  const args = {
    shell,
    command: `node -e "const fs=require('fs');fs.appendFileSync('count.txt','x');const s=fs.readFileSync('state.txt','utf8');console.log(s);process.exitCode=s==='ready'?0:7"`,
  };
  const ctx = { readDedup: createReadDedup() };
  await withSandboxRoot(root, async () => {
    await writeFile(state, 'pending');
    for (let i = 0; i < 3; i++) {
      const res = await runCommandTool.execute(args, ctx);
      assert.ok(typeof res !== 'string');
      assert.equal(res.code, 'PROCESS_FAILED');
      assert.match(res.output, /7\].*\npending/);
    }
    await writeFile(state, 'ready');
    const res = await runCommandTool.execute(args, ctx);
    assert.ok(typeof res !== 'string');
    assert.equal(res.status, 'success');
    assert.match(res.output, /ready/);
    assert.equal(await readFile(count, 'utf8'), 'xxxx');
  });
});

test('stdout 和 stderr 各自处理跨块 UTF-8 字符与 UTF-16 BOM，流式和最终输出一致', async () => {
  const cmd =
    `node -e "process.stdout.write(Buffer.from([0xe6]));process.stderr.write(Buffer.from([0xff]));` +
    `setTimeout(()=>{process.stdout.write(Buffer.from([0xb1,0x89]));process.stderr.write(Buffer.from([0xfe,0x4f,0,0x4b,0]))},35)"`;
  let stream = '';
  const res = await runCommandRaw(cmd, 10_000, undefined, undefined, shell, (s) => {
    stream += s;
  });
  assert.equal(res.status, 'passed');
  assert.equal(res.output, stream);
  assert.match(stream, /汉/);
  assert.match(stream, /OK/);
  assert.doesNotMatch(stream, /[\u0000\uFFFD]/);
});

test('遇到无标记的混合编码或 NUL 分隔符，保留同次调用里的可读结果', async () => {
  const cmd = `node -e "process.stderr.write(Buffer.from([0xff,0,0,0,0,0,0]));process.stdout.write('result=ready')"`;
  const res = await runCommandRaw(cmd, 10_000, undefined, undefined, shell);
  assert.equal(res.status, 'passed');
  assert.match(res.output, /result=ready/);
  assert.ok(res.output.includes('\u0000'));
});

const failure: ToolOutcome = { status: 'error', code: 'PROCESS_FAILED', retryable: false, output: 'failed' };
const success: ToolOutcome = { status: 'success', code: 'OK', retryable: false, output: 'ok' };

test('同一轮中的多个工具只算一次；跨轮同类失败时给可操作的提醒', () => {
  const guard = createTurnProgressGuard();
  for (let i = 0; i < 8; i++) guard.record('probe', String(i), failure);
  assert.equal(guard.takeReminder(), undefined);
  for (let i = 1; i <= 2; i++) {
    guard.record('probe', 'different-' + i, { ...failure, output: 'reason ' + i, changedFiles: ['background.log'] });
    const note = guard.takeReminder();
    if (i === 1) assert.equal(note, undefined);
    else assert.match(note ?? '', /probe \(PROCESS_FAILED\)/);
  }
  assert.equal(guard.takeReminder(), undefined);
});

test('同一批拿到新证据或提交修改时不误报，提交后重新计数', () => {
  const guard = createTurnProgressGuard();
  for (let i = 0; i < 2; i++) {
    guard.record('probe', 'a', failure);
    guard.takeReminder();
  }
  guard.record('probe', 'a', failure);
  guard.record('read', 'b', success);
  assert.equal(guard.takeReminder(), undefined);
  guard.record('edit', 'c', { ...success, changeSet: { id: '1', changedFiles: ['a.txt'], changes: [] } });
  guard.record('probe', 'a', failure);
  assert.equal(guard.takeReminder(), undefined);
  guard.record('probe', 'a', failure);
  assert.equal(guard.takeReminder(), undefined);
});

test('重复观察按工具、目标和完整结果区分，滚动窗口外的记录过期', () => {
  const guard = createTurnProgressGuard();
  for (let i = 0; i < 8; i++) {
    guard.record('read', 'fileA', { ...success, output: 'x'.repeat(2200) + i });
    guard.record('read', 'file' + i, success);
    assert.equal(guard.takeReminder(), undefined);
  }
  for (let i = 0; i < 2; i++) {
    guard.record('read', 'file0', success);
    assert.equal(guard.takeReminder(), undefined);
  }
  guard.record('read', 'file0', success);
  assert.match(guard.takeReminder() ?? '', /same call returned the same result/i);
});
