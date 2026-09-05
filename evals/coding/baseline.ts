import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createReport } from './report.js';
import type {
  BenchmarkBaseline,
  BenchmarkDifficulty,
  BenchmarkGroup,
  BenchmarkReport,
  BenchmarkTaskResult,
  BenchmarkThresholds,
  RecordedBaseline,
} from './types.js';

export const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  maxPassedTaskDrop: 0,
  maxFirstPatchPassRateDrop: 0,
  maxToolRecoveryRateDrop: 0,
  maxRegressionRateIncrease: 0,
};

export interface BaselineComparisonIssue {
  metric: 'schema' | 'suite' | 'model' | 'prompt' | 'passed' | 'firstPatchPass' | 'toolRecovery' | 'regression';
  message: string;
}

export interface BaselineComparison {
  status: 'not-recorded' | 'passed' | 'failed';
  issues: BaselineComparisonIssue[];
}

export interface BenchmarkRunIdentity {
  schemaVersion: 3;
  model: string;
  promptHash: string;
  taskIds: readonly string[];
}

const GROUPS = new Set<BenchmarkGroup>([
  'single-file',
  'multi-file',
  'types',
  'tests',
  'resilience',
  'context',
  'monorepo',
  'no-tests',
]);
const DIFFICULTIES = new Set<BenchmarkDifficulty>(['basic', 'hard', 'advanced']);
const STATUSES = new Set<BenchmarkTaskResult['status']>(['passed', 'failed', 'timeout', 'aborted', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid benchmark baseline: ${field} must be a string`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid benchmark baseline: ${field} must be a boolean`);
  return value;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid benchmark baseline: ${field} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = finiteNonNegative(value, field);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid benchmark baseline: ${field} must be an integer`);
  return parsed;
}

function rate(value: unknown, field: string): number {
  const parsed = finiteNonNegative(value, field);
  if (parsed > 1) throw new Error(`Invalid benchmark baseline: ${field} must be between 0 and 1`);
  return parsed;
}

function parseThresholds(value: unknown): BenchmarkThresholds {
  if (!isRecord(value)) throw new Error('Invalid benchmark baseline: thresholds must be an object');
  return {
    maxPassedTaskDrop: finiteNonNegative(value.maxPassedTaskDrop, 'thresholds.maxPassedTaskDrop'),
    maxFirstPatchPassRateDrop: rate(value.maxFirstPatchPassRateDrop, 'thresholds.maxFirstPatchPassRateDrop'),
    maxToolRecoveryRateDrop: rate(value.maxToolRecoveryRateDrop, 'thresholds.maxToolRecoveryRateDrop'),
    maxRegressionRateIncrease: rate(value.maxRegressionRateIncrease, 'thresholds.maxRegressionRateIncrease'),
  };
}

function parseTask(value: unknown, index: number): BenchmarkTaskResult {
  const prefix = `report.tasks[${index}]`;
  if (!isRecord(value)) throw new Error(`Invalid benchmark baseline: ${prefix} must be an object`);
  const group = requiredString(value.group, `${prefix}.group`) as BenchmarkGroup;
  const difficulty = requiredString(value.difficulty, `${prefix}.difficulty`) as BenchmarkDifficulty;
  const status = requiredString(value.status, `${prefix}.status`) as BenchmarkTaskResult['status'];
  if (!GROUPS.has(group)) throw new Error(`Invalid benchmark baseline: ${prefix}.group is unknown`);
  if (!DIFFICULTIES.has(difficulty)) throw new Error(`Invalid benchmark baseline: ${prefix}.difficulty is unknown`);
  if (!STATUSES.has(status)) throw new Error(`Invalid benchmark baseline: ${prefix}.status is unknown`);

  const finalVerifiedSuccess = requiredBoolean(value.finalVerifiedSuccess, `${prefix}.finalVerifiedSuccess`);
  if ((status === 'passed') !== finalVerifiedSuccess) {
    throw new Error(`Invalid benchmark baseline: ${prefix}.status contradicts finalVerifiedSuccess`);
  }
  const toolCalls = nonNegativeInteger(value.toolCalls, `${prefix}.toolCalls`);
  const toolRecoveryAttempts = nonNegativeInteger(value.toolRecoveryAttempts, `${prefix}.toolRecoveryAttempts`);
  const toolRecoveries = nonNegativeInteger(value.toolRecoveries, `${prefix}.toolRecoveries`);
  if (toolRecoveryAttempts > toolCalls) {
    throw new Error(`Invalid benchmark baseline: ${prefix}.toolRecoveryAttempts exceeds toolCalls`);
  }
  if (toolRecoveries > toolRecoveryAttempts) {
    throw new Error(`Invalid benchmark baseline: ${prefix}.toolRecoveries exceeds attempts`);
  }
  const toolRecovery = requiredBoolean(value.toolRecovery, `${prefix}.toolRecovery`);
  if (toolRecovery !== toolRecoveries > 0) {
    throw new Error(`Invalid benchmark baseline: ${prefix}.toolRecovery contradicts toolRecoveries`);
  }
  if (!Array.isArray(value.changedFiles) || !value.changedFiles.every((file) => typeof file === 'string')) {
    throw new Error(`Invalid benchmark baseline: ${prefix}.changedFiles must be a string array`);
  }
  if (value.tokens !== null) finiteNonNegative(value.tokens, `${prefix}.tokens`);
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error(`Invalid benchmark baseline: ${prefix}.error must be a string`);
  }
  if (value.retries !== undefined) nonNegativeInteger(value.retries, `${prefix}.retries`);
  if (value.firstSuccessRate !== undefined) rate(value.firstSuccessRate, `${prefix}.firstSuccessRate`);

  return {
    id: requiredString(value.id, `${prefix}.id`),
    title: requiredString(value.title, `${prefix}.title`),
    group,
    difficulty,
    status,
    finalVerifiedSuccess,
    firstPatchPass: requiredBoolean(value.firstPatchPass, `${prefix}.firstPatchPass`),
    regression: requiredBoolean(value.regression, `${prefix}.regression`),
    toolRecovery,
    toolRecoveryAttempts,
    toolRecoveries,
    toolCalls,
    ...(value.retries === undefined ? {} : { retries: value.retries as number }),
    ...(value.firstSuccessRate === undefined ? {} : { firstSuccessRate: value.firstSuccessRate as number }),
    tokens: value.tokens === null ? null : (value.tokens as number),
    durationMs: finiteNonNegative(value.durationMs, `${prefix}.durationMs`),
    changedFiles: [...value.changedFiles],
    ...(value.error === undefined ? {} : { error: value.error }),
    askHumanCount: finiteNonNegative(value.askHumanCount, `${prefix}.askHumanCount`),
  };
}

function parseReport(value: unknown): BenchmarkReport {
  if (!isRecord(value) || value.schemaVersion !== 3 || !isRecord(value.summary) || !Array.isArray(value.tasks)) {
    throw new Error('Invalid benchmark baseline: report must use schemaVersion 3');
  }
  const selection = requiredString(value.selection, 'report.selection');
  if (selection !== 'all') throw new Error('Invalid benchmark baseline: recorded report selection must be "all"');
  const tasks = value.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error('Invalid benchmark baseline: report task IDs must be unique');
  }
  const meta = {
    schemaVersion: 3 as const,
    runId: requiredString(value.runId, 'report.runId'),
    generatedAt: requiredString(value.generatedAt, 'report.generatedAt'),
    model: requiredString(value.model, 'report.model'),
    promptHash: requiredString(value.promptHash, 'report.promptHash'),
    selection,
  };
  const normalized = createReport(meta, tasks);
  for (const [field, expected] of Object.entries(normalized.summary)) {
    if (value.summary[field] !== expected) {
      throw new Error(`Invalid benchmark baseline: report.summary.${field} contradicts task results`);
    }
  }
  return normalized;
}

export function parseBenchmarkBaseline(value: unknown): BenchmarkBaseline {
  if (!isRecord(value) || value.schemaVersion !== 3) {
    throw new Error('Invalid benchmark baseline: schemaVersion 3 is required');
  }
  const suiteSize = nonNegativeInteger(value.suiteSize, 'suiteSize');
  if (value.status === 'not-recorded') {
    return {
      schemaVersion: 3,
      status: 'not-recorded',
      suiteSize,
      description: requiredString(value.description, 'description'),
    };
  }
  if (value.status !== 'recorded') throw new Error('Invalid benchmark baseline: unknown status');
  const report = parseReport(value.report);
  if (report.tasks.length !== suiteSize) {
    throw new Error('Invalid benchmark baseline: suiteSize does not match the recorded report');
  }
  return {
    schemaVersion: 3,
    status: 'recorded',
    suiteSize,
    thresholds: parseThresholds(value.thresholds),
    report,
  };
}

export function readBenchmarkBaseline(file: string): BenchmarkBaseline {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to read benchmark baseline ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseBenchmarkBaseline(value);
}

export function createRecordedBaseline(
  report: BenchmarkReport,
  thresholds: BenchmarkThresholds = DEFAULT_BENCHMARK_THRESHOLDS,
): RecordedBaseline {
  const normalizedReport = parseReport(report);
  return {
    schemaVersion: 3,
    status: 'recorded',
    suiteSize: normalizedReport.tasks.length,
    thresholds: parseThresholds(thresholds),
    report: normalizedReport,
  };
}

export function writeBenchmarkBaseline(file: string, baseline: BenchmarkBaseline): void {
  const normalized = parseBenchmarkBaseline(baseline);
  const target = path.resolve(file);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sortedTaskIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

export function compareBenchmarkPreflight(
  identity: BenchmarkRunIdentity,
  baseline: BenchmarkBaseline,
): BaselineComparison {
  const issues: BaselineComparisonIssue[] = [];
  const actualIds = sortedTaskIds(identity.taskIds);
  if (actualIds.length !== baseline.suiteSize || new Set(actualIds).size !== actualIds.length) {
    issues.push({ metric: 'suite', message: 'current task set size or uniqueness differs from the baseline' });
  }
  if (baseline.status === 'recorded') {
    const expected = baseline.report;
    if (identity.schemaVersion !== expected.schemaVersion) {
      issues.push({
        metric: 'schema',
        message: `schema changed: ${expected.schemaVersion} -> ${identity.schemaVersion}`,
      });
    }
    if (JSON.stringify(actualIds) !== JSON.stringify(sortedTaskIds(expected.tasks.map((task) => task.id)))) {
      issues.push({ metric: 'suite', message: 'task IDs differ from the recorded baseline' });
    }
    if (identity.model !== expected.model) {
      issues.push({ metric: 'model', message: `model changed: ${expected.model} -> ${identity.model}` });
    }
    if (identity.promptHash !== expected.promptHash) {
      issues.push({
        metric: 'prompt',
        message: `prompt hash changed: ${expected.promptHash} -> ${identity.promptHash}`,
      });
    }
  }
  return {
    status: issues.length ? 'failed' : baseline.status === 'recorded' ? 'passed' : 'not-recorded',
    issues,
  };
}

function deltaExceeded(delta: number, allowed: number): boolean {
  return delta > allowed + Number.EPSILON;
}

export function compareBenchmarkReport(report: BenchmarkReport, baseline: BenchmarkBaseline): BaselineComparison {
  const preflight = compareBenchmarkPreflight(
    {
      schemaVersion: report.schemaVersion,
      model: report.model,
      promptHash: report.promptHash,
      taskIds: report.tasks.map((task) => task.id),
    },
    baseline,
  );
  if (preflight.status !== 'passed') return preflight;
  if (baseline.status !== 'recorded') return { status: 'not-recorded', issues: [] };

  const issues: BaselineComparisonIssue[] = [];
  const expected = baseline.report;
  const thresholds = baseline.thresholds;
  const passedDrop = expected.summary.passed - report.summary.passed;
  if (deltaExceeded(passedDrop, thresholds.maxPassedTaskDrop)) {
    issues.push({
      metric: 'passed',
      message: `passed tasks dropped by ${passedDrop} (allowed ${thresholds.maxPassedTaskDrop})`,
    });
  }
  const firstPatchDrop = expected.summary.firstPatchPassRate - report.summary.firstPatchPassRate;
  if (deltaExceeded(firstPatchDrop, thresholds.maxFirstPatchPassRateDrop)) {
    issues.push({
      metric: 'firstPatchPass',
      message: `first-patch pass rate dropped by ${firstPatchDrop.toFixed(4)} (allowed ${thresholds.maxFirstPatchPassRateDrop})`,
    });
  }
  if (expected.summary.toolRecoveryRate !== null && report.summary.toolRecoveryRate !== null) {
    const recoveryDrop = expected.summary.toolRecoveryRate - report.summary.toolRecoveryRate;
    if (deltaExceeded(recoveryDrop, thresholds.maxToolRecoveryRateDrop)) {
      issues.push({
        metric: 'toolRecovery',
        message: `tool-recovery rate dropped by ${recoveryDrop.toFixed(4)} (allowed ${thresholds.maxToolRecoveryRateDrop})`,
      });
    }
  }
  const regressionIncrease = report.summary.regressionRate - expected.summary.regressionRate;
  if (deltaExceeded(regressionIncrease, thresholds.maxRegressionRateIncrease)) {
    issues.push({
      metric: 'regression',
      message: `regression rate increased by ${regressionIncrease.toFixed(4)} (allowed ${thresholds.maxRegressionRateIncrease})`,
    });
  }
  return { status: issues.length ? 'failed' : 'passed', issues };
}

export function renderBaselineComparison(comparison: BaselineComparison): string {
  if (comparison.status === 'not-recorded') return 'Baseline: not recorded; no regression gate was applied.';
  if (comparison.status === 'passed') return 'Baseline: passed (no configured quality regression).';
  return ['Baseline: failed', ...comparison.issues.map((issue) => `- ${issue.metric}: ${issue.message}`)].join('\n');
}
