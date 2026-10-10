/**
 * summarizeMetrics:按 action 分组的 p50/p95。纯函数,用合成数据,不依赖模块级 ring buffer。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMetrics, type ComputerMetric } from '../src/tools/builtins/computer.js';

function metric(action: string, totalMs: number, over: Partial<ComputerMetric> = {}): ComputerMetric {
  return {
    action,
    captureMs: 0,
    decodeMs: 0,
    scaleMs: 0,
    encodeMs: 0,
    injectMs: 0,
    totalMs,
    bytes: 0,
    skipped: false,
    ...over,
  };
}

test('summarizeMetrics: 空输入 → 全 0、byAction 为空', () => {
  const s = summarizeMetrics([]);
  assert.equal(s.count, 0);
  assert.equal(s.totalP50, 0);
  assert.deepEqual(s.byAction, {});
  assert.equal(s.last, undefined);
});

test('summarizeMetrics: 按 action 分组各自算 count / p50 / p95,互不污染', () => {
  const list = [
    metric('left_click', 100),
    metric('left_click', 300),
    metric('left_click', 200),
    metric('inspect', 1000),
    metric('inspect', 2000),
    metric('wait_until', 400),
  ];
  const s = summarizeMetrics(list);
  assert.equal(s.count, 6);
  assert.deepEqual(s.byAction.left_click, { count: 3, p50: 200, p95: 300 });
  assert.deepEqual(s.byAction.inspect, { count: 2, p50: 2000, p95: 2000 });
  assert.deepEqual(s.byAction.wait_until, { count: 1, p50: 400, p95: 400 });
});

test('summarizeMetrics: 总体指标与 dedup 比例、平均字节、last 保持原语义', () => {
  const list = [
    metric('screenshot', 100, { captureMs: 40, bytes: 2048, skipped: true }),
    metric('screenshot', 200, { captureMs: 60, bytes: 4096 }),
  ];
  const s = summarizeMetrics(list);
  assert.equal(s.skippedRatio, 0.5);
  assert.equal(s.avgBytes, 3072);
  assert.equal(s.captureP50, 60);
  assert.equal(s.last, list[1]);
});
