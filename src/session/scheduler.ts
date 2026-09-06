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
import {
  defaultCompactionRuntime,
  maybeCompact,
  contextState,
  type CompactionRuntime,
  type ContextState,
} from './compact.js';
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
  historyMutation: 'none' | 'content' | 'rebuild';
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
export function createBudgetScheduler(
  state: ContextState = contextState,
  runtime: CompactionRuntime = defaultCompactionRuntime,
): BudgetScheduler {
  const evaluate = (
    history: ChatMessage[],
    step: number,
    activeTools: readonly ChatTool[],
    ephemeralTokens: number,
  ): BudgetReport =>
    evaluateBudget(history, runtime.config.contextWindowTokens, step, state.correction, activeTools, ephemeralTokens);

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
        if (runtime.config.contextRelprune) {
          pressure.superseded = pruneSuperseded(history, report.hotBoundary);
        }
        pressure.staleArtifacts = pruneStaleArtifacts(state, history, report.hotBoundary);
        if (runtime.config.contextOptimize) {
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
      let contentMutated =
        pressure.superseded > 0 || pressure.staleArtifacts > 0 || pressure.encodedLogsAndSearches > 0;
      for (const _action of actions) {
        const result = await maybeCompact(history, report, undefined, state, activeTools, signal, runtime);
        compactHistoryCalled = true;
        historyRebuilt ||= result?.historyRebuilt === true;
        contentMutated ||= result?.compacted === true;
      }

      const log: SchedulerRunLog = {
        step,
        report,
        actions,
        pressure,
        compactHistoryCalled,
        historyMutation: historyRebuilt ? 'rebuild' : contentMutated ? 'content' : 'none',
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
  runtime: CompactionRuntime = defaultCompactionRuntime,
): Promise<boolean> {
  return createBudgetScheduler(state, runtime).runStep(history, step, activeTools);
}

/** User-requested compaction bypasses automatic pressure gating. */
export async function manualCompact(
  history: ChatMessage[],
  focus?: string,
  opts?: {
    force?: boolean;
    signal?: AbortSignal;
    contextState?: ContextState;
    activeTools?: readonly ChatTool[];
    runtime?: CompactionRuntime;
  },
): Promise<SchedulerRunLog & { compactDetail?: CompactHistoryDetail }> {
  const signal = opts?.signal;
  const runtime = opts?.runtime ?? defaultCompactionRuntime;
  const state = opts?.contextState ?? contextState;
  const activeTools = opts?.activeTools ?? chatTools;
  if (runtime.config.contextBudget === false) {
    const result = await import('./compact.js').then(({ compactHistory }) =>
      compactHistory(history, {
        window: runtime.config.contextWindowTokens,
        threshold: DEFAULT_BUDGET_POLICY.pressureTriggerRatio,
        focus,
        manual: true,
        force: opts?.force,
        tools: activeTools,
        contextState: state,
        runtime,
        signal,
      }),
    );
    const report = evaluateBudget(history, runtime.config.contextWindowTokens, -1, state.correction, activeTools);
    const log: SchedulerRunLog & { compactDetail: CompactHistoryDetail } = {
      step: -1,
      report,
      actions: [{ kind: 'compact_history', focus }],
      pressure: emptyPressure(report),
      compactHistoryCalled: true,
      historyMutation: result.historyRebuilt ? 'rebuild' : result.compacted ? 'content' : 'none',
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
    state.schedulerLog = log;
    return log;
  }

  const report = evaluateBudget(history, runtime.config.contextWindowTokens, -1, state.correction, activeTools);
  let actions = scheduleActions(report);
  if (!actions.some((action) => action.kind === 'compact_history')) {
    actions = [...actions, { kind: 'compact_history', focus }];
  } else if (focus) {
    actions = actions.map((action) => (action.kind === 'compact_history' ? { ...action, focus } : action));
  }

  let compactHistoryCalled = false;
  let historyMutation: SchedulerRunLog['historyMutation'] = 'none';
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
      state,
      activeTools,
      signal,
      runtime,
    );
    compactHistoryCalled = true;
    if (result) {
      historyMutation = result.historyRebuilt ? 'rebuild' : result.compacted ? 'content' : historyMutation;
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
    historyMutation,
    ts: Date.now(),
    compactDetail,
  };
  state.schedulerLog = log;
  return log;
}

export { evaluateBudget, scheduleActions, formatReport };
