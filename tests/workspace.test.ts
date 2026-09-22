/**
 * 工作区切换单元测试:resolveWorkspaceTarget 的分支 + switchWorkspaceRoot 的三处状态改写。
 *
 * 用 mkdtemp 临时目录,并在 after 里把 cwd / 沙箱根 / config.sessionDir 全部还原——
 * 这三个是进程级单例,泄漏出去会让同进程后续测试的路径断言莫名其妙。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from '../src/config/index.js';
import { getSandboxRoot, setSandboxRoot } from '../src/sandbox/root.js';
import { defaultSessionStore } from '../src/session/store.js';
import { getWorkspaceRoot, resolveWorkspaceTarget, switchWorkspaceRoot } from '../src/workspace/index.js';

let wsA: string;
let wsB: string;
/** 还原用:原始 cwd / 沙箱根 / sessionDir。 */
let origin: { cwd: string; root: string | null; sessionDir: string };

before(() => {
  wsA = mkdtempSync(join(tmpdir(), 'mocode-ws-a-'));
  wsB = mkdtempSync(join(tmpdir(), 'mocode-ws-b-'));
  mkdirSync(join(wsA, 'sub'), { recursive: true });
  writeFileSync(join(wsA, 'file.txt'), 'x');
  origin = { cwd: process.cwd(), root: getSandboxRoot(), sessionDir: config.sessionDir };
});

after(() => {
  process.chdir(origin.cwd);
  setSandboxRoot(origin.root);
  config.sessionDir = origin.sessionDir;
  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
});

/** 每个用例都从 A 起步,避免用例间互相依赖。 */
function resetToA(): void {
  switchWorkspaceRoot(wsA);
}

// ---------- resolveWorkspaceTarget ----------

test('resolveWorkspaceTarget: 相对路径按当前工作区根解析', () => {
  resetToA();
  const target = resolveWorkspaceTarget('sub');
  assert.equal(target.ok, true);
  assert.equal(target.root, resolve(wsA, 'sub'));
});

test('resolveWorkspaceTarget: 绝对路径原样采纳', () => {
  resetToA();
  const target = resolveWorkspaceTarget(wsB);
  assert.equal(target.ok, true);
  assert.equal(target.root, resolve(wsB));
});

test('resolveWorkspaceTarget: 目录不存在 → missing', () => {
  resetToA();
  const target = resolveWorkspaceTarget(join(wsA, 'nope'));
  assert.equal(target.ok, false);
  // 断言窄化:assert.equal 不收窄联合类型,这里显式取失败分支字段。
  assert.equal(target.ok === false ? target.error : null, 'missing');
});

test('resolveWorkspaceTarget: 传文件 → not-dir', () => {
  resetToA();
  const target = resolveWorkspaceTarget(join(wsA, 'file.txt'));
  assert.equal(target.ok, false);
  assert.equal(target.ok === false ? target.error : null, 'not-dir');
});

test('resolveWorkspaceTarget: 空串 → empty', () => {
  resetToA();
  const target = resolveWorkspaceTarget('   ');
  assert.equal(target.ok, false);
  assert.equal(target.ok === false ? target.error : null, 'empty');
});

test('resolveWorkspaceTarget: 切换一次后 /cd - 指向上一个工作区', () => {
  resetToA();
  switchWorkspaceRoot(wsB);
  const back = resolveWorkspaceTarget('-');
  assert.equal(back.ok, true);
  assert.equal(back.root, resolve(wsA));
});

// ---------- switchWorkspaceRoot ----------

test('switchWorkspaceRoot: cwd + 沙箱根 + sessionDir 三处一起改', () => {
  resetToA();
  const result = switchWorkspaceRoot(wsB);
  assert.equal(result.previous, resolve(wsA));
  assert.equal(result.root, resolve(wsB));
  assert.equal(process.cwd(), resolve(wsB));
  assert.equal(getSandboxRoot(), resolve(wsB));
  assert.equal(getWorkspaceRoot(), resolve(wsB));
  assert.equal(config.sessionDir, join(resolve(wsB), '.mocode', 'sessions'));
  // 会话归属的工作区根必须跟随(默认 store 用 provider 动态读,不重建实例)。
  assert.equal(defaultSessionStore.workspaceRoot, resolve(wsB));
  // 后续落盘走新工作区的 sessions 目录(旧会话留在原工作区,由 /cd 命令显式 save)。
  assert.equal(defaultSessionStore.sessionsRoot, join(resolve(wsB), '.mocode', 'sessions'));
});

test('switchWorkspaceRoot: /cd - 回到上一个工作区', () => {
  resetToA();
  switchWorkspaceRoot(wsB);
  const target = resolveWorkspaceTarget('-');
  assert.equal(target.ok, true);
  assert.equal(target.root, resolve(wsA));
  const result = switchWorkspaceRoot(target.root);
  assert.equal(result.previous, resolve(wsB));
  assert.equal(getWorkspaceRoot(), resolve(wsA));
});

test('switchWorkspaceRoot: 幂等 —— 切到当前工作区仍返回一致结果', () => {
  resetToA();
  const result = switchWorkspaceRoot(wsA);
  assert.equal(result.previous, resolve(wsA));
  assert.equal(result.root, resolve(wsA));
  assert.equal(getWorkspaceRoot(), resolve(wsA));
});
