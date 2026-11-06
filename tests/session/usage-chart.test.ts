import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketizeDays,
  renderUsageBars,
  MAX_BARS,
  CHART_ROWS,
  type ChartDatum,
} from '../../src/session/usage-chart.js';

function days(n: number, fn?: (i: number) => number): ChartDatum[] {
  return Array.from({ length: n }, (_, i) => ({
    day: `2026-01-${String((i % 27) + 1).padStart(2, '0')}`,
    input: fn ? fn(i) : i * 1000,
    output: fn ? Math.round(fn(i) / 10) : i * 100,
    calls: i,
  }));
}

test('usage-chart: 天数不超过上限时逐日成柱,标签为 MM-DD', () => {
  const bars = bucketizeDays(days(7));
  assert.equal(bars.length, 7);
  assert.ok(bars.every((b) => b.spanDays === 1));
  assert.deepEqual(
    bars.map((b) => b.label),
    ['01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07'],
  );
});

test('usage-chart: 长区间等宽聚合成不超过 MAX_BARS 根柱,桶内求和且覆盖全部天数', () => {
  const data = days(300);
  const bars = bucketizeDays(data);
  assert.ok(bars.length <= MAX_BARS);
  assert.equal(bars.length, Math.ceil(300 / 7));
  assert.equal(bars[0].spanDays, 7);
  // 标签取桶末日
  assert.equal(bars[0].label, '01-07');
  // 桶内 input 求和
  const firstWeek = data.slice(0, 7).reduce((s, d) => s + d.input, 0);
  assert.equal(bars[0].input, firstWeek);
  // 覆盖天数合计等于原始天数
  assert.equal(
    bars.reduce((s, b) => s + b.spanDays, 0),
    300,
  );
});

test('usage-chart: 空数据/全零返回空行', () => {
  assert.deepEqual(bucketizeDays([]), []);
  assert.deepEqual(renderUsageBars([], 80), []);
  assert.deepEqual(renderUsageBars(bucketizeDays(days(3, () => 0)), 80), []);
});

test('usage-chart: 图高度恒定,且不超出终端宽度', () => {
  for (const n of [7, 30, 300]) {
    const bars = bucketizeDays(days(n, (i) => (i % 47 === 0 ? 50_000_000 : (i % 7) * 20_000)));
    const lines = renderUsageBars(bars, 100);
    // CHART_ROWS 柱体行 + 1 标签行
    assert.equal(lines.length, CHART_ROWS + 1, `${n} 天图高恒定`);
    const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;
    assert.ok(Math.max(...lines.map(visible)) <= 100, `${n} 天不超宽`);
  }
});

test('usage-chart: 小值日在对数刻度下仍可见(最小高度 1,不被大值日压平)', () => {
  const data: ChartDatum[] = [
    { day: '2026-11-01', input: 100_000, output: 1000, calls: 5 },
    { day: '2026-11-02', input: 466_000_000, output: 3_000_000, calls: 3000 },
  ];
  const lines = renderUsageBars(bucketizeDays(data), 100);
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  // 底行(最后一个柱体行,索引 CHART_ROWS-1)两柱都至少有一个 █
  const bottom = strip(lines[CHART_ROWS - 1]!);
  const blocks = bottom.match(/█/g);
  assert.ok((blocks?.length ?? 0) >= 2, '小值日与大值日在底行都有柱体');
});
