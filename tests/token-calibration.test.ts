/** token 校准(EWMA)单元测试:重点锁「provider 口径异常样本不得污染 correction」。
 *
 *  背景:估算器允许偏高(安全侧),usage 是 provider 报的账,两者本该同量级。
 *  实测踩过 localhost 网关的 thinking 模型报出 20.8 chars/token(同机其它 provider
 *  全是 1.3–3.3),ratio 直接砸穿 MIN_CORRECTION 被 clamp 成 0.5,之后每个乘以它的
 *  显示数字都被无谓打对折(压缩行 40% vs 底栏 80%)。这类样本必须丢弃。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTokenCalibration, updateTokenCalibration } from '../src/context/token-calibration.js';

// 校准缓存路径支持环境变量覆盖(见 token-calibration.ts cachePath):必须在第一次
// 读缓存前设好,否则会落到 ~/.mocode/token-calibration.json 污染真实数据。
// (该模块不在 import 期读 env/磁盘,所以此处赋值对下面的调用有效。)
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-calib-'));
process.env.MOCODE_TOKEN_CALIBRATION_CACHE = path.join(cacheDir, 'calibration.json');

const tools = [{ type: 'function', function: { name: 'read_file' } }];
let seq = 0;
/** 每个用例用独立 key(baseURL 不同),避免共享模块级缓存时互相串数据。 */
function freshKey(): string {
  seq += 1;
  return `http://unit-test-${seq}.invalid/v1`;
}

test.after(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('正常样本入账:首次用原始比例,之后走 EWMA', () => {
  const base = freshKey();
  const first = updateTokenCalibration(base, 'model-a', tools, 10_000, 9_500);
  assert.equal(first.samples, 1);
  assert.ok(Math.abs(first.correction - 0.95) < 1e-9, `期望 0.95,实际 ${first.correction}`);

  const second = updateTokenCalibration(base, 'model-a', tools, 10_000, 10_000);
  assert.equal(second.samples, 2);
  // EWMA:0.95 * 0.8 + 1.0 * 0.2
  assert.ok(Math.abs(second.correction - 0.96) < 1e-9, `期望 0.96,实际 ${second.correction}`);
  assert.equal(getTokenCalibration(base, 'model-a', tools).samples, 2);
});

test('provider 报账远低于估算(ratio<0.3)时丢弃样本', () => {
  const base = freshKey();
  // 20 万估算 vs 3.9 万实测 = 0.195:典型的口径不可比(不是估算器错了)。
  const r = updateTokenCalibration(base, 'model-chatty-gateway', tools, 200_000, 39_000);
  assert.equal(r.samples, 0, '样本不应入账');
  assert.equal(r.correction, 1, 'correction 应保持未校准');
  assert.equal(getTokenCalibration(base, 'model-chatty-gateway', tools).samples, 0, '不应写盘');
});

test('provider 报账远高于估算(ratio>3.5)时同样丢弃', () => {
  const base = freshKey();
  const r = updateTokenCalibration(base, 'model-b', tools, 1_000, 20_000);
  assert.equal(r.samples, 0);
  assert.equal(r.correction, 1);
});

test('区间边界:ratio=0.3 仍入账(仅被 MIN_CORRECTION 夹到 0.5)', () => {
  const base = freshKey();
  const r = updateTokenCalibration(base, 'model-c', tools, 10_000, 3_000);
  assert.equal(r.samples, 1);
  assert.equal(r.correction, 0.5);
});

test('可疑样本不推翻已建立的校准值', () => {
  const base = freshKey();
  updateTokenCalibration(base, 'model-d', tools, 10_000, 8_000); // 0.8
  const good = getTokenCalibration(base, 'model-d', tools);
  assert.equal(good.samples, 1);

  const after = updateTokenCalibration(base, 'model-d', tools, 10_000, 500); // ratio 0.05 → 丢弃
  assert.equal(after.samples, good.samples, '样本数不应增长');
  assert.equal(after.correction, good.correction, '校准值不应被可疑样本拉动');
});

test('样本过小(<=100)保持原有早退行为', () => {
  const base = freshKey();
  const r = updateTokenCalibration(base, 'model-e', tools, 50, 5);
  assert.equal(r.samples, 0);
  assert.equal(r.correction, 1);
});
