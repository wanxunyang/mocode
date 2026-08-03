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
import * as layout from '../ui/layout.js';
import { ui } from '../ui/theme.js';
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
  ) => Promise<boolean>;
  lastRunLog: SchedulerRunLog | null;
}

export interface CompactHistoryDetail {
  reason: 'microcompact' | 'summarize' | 'noop-empty' | 'noop-protected' | 'noop-ml-only' | 'noop-shrunk-too-large' | 'noop-noold-noop';
  estimateBefore: number;
  estimateAfter: number;
  protectedRatio?: number;
  oldGroupCount?: number;
  focus?: string;
}

function atPressure(report: BudgetReport): boolean {
  return Math.max(report.rawTotal, report.total)
    >= report.window * DEFAULT_BUDGET_POLICY.pressureTriggerRatio;
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
  const evaluate = (history: ChatMessage[], step: number, activeTools: readonly ChatTool[]): BudgetReport =>
    evaluateBudget(history, config.contextWindowTokens, step, state.correction, activeTools);

  const scheduler: BudgetScheduler = {
    lastRunLog: null,
    async runStep(history, step, activeTools = chatTools) {
      // External file changes and mutations only update artifact metadata here.
      refreshArtifactFreshness(state, history);
      let report = evaluate(history, step, activeTools);
      const pressure = emptyPressure(report);
      pressure.triggered = atPressure(report);

      if (pressure.triggered) {
        // The order is deliberate. Re-evaluate after every stage and stop as soon
        // as the request is below pressure, preserving lower-priority evidence.
        if (config.contextRelprune) {
          pressure.superseded = pruneSuperseded(history, report.hotBoundary);
          report = evaluate(history, step, activeTools);
        }
        if (atPressure(report)) {
          pressure.staleArtifacts = pruneStaleArtifacts(state, history, report.hotBoundary);
          report = evaluate(history, step, activeTools);
        }
        if (atPressure(report) && config.contextOptimize) {
          const ageAware = createAgeAwareEncodingState(history);
          pressure.encodedLogsAndSearches = ageAware.sweepPressure(history, report.hotBoundary);
          report = evaluate(history, step, activeTools);
        }
        pressure.after = report.total;
      }

      const actions = scheduleActions(report);
      let compactHistoryCalled = false;
      let historyRebuilt = false;
      for (const action of actions) {
        if (action.kind === 'warn') {
          layout.contentWrite(
            `  ${ui.accent}●${ui.reset} ${ui.yellow}调度器警告 [${action.layer}] ${action.reason}${ui.reset}\n`,
          );
          continue;
        }
        const result = await maybeCompact(history, report, undefined, state, activeTools);
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
  opts?: { force?: boolean },
): Promise<SchedulerRunLog & { compactDetail?: CompactHistoryDetail }> {
  if (config.contextBudget === false) {
    const result = await import('./compact.js').then(({ compactHistory }) =>
      compactHistory(history, {
        window: config.contextWindowTokens,
        threshold: config.compactThreshold,
        focus,
        manual: true,
        force: opts?.force,
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
    actions = actions.map((action) =>
      action.kind === 'compact_history' ? { ...action, focus } : action,
    );
  }

  let compactHistoryCalled = false;
  let compactDetail: CompactHistoryDetail | undefined;
  for (const action of actions) {
    if (action.kind !== 'compact_history') continue;
    const result = await maybeCompact(history, report, {
      manual: true,
      force: opts?.force,
      focus: action.focus,
    });
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
