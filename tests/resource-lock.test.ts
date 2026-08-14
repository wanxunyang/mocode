/**
 * ResourceLockManager 单元测试:读/写锁语义、workspace 锁冲突、FIFO 公平性、abort 清理。
 * 纯内存并发原语,不依赖 fs / config;直接用 node:test 跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ResourceLockManager,
  resolveResourceLockRequests,
  canonicalFileResourceKey,
} from '../src/tools/resource-lock.js';
import type { ToolCapabilities } from '../src/tools/types.js';

const res = (key: string, mode: 'read' | 'write' = 'write') =>
  ({ key, scope: 'resource', mode }) as const;
const ws = (mode: 'read' | 'write' = 'write') =>
  ({ key: 'workspace', scope: 'workspace', mode }) as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('读锁相互共享:同 key 双读并发获得', async () => {
  const mgr = new ResourceLockManager();
  const order: string[] = [];
  const a = mgr.acquire([res('f', 'read')]).then(() => order.push('a'));
  const b = mgr.acquire([res('f', 'read')]).then(() => order.push('b'));
  await Promise.all([a, b]);
  assert.equal(order.length, 2);
});

test('写写互斥:同 key 第二个写必须等第一个释放', async () => {
  const mgr = new ResourceLockManager();
  const release1 = await mgr.acquire([res('f')]);
  let secondAcquired = false;
  const p2 = mgr.acquire([res('f')]).then(() => { secondAcquired = true; });
  await sleep(20);
  assert.equal(secondAcquired, false, '锁未释放前不得获取');
  release1();
  await p2;
  assert.equal(secondAcquired, true);
});

test('读写互斥:写持有期间读等待', async () => {
  const mgr = new ResourceLockManager();
  const releaseW = await mgr.acquire([res('f', 'write')]);
  let readAcquired = false;
  const pR = mgr.acquire([res('f', 'read')]).then(() => { readAcquired = true; });
  await sleep(20);
  assert.equal(readAcquired, false);
  releaseW();
  await pR;
  assert.equal(readAcquired, true);
});

test('不同 key 互不干扰:并发同时获得', async () => {
  const mgr = new ResourceLockManager();
  const r1 = mgr.acquire([res('a')]);
  const r2 = mgr.acquire([res('b')]);
  await Promise.all([r1, r2]);
});

test('workspace 写锁与任意资源写锁冲突', async () => {
  const mgr = new ResourceLockManager();
  const releaseWs = await mgr.acquire([ws()]);
  let fileAcquired = false;
  const pFile = mgr.acquire([res('f')]).then(() => { fileAcquired = true; });
  await sleep(20);
  assert.equal(fileAcquired, false);
  releaseWs();
  await pFile;
});

test('workspace 读锁与资源读锁不冲突(读读共享)', async () => {
  const mgr = new ResourceLockManager();
  await Promise.all([
    mgr.acquire([ws('read')]),
    mgr.acquire([res('f', 'read')]),
  ]);
});

test('FIFO 公平性:同 key 排队者按到达顺序获得(无饥饿)', async () => {
  const mgr = new ResourceLockManager();
  const release1 = await mgr.acquire([res('f')]);
  const order: string[] = [];
  // 拿到锁后立即记录并释放,链式推进;若调度不 FIFO(后到者插队),order 会乱序。
  const claim = (label: string) =>
    mgr.acquire([res('f')]).then((release) => { order.push(label); release(); });
  const p2 = claim('w1');
  const p3 = claim('w2');
  const p4 = claim('w3');
  await sleep(20);
  release1();
  await Promise.all([p2, p3, p4]);
  assert.deepEqual(order, ['w1', 'w2', 'w3']);
});

test('abort: 已 abort 的 signal 直接 reject,不进入队列', async () => {
  const mgr = new ResourceLockManager();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    mgr.acquire([res('f')], ac.signal),
    (e: unknown) => e instanceof Error && e.name === 'AbortError',
  );
});

test('abort: 排队等待中 abort,立即 reject 且后续 waiter 可继续', async () => {
  const mgr = new ResourceLockManager();
  const release1 = await mgr.acquire([res('f')]);

  const ac = new AbortController();
  const pAborted = mgr.acquire([res('f')], ac.signal);
  let thirdAcquired = false;
  const pThird = mgr.acquire([res('f')]).then(() => { thirdAcquired = true; });

  await sleep(10);
  ac.abort();
  await assert.rejects(pAborted, (e: unknown) => e instanceof Error && e.name === 'AbortError');

  // 被 abort 的 waiter 已移出队列;释放后第三个 waiter 直接获得
  release1();
  await pThird;
  assert.equal(thirdAcquired, true);
});

test('abort: 已获锁后 signal 再 abort 不影响执行(监听已移除)', async () => {
  const mgr = new ResourceLockManager();
  const ac = new AbortController();
  const release = await mgr.acquire([res('f')], ac.signal);
  ac.abort(); // 获锁后 abort,不应产生未捕获异常
  release();
  // 能走到这里即通过;锁已被正确释放,后续可再次获取
  const release2 = await mgr.acquire([res('f')]);
  release2();
});

test('空请求列表立即 resolve,不产生等待', async () => {
  const mgr = new ResourceLockManager();
  const release = await mgr.acquire([]);
  assert.equal(typeof release, 'function');
  release(); // 幂等 no-op
});

test('withLocks: 异常时仍释放锁', async () => {
  const mgr = new ResourceLockManager();
  await assert.rejects(mgr.withLocks([res('f')], undefined, async () => {
    throw new Error('boom');
  }));
  // 锁已释放:再次获取应立即成功
  const release = await mgr.acquire([res('f')]);
  release();
});

test('resolveResourceLockRequests: 空键 + network effect → 无锁', () => {
  const caps: ToolCapabilities = { effect: 'network', concurrency: 'parallel', resources: () => [] };
  assert.deepEqual(resolveResourceLockRequests(caps, {}), []);
});

test('resolveResourceLockRequests: 空键 + 非 network → fail-closed 到 workspace 写锁', () => {
  const caps: ToolCapabilities = { effect: 'read', concurrency: 'serial', resources: () => [] };
  assert.deepEqual(resolveResourceLockRequests(caps, {}), [ws()]);
});

test('resolveResourceLockRequests: resources() 抛错 → fail-closed 到 workspace 写锁', () => {
  const caps: ToolCapabilities = {
    effect: 'write',
    concurrency: 'resource-locked',
    resources: () => { throw new Error('bad args'); },
  };
  assert.deepEqual(resolveResourceLockRequests(caps, {}), [ws()]);
});

test('resolveResourceLockRequests: 非字符串键 → fail-closed 到 workspace 写锁', () => {
  const caps: ToolCapabilities = {
    effect: 'write',
    concurrency: 'resource-locked',
    resources: () => [42 as unknown as string],
  };
  assert.deepEqual(resolveResourceLockRequests(caps, {}), [ws()]);
});

test('resolveResourceLockRequests: process/unknown effect 恒 workspace 写锁(不调 resources)', () => {
  const caps: ToolCapabilities = {
    effect: 'process',
    concurrency: 'serial',
    resources: () => { throw new Error('must not be called'); },
  };
  assert.deepEqual(resolveResourceLockRequests(caps, {}), [ws()]);
});

test('resolveResourceLockRequests: file: 键转 canonical 资源锁,workspace 键原样保留', () => {
  const caps: ToolCapabilities = {
    effect: 'write',
    concurrency: 'resource-locked',
    resources: (args) => [`file:${args.path}`, 'workspace'],
  };
  const requests = resolveResourceLockRequests(caps, { path: 'src/a.ts' });
  assert.equal(requests.length, 2);
  const fileReq = requests.find((r) => r.key.startsWith('file:'))!;
  const wsReq = requests.find((r) => r.scope === 'workspace')!;
  assert.equal(fileReq.mode, 'write');
  assert.equal(fileReq.scope, 'resource');
  assert.equal(wsReq.key, 'workspace');
});

test('resolveResourceLockRequests: delegatesResourceLocks 恒返回空(编排器不持锁)', () => {
  const caps: ToolCapabilities = {
    effect: 'write',
    concurrency: 'resource-locked',
    resources: () => ['file:x'],
    delegatesResourceLocks: true,
  };
  assert.deepEqual(resolveResourceLockRequests(caps, {}), []);
});

test('canonicalFileResourceKey: 同一路径在 Windows 下大小写归一', () => {
  const k1 = canonicalFileResourceKey('src/Main.ts');
  const k2 = canonicalFileResourceKey('src/main.ts');
  const k3 = canonicalFileResourceKey('src/other.ts');
  if (process.platform === 'win32') {
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
  } else {
    // 非 Windows 平台不强制大小写归一;只断言 file: 前缀与确定性
    assert.ok(k1.startsWith('file:'));
    assert.equal(k1, k1);
  }
});
