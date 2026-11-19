import { writeFileSync } from 'node:fs';
import type { ShortPathReport, ShortPathScenarioSummary, ShortPathTaskResult } from './types.js';

const rate = (n: number, d: number): number => (d ? Number((n / d).toFixed(4)) : 0);
const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (n: number): number => Number(n.toFixed(2));
const seconds = (n: number): string => `${(n / 1000).toFixed(2)}s`;

function renderPathMetrics(tasks: ShortPathTaskResult[]): string[] {
  if (!tasks.some((task) => task.efficiency.phases)) return [];
  const passed = tasks.filter((task) => task.status === 'passed');
  const measured = passed.flatMap((task) => task.efficiency.phases ?? []);
  const elapsed = passed.flatMap((task) => task.endToEndDurationMs ?? []).sort((a, b) => a - b);
  const warmup = passed.flatMap((task) => task.warmupDurationMs ?? []);
  const scored = passed.flatMap(({ warmupDurationMs, endToEndDurationMs }) =>
    warmupDurationMs !== undefined && endToEndDurationMs !== undefined ? [endToEndDurationMs - warmupDurationMs] : [],
  );
  const route = measured.flatMap((phase) => phase.routeDurationMs ?? []);
  const uncached = measured.flatMap((phase) => phase.uncachedPromptTokens ?? []);
  const automatic = tasks.filter((task) => task.efficiency.phases?.completion === 'automatic').length;
  const fallbacks = new Map<string, number>();
  for (const task of tasks) {
    const reason = task.efficiency.phases?.fallbackReason;
    if (reason) fallbacks.set(reason, (fallbacks.get(reason) ?? 0) + 1);
  }
  const p = (q: number): string => seconds(elapsed[Math.ceil(elapsed.length * q) - 1]);
  return [
    ...(measured.length
      ? [
          `- Passed tasks: mean model requests ${round(mean(passed.map((task) => task.efficiency.modelRequests)))}; attempts ${round(mean(measured.map((phase) => phase.modelAttempts)))}; model time ${seconds(mean(measured.map((phase) => phase.modelDurationMs)))}`,
          `- Mean final model requests / time: ${round(mean(measured.map((phase) => phase.finalModelRequests)))} / ${seconds(mean(measured.map((phase) => phase.finalModelDurationMs)))}`,
          `- Mean post-edit shell calls / time: ${round(mean(measured.map((phase) => phase.postEditCommands)))} / ${seconds(mean(measured.map((phase) => phase.postEditCommandDurationMs)))}`,
        ]
      : []),
    ...(elapsed.length ? [`- Passed tasks end-to-end P50/P95: ${p(0.5)} / ${p(0.95)} (n=${elapsed.length})`] : []),
    ...(scored.length
      ? [`- Mean warm-up / scored turn including routing: ${seconds(mean(warmup))} / ${seconds(mean(scored))}`]
      : []),
    ...(route.length ? [`- Mean pre-route time: ${seconds(mean(route))} (n=${route.length})`] : []),
    ...(uncached.length
      ? [`- Mean uncached input tokens: ${Math.round(mean(uncached))} (n=${uncached.length}/${passed.length})`]
      : []),
    `- Automatic completion: ${automatic}; fallbacks: ${[...fallbacks.values()].reduce((sum, count) => sum + count, 0)}${fallbacks.size ? ` (${[...fallbacks].map(([reason, count]) => `${reason}=${count}`).join(', ')})` : ''}`,
  ];
}

/** 按复杂度等级小计;level 0(未知/旧数据)不单独成行。 */
function levelRows(tasks: ShortPathTaskResult[]): string[] {
  const groups = new Map<number, ShortPathTaskResult[]>();
  for (const task of tasks) {
    if (task.level === 0) continue;
    const bucket = groups.get(task.level) ?? [];
    bucket.push(task);
    groups.set(task.level, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, bucket]) => {
      const passed = bucket.filter((task) => task.status === 'passed').length;
      return `| L${level} | ${bucket.length} | ${passed} | ${round(mean(bucket.map((task) => task.efficiency.toolCalls)))} | ${round(mean(bucket.map((task) => task.pathRatio)))}x |`;
    });
}

/** 首改前请求均值只统计确实发生过 mutation 的任务;无 mutation(失败/未改)任务不计入分母。 */
export function createScenarioSummary(
  scenario: ShortPathScenarioSummary['scenario'],
  tasks: ShortPathTaskResult[],
): ShortPathScenarioSummary {
  const passed = tasks.filter((task) => task.status === 'passed').length;
  const verified = tasks.filter((task) => task.finalVerifiedSuccess).length;
  const firstEditRequests = tasks
    .map((task) => task.efficiency.requestsBeforeFirstEdit)
    .filter((value): value is number => value !== null);
  return {
    scenario,
    tasks: tasks.length,
    passed,
    verifiedRate: rate(verified, tasks.length),
    meanToolCalls: round(mean(tasks.map((task) => task.efficiency.toolCalls))),
    meanPathRatio: round(mean(tasks.map((task) => task.pathRatio))),
    meanRequestsBeforeFirstEdit: round(mean(firstEditRequests)),
    totalRepeatedIdenticalReadOnlyCalls: tasks.reduce(
      (total, task) => total + task.efficiency.repeatedIdenticalReadOnlyCalls,
      0,
    ),
    meanPostEditReadOnlyCalls: round(mean(tasks.map((task) => task.efficiency.postEditReadOnlyCalls))),
    meanPromptTokens: Math.round(mean(tasks.map((task) => task.promptTokens ?? 0))),
    meanCompletionTokens: Math.round(mean(tasks.map((task) => task.completionTokens ?? 0))),
    meanDurationMs: Math.round(mean(tasks.map((task) => task.durationMs))),
  };
}

export function createReport(
  meta: Omit<ShortPathReport, 'summary' | 'tasks'>,
  tasks: ShortPathTaskResult[],
): ShortPathReport {
  return { ...meta, summary: createScenarioSummary(meta.scenario, tasks), tasks };
}

export function renderSummary(report: ShortPathReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `# MoCode short-path efficiency benchmark (${report.scenario})`,
    '',
    `- Run: ${report.runId}`,
    `- Model: ${report.model}`,
    `- Selection: ${report.selection}`,
    `- Tasks: ${report.summary.passed}/${report.summary.tasks} passed (verified ${pct(report.summary.verifiedRate)})`,
    ...(report.experiment
      ? [
          `- Fixture hash: ${report.experiment.fixtureHash}; effort: ${report.experiment.reasoningEffort}; routing: ${report.experiment.routing}; automatic completion: ${report.experiment.shortPathCompletion ? 'on' : 'off'}`,
        ]
      : []),
    ...renderPathMetrics(report.tasks),
    `- Mean tool calls / path ratio: ${report.summary.meanToolCalls} / ${report.summary.meanPathRatio}x`,
    `- Mean requests before first edit: ${report.summary.meanRequestsBeforeFirstEdit}`,
    `- Repeated identical read-only calls: ${report.summary.totalRepeatedIdenticalReadOnlyCalls}`,
    `- Mean post-edit read-only calls: ${report.summary.meanPostEditReadOnlyCalls}`,
    `- Mean tokens (prompt/completion): ${report.summary.meanPromptTokens} / ${report.summary.meanCompletionTokens}`,
    `- Mean duration: ${(report.summary.meanDurationMs / 1000).toFixed(1)}s`,
    '',
    '| Task | Result | Calls | Gold | Ratio | Pre-edit req | Rep read | Post-edit read | Prompt tok | Time |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.tasks.map(
      (task) =>
        `| ${task.id} | ${task.status} | ${task.efficiency.toolCalls} | ${task.goldMaxToolCalls} | ${task.pathRatio.toFixed(2)}x | ${task.efficiency.requestsBeforeFirstEdit ?? '-'} | ${task.efficiency.repeatedIdenticalReadOnlyCalls} | ${task.efficiency.postEditReadOnlyCalls} | ${task.promptTokens ?? '-'} | ${(task.durationMs / 1000).toFixed(1)}s |`,
    ),
    '',
    `## By complexity level`,
    '| Level | Tasks | Passed | Mean calls | Mean ratio |',
    '|---|---:|---:|---:|---:|',
    ...levelRows(report.tasks),
    '',
  ];
  if (report.tasks.some((task) => task.warmupReadCalls !== null)) {
    lines.push(
      `Warm-up context: ${report.tasks
        .map((task) => `${task.id}=${task.warmupReadCalls ?? '-'} reads${task.warmupMutated ? ' (MUTATED!)' : ''}`)
        .join(', ')}`,
      '',
    );
  }
  return lines.join('\n');
}

export function writeReport(report: ShortPathReport, jsonPath: string, markdownPath: string): void {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderSummary(report), 'utf8');
}
