/**
 * 提交泳道图的 SVG 渲染（纯函数）：吃一行 `GraphRow`，吐一段 `<svg>`。
 *
 * 单独成模块的理由与 `../git-graph.ts` 相同：几何常量必须只有一份。
 * 两处用图 —— Git 历史面板的提交列表、源代码管理面板顶部的「最近提交」——
 * 高度（`ROW_H`）与列宽（`LANE_W`）若各写一遍，两边行高一改就对不齐，
 * 而且颜色 class 也会分叉。**对应行高必须等于 `ROW_H`**：
 * `.history-row` 与 `.scm-recent-row` 都是 26px（见 style.css）。
 */
import type { GraphRow } from '../git-graph.js';

/** 每条 lane 的列宽。 */
export const LANE_W = 12;
/** 一行的高度；宿主行（.history-row / .scm-recent-row）必须与它一致。 */
export const ROW_H = 26;
/** 节点半径。 */
export const NODE_R = 3.5;

function laneColor(index: number): string {
  // 颜色只选 class，具体色值在 style.css（跟随主题，亮/暗各一套）。
  return `lane-${index}`;
}

function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

/**
 * 一行泳道图。
 *
 * 只画三种东西（见 git-graph.ts 的说明，非节点 lane 不会半路消失）：
 *   1. 直通线（贯穿本行，不经过节点）；
 *   2. 节点到父提交的连接（第一父继承列 → 竖线；并到别的列 → 曲线）；
 *   3. 节点本身。
 * 行的上下沿各让出半步，让相邻行的线自然接上，不留缝。
 */
export function graphSvg(row: GraphRow): string {
  const width = Math.max(1, row.lanes) * LANE_W;
  const cx = laneX(row.lane);
  const cy = ROW_H / 2;
  const parts: string[] = [];
  for (const line of row.through) {
    const x = laneX(line.lane);
    parts.push(`<path class="lane-line ${laneColor(line.color)}" d="M${x} 0V${ROW_H}"/>`);
  }
  // 有 lane 在等这个提交 → 从行顶连到节点；尖端（没有任何子提交指向它）则从节点起笔。
  if (row.fromTop) parts.push(`<path class="lane-line ${laneColor(row.color)}" d="M${cx} 0V${cy}"/>`);
  for (const edge of row.edges) {
    const from = laneX(edge.from);
    const to = laneX(edge.to);
    const d = from === to
      ? `M${from} ${cy}V${ROW_H}`
      // 半个行高的控制点：弯得太急会像折线，太缓又会压到相邻 lane。
      : `M${from} ${cy}C${from} ${cy + ROW_H / 4} ${to} ${ROW_H - ROW_H / 4} ${to} ${ROW_H}`;
    parts.push(`<path class="lane-line ${laneColor(edge.color)}" d="${d}"/>`);
  }
  parts.push(`<circle class="lane-node ${laneColor(row.color)}" cx="${cx}" cy="${cy}" r="${NODE_R}"/>`);
  return `<svg class="history-graph" width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">${parts.join('')}</svg>`;
}