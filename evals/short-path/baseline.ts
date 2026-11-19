import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseReasoningEffort } from '../../src/llm/reasoning.js';
import { createScenarioSummary } from './report.js';
import {
  EFFICIENCY_WARN_DELTA,
  type ShortPathEfficiencyBaseline,
  type ShortPathReport,
  type ShortPathScenario,
  type ShortPathTaskResult,
  type ShortPathThresholds,
} from './types.js';

export const DEFAULT_SHORT_PATH_THRESHOLDS: ShortPathThresholds = { maxPassedTaskDrop: 0 };

export type BaselineIssueSeverity = 'warn' | 'block';

export interface ShortPathBaselineIssue {
  metric: string;
  severity: BaselineIssueSeverity;
  message: string;
}

export interface ShortPathBaselineComparison {
  status: 'not-recorded' | 'passed' | 'warned' | 'failed';
  issues: ShortPathBaselineIssue[];
}

export interface ShortPathRunIdentity {
  schemaVersion: 1;
  model: string;
  promptHash: string;
  scenario: ShortPathScenario;
  taskIds: readonly string[];
  experiment?: ShortPathReport['experiment'];
}

export interface UnrecordedShortPathBaseline {
  schemaVersion: 1;
  status: 'not-recorded';
  scenario: ShortPathScenario;
  suiteSize: number;
  description: string;
}

export interface RecordedShortPathBaseline {
  schemaVersion: 1;
  status: 'recorded';
  scenario: ShortPathScenario;
  suiteSize: number;
  thresholds: ShortPathThresholds;
  efficiency: ShortPathEfficiencyBaseline;
  report: ShortPathReport;
}

export type ShortPathBaseline = UnrecordedShortPathBaseline | RecordedShortPathBaseline;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid short-path baseline: ${field} must be a string`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid short-path baseline: ${field} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid short-path baseline: ${field} must be a non-negative finite number`);
  }
  return value;
}

const SCENARIOS = new Set<ShortPathScenario>(['micro', 'hinted', 'warm', 'repo']);

function parseEfficiency(value: unknown): ShortPathEfficiencyBaseline {
  if (!isRecord(value)) throw new Error('Invalid short-path baseline: efficiency must be an object');
  return {
    meanToolCalls: nonNegativeNumber(value.meanToolCalls, 'efficiency.meanToolCalls'),
    meanPathRatio: nonNegativeNumber(value.meanPathRatio, 'efficiency.meanPathRatio'),
    meanRequestsBeforeFirstEdit: nonNegativeNumber(
      value.meanRequestsBeforeFirstEdit,
      'efficiency.meanRequestsBeforeFirstEdit',
    ),
    meanPromptTokens: nonNegativeNumber(value.meanPromptTokens, 'efficiency.meanPromptTokens'),
  };
}

function parseTask(value: unknown, index: number): ShortPathTaskResult {
  const prefix = `report.tasks[${index}]`;
  if (!isRecord(value)) throw new Error(`Invalid short-path baseline: ${prefix} must be an object`);
  const scenario = requiredString(value.scenario, `${prefix}.scenario`) as ShortPathScenario;
  if (!SCENARIOS.has(scenario)) throw new Error(`Invalid short-path baseline: ${prefix}.scenario is unknown`);
  // level 是后加字段:旧基线缺省 0(未知),不拒绝历史文件。
  const level = (
    value.level === undefined ? 0 : nonNegativeInteger(value.level, `${prefix}.level`)
  ) as ShortPathTaskResult['level'];
  const status = requiredString(value.status, `${prefix}.status`) as ShortPathTaskResult['status'];
  if (!['passed', 'failed', 'timeout', 'error'].includes(status)) {
    throw new Error(`Invalid short-path baseline: ${prefix}.status is unknown`);
  }
  if (!isRecord(value.efficiency)) {
    throw new Error(`Invalid short-path baseline: ${prefix}.efficiency must be an object`);
  }
  return {
    id: requiredString(value.id, `${prefix}.id`),
    title: requiredString(value.title, `${prefix}.title`),
    scenario,
    level,
    status: status as ShortPathTaskResult['status'],
    finalVerifiedSuccess: value.finalVerifiedSuccess === true,
    expectedFilesTouched: value.expectedFilesTouched === true,
    verifierUnchanged: value.verifierUnchanged === true,
    warmupMutated: value.warmupMutated === true,
    // efficiency 字段以解析时的归约器 schema 为准;基线只做形状与关键数值校验。
    efficiency: value.efficiency as unknown as ShortPathTaskResult['efficiency'],
    warmupReadCalls:
      value.warmupReadCalls === null ? null : nonNegativeInteger(value.warmupReadCalls, `${prefix}.warmupReadCalls`),
    goldMaxToolCalls: nonNegativeInteger(value.goldMaxToolCalls, `${prefix}.goldMaxToolCalls`),
    pathRatio: nonNegativeNumber(value.pathRatio, `${prefix}.pathRatio`),
    promptTokens:
      value.promptTokens === null || value.promptTokens === undefined
        ? null
        : nonNegativeInteger(value.promptTokens, `${prefix}.promptTokens`),
    completionTokens:
      value.completionTokens === null || value.completionTokens === undefined
        ? null
        : nonNegativeInteger(value.completionTokens, `${prefix}.completionTokens`),
    cachedTokens:
      value.cachedTokens === null || value.cachedTokens === undefined
        ? null
        : nonNegativeInteger(value.cachedTokens, `${prefix}.cachedTokens`),
    durationMs: nonNegativeInteger(value.durationMs, `${prefix}.durationMs`),
    ...(value.endToEndDurationMs === undefined
      ? {}
      : {
          endToEndDurationMs: nonNegativeInteger(value.endToEndDurationMs, `${prefix}.endToEndDurationMs`),
        }),
    ...(value.warmupDurationMs === undefined
      ? {}
      : {
          warmupDurationMs: nonNegativeInteger(value.warmupDurationMs, `${prefix}.warmupDurationMs`),
        }),
    changedFiles: Array.isArray(value.changedFiles) ? [...value.changedFiles].map(String) : [],
    ...(value.error === undefined ? {} : { error: String(value.error) }),
  };
}

function parseExperiment(value: unknown): ShortPathReport['experiment'] {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Invalid short-path baseline: report.experiment must be an object');
  const effort = parseReasoningEffort(value.reasoningEffort);
  const { routing, shortPathCompletion } = value;
  if (
    !effort ||
    (routing !== 'off' && routing !== 'llm' && routing !== 'jev') ||
    typeof shortPathCompletion !== 'boolean'
  ) {
    throw new Error('Invalid short-path baseline: report.experiment settings are invalid');
  }
  return {
    fixtureHash: requiredString(value.fixtureHash, 'report.experiment.fixtureHash'),
    reasoningEffort: effort,
    routing,
    shortPathCompletion,
  };
}

function parseReport(value: unknown): ShortPathReport {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks) || !isRecord(value.summary)) {
    throw new Error('Invalid short-path baseline: report must use schemaVersion 1');
  }
  const scenario = requiredString(value.scenario, 'report.scenario') as ShortPathScenario;
  if (!SCENARIOS.has(scenario)) throw new Error('Invalid short-path baseline: report.scenario is unknown');
  const tasks = value.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error('Invalid short-path baseline: report task IDs must be unique');
  }
  const meta = {
    schemaVersion: 1 as const,
    runId: requiredString(value.runId, 'report.runId'),
    generatedAt: requiredString(value.generatedAt, 'report.generatedAt'),
    model: requiredString(value.model, 'report.model'),
    promptHash: requiredString(value.promptHash, 'report.promptHash'),
    scenario,
    selection: requiredString(value.selection, 'report.selection'),
    experiment: parseExperiment(value.experiment),
  };
  // 用 createScenarioSummary 重算 summary,保证基线里的汇总与任务明细互相一致。
  const summary = createScenarioSummary(scenario, tasks);
  return { ...meta, summary, tasks };
}

export function parseShortPathBaseline(value: unknown): ShortPathBaseline {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Invalid short-path baseline: schemaVersion 1 is required');
  }
  const scenario = requiredString(value.scenario, 'scenario') as ShortPathScenario;
  if (!SCENARIOS.has(scenario)) throw new Error('Invalid short-path baseline: scenario is unknown');
  const suiteSize = nonNegativeInteger(value.suiteSize, 'suiteSize');
  if (value.status === 'not-recorded') {
    return {
      schemaVersion: 1,
      status: 'not-recorded',
      scenario,
      suiteSize,
      description: requiredString(value.description, 'description'),
    };
  }
  if (value.status !== 'recorded') throw new Error('Invalid short-path baseline: unknown status');
  const report = parseReport(value.report);
  if (report.scenario !== scenario) {
    throw new Error('Invalid short-path baseline: report.scenario contradicts baseline.scenario');
  }
  if (report.tasks.length !== suiteSize) {
    throw new Error('Invalid short-path baseline: suiteSize does not match the recorded report');
  }
  const thresholdsValue = isRecord(value.thresholds) ? value.thresholds : {};
  return {
    schemaVersion: 1,
    status: 'recorded',
    scenario,
    suiteSize,
    thresholds: {
      maxPassedTaskDrop: nonNegativeInteger(
        thresholdsValue.maxPassedTaskDrop ?? DEFAULT_SHORT_PATH_THRESHOLDS.maxPassedTaskDrop,
        'thresholds.maxPassedTaskDrop',
      ),
    },
    efficiency: parseEfficiency(value.efficiency),
    report,
  };
}

export function readShortPathBaseline(file: string): ShortPathBaseline {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to read short-path baseline ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseShortPathBaseline(value);
}

export function createRecordedShortPathBaseline(report: ShortPathReport): RecordedShortPathBaseline {
  const normalized = parseReport(report);
  const summary = normalized.summary;
  return {
    schemaVersion: 1,
    status: 'recorded',
    scenario: normalized.scenario,
    suiteSize: normalized.tasks.length,
    thresholds: { ...DEFAULT_SHORT_PATH_THRESHOLDS },
    efficiency: {
      meanToolCalls: summary.meanToolCalls,
      meanPathRatio: summary.meanPathRatio,
      meanRequestsBeforeFirstEdit: summary.meanRequestsBeforeFirstEdit,
      meanPromptTokens: summary.meanPromptTokens,
    },
    report: normalized,
  };
}

export function writeShortPathBaseline(file: string, baseline: ShortPathBaseline): void {
  const normalized = parseShortPathBaseline(baseline);
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

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** 与 coding 基线相同的 preflight 语义:任务集/模型/提示词任一漂移都拒绝比较。 */
export function compareShortPathPreflight(
  identity: ShortPathRunIdentity,
  baseline: ShortPathBaseline,
): ShortPathBaselineComparison {
  const issues: ShortPathBaselineIssue[] = [];
  const actualIds = sortedIds(identity.taskIds);
  if (actualIds.length !== baseline.suiteSize || new Set(actualIds).size !== actualIds.length) {
    issues.push({
      metric: 'suite',
      severity: 'block',
      message: 'task set size or uniqueness differs from the baseline',
    });
  }
  if (baseline.status === 'recorded') {
    const expected = baseline.report;
    if (identity.scenario !== expected.scenario) {
      issues.push({
        metric: 'scenario',
        severity: 'block',
        message: `scenario changed: ${expected.scenario} -> ${identity.scenario}`,
      });
    }
    if (JSON.stringify(actualIds) !== JSON.stringify(sortedIds(expected.tasks.map((task) => task.id)))) {
      issues.push({ metric: 'suite', severity: 'block', message: 'task IDs differ from the recorded baseline' });
    }
    if (identity.model !== expected.model) {
      issues.push({
        metric: 'model',
        severity: 'block',
        message: `model changed: ${expected.model} -> ${identity.model}`,
      });
    }
    if (identity.promptHash !== expected.promptHash) {
      issues.push({
        metric: 'prompt',
        severity: 'block',
        message: `prompt hash changed: ${expected.promptHash} -> ${identity.promptHash}`,
      });
    }
    if (expected.experiment) {
      const actual = identity.experiment;
      if (actual?.fixtureHash !== expected.experiment.fixtureHash) {
        issues.push({
          metric: 'fixtureHash',
          severity: 'block',
          message: 'fixture contents differ from the recorded baseline',
        });
      }
      if (
        actual?.reasoningEffort !== expected.experiment.reasoningEffort ||
        actual?.routing !== expected.experiment.routing
      ) {
        issues.push({
          metric: 'experiment',
          severity: 'block',
          message: 'reasoning effort or routing differs from the recorded baseline',
        });
      }
    }
  }
  const blocking = issues.some((issue) => issue.severity === 'block');
  return {
    status: blocking ? 'failed' : baseline.status === 'recorded' ? 'passed' : 'not-recorded',
    issues,
  };
}

function exceededBy(value: number, baseline: number, delta: number): boolean {
  return value > baseline * (1 + delta) + Number.EPSILON;
}

/**
 * 质量指标(通过数)是硬门禁;效率指标默认只告警——先观察分布,再收紧成阻断。
 * efficiencyGate = true 时效率劣化也计入 block。
 */
export function compareShortPathReport(
  report: ShortPathReport,
  baseline: ShortPathBaseline,
  efficiencyGate = false,
): ShortPathBaselineComparison {
  const preflight = compareShortPathPreflight(
    {
      schemaVersion: report.schemaVersion,
      model: report.model,
      promptHash: report.promptHash,
      scenario: report.scenario,
      taskIds: report.tasks.map((task) => task.id),
      experiment: report.experiment,
    },
    baseline,
  );
  if (preflight.status !== 'passed') return preflight;
  if (baseline.status !== 'recorded') return { status: 'not-recorded', issues: [] };

  const issues: ShortPathBaselineIssue[] = [];
  const expected = baseline.report;
  const passedDrop = expected.summary.passed - report.summary.passed;
  if (passedDrop > baseline.thresholds.maxPassedTaskDrop) {
    issues.push({
      metric: 'passed',
      severity: 'block',
      message: `passed tasks dropped by ${passedDrop} (allowed ${baseline.thresholds.maxPassedTaskDrop})`,
    });
  }

  const efficiency: Array<[string, number, number]> = [
    ['meanToolCalls', report.summary.meanToolCalls, baseline.efficiency.meanToolCalls],
    ['meanPathRatio', report.summary.meanPathRatio, baseline.efficiency.meanPathRatio],
    [
      'meanRequestsBeforeFirstEdit',
      report.summary.meanRequestsBeforeFirstEdit,
      baseline.efficiency.meanRequestsBeforeFirstEdit,
    ],
    ['meanPromptTokens', report.summary.meanPromptTokens, baseline.efficiency.meanPromptTokens],
  ];
  for (const [metric, current, recorded] of efficiency) {
    if (recorded > 0 && exceededBy(current, recorded, EFFICIENCY_WARN_DELTA)) {
      issues.push({
        metric,
        severity: efficiencyGate ? 'block' : 'warn',
        message: `${metric} rose ${current} vs recorded ${recorded} (> +${EFFICIENCY_WARN_DELTA * 100}%)`,
      });
    }
  }

  if (issues.some((issue) => issue.severity === 'block')) return { status: 'failed', issues };
  if (issues.length > 0) return { status: 'warned', issues };
  return { status: 'passed', issues };
}

export function renderShortPathComparison(comparison: ShortPathBaselineComparison): string {
  if (comparison.status === 'not-recorded') return 'Baseline: not recorded; no regression gate was applied.';
  if (comparison.status === 'passed') return 'Baseline: passed (no quality or efficiency regression).';
  const lines = [comparison.status === 'warned' ? 'Baseline: passed with efficiency warnings' : 'Baseline: failed'];
  for (const issue of comparison.issues) lines.push(`- [${issue.severity}] ${issue.metric}: ${issue.message}`);
  return lines.join('\n');
}
