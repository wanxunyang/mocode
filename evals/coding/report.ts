import { writeFileSync } from 'node:fs';
import type { BenchmarkReport, BenchmarkTaskResult } from './types.js';

const rate = (n: number, d: number): number => d ? Number((n / d).toFixed(4)) : 0;

export function createReport(meta: Omit<BenchmarkReport, 'summary' | 'tasks'>, tasks: BenchmarkTaskResult[]): BenchmarkReport {
  const passed = tasks.filter(t => t.status === 'passed').length;
  const verified = tasks.filter(t => t.finalVerifiedSuccess).length;
  const recovered = tasks.filter(t => t.toolRecovery).length;
  return {
    ...meta,
    summary: {
      tasks: tasks.length,
      passed,
      finalVerifiedSuccessRate: rate(verified, tasks.length),
      firstPatchPassRate: rate(tasks.filter(t => t.firstPatchPass).length, tasks.length),
      regressionRate: rate(tasks.filter(t => t.regression).length, tasks.length),
      toolRecoveryRate: rate(recovered, tasks.length),
      unverifiedCompletionRate: rate(tasks.filter(t => t.unverifiedCompletion).length, tasks.length),
      toolCalls: tasks.reduce((n, t) => n + t.toolCalls, 0),
      tokens: tasks.reduce((n, t) => n + (t.tokens ?? 0), 0),
      durationMs: tasks.reduce((n, t) => n + t.durationMs, 0),
    },
    tasks,
  };
}

export function renderSummary(r: BenchmarkReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `# Mocode coding benchmark`, '',
    `- Run: ${r.runId}`,
    `- Model: ${r.model}`,
    `- Selection: ${r.selection}`,
    `- Tasks: ${r.summary.passed}/${r.summary.tasks} passed`,
    `- Final verified success: ${pct(r.summary.finalVerifiedSuccessRate)}`,
    `- First-patch pass: ${pct(r.summary.firstPatchPassRate)}`,
    `- Regression: ${pct(r.summary.regressionRate)}`,
    `- Tool recovery: ${pct(r.summary.toolRecoveryRate)}`,
    `- Unverified completion: ${pct(r.summary.unverifiedCompletionRate)}`,
    `- Tool calls / tokens / elapsed: ${r.summary.toolCalls} / ${r.summary.tokens} / ${(r.summary.durationMs / 1000).toFixed(1)}s`,
    '',
    '| Task | Difficulty | Group | Result | First patch | Recovery | Calls | Tokens | Time |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...r.tasks.map(t => `| ${t.id} | ${t.difficulty} | ${t.group} | ${t.status} | ${t.firstPatchPass ? 'yes' : 'no'} | ${t.toolRecovery ? 'yes' : 'no'} | ${t.toolCalls} | ${t.tokens ?? '-'} | ${(t.durationMs / 1000).toFixed(1)}s |`),
    '',
  ];
  return lines.join('\n');
}

export function writeReport(report: BenchmarkReport, jsonPath: string, markdownPath: string): void {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderSummary(report), 'utf8');
}
