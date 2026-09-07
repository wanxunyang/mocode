/**
 * IdleGuard(常驻子进程空闲回收)单测。
 *
 * 为什么值得单测:这个类的失败模式是「静默的」—— 定时器不 unref 会让 REPL 退不出去,
 * 空闲不回收会留孤儿 PowerShell,回收回调不幂等会重复 kill。三种都不会在 typecheck 里暴露。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { IdleGuard, envInt } from '../src/runtime/idle-guard.js';

// 注意:这里的 sleep **不能** unref。IdleGuard 自身的定时器必须 unref(否则吊住 REPL 退出),
// 但测试若在等待期间没有任何 ref'd handle,Node 会判定 event loop 已空并直接退出 ——
// 在 `npm test` 的 --experimental-test-isolation=none 下这会连带 cancel 掉其它文件的用例。
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('IdleGuard: 空闲到期触发回收回调', async () => {
  let fired = 0;
  const guard = new IdleGuard(30, () => {
    fired += 1;
  });
  guard.touch();
  assert.equal(guard.armed, true);
  await sleep(70);
  assert.equal(fired, 1, '到期应恰好触发一次');
  assert.equal(guard.armed, false, '触发后应解除武装');
});

test('IdleGuard: touch 续期,未到期不回收', async () => {
  let fired = 0;
  const guard = new IdleGuard(60, () => {
    fired += 1;
  });
  guard.touch();
  await sleep(30);
  guard.touch(); // 续期:计时从头开始
  await sleep(30);
  assert.equal(fired, 0, '第二次 touch 后 30ms 不应到期(总共 60ms)');
  await sleep(50);
  assert.equal(fired, 1, '续期后到期应触发一次');
});

test('IdleGuard: stop 后不再触发', async () => {
  let fired = 0;
  const guard = new IdleGuard(30, () => {
    fired += 1;
  });
  guard.touch();
  guard.stop();
  assert.equal(guard.armed, false);
  await sleep(70);
  assert.equal(fired, 0);
});

test('IdleGuard: idleMs <= 0 表示永不自动回收', async () => {
  let fired = 0;
  const guard = new IdleGuard(0, () => {
    fired += 1;
  });
  guard.touch();
  assert.equal(guard.armed, false, '0 不应武装定时器');
  await sleep(30);
  assert.equal(fired, 0);
  // 负数同理(envInt 拦掉了负值,但类自身也应稳健)
  const neg = new IdleGuard(-1, () => {
    fired += 1;
  });
  neg.touch();
  assert.equal(neg.armed, false);
});

test('IdleGuard: stop 幂等,未 touch 直接 stop 不抛', () => {
  const guard = new IdleGuard(30, () => {});
  guard.stop();
  guard.stop();
  assert.equal(guard.armed, false);
});

test('envInt: 合法值取整,非法/缺失/负值回落默认', () => {
  const prev = process.env.MOCODE_TEST_ENVINT;
  try {
    delete process.env.MOCODE_TEST_ENVINT;
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 5000, '缺失回落');
    process.env.MOCODE_TEST_ENVINT = '1234';
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 1234);
    process.env.MOCODE_TEST_ENVINT = '1234.6';
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 1235, '四舍五入');
    process.env.MOCODE_TEST_ENVINT = '0';
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 0, '0 是合法值(关闭自动回收)');
    process.env.MOCODE_TEST_ENVINT = '-100';
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 5000, '负值回落');
    process.env.MOCODE_TEST_ENVINT = 'abc';
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 5000, '非数字回落');
    process.env.MOCODE_TEST_ENVINT = '';
    assert.equal(envInt('MOCODE_TEST_ENVINT', 5000), 5000, '空串回落');
  } finally {
    if (prev === undefined) delete process.env.MOCODE_TEST_ENVINT;
    else process.env.MOCODE_TEST_ENVINT = prev;
  }
});
