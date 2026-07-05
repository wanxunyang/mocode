// Context Budget Scheduler(执行层):把 scheduleActions() 产生的动作落到既有闸上。
//
// 关系图:
//
//   agent/core.ts (步前)              repl /compact 命令(手动)
//     ↓ runScheduler(history, step)    ↓ manualCompact(history, focus?)
//   session/scheduler.ts(本文件)
//     ├─ evaluateBudget(history, window, step) → BudgetReport
//     │     ↓
//     ├─ scheduleActions(report) → ScheduleAction[]
//     │     ↓
//     └─ 执行 actions:
//          - warn:                  仅写日志
//          - shrink_cold_tools L1:  由 push-time cap.ts(MAX_HISTORY_RESULT)自动处理;此处 no-op
//          - shrink_cold_tools L2:  由 pruner.observePush(relevance.ts)自动处理;此处 no-op
//          - shrink_cold_tools L3:  由 lifecycle.pushTool(lifecycle.ts)自动处理;此处 no-op
//          - cap_hot_tools:         Hot 区只 cap,实际仍由 push-time cap 走;此处 no-op + 记日志
//          - compact_history:       调 maybeCompact(history, report)── report 路由到 ROI 调度
//
// 设计意图:
//   - **L1/L2/L3 不重复实现**——push-time 已经自动跑过这三级。再在调度器做一遍是 Double-Action
//     且破坏「调度器永不抛错 + 幂等」契约。调度器只负责"决策时点",push-time 闸负责"执行"。
//   - **hotBoundary** 仍由调度器算出来供 lifecycle 内部用(将来可演进成「仅 Cold 区跑 age stub」)——
//     现版本先全面暴露给 report,暂不传参给 lifecycle。
//   - **actionLog**:每次执行的决策落进 contextState.schedulerLog,供 /context 命令与调试用。
//   - **manualCompact**:手动入口(用户敲 /compact),与 runScheduler 共享决策路径;唯一差别是
//     即使 history 不超预算也强制产 compact_history(focus 透传)。对齐用户拍板的方案 A。
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
import type { ChatMessage } from '../llm/index.js';
import { config } from '../config/index.js';
import { maybeCompact, contextState } from './compact.js';
import * as layout from '../ui/layout.js';
import { ui } from '../ui/theme.js';

/** 一次调度的执行日志(供 /context 命令显示与调试)。 */
export interface SchedulerRunLog {
  step: number;
  report: BudgetReport;
  actions: ScheduleAction[];
  /** 实际触发的闸('compact_history' 调过 maybeCompact → true;其它已在 push-time 自动跑)。 */
  compactHistoryCalled: boolean;
  ts: number;
}

/** Scheduler 实例状态:压一份最近日志,方便 /context 看到上一次决策。 */
export interface BudgetScheduler {
  observePush: (history: ChatMessage[], idx: number) => void;
  runStep: (history: ChatMessage[], step: number) => Promise<void>;
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

/** 创建 runAgentCore 闭包持有的 scheduler(每次 agent 启动一个新实例)。
 *  observePush 当前只是占位:真正 L1/L2/L3 已由 cap / pruner / lifecycle 在 push 时跑;
 *  保留接口为后续「调度器注入 hotBoundary 给 lifecycle」演进留接缝。 */
export function createBudgetScheduler(): BudgetScheduler {
  const obs: BudgetScheduler = {
    lastRunLog: null,
    observePush(_history, _idx) {
      // 占位:push-time 三闸(cap / pruner / lifecycle)已自动跑;此接缝供将来演进。
    },
    async runStep(history, step) {
      const report = evaluateBudget(history, config.contextWindowTokens, step);
      const actions = scheduleActions(report);
      let compactHistoryCalled = false;

      for (const a of actions) {
        if (a.kind === 'warn') {
          // system 超:写一行提示(配置漂移应由用户处理,不是调度器压)
          layout.contentWrite(
            `  ${ui.yellow}●${ui.reset} ${ui.yellow}调度器警告:${a.layer} ${a.reason}${ui.reset}\n`,
          );
        } else if (a.kind === 'compact_history') {
          // 路由到 maybeCompact(history, report)——按 ROI 调度(只有 history 超 / totalOver 才真压)
          await maybeCompact(history, report);
          compactHistoryCalled = true;
        }
        // shrink_cold_tools L1/L2/L3 与 cap_hot_tools:已由 push-time 闸在每次 push 自动跑
        // (cap = MAX_HISTORY_RESULT;pruner = same-path 新旧替换;lifecycle = age stub)。
        // 调度器不重复,只把决策记录下来供调试。
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
      contextState.schedulerLog = log;
    },
  };
  return obs;
}

/** 便捷:agent/core.ts 不需要每次 createBudgetScheduler,直接 runScheduler(history, step)。 */
export async function runScheduler(history: ChatMessage[], step: number): Promise<void> {
  const s = createBudgetScheduler();
  await s.runStep(history, step);
}

/** 手动 /compact 入口(repl):与自动路径完全一致——五区 ROI 调度,但 history 摘要强制执行。
 *  即便 layers.history.overBudget=false 或 totalOver=false,manual 仍产 compact_history action
 *  把 focus 透传给 LLM 摘要 prompt。其它 ROI 决策(cold tools / cap hot / warn)按 scheduleActions 走。
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
      report: evaluateBudget(history, config.contextWindowTokens, -1),
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

  const report = evaluateBudget(history, config.contextWindowTokens, -1);
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
