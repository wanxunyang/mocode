// Context Budget Scheduler(执行层):评估五区预算并执行可落地的动作。
//
//   agent/core.ts (步前)              repl /compact 命令(手动)
//     ↓ runScheduler(history, step)    ↓ manualCompact(history, focus?)
//   session/scheduler.ts(本文件)
//     ├─ evaluateBudget(history, window, step) → BudgetReport
//     ├─ scheduleActions(report) → warn | compact_history
//     └─ 执行 actions:
//          - warn:            仅写日志
//          - compact_history: 调 maybeCompact(history, report)
//
// push-time cap / relevance / lifecycle / age-aware sweep 在进入 scheduler 前独立完成，
// scheduler 不再生成无法执行的 Cold/Hot tool action。每次决策写入 actionLog，供 /context 调试。
// manualCompact 与自动路径共享 scheduleActions，但用户显式触发时强制追加 compact_history。
//
// 开关:
//   - config.contextBudget !== false(默认 true):agent 调 runScheduler
//   - 关时 agent 仍走原 maybeCompact(history)无 report 路径,零行为变化
//   - 手动 /compact 走 manualCompact;关时退化直接调 compactHistory(history, { focus })

import {
  evaluateBudget,
  scheduleActions,
  formatReport,
  type BudgetReport,
  type ScheduleAction,
} from '../context/budget.js';
import { chatTools, type ChatMessage, type ChatTool } from '../llm/index.js';
import { config } from '../config/index.js';
import { maybeCompact, contextState, type ContextState } from './compact.js';
import * as layout from '../ui/layout.js';
import { ui } from '../ui/theme.js';
import { pruneStaleArtifacts, refreshArtifactFreshness } from '../context/artifacts.js';

/** 一次调度的执行日志(供 /context 命令显示与调试)。 */
export interface SchedulerRunLog {
  step: number;
  report: BudgetReport;
  actions: ScheduleAction[];
  /** compact_history 是否实际调用过 maybeCompact。 */
  compactHistoryCalled: boolean;
  ts: number;
}

/** Scheduler 实例状态:压一份最近日志,方便 /context 看到上一次决策。 */
export interface BudgetScheduler {
  /** 执行本步调度；history 被结构性重建时返回 true。 */
  runStep: (
    history: ChatMessage[],
    step: number,
    activeTools?: readonly ChatTool[],
  ) => Promise<boolean>;
  /** 暴露最近一次决策(供 /context)。 */
  lastRunLog: SchedulerRunLog | null;
}

/** compact_history action 的执行明细(供 repl 文案展示"为什么没压")。 */
export interface CompactHistoryDetail {
  reason: 'microcompact' | 'summarize' | 'noop-empty' | 'noop-protected' | 'noop-ml-only' | 'noop-shrunk-too-large' | 'noop-noold-noop';
  estimateBefore: number;
  estimateAfter: number;
  /** 保护区占比 0-1(系统 + 当前轮 / 总 history)。 */
  protectedRatio?: number;
  /** 旧区可压组数。 */
  oldGroupCount?: number;
  /** focus 透传。 */
  focus?: string;
}

/** 创建 runAgentCore 闭包持有的 scheduler(每次 agent 启动一个新实例)。 */
export function createBudgetScheduler(state: ContextState = contextState): BudgetScheduler {
  const obs: BudgetScheduler = {
    lastRunLog: null,
    async runStep(history, step, activeTools = chatTools) {
      // Re-check file-backed hashes first, then discard stale/rebuildable facts before budgeting.
      refreshArtifactFreshness(state, history);
      pruneStaleArtifacts(state, history);
      const report = evaluateBudget(
        history,
        config.contextWindowTokens,
        step,
        state.correction,
        activeTools,
      );
      const actions = scheduleActions(report);
      let compactHistoryCalled = false;
      let historyRebuilt = false;

      for (const a of actions) {
        if (a.kind === 'warn') {
          // system 超:写一行提示(配置漂移应由用户处理,不是调度器压)
          layout.contentWrite(
            `  ${ui.accent}●${ui.reset} ${ui.yellow}调度器警告 [${a.layer}] ${a.reason}${ui.reset}\n`,
          );
        } else if (a.kind === 'compact_history') {
          // 路由到 maybeCompact；把结构重建信号传回 core，使 lifecycle 按新 index 恢复。
          const result = await maybeCompact(history, report, undefined, state, activeTools);
          compactHistoryCalled = true;
          historyRebuilt ||= result?.historyRebuilt === true;
        }
      }

      const log: SchedulerRunLog = {
        step,
        report,
        actions,
        compactHistoryCalled,
        ts: Date.now(),
      };
      obs.lastRunLog = log;
      // 暴露给 /context 共享读(repl / context 命令)
      state.schedulerLog = log;
      return historyRebuilt;
    },
  };
  return obs;
}

/** 便捷:agent/core.ts 不需要每次 createBudgetScheduler,直接 runScheduler(history, step)。 */
export async function runScheduler(
  history: ChatMessage[],
  step: number,
  state: ContextState = contextState,
  activeTools: readonly ChatTool[] = chatTools,
): Promise<boolean> {
  const s = createBudgetScheduler(state);
  return s.runStep(history, step, activeTools);
}

/** 手动 /compact 入口(repl):与自动路径共享预算评估和可执行 action，但强制执行 history 摘要。
 *  即便 layers.history.overBudget=false 或 totalOver=false，manual 仍追加 compact_history，
 * 并把 focus 透传给 LLM 摘要 prompt。
 *
 *  关系:runScheduler 是「自动触发」,manualCompact 是「用户显式触发」,二者共享 scheduleActions。
 *
 *  force=true:即便 oldGroups 空(history 全在保护区)也强行把早期消息降级压一次。
 *  适合"history 太长,自动阈值从未触发,但用户想强制压"的场景。
 *
 *  退化:config.contextBudget === false 时直接调 compactHistory(history, { focus }),与改造前等价。
 *  返回 SchedulerRunLog + compactDetail 字段,供 repl 文案展示"为什么没压"。 */
export async function manualCompact(
  history: ChatMessage[],
  focus?: string,
  opts?: { force?: boolean },
): Promise<SchedulerRunLog & { compactDetail?: CompactHistoryDetail }> {
  if (config.contextBudget === false) {
    // 退化:不经调度器,直压 history(等价于改造前,但带 manual/force 透传)
    const r = await import('./compact.js').then(({ compactHistory }) =>
      compactHistory(history, {
        window: config.contextWindowTokens,
        threshold: config.compactThreshold,
        focus,
        manual: true,
        force: opts?.force,
      }),
    );
    return {
      step: -1,
      report: evaluateBudget(history, config.contextWindowTokens, -1, contextState.correction),
      actions: [{ kind: 'compact_history', focus }],
      compactHistoryCalled: true,
      ts: Date.now(),
      compactDetail: {
        reason: r.reason,
        estimateBefore: r.estimateBefore,
        estimateAfter: r.estimateAfter,
        protectedRatio: r.protectedRatio,
        oldGroupCount: r.oldGroupCount,
        focus,
      },
    };
  }

  const report = evaluateBudget(history, config.contextWindowTokens, -1, contextState.correction);
  let actions = scheduleActions(report);
  // 用户显式说「要压」:即使 report 不含 history 触发,仍追加 compact_history
  const hasCompact = actions.some(a => a.kind === 'compact_history');
  if (!hasCompact) {
    actions = [...actions, { kind: 'compact_history', focus }];
  } else if (focus) {
    // 已有 compact_history(action 由 scheduleActions 产,无 focus)— 注入 focus
    actions = actions.map(a =>
      a.kind === 'compact_history' ? { ...a, focus } : a,
    );
  }

  const s = createBudgetScheduler();
  // 直接驱动 runStep 的执行逻辑(action list 我们已自己生成)
  let compactHistoryCalled = false;
  let compactDetail: CompactHistoryDetail | undefined;
  for (const a of actions) {
    if (a.kind === 'warn') {
      // 复用现有 contentWrite 路径(经 scheduler.runStep);这里略,只记录到 log
    } else if (a.kind === 'compact_history') {
      const r = await maybeCompact(history, report, {
        manual: true,
        force: opts?.force,
        focus: a.focus,
      });
      compactHistoryCalled = true;
      if (r) {
        compactDetail = {
          reason: r.reason,
          estimateBefore: r.estimateBefore,
          estimateAfter: r.estimateAfter,
          protectedRatio: r.protectedRatio,
          oldGroupCount: r.oldGroupCount,
          focus: a.focus,
        };
      }
    }
  }
  const log = {
    step: -1,
    report,
    actions,
    compactHistoryCalled,
    ts: Date.now(),
    compactDetail,
  };
  s.lastRunLog = log;
  contextState.schedulerLog = log;
  return log;
}

// ── 调试导出:用于 scripts/check-budget.ts 把报告打到 stdout 调试 ────────
export { evaluateBudget, scheduleActions, formatReport };
