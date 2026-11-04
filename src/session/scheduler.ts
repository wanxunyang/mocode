// Context Budget Scheduler: normal operation is metadata-only. History content is
// rewritten only after real occupancy reaches the shared pressure threshold.

import {
  evaluateBudget,
  scheduleActions,
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
import { clearRetrievableResults } from '../context/clearing.js';
import { createAgeAwareEncodingState } from '../context/age-aware.js';
import { applyImageBudget } from '../context/vision-window.js';
import { ui } from '../ui/theme.js';
import * as layout from '../ui/layout.js';

export interface PressureCompressionLog {
  /** 80% 高压(动 LLM 摘要);60-80% 低压只跑确定性清理。 */
  triggered: boolean;
  /** 60% 低压事件(零 LLM 成本 masking/clearing)。 */
  lowTriggered: boolean;
  before: number;
  after: number;
  superseded: number;
  staleArtifacts: number;
  encodedLogsAndSearches: number;
  /** tool-result clearing 清除的消息数。 */
  cleared: number;
  /** 压力线触发时,摘要之前先剥掉的图片数(只留最新一张)。 */
  imagesRelieved?: number;
}

export interface SchedulerRunLog {
  step: number;
  report: BudgetReport;
  actions: ScheduleAction[];
  pressure: PressureCompressionLog;
  compactHistoryCalled: boolean;
  historyMutation: 'none' | 'content' | 'rebuild';
  /** 断路器已开:压缩压不下去,本 run 后续 step 不再尝试摘要。 */
  breakerOpen?: boolean;
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

function emptyPressure(report: BudgetReport): PressureCompressionLog {
  return {
    triggered: false,
    lowTriggered: false,
    before: report.total,
    after: report.total,
    superseded: 0,
    staleArtifacts: 0,
    encodedLogsAndSearches: 0,
    cleared: 0,
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

  // 断路器:压缩跑完仍站在压力线之上,说明「压不下去」是结构性的(system prompt + 工具 schema
  // 等固定开销本身超线,或存在超大单条)。调度器每个 run 新建一次(等价于一个用户轮),所以
  // 这两个标志天然是 turn 作用域的——与 model-turn.ts 的 overflowCompaction 断路器同口径,
  // 但那边按 turnId 计数是因为它挂在跨轮复用的 runtimeContextState 上,这里不需要。
  // 不设此闸的后果:小窗口模型下每步都会付一次完整摘要(输入上限 0.55×window),并连带让
  // readDedup 全量失效、history 前缀缓存归零,三步损耗叠加。
  let compactStuck = false;
  let compactStuckWarned = false;

  const scheduler: BudgetScheduler = {
    lastRunLog: null,
    async runStep(history, step, activeTools = chatTools, ephemeralTokens = 0, signal?: AbortSignal) {
      // External file changes and mutations only update artifact metadata here.
      refreshArtifactFreshness(state, history);
      let report = evaluate(history, step, activeTools, ephemeralTokens);
      const pressureLine = report.window * DEFAULT_BUDGET_POLICY.pressureTriggerRatio;
      // 图片先行:压力线触发时先剥图(只留最新一张非屏幕帧图)再重估。图按像素计 token、又会随
      // history 每步重发,但摘要只对旧区剥图、保留区的图原样留着 —— 为图压缩既压不掉图又白花一次
      // LLM 调用。剥完低于线就根本不摘要;仍高于线说明文本本身超了,此时摘要才有意义。
      // 屏幕帧(computer-)由 vision-window 管,这里不碰。
      let imagesRelieved = 0;
      if (Math.max(report.rawTotal, report.total) >= pressureLine) {
        const relief = applyImageBudget(history, { maxChars: 1 });
        if (relief.changed) {
          history.splice(0, history.length, ...relief.messages);
          imagesRelieved = relief.evicted;
          report = evaluate(history, step, activeTools, ephemeralTokens);
        }
      }
      const pressure = emptyPressure(report);
      pressure.imagesRelieved = imagesRelieved;
      const occupancy = Math.max(report.rawTotal, report.total);
      pressure.triggered = occupancy >= pressureLine;
      pressure.lowTriggered = !pressure.triggered && occupancy >= report.window * runtime.config.lowPressureRatio;

      if (pressure.triggered) {
        // A single 80% pressure event owns every history rewrite. Run all enabled
        // low-cost cleanup first, then always compact; do not introduce per-stage
        // thresholds or stop early when one stage happens to cross below 80%.
        // 注意:此阶段不跑 tool-clearing——旧区内容马上要喂给摘要器,清掉会把摘要弄瞎。
        if (runtime.config.contextRelprune) {
          pressure.superseded = pruneSuperseded(history, report.hotBoundary);
        }
        pressure.staleArtifacts = pruneStaleArtifacts(state, history, report.hotBoundary);
        if (runtime.config.contextOptimize) {
          const ageAware = createAgeAwareEncodingState(history);
          pressure.encodedLogsAndSearches = ageAware.sweepPressure(history, report.hotBoundary);
        }
        pressure.after = evaluate(history, step, activeTools, ephemeralTokens).total;
      } else if (pressure.lowTriggered) {
        // 60-80% 低压:只做零 LLM 成本的确定性清理(masking/clearing),不摘要、不重建。
        // 可重取结果在此阶段丢弃;热区(最近 4 user turn)不动。各步幂等,占用停留在
        // 低压带时重复执行也很便宜。
        if (runtime.config.contextRelprune) {
          pressure.superseded = pruneSuperseded(history, report.hotBoundary);
        }
        pressure.staleArtifacts = pruneStaleArtifacts(state, history, report.hotBoundary);
        if (runtime.config.toolClearing) {
          pressure.cleared = clearRetrievableResults(history, report.hotBoundary);
        }
        if (runtime.config.contextOptimize) {
          const ageAware = createAgeAwareEncodingState(history);
          pressure.encodedLogsAndSearches = ageAware.sweepPressure(history, report.hotBoundary);
        }
        pressure.after = evaluate(history, step, activeTools, ephemeralTokens).total;
      }

      // Use the trigger report intentionally: cleanup may reduce the current estimate,
      // but crossing 80% commits this step to compacting for maximum token savings.
      // 低压不进 LLM 压缩:actions 仅在 80% 高压时生成。
      const actions = pressure.triggered ? scheduleActions(report) : [];
      let compactHistoryCalled = false;
      let historyRebuilt = false;
      let contentMutated =
        imagesRelieved > 0 ||
        pressure.superseded > 0 ||
        pressure.staleArtifacts > 0 ||
        pressure.encodedLogsAndSearches > 0 ||
        pressure.cleared > 0;
      let skippedByBreaker = false;
      for (const _action of actions) {
        if (compactStuck) {
          skippedByBreaker = true;
          break;
        }
        const result = await maybeCompact(history, report, undefined, state, activeTools, signal, runtime);
        compactHistoryCalled = true;
        historyRebuilt ||= result?.historyRebuilt === true;
        contentMutated ||= result?.compacted === true;
        // 压完仍在线上 → 本 run 不再重试。注意不能只判 summarized:noop-shrunk-too-large /
        // noop-protected 同样是「束手无策」,重复调用只是白跑。
        if (result && result.estimateAfter >= pressureLine) compactStuck = true;
      }
      // 首次压完超阈时 compact.ts 已经打过一行提示;这里只在**真的又触发、却被断路器挡下**
      // 时补一句,说明"别指望再压一次",避免两次提示措辞打架。
      if (skippedByBreaker && !compactStuckWarned) {
        compactStuckWarned = true;
        layout.contentWrite(
          `  ${ui.yellow}●${ui.reset} ${ui.yellow}本回合已停止重复压缩(压不下去是结构性的:固定开销或超大单条超线);建议 /clear 或改用更大窗口的模型。${ui.reset}\n`,
        );
      }

      const log: SchedulerRunLog = {
        step,
        report,
        actions: compactStuck ? [] : actions,
        pressure,
        compactHistoryCalled,
        historyMutation: historyRebuilt ? 'rebuild' : contentMutated ? 'content' : 'none',
        breakerOpen: compactStuck,
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

export { evaluateBudget, scheduleActions };
