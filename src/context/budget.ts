// 五区 Context Budget accounting and the shared pressure threshold.
//
// This module only estimates and reports. session/scheduler.ts owns the sole
// automatic rewrite sequence and starts all pressure cleanup plus compact_history
// when corrected or raw request occupancy reaches 80%.

import type { ChatMessage, ChatTool } from '../llm/index.js';
import {
  chatTools,
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  messageTokens,
} from '../llm/index.js';
import { lastUserIndex, toText } from './utils.js';

/** 五区分账(占比对齐 CONTEXT_WINDOW)。顺序固定,便于遍历。 */
export const BUDGET_LAYERS = [
  'system',
  'history',
  'toolRecent', // Hot Tool
  'toolOld', // Cold Tool
  'summary',
  'reserve', // Reserve(不占内容,只占预算分配;5%)
] as const;
export type BudgetLayer = (typeof BUDGET_LAYERS)[number];

/** Context Budget Scheduler 的单一策略源。 */
export interface BudgetPolicy {
  ratios: Readonly<Record<BudgetLayer, number>>;
  hotTurnWindow: number;
  compactKeepRatio: number;
  /** Context occupancy at which pressure-only history compression may run. */
  pressureTriggerRatio: number;
  schedulerTargetRatio: number;
  estimateSafetyFactor: number;
  compactHeadroomTokens: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  ratios: {
    system: 0.15,
    history: 0.20,
    toolRecent: 0.25,
    toolOld: 0.25,
    summary: 0.10,
    reserve: 0.05,
  },
  hotTurnWindow: 4,
  compactKeepRatio: 0.40,
  pressureTriggerRatio: 0.80,
  schedulerTargetRatio: 0.80,
  estimateSafetyFactor: 1.05,
  compactHeadroomTokens: 1500,
};

/** 兼容既有调用方的只读别名；配置只在 DEFAULT_BUDGET_POLICY 中维护。 */
export const BUDGET_RATIO = DEFAULT_BUDGET_POLICY.ratios;
export const HOT_TURN_WINDOW = DEFAULT_BUDGET_POLICY.hotTurnWindow;

function msgTokens(m: ChatMessage): number {
  // 与请求预估复用同一实现，避免角色结构开销、多模态和 tool_calls 在两个预算路径中漂移。
  return messageTokens(m);
}

/** 从 idx 处向前数第 N 个 user turn 的边界 index(含该 user 之后的内容)。
 * 用于把 history 切成 Hot 区(tail 一段,endExclusive=history.length)与 Cold 区(0..endExclusive)。
 * 若 N 个 user 不足,Hot 区 = history.length(全保护);Cold 区空,无压缩目标。 */
export function userTurnBoundary(history: ChatMessage[], window: number): number {
  let seen = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'user') {
      seen++;
      if (seen >= window) return i;
    }
  }
  return 1; // 没攒够 N 个 user 之前的全归 Cold(history[0] system 不动)
}

/** 单区预算分配。绝对值 = ratio * window。 */
export interface LayerBudget {
  actual: number;
  budget: number;
  overBudget: boolean;
  /** overBudget 比值 = max(0, actual - budget) / budget;无超 = 0。
   * 调度器用此值做 ROI 排序——溢出越多,优先处理。 */
  overRatio: number;
}

/** 一次评估的完整报告(供 agent/core.ts 决策)。 */
export interface SystemCostBreakdown {
  /** 校正前的 system prompt token 估算。 */
  prompt: number;
  /** 校正前的本次 active tool schema token 估算。 */
  toolSchemas: number;
}

export interface BudgetReport {
  step: number;
  total: number; // 各区 actual 之和(已经过 correction 校正)
  /** 裸估算总量(不乘 correction)。硬闸触发线用它判断:correction<1 把调度器视角
   * 压到触发线以下、而 UI 裸估算已超窗时,仍必须触发压缩。 */
  rawTotal: number;
  window: number;
  layers: Record<BudgetLayer, LayerBudget>;
  /** system 层固定请求开销的校正前拆分，供告警定位具体来源。 */
  systemCosts: SystemCostBreakdown;
  /** 实际超预算的层(按 overRatio 降序,排前面先处理)。 */
  triggers: BudgetLayer[];
  /** 总占用超总阈(0.80*window,校正后)的兜底触发 — 单独字段,与 layers.triggers 分开。 */
  totalOver: boolean;
  /** Hot/Cold 边界:Cold 区 = [1, hotBoundary);Hot 区 = [hotBoundary, length)。
   * agent/core.ts 拿到后可对 Cold 区做就地 stub,Hot 区只 cap。 */
  hotBoundary: number;
  /** 本次评估使用的校正系数(API 实测/估算;1 = 未校准)。 */
  correction: number;
}

/** 评估当前 history 的五区预算(纯函数,改不动 history)。
 * 传入 step 是当前所在 step 编号(agent 循环 step 变量),用于日志/调试。
 * correction:API 实测 / 估算的校正系数(默认 1);>1 表示粗估偏低,乘以系数后 actual 更接近真实值。
 * activeTools 必须与下一次 chat() 实际发送的工具集合一致，避免 plan/子 agent 误算 schema。 */
export function evaluateBudget(
  history: ChatMessage[],
  window: number,
  step: number = 0,
  correction: number = 1,
  activeTools: readonly ChatTool[] = chatTools,
): BudgetReport {
  const layers: Record<BudgetLayer, LayerBudget> = {} as Record<BudgetLayer, LayerBudget>;
  for (const k of BUDGET_LAYERS) {
    const budget = Math.floor(BUDGET_RATIO[k] * window);
    layers[k] = { actual: 0, budget, overBudget: false, overRatio: 0 };
  }

  // 校正后的 token 数:raw * correction,最小 1(raw > 0 时)。
  const adj = (raw: number): number => (raw > 0 ? Math.max(1, Math.round(raw * correction)) : 0);

  // 裸总量(不乘 correction):硬闸用它判断,防止 correction 折扣否决真实溢出。
  let rawTotal = 0;

  const sysMsg = history[0];
  const systemCosts: SystemCostBreakdown = {
    prompt: sysMsg ? msgTokens(sysMsg) : 0,
    toolSchemas: estimateToolSchemaTokens(activeTools),
  };
  // 工具 schema 与 system prompt 同属请求固定开销；必须计入总量才能可靠触发压缩。
  const systemRaw = systemCosts.prompt + systemCosts.toolSchemas;
  layers.system.actual = adj(systemRaw);
  rawTotal += systemRaw;

  // Summary 检测:role:'system' 且不是 history[0] 的,视为摘要(compact.ts 摘要插 index 1)。
  // 简单启发:若 history[1]?.role === 'system' 且 content 含「# 会话摘要」特征串,计入 summary。
  // 命中时循环跳过 i=1;不命中时当作普通 message(罕见,落到下方 user/assistant 分支)。
  let summaryHit = false;
  if (history.length > 1 && history[1].role === 'system') {
    const c1 = toText(history[1].content);
    if (c1.startsWith('# 会话摘要') || c1.includes('会话摘要')) {
      const summaryRaw = msgTokens(history[1]);
      layers.summary.actual = adj(summaryRaw);
      rawTotal += summaryRaw;
      summaryHit = true;
    }
  }

  // 划 Hot/Cold 边界
  const hotStart = userTurnBoundary(history, HOT_TURN_WINDOW);
  // history 区 = 减去 summary + tool 单算;tool 按 Hot/Cold 分。
  for (let i = 1; i < history.length; i++) {
    const m = history[i];
    if (i === 1 && summaryHit) continue; // summary 已单独算过
    const raw = msgTokens(m);
    if (m.role === 'tool') {
      if (i >= hotStart) layers.toolRecent.actual += adj(raw);
      else layers.toolOld.actual += adj(raw);
      rawTotal += raw;
    } else if (m.role !== 'system') {
      // user / assistant 全部计入 history(对话轨迹)
      layers.history.actual += adj(raw);
      rawTotal += raw;
    }
    // 其它 system(几乎不存在)跳过
  }

  // 计算 overBudget + overRatio
  const triggers: BudgetLayer[] = [];
  for (const k of BUDGET_LAYERS) {
    const lb = layers[k];
    if (lb.actual > lb.budget) {
      lb.overBudget = true;
      lb.overRatio = (lb.actual - lb.budget) / Math.max(lb.budget, 1);
      triggers.push(k);
    }
  }
  // 按 overRatio 降序
  triggers.sort((a, b) => layers[b].overRatio - layers[a].overRatio);

  const total = BUDGET_LAYERS.reduce((s, k) => s + (k === 'reserve' ? 0 : layers[k].actual), 0);
  const totalOver = total >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * window;

  return {
    step,
    total,
    rawTotal,
    window,
    layers,
    systemCosts,
    triggers,
    totalOver,
    hotBoundary: hotStart,
    correction,
  };
}

/** 调度器只生成执行层能够真正落地的动作。 */
export type ScheduleAction =
  | {
      kind: 'warn';
      layer: BudgetLayer;
      reason: string;
    }
  | {
      kind: 'compact_history';
      focus?: string;
    };

/** 根据 BudgetReport 生成可执行动作。
 * History compaction is the final fallback after pressure-only tool stages.
 * Per-layer overages are diagnostics, never independent rewrite triggers. */
export function scheduleActions(report: BudgetReport): ScheduleAction[] {
  const actions: ScheduleAction[] = [];
  const { layers } = report;

  if (layers.system.overBudget) {
    const { prompt, toolSchemas } = report.systemCosts;
    const { actual, budget } = layers.system;
    const excess = actual - budget;
    const percent = ((actual / Math.max(budget, 1)) * 100).toFixed(0);
    actions.push({
      kind: 'warn',
      layer: 'system',
      reason:
        `固定开销 ${actual}/${budget} (+${excess}, ${percent}%)；`
        + `提示 ${prompt} + 工具 ${toolSchemas}，×${report.correction.toFixed(2)}。`,
    });
  }

  const pressureLine = DEFAULT_BUDGET_POLICY.pressureTriggerRatio * report.window;
  if (Math.max(report.rawTotal, report.total) >= pressureLine) {
    actions.push({ kind: 'compact_history' });
  }

  return actions;
}

/** 拍平成人类可读(供 /context 命令与 check-budget 脚本用)。 */
export function formatReport(report: BudgetReport): string {
  const lines: string[] = [];
  lines.push(`step ${report.step}  total ${report.total}/${report.window}  (${((report.total / report.window) * 100).toFixed(1)}%)  raw ${report.rawTotal}`);
  for (const k of BUDGET_LAYERS) {
    const lb = report.layers[k];
    const pct = lb.budget > 0 ? ((lb.actual / lb.budget) * 100).toFixed(0) : '-';
    const flag = lb.overBudget ? '⚠' : ' ';
    lines.push(`  ${flag} ${k.padEnd(10)} ${String(lb.actual).padStart(6)} / ${String(lb.budget).padStart(6)} (${pct.padStart(3)}%)`);
  }
  if (report.triggers.length > 0) {
    lines.push(`  triggers: ${report.triggers.join(' → ')}`);
  }
  return lines.join('\n');
}

/** 便捷:把 history 一把估成总 token 数(给 cap.js 等复用,避免重复实现)。
 * 注意:此处是粗估(只看 content 长度),不区分五区——只用于「系统层整体还剩多少」快查。 */
export function quickEstimate(history: ChatMessage[]): number {
  return estimateMessagesTokens(history);
}
