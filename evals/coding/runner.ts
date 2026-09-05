import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAgentCore } from '../../src/agent/core.js';
// 装配官方默认工具包:registry 不再顶层 import builtins(破模块循环),eval runner 须显式装配。
import '../../src/tools/builtins/index.js';
import { config } from '../../src/config/index.js';
import { beginTurn, getCurrentTurnMutationState, resetState } from '../../src/rollback/index.js';
import { setSandboxRoot } from '../../src/sandbox/root.js';
import type { AgentTraceEvent } from '../../src/session/trace.js';
import { reduceTraceMetrics } from '../../src/session/trace-metrics.js';
import {
  compareBenchmarkPreflight,
  compareBenchmarkReport,
  createRecordedBaseline,
  readBenchmarkBaseline,
  renderBaselineComparison,
  writeBenchmarkBaseline,
} from './baseline.js';
import { codingTasks, selectTasks } from './fixtures.js';
import { createReport, renderSummary, writeReport } from './report.js';
import type { BenchmarkBaseline, BenchmarkTaskResult, CodingTaskFixture } from './types.js';

const execFileAsync = promisify(execFile);

export interface CliOptions {
  selection: string;
  selectionSource: 'task' | 'group' | null;
  outDir: string;
  baselinePath: string;
  updateBaseline: boolean;
  list: boolean;
  keep: boolean;
  timeoutMs?: number;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseBenchmarkArgs(args: string[]): CliOptions {
  let taskSelection = '';
  let groupSelection = '';
  let outDir = 'evals/results';
  let baselinePath = 'evals/baseline.json';
  let updateBaseline = false;
  let list = false;
  let keep = false;
  let timeoutMs: number | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--task') taskSelection = requiredValue(args, index++, arg);
    else if (arg === '--group') groupSelection = requiredValue(args, index++, arg);
    else if (arg === '--out') outDir = requiredValue(args, index++, arg);
    else if (arg === '--baseline') baselinePath = requiredValue(args, index++, arg);
    else if (arg === '--timeout') {
      const raw = requiredValue(args, index++, arg);
      timeoutMs = Number(raw);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds');
      }
    } else if (arg === '--update-baseline') updateBaseline = true;
    else if (arg === '--list') list = true;
    else if (arg === '--keep-workspaces') keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    selection: taskSelection || groupSelection,
    selectionSource: taskSelection ? 'task' : groupSelection ? 'group' : null,
    outDir: path.resolve(outDir),
    baselinePath: path.resolve(baselinePath),
    updateBaseline,
    list,
    keep,
    timeoutMs,
  };
}

export function validateBenchmarkOptions(options: CliOptions): void {
  if (options.updateBaseline && (options.selectionSource !== 'task' || options.selection !== 'all')) {
    throw new Error('--update-baseline requires --task all');
  }
}

function materialize(root: string, fixture: CodingTaskFixture): void {
  for (const file of fixture.files) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    const content = file.eol === 'crlf' ? file.content.replace(/\r?\n/g, '\r\n') : file.content;
    writeFileSync(target, content, 'utf8');
  }
  writeFileSync(path.join(root, 'package.json'), '{"type":"module","private":true}\n', 'utf8');
}

async function verify(root: string, command: string, timeoutMs = 15_000): Promise<boolean> {
  const [program, ...args] = command.split(' ');
  try {
    await execFileAsync(program, args, { cwd: root, timeout: timeoutMs, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function verifierHash(root: string): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(root, 'verify.mjs')))
      .digest('hex');
  } catch {
    return null;
  }
}

async function evaluateFirstPatch(
  snapshotRoot: string | undefined,
  fixture: CodingTaskFixture,
  originalVerifierHash: string,
): Promise<boolean> {
  if (!snapshotRoot || verifierHash(snapshotRoot) !== originalVerifierHash) return false;
  return verify(snapshotRoot, fixture.verificationCommand);
}

function promptHash(): string {
  return createHash('sha256').update(config.systemPrompt).digest('hex').slice(0, 16);
}

export interface FirstPatchCaptureDependencies {
  createContainer(prefix: string): string;
  copyWorkspace(source: string, target: string): void;
  removeContainer(container: string): void;
}

const defaultFirstPatchCaptureDependencies: FirstPatchCaptureDependencies = {
  createContainer: (prefix) => mkdtempSync(prefix),
  copyWorkspace: (source, target) => cpSync(source, target, { recursive: true }),
  removeContainer: (container) => rmSync(container, { recursive: true, force: true }),
};

export function createFirstPatchCapture(
  workspaceRoot: string,
  fixtureId: string,
  dependencies: FirstPatchCaptureDependencies = defaultFirstPatchCaptureDependencies,
): {
  capture(hasMutations: boolean): void;
  snapshotRoot(): string | undefined;
  dispose(): void;
} {
  let attempted = false;
  let container: string | undefined;
  let snapshot: string | undefined;
  const removeFailSoft = (target: string | undefined): void => {
    if (!target) return;
    try {
      dependencies.removeContainer(target);
    } catch {
      // Eval instrumentation is best-effort and cannot change the Agent result.
    }
  };
  return {
    capture(hasMutations) {
      if (attempted || !hasMutations) return;
      attempted = true;
      try {
        container = dependencies.createContainer(path.join(tmpdir(), `mocode-eval-first-patch-${fixtureId}-`));
        snapshot = path.join(container, 'workspace');
        dependencies.copyWorkspace(workspaceRoot, snapshot);
      } catch {
        const failedContainer = container;
        container = undefined;
        snapshot = undefined;
        removeFailSoft(failedContainer);
      }
    },
    snapshotRoot: () => snapshot,
    dispose() {
      const disposedContainer = container;
      container = undefined;
      snapshot = undefined;
      removeFailSoft(disposedContainer);
    },
  };
}

async function runTask(
  fixture: CodingTaskFixture,
  keep: boolean,
  timeoutOverride?: number,
): Promise<BenchmarkTaskResult> {
  const root = mkdtempSync(path.join(tmpdir(), `mocode-eval-${fixture.id}-`));
  materialize(root, fixture);
  const originalVerifierHash = verifierHash(root);
  if (!originalVerifierHash) throw new Error(`Fixture ${fixture.id} has no readable verify.mjs`);
  const previousCwd = process.cwd();
  const previousRoot = setSandboxRoot(root);
  const previousPermission = config.permissionEnabled;
  config.permissionEnabled = false; // isolated disposable fixture only
  resetState();
  const turnId = beginTurn(fixture.goal);
  const traceEvents: AgentTraceEvent[] = [];
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutOverride ?? fixture.timeoutMs ?? 120_000);
  let result: Awaited<ReturnType<typeof runAgentCore>> | undefined;
  const firstPatchCapture = createFirstPatchCapture(root, fixture.id);

  try {
    process.chdir(root);
    result = await runAgentCore({
      history: [],
      userInput: fixture.goal,
      signal: controller.signal,
      hooks: {
        onToolBatchEnd: () => firstPatchCapture.capture(getCurrentTurnMutationState().changedFiles.length > 0),
      },
      onTraceEvent: (event) => traceEvents.push(event),
      traceContext: { sessionId: `eval-${fixture.id}`, turnId },
    });
    const finalVerified = await verify(root, fixture.verificationCommand);
    const firstPatchPass = await evaluateFirstPatch(firstPatchCapture.snapshotRoot(), fixture, originalVerifierHash);
    const regression = fixture.regressionCommand ? !(await verify(root, fixture.regressionCommand)) : false;
    const expectedChanged = fixture.expected.files ?? [];
    const changed = result.changedFiles ?? [];
    const traceMetrics = reduceTraceMetrics(traceEvents);
    const expectedFilesTouched = expectedChanged.every((file) =>
      changed.some((changedFile) => changedFile.replace(/\\/g, '/').endsWith(file)),
    );
    const verifierUnchanged = verifierHash(root) === originalVerifierHash;
    const timedOut = controller.signal.aborted;
    const verified = finalVerified && expectedFilesTouched && verifierUnchanged && !timedOut;
    return {
      id: fixture.id,
      title: fixture.title,
      group: fixture.group,
      difficulty: fixture.difficulty,
      status: timedOut ? 'timeout' : verified ? 'passed' : 'failed',
      finalVerifiedSuccess: verified,
      firstPatchPass,
      regression,
      toolRecovery: traceMetrics.toolRecovery,
      toolRecoveryAttempts: traceMetrics.toolRecoveryAttempts,
      toolRecoveries: traceMetrics.toolRecoveries,
      toolCalls: traceMetrics.toolCalls,
      retries: traceMetrics.retries,
      firstSuccessRate: traceMetrics.firstSuccessRate,
      tokens: traceMetrics.tokens,
      durationMs: traceMetrics.durationMs,
      changedFiles: changed,
      askHumanCount: traceMetrics.askHumanCount,
    };
  } catch (error) {
    const traceMetrics = reduceTraceMetrics(traceEvents);
    return {
      id: fixture.id,
      title: fixture.title,
      group: fixture.group,
      difficulty: fixture.difficulty,
      status: controller.signal.aborted ? 'timeout' : 'error',
      finalVerifiedSuccess: false,
      firstPatchPass: await evaluateFirstPatch(firstPatchCapture.snapshotRoot(), fixture, originalVerifierHash),
      regression: false,
      toolRecovery: traceMetrics.toolRecovery,
      toolRecoveryAttempts: traceMetrics.toolRecoveryAttempts,
      toolRecoveries: traceMetrics.toolRecoveries,
      toolCalls: traceMetrics.toolCalls,
      retries: traceMetrics.retries,
      firstSuccessRate: traceMetrics.firstSuccessRate,
      tokens: traceMetrics.tokens,
      durationMs: traceMetrics.durationMs || Date.now() - started,
      changedFiles: [],
      error: error instanceof Error ? error.message : String(error),
      askHumanCount: traceMetrics.askHumanCount,
    };
  } finally {
    clearTimeout(timer);
    process.chdir(previousCwd);
    setSandboxRoot(previousRoot);
    config.permissionEnabled = previousPermission;
    resetState();
    firstPatchCapture.dispose();
    if (!keep && root.startsWith(path.join(tmpdir(), 'mocode-eval-'))) rmSync(root, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseBenchmarkArgs(args);
  validateBenchmarkOptions(options);
  if (options.list || !options.selection) {
    for (const task of codingTasks) console.log(`${task.id}\t${task.difficulty}\t${task.group}\t${task.title}`);
    if (!options.list) console.log('\nChoose a task/group explicitly; use --task all for the full paid run.');
    return;
  }

  const selected = selectTasks(options.selection);
  const identity = {
    schemaVersion: 3 as const,
    model: config.model,
    promptHash: promptHash(),
    taskIds: selected.map((task) => task.id),
  };
  let baseline: BenchmarkBaseline | undefined;
  if (options.selection === 'all' && !options.updateBaseline) {
    baseline = readBenchmarkBaseline(options.baselinePath);
    const preflight = compareBenchmarkPreflight(identity, baseline);
    if (preflight.status === 'failed') throw new Error(renderBaselineComparison(preflight));
  }

  const results: BenchmarkTaskResult[] = [];
  for (const fixture of selected) {
    process.stdout.write(`[eval] ${fixture.id} ${fixture.title} ... `);
    const result = await runTask(fixture, options.keep, options.timeoutMs);
    results.push(result);
    console.log(result.status);
  }
  const report = createReport(
    {
      schemaVersion: identity.schemaVersion,
      runId: randomUUID(),
      generatedAt: new Date().toISOString(),
      model: identity.model,
      promptHash: identity.promptHash,
      selection: options.selection,
    },
    results,
  );
  mkdirSync(options.outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(options.outDir, `${stamp}.json`);
  const mdPath = path.join(options.outDir, `${stamp}.md`);
  writeReport(report, jsonPath, mdPath);

  let baselineFailed = false;
  if (options.updateBaseline) {
    writeBenchmarkBaseline(options.baselinePath, createRecordedBaseline(report));
    console.log(`Baseline updated: ${options.baselinePath}`);
  } else if (baseline) {
    const comparison = compareBenchmarkReport(report, baseline);
    baselineFailed = comparison.status === 'failed';
    console.log(`\n${renderBaselineComparison(comparison)}`);
  }

  console.log(`\n${renderSummary(report)}`);
  console.log(`JSON: ${jsonPath}\nSummary: ${mdPath}`);
  if (report.summary.passed !== report.summary.tasks || baselineFailed) process.exitCode = 1;
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
if (invoked)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
