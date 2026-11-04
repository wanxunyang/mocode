// Context Budget accounting and the shared pressure threshold.
//
// This module only estimates and reports. session/scheduler.ts owns the sole
// automatic rewrite sequence and starts all pressure cleanup plus compact_history
// when corrected or raw request occupancy reaches 80%.
//
// 产出只有四个标量:total / rawTotal / window / hotBoundary(外加 systemCosts 拆分)。
// 曾经这里还有一套「五区分账」(system/history/toolRecent/toolOld/summary/reserve 各自的
// ratio 与 overBudget/overRatio),但它的全部产物只流向一个无人调用的 formatReport(),
// 调度器从头到尾只看总阈值 —— 留着会让后来的人以为改 ratios 能改变压缩行为,实际零影响。
// 2026-11 已删除,避免误判。

import type { ChatMessage, ChatTool } from '../llm/index.js';
import { chatTools, estimateToolSchemaTokens, messageTokens } from '../llm/index.js';
import { toText } from './utils.js';

/** Context Budget Scheduler 的单一策略源。 */
export interface BudgetPolicy {
  hotTurnWindow: number;
  compactKeepRatio: number;
  /** force/手动强压时的保留比例(比自动路径更激进)。 */
  compactForceKeepRatio: number;
  /** 保留区绝对上限(token):防大窗口下按比例保留区仍过大(如 256k×0.15≈38k)。 */
  compactKeepMaxTokens: number;
  /** Context occupancy at which pressure-only history compression may run. */
  pressureTriggerRatio: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  hotTurnWindow: 4,
  // 压缩保留区:自动 15% / 强压 5%,且绝对上限 48k——摘要+最近几轮足够续工,
  // 旧 0.40 在大窗口下导致"160k 压到 100k"的无效压缩。
  compactKeepRatio: 0.15,
  compactForceKeepRatio: 0.05,
  compactKeepMaxTokens: 48000,
  pressureTriggerRatio: 0.8,
};

/** 兼容既有调用方的只读别名；配置只在 DEFAULT_BUDGET_POLICY 中维护。 */
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

/** 一次评估的完整报告(供 agent/core.ts 决策)。 */
export interface SystemCostBreakdown {
  /** 校正前的 system prompt token 估算。 */
  prompt: number;
  /** 校正前的本次 active tool schema token 估算。 */
  toolSchemas: number;
  /**
   * 校正前的「尾部 ephemeral 注入」token 估算(会话状态提醒 / 开场分析 / compact 恢复段)。
   *
   * 为什么必须单独记账:这些段为了不破坏 prompt 缓存,只拼进 agent/core 的 requestHistory
   * 末尾,**不写回 history**(见 core.ts 的 ephemeralReminder)。调度器拿到的 history 里
   * 没有它们,若不显式计入,这部分请求开销对压力线完全不可见——会话笔记单独就可达 5k
   * (NOTES_INJECT_BUDGET_TOKENS),小窗口模型(32k)下约占 17%,压力线会系统性偏低。
   * 它与 system prompt / 工具 schema 同属「每次请求都要付的固定开销」,故并入 system 层。
   */
  ephemeralInjection: number;
}

export interface BudgetReport {
  step: number;
  total: number; // 全部内容之和(已经过 correction 校正)
  /** 裸估算总量(不乘 correction)。硬闸触发线用它判断:correction<1 把调度器视角
   * 压到触发线以下、而 UI 裸估算已超窗时,仍必须触发压缩。 */
  rawTotal: number;
  window: number;
  /** 固定请求开销的校正前拆分(prompt / 工具 schema / 尾部 ephemeral 注入)：既参与
   * total 累加，也用于定位「固定底价被谁吃掉」。 */
  systemCosts: SystemCostBreakdown;
  /** 总占用超总阈(0.80*window,校正后)。 */
  totalOver: boolean;
  /** Hot/Cold 边界:Cold 区 = [1, hotBoundary);Hot 区 = [hotBoundary, length)。
   * agent/core.ts 拿到后可对 Cold 区做就地 stub,Hot 区只 cap。 */
  hotBoundary: number;
  /** 本次评估使用的校正系数(API 实测/估算;1 = 未校准)。 */
  correction: number;
}

/** 评估当前 history 的请求占用(纯函数,改不动 history)。
 * 传入 step 是当前所在 step 编号(agent 循环 step 变量),用于日志/调试。
 * correction:API 实测 / 估算的校正系数(默认 1);>1 表示粗估偏低,乘以系数后 actual 更接近真实值。
 * activeTools 必须与下一次 chat() 实际发送的工具集合一致，避免 plan/子 agent 误算 schema。
 * ephemeralTokens:本次请求会追加、但不在 history 里的尾部注入(会话状态提醒等)的裸 token,
 *   必须传入,否则压力线看不见这部分开销(见 SystemCostBreakdown.ephemeral)。 */
export function evaluateBudget(
  history: ChatMessage[],
  window: number,
  step: number = 0,
  correction: number = 1,
  activeTools: readonly ChatTool[] = chatTools,
  ephemeralTokens: number = 0,
): BudgetReport {
  // 校正后的 token 数:raw * correction,最小 1(raw > 0 时)。
  const adj = (raw: number): number => (raw > 0 ? Math.max(1, Math.round(raw * correction)) : 0);

  // 校正后总量:逐段累加,不再先分桶再求和。
  let total = 0;

  // 裸总量(不乘 correction):硬闸用它判断,防止 correction 折扣否决真实溢出。
  let rawTotal = 0;

  const sysMsg = history[0];
  const safeEphemeral = Number.isFinite(ephemeralTokens) ? Math.max(0, Math.round(ephemeralTokens)) : 0;
  const systemCosts: SystemCostBreakdown = {
    prompt: sysMsg ? msgTokens(sysMsg) : 0,
    toolSchemas: estimateToolSchemaTokens(activeTools),
    ephemeralInjection: safeEphemeral,
  };
  // 工具 schema、system prompt 与尾部 ephemeral 注入同属请求固定开销；
  // 必须计入总量才能可靠触发压缩(尾部注入不在 history 里,只能由调用方传入)。
  const systemRaw = systemCosts.prompt + systemCosts.toolSchemas + systemCosts.ephemeralInjection;
  total += adj(systemRaw);
  rawTotal += systemRaw;

  // Summary 检测:role:'system' 且不是 history[0] 的,视为摘要(compact.ts 摘要插 index 1)。
  // 简单启发:若 history[1]?.role === 'system' 且 content 含「# 会话摘要」特征串,计入 summary。
  // 命中时循环跳过 i=1;不命中时当作普通 message(罕见,落到下方 user/assistant 分支)。
  let summaryHit = false;
  if (history.length > 1 && history[1].role === 'system') {
    const c1 = toText(history[1].content);
    if (c1.startsWith('# 会话摘要') || c1.includes('会话摘要')) {
      const summaryRaw = msgTokens(history[1]);
      total += adj(summaryRaw);
      rawTotal += summaryRaw;
      summaryHit = true;
    }
  }

  // 划 Hot/Cold 边界
  const hotStart = userTurnBoundary(history, HOT_TURN_WINDOW);
  // tool / user / assistant 一并计入总量(冷热区划分只用于决定改写范围,不影响总量)。
  for (let i = 1; i < history.length; i++) {
    const m = history[i];
    if (i === 1 && summaryHit) continue; // summary 已单独算过
    if (m.role === 'system') continue; // 其它 system(几乎不存在)跳过
    const raw = msgTokens(m);
    total += adj(raw);
    rawTotal += raw;
  }

  const totalOver = total >= DEFAULT_BUDGET_POLICY.pressureTriggerRatio * window;

  return {
    step,
    total,
    rawTotal,
    window,
    systemCosts,
    totalOver,
    hotBoundary: hotStart,
    correction,
  };
}

/** 调度器只生成执行层能够真正落地的动作:唯一触发条件是总占用过 80% 压力线。
 * 「某个分区超配额」从来不是独立触发源(那套只喂给已删除的诊断函数),所以这里不存在
 * warn 之类的分层告警动作。要查固定开销构成,读 `BudgetReport.systemCosts`。 */
export type ScheduleAction = {
  kind: 'compact_history';
  focus?: string;
};

/** 根据 BudgetReport 生成可执行动作。
 * History compaction is the final fallback after pressure-only tool stages.
 * 唯一判定条件是总占用(裸估或校正后的较大者)过 80% 压力线。 */
export function scheduleActions(report: BudgetReport): ScheduleAction[] {
  const actions: ScheduleAction[] = [];

  const pressureLine = DEFAULT_BUDGET_POLICY.pressureTriggerRatio * report.window;
  if (Math.max(report.rawTotal, report.total) >= pressureLine) {
    actions.push({ kind: 'compact_history' });
  }

  return actions;
}
