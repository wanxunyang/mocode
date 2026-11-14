import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDiagnostics,
  flushDiagnostics,
  recordDiagnostic,
  resolveDiagnosticsLogPath,
  snapshotDiagnostics,
} from '../../src/runtime/browser-diagnostics.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-browser-diag-'));
}

test('计数是累计值，不随环缓冲滑动而变小', () => {
  const diag = createDiagnostics({ logPath: null, ringLimit: 3, tailSize: 2 });
  for (let index = 0; index < 10; index++) recordDiagnostic(diag, 'console', `line ${index}`);

  const snapshot = snapshotDiagnostics(diag);
  // 环缓冲只留最后 3 条，但「一共来了 10 条」这个事实必须保住：
  // 否则模型看到计数回落会误判问题已消失。
  assert.equal(snapshot.counts.console, 10);
  assert.deepEqual(snapshot.tail.console, ['line 8', 'line 9']);
  assert.equal(snapshot.logPath, undefined);
});

test('三个桶各自独立计数与截尾', () => {
  const diag = createDiagnostics({ logPath: null, ringLimit: 50, tailSize: 1 });
  recordDiagnostic(diag, 'console', 'c1');
  recordDiagnostic(diag, 'pageErrors', 'e1');
  recordDiagnostic(diag, 'pageErrors', 'e2');
  recordDiagnostic(diag, 'failedRequests', 'r1');

  const snapshot = snapshotDiagnostics(diag);
  assert.deepEqual(snapshot.counts, { console: 1, pageErrors: 2, failedRequests: 1 });
  assert.deepEqual(snapshot.tail, { console: ['c1'], pageErrors: ['e2'], failedRequests: ['r1'] });
});

test('诊断写入会话日志文件，并按桶加前缀', async () => {
  const root = tempRoot();
  try {
    const logPath = resolveDiagnosticsLogPath(root, 'panel');
    const diag = createDiagnostics({ logPath });
    recordDiagnostic(diag, 'console', '[error] boom');
    recordDiagnostic(diag, 'failedRequests', 'GET /api — net::ERR_FAILED');
    await flushDiagnostics(diag);

    assert.equal(snapshotDiagnostics(diag).logPath, logPath);
    const text = fs.readFileSync(logPath, 'utf8');
    assert.match(text, /^\[console\] \[error\] boom$/m);
    assert.match(text, /^\[failedRequests\] GET \/api — net::ERR_FAILED$/m);
    // 目录是自动建的：work-app 的工作区首次跑浏览器不必预建 .mocode/browser。
    assert.ok(fs.existsSync(path.join(root, '.mocode', 'browser')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('并发事件串行落盘，不交错覆盖', async () => {
  const root = tempRoot();
  try {
    const diag = createDiagnostics({ logPath: resolveDiagnosticsLogPath(root, 'panel') });
    for (let index = 0; index < 40; index++) recordDiagnostic(diag, 'console', `n${index}`);
    await flushDiagnostics(diag);

    const lines = fs
      .readFileSync(snapshotDiagnostics(diag).logPath as string, 'utf8')
      .split('\n')
      .filter(Boolean);
    assert.equal(lines.length, 40);
    // 顺序必须与产生顺序一致：排队写入若用 Promise.all 就会乱序。
    assert.deepEqual(
      lines,
      Array.from({ length: 40 }, (_, index) => `[console] n${index}`),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('日志超过体积上限后停止追加并标记 logTruncated', async () => {
  const root = tempRoot();
  try {
    const diag = createDiagnostics({
      logPath: resolveDiagnosticsLogPath(root, 'panel'),
      maxLogBytes: 60,
    });
    recordDiagnostic(diag, 'console', 'a'.repeat(40));
    recordDiagnostic(diag, 'console', 'b'.repeat(40));
    const afterSecond = snapshotDiagnostics(diag);
    recordDiagnostic(diag, 'console', 'c'.repeat(40));
    await flushDiagnostics(diag);

    // 第二条已越界：它是被记录的最后一条（标记在先，不再追加），第三条不写。
    assert.equal(afterSecond.logTruncated, true);
    const text = fs.readFileSync(afterSecond.logPath as string, 'utf8');
    assert.ok(!text.includes('cccc'), '越界后的条目不得写入日志');
    // 计数仍然继续累加：截断的是明细，不是「发生过几次」。
    assert.equal(snapshotDiagnostics(diag).counts.console, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('落点建不了时不阻塞采集，仅缺 logPath', async () => {
  // 用一个「父路径是文件」的位置模拟建目录失败（只读工作区的等价场景）。
  const root = tempRoot();
  try {
    const blocker = path.join(root, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    const diag = createDiagnostics({ logPath: path.join(blocker, 'nested', 'panel.log') });
    recordDiagnostic(diag, 'console', 'still collected');
    await flushDiagnostics(diag);

    const snapshot = snapshotDiagnostics(diag);
    assert.equal(snapshot.counts.console, 1);
    assert.deepEqual(snapshot.tail.console, ['still collected']);
    assert.equal(snapshot.logPath, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
