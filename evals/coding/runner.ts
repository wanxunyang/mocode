import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAgentCore } from '../../src/agent/core.js';
import { config } from '../../src/config/index.js';
import { beginTurn, resetState } from '../../src/rollback/index.js';
import { setSandboxRoot } from '../../src/sandbox/root.js';
import type { AgentTurnTrace } from '../../src/session/trace.js';
import { codingTasks, selectTasks } from './fixtures.js';
import { createReport, renderSummary, writeReport } from './report.js';
import type { BenchmarkTaskResult, CodingTaskFixture } from './types.js';

const execFileAsync = promisify(execFile);

interface CliOptions { selection: string; outDir: string; updateBaseline: boolean; list: boolean; keep: boolean; timeoutMs?: number }

export function parseBenchmarkArgs(args: string[]): CliOptions {
  const value = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
  };
  const timeoutRaw = value('--timeout', '');
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }
  return {
    selection: value('--task', value('--group', '')),
    outDir: path.resolve(value('--out', 'evals/results')),
    updateBaseline: args.includes('--update-baseline'),
    list: args.includes('--list'),
    keep: args.includes('--keep-workspaces'),
    timeoutMs,
  };
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
  } catch { return false; }
}

function promptHash(): string {
  return createHash('sha256').update(config.systemPrompt).digest('hex').slice(0, 16);
}

async function runTask(fixture: CodingTaskFixture, keep: boolean, timeoutOverride?: number): Promise<BenchmarkTaskResult> {
  const root = mkdtempSync(path.join(tmpdir(), `mocode-eval-${fixture.id}-`));
  materialize(root, fixture);
  const verifierHash = createHash('sha256').update(readFileSync(path.join(root, 'verify.mjs'))).digest('hex');
  const previousCwd = process.cwd();
  const previousRoot = setSandboxRoot(root);
  const previousPermission = config.permissionEnabled;
  config.permissionEnabled = false; // isolated disposable fixture only
  resetState();
  beginTurn(fixture.goal);
  const traces: AgentTurnTrace[] = [];
  let toolCalls = 0;
  let hadToolFailure = false;
  let recovered = false;
  let validationRuns = 0;
  let firstValidationPassed = false;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutOverride ?? fixture.timeoutMs ?? 120_000);
  try {
    process.chdir(root);
    const result = await runAgentCore({
      history: [], userInput: fixture.goal, signal: controller.signal, hooks: {
        onToolHeader: () => { toolCalls += 1; },
        onToolResult: (_tc, output) => {
          const failed = /^error[:\s]|\[error\]|失败|错误/i.test(output);
          if (failed) hadToolFailure = true;
          else if (hadToolFailure) recovered = true;
        },
      },
      autoValidate: true,
      validator: async () => {
        const validationStarted = Date.now();
        const passed = await verify(root, fixture.verificationCommand);
        validationRuns += 1;
        if (validationRuns === 1) firstValidationPassed = passed;
        return {
          status: passed ? 'passed' : 'failed', command: fixture.verificationCommand,
          output: passed ? 'ok' : 'verification failed', durationMs: Date.now() - validationStarted,
          changedFiles: [], mutationVersion: validationRuns,
        };
      },
      onTrace: t => traces.push(t),
    });
    const finalVerified = await verify(root, fixture.verificationCommand);
    const regression = fixture.regressionCommand ? !(await verify(root, fixture.regressionCommand)) : false;
    const expectedChanged = fixture.expected.files ?? [];
    const changed = result.changedFiles ?? traces.at(-1)?.changedFiles ?? [];
    const expectedFilesTouched = expectedChanged.every(f => changed.some(c => c.replace(/\\/g, '/').endsWith(f)));
    const verifierUnchanged = createHash('sha256').update(readFileSync(path.join(root, 'verify.mjs'))).digest('hex') === verifierHash;
    const timedOut = controller.signal.aborted;
    const verified = finalVerified && expectedFilesTouched && verifierUnchanged && !timedOut;
    return {
      id: fixture.id, title: fixture.title, group: fixture.group, difficulty: fixture.difficulty,
      status: timedOut ? 'timeout' : verified ? 'passed' : 'failed',
      finalVerifiedSuccess: verified,
      firstPatchPass: firstValidationPassed,
      regression,
      toolRecovery: recovered,
      toolCalls: traces.at(-1)?.toolCalls ?? toolCalls,
      tokens: result.usage?.totalTokens ?? traces.at(-1)?.usage?.totalTokens ?? null,
      durationMs: Date.now() - started,
      unverifiedCompletion: result.completed && !finalVerified,
      changedFiles: changed,
    };
  } catch (error) {
    return {
      id: fixture.id, title: fixture.title, group: fixture.group, difficulty: fixture.difficulty,
      status: controller.signal.aborted ? 'timeout' : 'error', finalVerifiedSuccess: false,
      firstPatchPass: false, regression: false, toolRecovery: recovered, toolCalls,
      tokens: null, durationMs: Date.now() - started, unverifiedCompletion: false,
      changedFiles: [], error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    process.chdir(previousCwd);
    setSandboxRoot(previousRoot);
    config.permissionEnabled = previousPermission;
    resetState();
    if (!keep && root.startsWith(path.join(tmpdir(), 'mocode-eval-'))) rmSync(root, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const opts = parseBenchmarkArgs(args);
  if (opts.list || !opts.selection) {
    for (const task of codingTasks) console.log(`${task.id}\t${task.difficulty}\t${task.group}\t${task.title}`);
    if (!opts.list) console.log('\nChoose a task/group explicitly; use --task all for the full paid run.');
    return;
  }
  const selected = selectTasks(opts.selection);
  const results: BenchmarkTaskResult[] = [];
  for (const fixture of selected) {
    process.stdout.write(`[eval] ${fixture.id} ${fixture.title} ... `);
    const result = await runTask(fixture, opts.keep, opts.timeoutMs);
    results.push(result);
    console.log(result.status);
  }
  const report = createReport({
    schemaVersion: 2, runId: randomUUID(), generatedAt: new Date().toISOString(),
    model: config.model, promptHash: promptHash(), selection: opts.selection,
  }, results);
  mkdirSync(opts.outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(opts.outDir, `${stamp}.json`);
  const mdPath = path.join(opts.outDir, `${stamp}.md`);
  writeReport(report, jsonPath, mdPath);
  if (opts.updateBaseline) {
    if (opts.selection !== 'all') throw new Error('--update-baseline requires all tasks');
    writeFileSync(path.resolve('evals/baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(`\n${renderSummary(report)}`);
  console.log(`JSON: ${jsonPath}\nSummary: ${mdPath}`);
  if (report.summary.passed !== report.summary.tasks) process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
if (invoked) main().catch(error => { console.error(error); process.exitCode = 1; });
