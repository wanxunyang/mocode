// 五区 Context Budget Scheduler。
//
// 目的:把当前请求拆成 System / History / Tool-Recent / Tool-Old / Summary + Reserve，
//      统一报告各区占用，并只调度执行层能够真正落地的 warn / compact_history。
//
// push-time cap、pipeline、relevance、lifecycle 与 age-aware sweep 负责工具结果优化；
// scheduler 在这些处理完成后评估，不重复生成 Cold/Hot tool 压缩动作。
// 本文件保持叶子级，只依赖 ChatMessage / token estimate，具体执行由 session/scheduler.ts 完成。
// contextBudget 开关关闭时，agent/core.ts 退化为直接调用 maybeCompact。

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
  toolOldAge: number;
  compactKeepRatio: number;
  totalTriggerRatio: number;
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
  toolOldAge: 2,
  compactKeepRatio: 0.40,
  totalTriggerRatio: 0.82,
  schedulerTargetRatio: 0.80,
  estimateSafetyFactor: 1.05,
  compactHeadroomTokens: 1500,
};

/** 兼容既有调用方的只读别名；配置只在 DEFAULT_BUDGET_POLICY 中维护。 */
export const BUDGET_RATIO = DEFAULT_BUDGET_POLICY.ratios;
export const HOT_TURN_WINDOW = DEFAULT_BUDGET_POLICY.hotTurnWindow;
export const TOOL_OLD_AGE = DEFAULT_BUDGET_POLICY.toolOldAge;

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
  window: number;
  layers: Record<BudgetLayer, LayerBudget>;
  /** system 层固定请求开销的校正前拆分，供告警定位具体来源。 */
  systemCosts: SystemCostBreakdown;
  /** 实际超预算的层(按 overRatio 降序,排前面先处理)。 */
  triggers: BudgetLayer[];
  /** 总占用超总阈(0.82*window)的兜底触发 — 单独字段,与 layers.triggers 分开。 */
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

  const sysMsg = history[0];
  const systemCosts: SystemCostBreakdown = {
    prompt: sysMsg ? msgTokens(sysMsg) : 0,
    toolSchemas: estimateToolSchemaTokens(activeTools),
  };
  // 工具 schema 与 system prompt 同属请求固定开销；必须计入总量才能可靠触发压缩。
  layers.system.actual = adj(systemCosts.prompt + systemCosts.toolSchemas);

  // Summary 检测:role:'system' 且不是 history[0] 的,视为摘要(compact.ts 摘要插 index 1)。
  // 简单启发:若 history[1]?.role === 'system' 且 content 含「# 会话摘要」特征串,计入 summary。
  // 命中时循环跳过 i=1;不命中时当作普通 message(罕见,落到下方 user/assistant 分支)。
  let summaryHit = false;
  if (history.length > 1 && history[1].role === 'system') {
    const c1 = toText(history[1].content);
    if (c1.startsWith('# 会话摘要') || c1.includes('会话摘要')) {
      layers.summary.actual = adj(msgTokens(history[1]));
      summaryHit = true;
    }
  }

  // 划 Hot/Cold 边界
  const hotStart = userTurnBoundary(history, HOT_TURN_WINDOW);
  // history 区 = 减去 summary + tool 单算;tool 按 Hot/Cold 分。
  for (let i = 1; i < history.length; i++) {
    const m = history[i];
    if (i === 1 && summaryHit) continue; // summary 已单独算过
    if (m.role === 'tool') {
      const t = adj(msgTokens(m));
      if (i >= hotStart) layers.toolRecent.actual += t;
      else layers.toolOld.actual += t;
    } else if (m.role !== 'system') {
      // user / assistant 全部计入 history(对话轨迹)
      layers.history.actual += adj(msgTokens(m));
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
  const totalOver = total >= DEFAULT_BUDGET_POLICY.totalTriggerRatio * window;

  return {
    step,
    total,
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
 * push-time cap、relevance、lifecycle 与 age-aware sweep 已在评估前完成，
 * 因此这里不再生成无法执行的 Cold/Hot tool action。
 * History 或总量超预算时才考虑昂贵的 LLM 摘要。 */
export function scheduleActions(report: BudgetReport): ScheduleAction[] {
  const actions: ScheduleAction[] = [];
  const { layers, totalOver, total } = report;
  const policy = DEFAULT_BUDGET_POLICY;
  const headroom = policy.schedulerTargetRatio * report.window
    - total * policy.estimateSafetyFactor;

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

  if (
    (layers.history.overBudget || totalOver)
    && headroom < -policy.compactHeadroomTokens
  ) {
    actions.push({ kind: 'compact_history' });
  }

  return actions;
}

/** 拍平成人类可读(供 /context 命令与 check-budget 脚本用)。 */
export function formatReport(report: BudgetReport): string {
  const lines: string[] = [];
  lines.push(`step ${report.step}  total ${report.total}/${report.window}  (${((report.total / report.window) * 100).toFixed(1)}%)`);
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
