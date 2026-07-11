// 五区 Context Budget Scheduler。
//
// 目的:把当前四道独立闸(cap / pipeline / relevance / maybeCompact)统一为
//       「先看预算报告,再按 ROI 排序调度」的单一入口。
//
// 设计原则(对应用户拍板的设计方案):
//   1. 五区分账:不是把 history 当一个黑盒,而是把上下文切成 5 区逐区配预算
//      (System / History / Tool-Recent / Tool-Old / Summary) + 1 个 Reserve。
//      Tool 内部再分 Hot/Cold:
//        - Cold Tool(老化区,scheduler 优先压缩——ROI 最低,LLM 复述成本最低)
//        - Hot Tool(当前±N 步内,scheduler **不主动 stub**——避免干扰 agent 当前步)
//      注:**Hot 区「scheduler 不主动」≠ 「绝对不动」**。lifecycle age stub、pruner
//      same-path 替代、agent 的 drop_context 工具仍可动 Hot 区;它们语义更精细(知道
//      哪条已无关),不会盲目 stub。Scheduler 只在更粗的层面决策,粗判断不踩精细判断。
//      Hot 区超预算时 scheduler 仅 cap(降单条上限,不丢内容)。
//   2. ROI 排序:History > Summary > Hot Tool > Cold Tool。压缩时先动 Cold Tool
//      (LLM 复述成本最低),再动 History(摘要成本高);Hot Tool 与 System 雷打不动(指 scheduler 层面)。
//   3. 零行为变化兜底:调度器不是闸,而是「报告 + 决策」——执行仍复用现有
//      cap / pipeline / relevance / compact / lifecycle / drop_context 实现,只是触发条件更精准。
//
// 依赖:本文件是叶子级,只依赖 ChatMessage / estimateTokens,绝不反向依赖
//      agent / session / compact(避免循环与耦合)。具体执行动作由 agent/core.ts
//      拿 ScheduleAction[] 去调现有闸。
//
// 开关(MOCODE_BUDGET_SCHEDULER):默认 true。false 时 agent/core.ts 走老路径
//      (直接 maybeCompact),完全跳过本模块,零行为变化。

import type { ChatMessage } from '../llm/index.js';
import { estimateMessagesTokens, estimateTokens } from '../llm/index.js';

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

/** 占比(总和 = 0.95,留 5% 给 Reserve)。对齐用户修正版:
 *  Recent Tool 25%(原 40% 偏大,因 Hot 区不该被压)+ Old Tool 25% 同等 +
 *  History 20% + System 15% + Summary 10%(平时 0 占用,触发后才用) */
export const BUDGET_RATIO: Record<BudgetLayer, number> = {
  system: 0.15,
  history: 0.20,
  toolRecent: 0.25,
  toolOld: 0.25,
  summary: 0.10,
  reserve: 0.05,
};

/** Hot/Cold 划分:当前 step 起往前 HOT_TURN_WINDOW 个 user turn 之内的工具结果视为 Hot,
 * 之外的视为 Cold。0 = 全 Cold(等同老路径);越短 Hot 越小,压缩越激进。 */
export const HOT_TURN_WINDOW = 4;

/** 工具消息推入历史后,经过的「消费者 push 次数」即 age。
 * Cold 区内:age ≥ TOOL_OLD_AGE 的非观察类工具结果可被调度器就地 stub。
 * 默认 2 = 跨过 2 个消费者 push 仍未被消费,等同 lifecycle 的 DEFAULT_AGE_THRESHOLD。 */
export const TOOL_OLD_AGE = 2;

/** 把每条 token 拍平成字符串(只估 token,不深解析工具调用)。 */
function toText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function msgTokens(m: ChatMessage): number {
  const c = (m as { content?: unknown }).content;
  const tcs = (m as { tool_calls?: { function?: { arguments?: string } }[] }).tool_calls;
  let extra = toText(c);
  if (tcs) for (const tc of tcs) extra += tc?.function?.arguments ?? '';
  // 与 llm.estimateTokens 同公式(CJK 1/字,ASCII 1/4字);保证调度器评估与系统估算口径一致。
  return 4 + estimateTokens(extra);
}

/** 从 history 末尾向前找最后一个 user 消息的索引;无 user 返 -1。 */
export function lastUserIndex(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'user') return i;
  }
  return -1;
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
export interface BudgetReport {
  step: number;
  total: number; // 各区 actual 之和(已经过 correction 校正)
  window: number;
  layers: Record<BudgetLayer, LayerBudget>;
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
 * correction:API 实测 / 估算的校正系数(默认 1);>1 表示粗估偏低,乘以系数后 actual 更接近真实值。 */
export function evaluateBudget(
  history: ChatMessage[],
  window: number,
  step: number = 0,
  correction: number = 1,
): BudgetReport {
  const layers: Record<BudgetLayer, LayerBudget> = {} as Record<BudgetLayer, LayerBudget>;
  for (const k of BUDGET_LAYERS) {
    const budget = Math.floor(BUDGET_RATIO[k] * window);
    layers[k] = { actual: 0, budget, overBudget: false, overRatio: 0 };
  }

  // 校正后的 token 数:raw * correction,最小 1(raw > 0 时)。
  const adj = (raw: number): number => (raw > 0 ? Math.max(1, Math.round(raw * correction)) : 0);

  const sysMsg = history[0];
  if (sysMsg) layers.system.actual = adj(msgTokens(sysMsg));

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
  // 安全裕量:用 0.82 而非 0.85,预留 3% 给 correction 波动与新消息增量。
  const totalOver = total >= 0.82 * window;

  return {
    step,
    total,
    window,
    layers,
    triggers,
    totalOver,
    hotBoundary: hotStart,
    correction,
  };
}

/** 调度器决策动作(纯数据,不动 history)。agent/core.ts 据此调用既有闸。 */
export type ScheduleAction =
  | {
      kind: 'warn';
      layer: BudgetLayer;
      reason: string;
    }
  | {
      /** 对 Cold 区(hotBoundary 之前)的 tool 消息按 ROI 做 L1→L2→L3 渐进压缩。
       *  注意:Hot 区永不发此 action——精细剔除由 lifecycle/pruner/drop_context 负责。 */
      kind: 'shrink_cold_tools';
      level: 1 | 2 | 3;
    }
  | {
      /** Hot 区只 cap(降单条上限),不 stub;aggressive = true 时调低阈值走更严的 cap。
       * 精细剔除(cap 不够时)由 lifecycle age stub 与 drop_context 工具兜底。 */
      kind: 'cap_hot_tools';
      aggressive: boolean;
    }
  | {
      kind: 'compact_history';
      focus?: string;
    };

/** 根据 BudgetReport 生成调度动作(从轻到重,直至总占用回落到阈值以下)。
 * 规则:
 *   - system 超 → warn(不压,配置问题不是内容问题)
 *   - toolOld 超 → 先 L1(中截超大)→ L2(same-path 已有 relevance)→ L3(age stub,新增)
 *   - toolRecent 超 → cap(只降低单条上限,不 stub)
 *   - history 超 或 totalOver → compact_history(调 maybeCompact / compactHistory)
 *   - summary 超 → 不动(摘要本身就压缩产物,删它等于丢历史,只能放任或扩 Recent 预算)
 *
 * 安全裕量:headroom 按 0.80 * window - total * 1.05 计算(预留 5% 应对 correction 误差
 * 与新消息增量),避免估算偏差导致被 API 硬截断。 */
export function scheduleActions(report: BudgetReport): ScheduleAction[] {
  const actions: ScheduleAction[] = [];
  const { layers, totalOver, total } = report;
  // 收紧:0.80 阈值(原 0.85)+ total * 1.05 放大(估算不确定性缓冲)
  const headroom = 0.80 * report.window - total * 1.05;

  // system 超 → warn,不是 schedule 目标
  if (layers.system.overBudget) {
    actions.push({
      kind: 'warn',
      layer: 'system',
      reason: `System prompt 超预算(${layers.system.actual} > ${layers.system.budget}),请检查配置/MOCODE.md`,
    });
  }

  // 渐进:toolOld(轻→重)
  if (layers.toolOld.overBudget && layers.toolOld.overRatio > 0.1) {
    actions.push({ kind: 'shrink_cold_tools', level: 1 });
  }
  if (layers.toolOld.overBudget && layers.toolOld.overRatio > 0.3) {
    actions.push({ kind: 'shrink_cold_tools', level: 2 });
  }
  if (layers.toolOld.overBudget && layers.toolOld.overRatio > 0.6) {
    actions.push({ kind: 'shrink_cold_tools', level: 3 });
  }

  // Hot 区只 cap
  if (layers.toolRecent.overBudget && layers.toolRecent.overRatio > 0.15) {
    actions.push({ kind: 'cap_hot_tools', aggressive: layers.toolRecent.overRatio > 0.5 });
  }

  // History / total 超 → 摘要(最贵);headroom < -1500 真正触发(原 -2000,裕量收紧后同步调低),让 cold tools 先动
  if ((layers.history.overBudget || totalOver) && headroom < -1500) {
    actions.push({ kind: 'compact_history' });
  }

  // 排序(同 kind 已在上面排好):warn → cold L1→L2→L3 → cap_hot → compact_history
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
