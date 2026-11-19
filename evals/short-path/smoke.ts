/**
 * 短路径基准的结构自检:零 LLM、零网络调用模型。
 *
 * 检查四层:
 *  1. fixture 不变量:id 唯一、gold 合理、每题都带 verifier 文件;
 *  2. 合成题( micro/hinted/warm )物化后,verifier 在初始状态必须失败(基准铁律);
 *  3. 报告与基线的一致性:createReport 的 summary 与任务明细互洽、基线 round-trip 无损;
 *  4. repo 题(默认跳过执行,--with-repo 时解包真实快照做 verifier 初始失败检查)。
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  compareShortPathReport,
  createRecordedShortPathBaseline,
  parseShortPathBaseline,
  readShortPathBaseline,
} from './baseline.js';
import { shortPathTasks } from './fixtures.js';
import { createReport } from './report.js';
import type { ShortPathTask, ShortPathTaskResult } from './types.js';

const execFileAsync = promisify(execFile);
const withRepo = process.argv.includes('--with-repo');

function fail(message: string): never {
  console.error(`[short-path smoke] FAIL: ${message}`);
  process.exit(1);
}

function checkInvariants(): void {
  const ids = new Set<string>();
  const byLevel = new Map<number, number>();
  for (const task of shortPathTasks) {
    if (ids.has(task.id)) fail(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.level < 1 || task.level > 10) fail(`${task.id}: level must be 1-10`);
    byLevel.set(task.level, (byLevel.get(task.level) ?? 0) + 1);
    if (task.gold.maxToolCalls < 2) fail(`${task.id}: gold.maxToolCalls must be >= 2`);
    if (task.files.length === 0) fail(`${task.id}: fixture has no files`);
    const hasVerifier = task.files.some((file) => path.basename(file.path).startsWith('verify'));
    if (!hasVerifier) fail(`${task.id}: fixture has no verify file`);
    if (task.scenario === 'warm' && !task.warmupGoal) fail(`${task.id}: warm fixture missing warmupGoal`);
    if (task.scenario === 'repo' && !task.repoSnapshot) fail(`${task.id}: repo fixture must set repoSnapshot`);
    if (task.scenario !== 'repo' && task.repoSnapshot) fail(`${task.id}: non-repo fixture must not set repoSnapshot`);
  }
  // L1-L6 全覆盖且每级 8-16 题(L7-L10 为预留定义,暂无题目)。
  for (let level = 1; level <= 6; level++) {
    const n = byLevel.get(level) ?? 0;
    if (n < 8 || n > 16) fail(`level ${level}: expected 8-16 tasks, got ${n}`);
  }
  for (let level = 7; level <= 10; level++) {
    if ((byLevel.get(level) ?? 0) > 0) fail(`level ${level}: reserved for future expansion, no tasks allowed yet`);
  }
  const distribution = [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([l, n]) => `L${l}=${n}`)
    .join(' ');
  console.log(`[short-path smoke] level distribution: ${distribution}`);
}

function materialize(root: string, fixture: ShortPathTask): void {
  for (const file of fixture.files) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  if (!fixture.repoSnapshot) {
    writeFileSync(path.join(root, 'package.json'), '{"type":"module","private":true}\n', 'utf8');
  }
}

async function checkSyntheticVerifiersFailInitially(): Promise<void> {
  const synthetic = shortPathTasks.filter((task) => task.scenario !== 'repo');
  for (const task of synthetic) {
    const root = mkdtempSync(path.join(tmpdir(), `mocode-shortpath-smoke-${task.id}-`));
    try {
      materialize(root, task);
      const [program, ...args] = task.verificationCommand.split(' ');
      try {
        await execFileAsync(program, args, { cwd: root, timeout: 15_000, windowsHide: true });
        fail(`${task.id}: verifier passed on the pristine fixture (must fail initially)`);
      } catch {
        // 期望路径:初始状态 verifier 失败。
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`[short-path smoke] synthetic verifiers fail initially: ${synthetic.length}/${synthetic.length}`);
}

function sampleReport(): void {
  const now = new Date().toISOString();
  const base = {
    id: 'micro-01',
    title: 't',
    scenario: 'micro' as const,
    level: 1 as const,
    warmupMutated: false,
    warmupReadCalls: null,
    goldMaxToolCalls: 3,
    promptTokens: 100,
    completionTokens: 10,
    cachedTokens: null,
    durationMs: 1000,
    endToEndDurationMs: 1030,
    changedFiles: ['config.js'],
    expectedFilesTouched: true,
    verifierUnchanged: true,
  };
  const passed: ShortPathTaskResult = {
    ...base,
    status: 'passed',
    finalVerifiedSuccess: true,
    efficiency: {
      toolCalls: 3,
      mutationCalls: 1,
      readOnlyCalls: 1,
      modelRequests: 2,
      requestsBeforeFirstEdit: 1,
      readCallsBeforeFirstEdit: 1,
      repeatedIdenticalReadOnlyCalls: 0,
      postEditReadOnlyCalls: 0,
      promptTokens: 100,
      completionTokens: 10,
      cachedTokens: null,
      totalTokens: 110,
      durationMs: 1000,
    },
    pathRatio: 1,
  };
  const failed: ShortPathTaskResult = {
    ...passed,
    id: 'micro-02',
    status: 'failed',
    finalVerifiedSuccess: false,
    expectedFilesTouched: false,
    efficiency: { ...passed.efficiency, toolCalls: 9, readOnlyCalls: 6, requestsBeforeFirstEdit: null },
    pathRatio: 3,
  };
  const report = createReport(
    {
      schemaVersion: 1,
      runId: 'smoke',
      generatedAt: now,
      model: 'smoke-model',
      promptHash: 'smokehash',
      scenario: 'micro',
      selection: 'micro',
      experiment: { fixtureHash: 'fixture-v1', reasoningEffort: 'low', routing: 'off', shortPathCompletion: false },
    },
    [passed, failed],
  );
  if (report.summary.tasks !== 2 || report.summary.passed !== 1) fail('createReport summary mismatch');
  if (report.summary.meanToolCalls !== 6) fail(`meanToolCalls expected 6, got ${report.summary.meanToolCalls}`);
  if (report.summary.meanRequestsBeforeFirstEdit !== 1) fail('requestsBeforeFirstEdit mean must skip null task');
  const baseline = parseShortPathBaseline(createRecordedShortPathBaseline(report));
  if (baseline.status !== 'recorded') fail('baseline round-trip lost recorded status');
  if (baseline.efficiency.meanToolCalls !== 6) fail('baseline efficiency snapshot mismatch');
  const experiment = baseline.report.experiment;
  if (!experiment || experiment.fixtureHash !== 'fixture-v1' || baseline.report.tasks[0].endToEndDurationMs !== 1030) {
    fail('baseline round-trip lost experiment settings or end-to-end timing');
  }
  if (
    compareShortPathReport({ ...report, experiment: { ...experiment, shortPathCompletion: true } }, baseline).status !==
    'passed'
  ) {
    fail('baseline must allow comparison across the completion feature toggle');
  }
  if (
    compareShortPathReport({ ...report, experiment: { ...experiment, fixtureHash: 'fixture-v2' } }, baseline).status !==
    'failed'
  ) {
    fail('baseline must reject changed fixture contents');
  }
  console.log('[short-path smoke] report/baseline consistency: ok');
}

function checkBaselineFileReadable(): void {
  // 基线是 per-scenario 的(baseline-<scenario>.json);逐个检查已录制的。
  const scenarios = ['micro', 'hinted', 'warm', 'repo'];
  const found: string[] = [];
  for (const scenario of scenarios) {
    const file = path.resolve(`evals/short-path/baseline-${scenario}.json`);
    if (!existsSync(file)) continue;
    const baseline = readShortPathBaseline(file);
    found.push(`${scenario}=${baseline.status}`);
  }
  console.log(`[short-path smoke] baseline files: ${found.length ? found.join(', ') : 'none recorded yet'}`);
}

async function checkRepoVerifiersFailInitially(): Promise<void> {
  const repoTasks = shortPathTasks.filter((task) => task.scenario === 'repo');
  const root = mkdtempSync(path.join(tmpdir(), 'mocode-shortpath-smoke-repo-'));
  try {
    const tarPath = path.join(mkdtempSync(path.join(tmpdir(), 'mocode-shortpath-smoke-tar-')), 'head.tar');
    await execFileAsync('git', ['-C', process.cwd(), 'archive', '--format=tar', '-o', tarPath, 'HEAD'], {
      windowsHide: true,
    });
    await execFileAsync('tar', ['-xf', tarPath, '-C', root], { windowsHide: true });
    rmSync(path.dirname(tarPath), { recursive: true, force: true });
    // verifier 走 node_modules/tsx:必须先 junction 真实 node_modules,否则是「错误的失败」。
    const nodeModules = path.join(process.cwd(), 'node_modules');
    if (!existsSync(nodeModules)) fail('repo check needs node_modules; run npm install first');
    symlinkSync(nodeModules, path.join(root, 'node_modules'), 'junction');
    for (const task of repoTasks) {
      materialize(root, task);
      const [, ...args] = task.verificationCommand.split(' ');
      try {
        await execFileAsync('node', args, { cwd: root, timeout: 60_000, windowsHide: true });
        fail(`${task.id}: repo verifier passed on the pristine snapshot (must fail initially)`);
      } catch {
        // 期望路径。
      }
    }
    console.log(`[short-path smoke] repo verifiers fail initially: ${repoTasks.length}/${repoTasks.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  checkInvariants();
  await checkSyntheticVerifiersFailInitially();
  sampleReport();
  checkBaselineFileReadable();
  if (withRepo) await checkRepoVerifiersFailInitially();
  else console.log('[short-path smoke] repo execution check skipped (pass --with-repo to run it)');
  console.log('[short-path smoke] all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
