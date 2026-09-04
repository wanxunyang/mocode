// Context Budget Scheduler: normal operation is metadata-only. History content is
// rewritten only after real occupancy reaches the shared pressure threshold.

import {
  evaluateBudget,
  scheduleActions,
  formatReport,
  DEFAULT_BUDGET_POLICY,
  type BudgetReport,
  type ScheduleAction,
} from '../context/budget.js';
import { chatTools, type ChatMessage, type ChatTool } from '../llm/index.js';
import { config } from '../config/index.js';
import { maybeCompact, contextState, type ContextState } from './compact.js';
import { pruneStaleArtifacts, refreshArtifactFreshness } from '../context/artifacts.js';
import { pruneSuperseded } from '../context/relevance.js';
import { createAgeAwareEncodingState } from '../context/age-aware.js';

export interface PressureCompressionLog {
  triggered: boolean;
  before: number;
  after: number;
  superseded: number;
  staleArtifacts: number;
  encodedLogsAndSearches: number;
}

export interface SchedulerRunLog {
  step: number;
  report: BudgetReport;
  actions: ScheduleAction[];
  pressure: PressureCompressionLog;
  compactHistoryCalled: boolean;
  ts: number;
}

export interface BudgetScheduler {
  runStep: (
    history: ChatMessage[],
    step: number,
    activeTools?: readonly ChatTool[],
    /** 本步将追加到请求末尾、但不写回 history 的 ephemeral 注入裸 token 数。
     *  agent/core 传入,否则这部分固定开销对压力线不可见(见 budget.ts 的
     *  SystemCostBreakdown.ephemeralInjection)。 */
    ephemeralTokens?: number,
    /** 主 agent 的 abort signal;透传给压缩的 LLM 摘要调用(Ctrl+C 可掐断「压缩中」)。 */
    signal?: AbortSignal,
  ) => Promise<boolean>;
  lastRunLog: SchedulerRunLog | null;
}

export interface CompactHistoryDetail {
  reason:
    | 'microcompact'
    | 'summarize'
    | 'noop-empty'
    | 'noop-protected'
    | 'noop-ml-only'
    | 'noop-shrunk-too-large'
    | 'noop-noold-noop';
  estimateBefore: number;
  estimateAfter: number;
  protectedRatio?: number;
  oldGroupCount?: number;
  focus?: string;
}

function atPressure(report: BudgetReport): boolean {
  return Math.max(report.rawTotal, report.total) >= report.window * DEFAULT_BUDGET_POLICY.pressureTriggerRatio;
}

function emptyPressure(report: BudgetReport): PressureCompressionLog {
  return {
    triggered: false,
    before: report.total,
    after: report.total,
    superseded: 0,
    staleArtifacts: 0,
    encodedLogsAndSearches: 0,
  };
}

/** One scheduler instance is owned by one agent run. */
export function createBudgetScheduler(state: ContextState = contextState): BudgetScheduler {
  const evaluate = (
    history: ChatMessage[],
    step: number,
    activeTools: readonly ChatTool[],
    ephemeralTokens: number,
  ): BudgetReport =>
    evaluateBudget(history, config.contextWindowTokens, step, state.correction, activeTools, ephemeralTokens);

  const scheduler: BudgetScheduler = {
    lastRunLog: null,
    async runStep(history, step, activeTools = chatTools, ephemeralTokens = 0, signal?: AbortSignal) {
      // External file changes and mutations only update artifact metadata here.
      refreshArtifactFreshness(state, history);
      const report = evaluate(history, step, activeTools, ephemeralTokens);
      const pressure = emptyPressure(report);
      pressure.triggered = atPressure(report);

      if (pressure.triggered) {
        // A single 80% pressure event owns every history rewrite. Run all enabled
        // low-cost cleanup first, then always compact; do not introduce per-stage
        // thresholds or stop early when one stage happens to cross below 80%.
        if (config.contextRelprune) {
          pressure.superseded = pruneSuperseded(history, report.hotBoundary);
        }
        pressure.staleArtifacts = pruneStaleArtifacts(state, history, report.hotBoundary);
        if (config.contextOptimize) {
          const ageAware = createAgeAwareEncodingState(history);
          pressure.encodedLogsAndSearches = ageAware.sweepPressure(history, report.hotBoundary);
        }
        pressure.after = evaluate(history, step, activeTools, ephemeralTokens).total;
      }

      // Use the trigger report intentionally: cleanup may reduce the current estimate,
      // but crossing 80% commits this step to compacting for maximum token savings.
      const actions = scheduleActions(report);
      let compactHistoryCalled = false;
      let historyRebuilt = false;
      for (const _action of actions) {
        const result = await maybeCompact(history, report, undefined, state, activeTools, signal);
        compactHistoryCalled = true;
        historyRebuilt ||= result?.historyRebuilt === true;
      }

      const log: SchedulerRunLog = {
        step,
        report,
        actions,
        pressure,
        compactHistoryCalled,
        ts: Date.now(),
      };
      scheduler.lastRunLog = log;
      state.schedulerLog = log;
      return historyRebuilt;
    },
  };
  return scheduler;
}

export async function runScheduler(
  history: ChatMessage[],
  step: number,
  state: ContextState = contextState,
  activeTools: readonly ChatTool[] = chatTools,
): Promise<boolean> {
  return createBudgetScheduler(state).runStep(history, step, activeTools);
}

/** User-requested compaction bypasses automatic pressure gating. */
export async function manualCompact(
  history: ChatMessage[],
  focus?: string,
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<SchedulerRunLog & { compactDetail?: CompactHistoryDetail }> {
  const signal = opts?.signal;
  if (config.contextBudget === false) {
    const result = await import('./compact.js').then(({ compactHistory }) =>
      compactHistory(history, {
        window: config.contextWindowTokens,
        threshold: DEFAULT_BUDGET_POLICY.pressureTriggerRatio,
        focus,
        manual: true,
        force: opts?.force,
        signal,
      }),
    );
    const report = evaluateBudget(history, config.contextWindowTokens, -1, contextState.correction);
    const log: SchedulerRunLog & { compactDetail: CompactHistoryDetail } = {
      step: -1,
      report,
      actions: [{ kind: 'compact_history', focus }],
      pressure: emptyPressure(report),
      compactHistoryCalled: true,
      ts: Date.now(),
      compactDetail: {
        reason: result.reason,
        estimateBefore: result.estimateBefore,
        estimateAfter: result.estimateAfter,
        protectedRatio: result.protectedRatio,
        oldGroupCount: result.oldGroupCount,
        focus,
      },
    };
    contextState.schedulerLog = log;
    return log;
  }

  const report = evaluateBudget(history, config.contextWindowTokens, -1, contextState.correction);
  let actions = scheduleActions(report);
  if (!actions.some((action) => action.kind === 'compact_history')) {
    actions = [...actions, { kind: 'compact_history', focus }];
  } else if (focus) {
    actions = actions.map((action) => (action.kind === 'compact_history' ? { ...action, focus } : action));
  }

  let compactHistoryCalled = false;
  let compactDetail: CompactHistoryDetail | undefined;
  for (const action of actions) {
    if (action.kind !== 'compact_history') continue;
    const result = await maybeCompact(
      history,
      report,
      {
        manual: true,
        force: opts?.force,
        focus: action.focus,
      },
      contextState,
      chatTools,
      signal,
    );
    compactHistoryCalled = true;
    if (result) {
      compactDetail = {
        reason: result.reason,
        estimateBefore: result.estimateBefore,
        estimateAfter: result.estimateAfter,
        protectedRatio: result.protectedRatio,
        oldGroupCount: result.oldGroupCount,
        focus: action.focus,
      };
    }
  }

  const log: SchedulerRunLog & { compactDetail?: CompactHistoryDetail } = {
    step: -1,
    report,
    actions,
    pressure: emptyPressure(report),
    compactHistoryCalled,
    ts: Date.now(),
    compactDetail,
  };
  contextState.schedulerLog = log;
  return log;
}

export { evaluateBudget, scheduleActions, formatReport };
