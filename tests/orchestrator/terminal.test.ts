import test from 'node:test';
import assert from 'node:assert/strict';
import { openTerminalWindow, minimizeWindowByTitle } from '../../src/orchestrator/terminal.js';
import type { spawn, SpawnOptions } from 'node:child_process';

interface Call {
  bin: string;
  args: readonly string[];
  options: SpawnOptions;
}

/**
 * 假 spawn：只记录调用，不真的起进程。
 *
 * 真实 spawn 是 EventEmitter（调用方会 `.on('error')` / `.unref()`），所以假对象也要有
 * 这两个方法，否则被测代码会在自己的 happy path 上崩掉。
 */
function fakeSpawn(calls: Call[]): typeof spawn {
  return ((bin: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ bin, args: args ?? [], options: options ?? {} });
    return { on: () => undefined, unref: () => undefined };
  }) as unknown as typeof spawn;
}

test('openTerminalWindow: asks the desktop helper to push the new window to the taskbar', () => {
  const calls: Call[] = [];
  const minimized: string[] = [];
  const result = openTerminalWindow({
    title: 'mocode · main · run-1',
    args: ['supervise', 'lane', 'run-1', '--lane', 'main'],
    spawnImpl: fakeSpawn(calls),
    minimizeImpl: (title) => minimized.push(title),
  });

  assert.equal(result.opened, true);
  // 标题必须和拉窗口时用的完全一致：helper 只靠标题匹配 HWND。
  assert.deepEqual(minimized, ['mocode · main · run-1']);
});

test('openTerminalWindow: the window title reaches the terminal launcher', () => {
  const calls: Call[] = [];
  openTerminalWindow({
    title: 'probe-title-42',
    args: ['supervise', 'lane', 'run-1', '--lane', 'main'],
    spawnImpl: fakeSpawn(calls),
    minimizeImpl: () => undefined,
  });

  // Windows 上走 wt.exe --title 或 cmd start <title>；两者都把标题写进 argv。
  const flat = calls.flatMap((call) => [call.bin, ...call.args]).join(' ');
  assert.match(flat, /probe-title-42/);
});

test('minimizeWindowByTitle: launches through `cmd /c start /min` instead of a detached spawn', () => {
  // 关键回归：直接 `spawn(powershell, {detached:true})` 会让 helper 静默死掉
  // （连脚本第一行都跑不到），窗口永远压不下去。分离必须交给 cmd 的 start 做。
  const calls: Call[] = [];
  minimizeWindowByTitle('mocode · main · run-1', fakeSpawn(calls), 1_000);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.bin, 'cmd');
  assert.deepEqual(call.args.slice(0, 5), ['/c', 'start', '', '/min', 'powershell']);
  assert.equal(call.args.includes('-EncodedCommand'), true);
  // 标题经环境变量传，不拼进命令行：避免引号地狱，也不会被当成 PowerShell 代码。
  assert.equal(call.options.env?.MOCODE_MINIMIZE_TITLE, 'mocode · main · run-1');
  assert.equal(call.options.env?.MOCODE_MINIMIZE_TIMEOUT_MS, '1000');
  assert.notEqual(call.options.detached, true);
});

test('minimizeWindowByTitle: never throws even when the helper cannot be spawned', () => {
  const boom = (() => {
    throw new Error('ENOENT');
  }) as unknown as typeof spawn;
  assert.doesNotThrow(() => minimizeWindowByTitle('any-title', boom, 100));
});

test('openTerminalWindow: MOCODE_SUPERVISE_NO_MINIMIZE=1 suppresses the taskbar helper', () => {
  const previous = process.env.MOCODE_SUPERVISE_NO_MINIMIZE;
  process.env.MOCODE_SUPERVISE_NO_MINIMIZE = '1';
  try {
    const calls: Call[] = [];
    const result = openTerminalWindow({
      title: 'probe-no-helper',
      args: ['supervise', 'lane', 'run-1', '--lane', 'main'],
      spawnImpl: fakeSpawn(calls),
    });
    assert.equal(result.opened, true);
    // 关掉开关后不该再有 helper 的启动命令（`start … /min powershell`）。
    assert.equal(
      calls.some((call) => call.args.includes('/min')),
      false,
      'MOCODE_SUPERVISE_NO_MINIMIZE=1 must suppress the taskbar helper',
    );
  } finally {
    if (previous === undefined) delete process.env.MOCODE_SUPERVISE_NO_MINIMIZE;
    else process.env.MOCODE_SUPERVISE_NO_MINIMIZE = previous;
  }
});
