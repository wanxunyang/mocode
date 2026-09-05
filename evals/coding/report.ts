import { writeFileSync } from 'node:fs';
import type { BenchmarkReport, BenchmarkTaskResult } from './types.js';

const rate = (n: number, d: number): number => (d ? Number((n / d).toFixed(4)) : 0);

export function createReport(
  meta: Omit<BenchmarkReport, 'summary' | 'tasks'>,
  tasks: BenchmarkTaskResult[],
): BenchmarkReport {
  const passed = tasks.filter((task) => task.status === 'passed').length;
  const verified = tasks.filter((task) => task.finalVerifiedSuccess).length;
  const firstPatchPassed = tasks.filter((task) => task.firstPatchPass).length;
  const toolRecoveryAttempts = tasks.reduce((total, task) => total + task.toolRecoveryAttempts, 0);
  const toolRecoveries = tasks.reduce((total, task) => total + task.toolRecoveries, 0);
  const averageAskHuman = tasks.length ? tasks.reduce((n, task) => n + task.askHumanCount, 0) / tasks.length : 0;
  return {
    ...meta,
    summary: {
      tasks: tasks.length,
      passed,
      finalVerifiedSuccessRate: rate(verified, tasks.length),
      firstPatchPassRate: rate(firstPatchPassed, tasks.length),
      regressionRate: rate(tasks.filter((task) => task.regression).length, tasks.length),
      toolRecoveryRate: toolRecoveryAttempts ? rate(toolRecoveries, toolRecoveryAttempts) : null,
      toolRecoveryAttempts,
      toolRecoveries,
      toolCalls: tasks.reduce((n, task) => n + task.toolCalls, 0),
      retries: tasks.reduce((n, task) => n + (task.retries ?? 0), 0),
      firstSuccessRate: tasks.length
        ? tasks.reduce((n, task) => n + (task.firstSuccessRate ?? 1), 0) / tasks.length
        : 0,
      tokens: tasks.reduce((n, task) => n + (task.tokens ?? 0), 0),
      durationMs: tasks.reduce((n, task) => n + task.durationMs, 0),
      askHumanCount: averageAskHuman,
    },
    tasks,
  };
}

export function renderSummary(report: BenchmarkReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const nullablePct = (n: number | null) => (n === null ? 'n/a' : pct(n));
  const num = (n: number) => n.toFixed(2);
  const lines = [
    `# Mocode coding benchmark`,
    '',
    `- Run: ${report.runId}`,
    `- Model: ${report.model}`,
    `- Selection: ${report.selection}`,
    `- Tasks: ${report.summary.passed}/${report.summary.tasks} passed`,
    `- Final verified success: ${pct(report.summary.finalVerifiedSuccessRate)}`,
    `- First-patch pass: ${pct(report.summary.firstPatchPassRate)}`,
    `- Regression: ${pct(report.summary.regressionRate)}`,
    `- Tool recovery: ${nullablePct(report.summary.toolRecoveryRate)} (${report.summary.toolRecoveries}/${report.summary.toolRecoveryAttempts})`,
    `- Tool first-success rate: ${pct(report.summary.firstSuccessRate)}`,
    `- Tool calls / retries / tokens / elapsed: ${report.summary.toolCalls} / ${report.summary.retries} / ${report.summary.tokens} / ${(report.summary.durationMs / 1000).toFixed(1)}s`,
    '',
    `## Quality dimensions (per task average)`,
    `- Ask-human calls: ${num(report.summary.askHumanCount)}`,
    '',
    '| Task | Difficulty | Group | Result | First patch | Recovery | AskH | Calls | Tokens | Time |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.tasks.map(
      (task) =>
        `| ${task.id} | ${task.difficulty} | ${task.group} | ${task.status} | ${task.firstPatchPass ? 'yes' : 'no'} | ${task.toolRecoveries}/${task.toolRecoveryAttempts} | ${task.askHumanCount} | ${task.toolCalls} | ${task.tokens ?? '-'} | ${(task.durationMs / 1000).toFixed(1)}s |`,
    ),
    '',
  ];
  return lines.join('\n');
}

export function writeReport(report: BenchmarkReport, jsonPath: string, markdownPath: string): void {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderSummary(report), 'utf8');
}
