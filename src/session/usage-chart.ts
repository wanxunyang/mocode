/**
 * /usage 按天用量的终端柱状图(替代长表格:300 天的表有 300+ 行,不可用)。
 *
 * 设计:
 *  - 固定 CHART_ROWS 行高,区间再长也不增高;天数 > MAX_BARS 时按等宽时间桶聚合
 *    (300 天 → 每柱 7 天,约 43 根柱)。
 *  - 柱高按 log1p 缩放:日用量从几十 k 到几百 M 跨 4 个数量级,线性柱会让小日全贴底。
 *  - x 轴标签等距抽样(MM-DD),柱子密集时不互相叠字。
 *
 * 纯函数:输入每日聚合 + 终端列宽,输出多行 ANSI 字符串(非 markdown,直接 contentWrite)。
 */
import { ui } from '../ui/theme.js';
import { fmtCompactTokens } from '../ui/render.js';

export const CHART_ROWS = 6;
/** 柱数上限:超过则按时间桶聚合。 */
export const MAX_BARS = 48;
/** 左侧对数标尺占用列宽。 */
const SCALE_W = 7;

export interface ChartDatum {
  day: string;
  input: number;
  output: number;
  calls: number;
}

export interface ChartBar {
  /** 桶末日 MM-DD。 */
  label: string;
  total: number;
  input: number;
  output: number;
  calls: number;
  /** 本桶覆盖天数(1 = 单天)。 */
  spanDays: number;
}

/** 每日数据 → 柱数据;超过 maxBars 则等宽分桶(桶内求和,标签取桶末日)。 */
export function bucketizeDays(data: readonly ChartDatum[], maxBars = MAX_BARS): ChartBar[] {
  const n = data.length;
  if (n === 0) return [];
  const toBar = (d: ChartDatum): ChartBar => ({
    label: d.day.slice(5),
    total: d.input + d.output,
    input: d.input,
    output: d.output,
    calls: d.calls,
    spanDays: 1,
  });
  if (n <= maxBars) return data.map(toBar);

  const size = Math.ceil(n / maxBars);
  const bars: ChartBar[] = [];
  for (let i = 0; i < n; i += size) {
    const chunk = data.slice(i, i + size);
    const agg = chunk.reduce(
      (acc, d) => {
        acc.input += d.input;
        acc.output += d.output;
        acc.calls += d.calls;
        return acc;
      },
      { input: 0, output: 0, calls: 0 },
    );
    bars.push({
      label: chunk[chunk.length - 1]!.day.slice(5),
      total: agg.input + agg.output,
      input: agg.input,
      output: agg.output,
      calls: agg.calls,
      spanDays: chunk.length,
    });
  }
  return bars;
}

/** 柱高 → 颜色梯度(顶层黄、高量绿、中量青、低量 dim)。 */
function bandColor(height: number): string {
  if (height >= CHART_ROWS) return ui.yellow;
  if (height >= CHART_ROWS - 2) return ui.green;
  if (height >= 2) return ui.cyan;
  return ui.dim;
}

/**
 * 渲染柱状图为物理行数组(调用方自行 join '\n')。
 * @param cols 终端列宽;图表总宽钳到 [28, 84]。
 */
export function renderUsageBars(bars: readonly ChartBar[], cols: number): string[] {
  if (bars.length === 0 || bars.every((b) => b.total <= 0)) return [];

  const totalW = Math.max(28, Math.min(cols - 2, 84));
  const plotW = totalW - SCALE_W;
  const slot = Math.max(1, Math.floor(plotW / bars.length));
  const barW = Math.min(3, Math.max(1, slot - 1));

  const maxV = Math.max(...bars.map((b) => b.total));
  const logMax = Math.log1p(maxV);
  const heightOf = (v: number): number => (v <= 0 ? 0 : Math.max(1, Math.round((Math.log1p(v) / logMax) * CHART_ROWS)));

  const scaleCol = (text: string): string => ui.dim + String(text).padStart(SCALE_W - 1) + ' ' + ui.reset;

  const lines: string[] = [];
  for (let r = CHART_ROWS; r >= 1; r--) {
    // 仅顶行/底行给对数标尺(最大/最小),中间行留空,省地方也不制造精度错觉。
    let row: string;
    if (r === CHART_ROWS) row = scaleCol(fmtCompactTokens(maxV));
    else if (r === 1) row = scaleCol('0');
    else row = ' '.repeat(SCALE_W);

    for (const b of bars) {
      const h = heightOf(b.total);
      if (r <= h) {
        const color = bandColor(h);
        row += color + '█'.repeat(barW) + ui.reset + ' '.repeat(Math.max(0, slot - barW));
      } else {
        row += ' '.repeat(slot);
      }
    }
    lines.push(row.replace(/\s+$/, ''));
  }

  // x 轴标签:按可用宽度等距抽样,每标签至少 6 列间隔(MM-DD 长 5)。
  const labelEvery = Math.max(1, Math.ceil(6 / slot));
  let axis = ' '.repeat(SCALE_W);
  bars.forEach((b, i) => {
    if (i % labelEvery === 0) {
      // 覆盖该 slot 起点放标签;抽样间隔保证不会与下一个标签相撞。
      axis += ui.dim + b.label + ui.reset + ' '.repeat(Math.max(0, slot * labelEvery - 5));
    }
  });
  lines.push(axis.replace(/\s+$/, ''));
  return lines;
}
