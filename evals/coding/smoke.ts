import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAgentCore } from '../../src/agent/core.js';
import { getAgentMode, setAgentMode } from '../../src/agent/mode.js';
import { __setChatCreateImpl } from '../../src/llm/index.js';
import { getCurrentSessionId, setCurrentSessionId } from '../../src/session/state.js';
import { clearSkillActivation } from '../../src/skills/activation.js';
import {
  compareBenchmarkPreflight,
  compareBenchmarkReport,
  createRecordedBaseline,
  parseBenchmarkBaseline,
  readBenchmarkBaseline,
  writeBenchmarkBaseline,
} from './baseline.js';
import { codingTasks, selectTasks } from './fixtures.js';
import { createReport, renderSummary } from './report.js';
import { createFirstPatchCapture, parseBenchmarkArgs, validateBenchmarkOptions } from './runner.js';
import { assembleCodingEvalTurn, buildCodingEvalSystemPrompt } from './runtime.js';
import type { BenchmarkTaskResult } from './types.js';

assert.equal(codingTasks.length, 61);
assert.equal(new Set(codingTasks.map((task) => task.id)).size, 61);
assert.ok(codingTasks.every((task) => task.files.length >= 2 && task.verificationCommand && task.goal));
assert.equal(selectTasks('monorepo').length, 4);
assert.equal(selectTasks('basic').length, 21);
assert.equal(selectTasks('hard').length, 20);
assert.equal(selectTasks('advanced').length, 20);
assert.deepEqual(
  selectTasks('single-01,multi-01').map((task) => task.id),
  ['single-01', 'multi-01'],
);

// multifile-boundary-01: fixture 内含多文件 / 边界条件 bug。
{
  const task = codingTasks.find((item) => item.id === 'multifile-boundary-01');
  assert.ok(task, 'multifile-boundary-01 fixture exists');
  assert.equal(
    task.files.filter((file) => file.path.endsWith('.js')).length,
    2,
    'multifile-boundary fixture has 2 source files',
  );
  assert.ok(
    /boundary/i.test(task.goal) || /zero|neg/i.test(task.verificationCommand),
    'multifile-boundary goal mentions boundary',
  );
}
assert.equal(parseBenchmarkArgs(['--group', 'types']).selection, 'types');
assert.equal(parseBenchmarkArgs(['single-01']).selection, 'single-01');
assert.equal(parseBenchmarkArgs(['single-01']).selectionSource, 'positional');
assert.equal(parseBenchmarkArgs([]).selection, '');
assert.equal(parseBenchmarkArgs(['--timeout', '300000']).timeoutMs, 300000);
assert.throws(() => parseBenchmarkArgs(['--timeout', '0']), /positive/);
assert.throws(() => parseBenchmarkArgs(['--task']), /requires a value/);
assert.throws(() => parseBenchmarkArgs(['single-01', 'multi-01']), /Unknown argument/);
assert.throws(() => parseBenchmarkArgs(['--typo']), /Unknown argument/);
assert.throws(
  () => validateBenchmarkOptions(parseBenchmarkArgs(['--task', 'single-01', '--update-baseline'])),
  /requires --task all/,
);
assert.throws(() => validateBenchmarkOptions(parseBenchmarkArgs(['all', '--update-baseline'])), /requires --task all/);
assert.throws(
  () => validateBenchmarkOptions(parseBenchmarkArgs(['--group', 'all', '--update-baseline'])),
  /requires --task all/,
);
validateBenchmarkOptions(parseBenchmarkArgs(['--task', 'all', '--update-baseline']));

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mocode-fixture-smoke-'));
try {
  for (const fixture of codingTasks) {
    const root = path.join(fixtureRoot, fixture.id);
    for (const file of fixture.files) {
      const target = path.join(root, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.eol === 'crlf' ? file.content.replace(/\r?\n/g, '\r\n') : file.content);
    }
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    const checked = spawnSync(process.execPath, ['--check', 'verify.mjs'], { cwd: root });
    assert.equal(checked.status, 0, `${fixture.id}: verifier syntax error: ${checked.stderr}`);
    const initial = spawnSync(process.execPath, ['verify.mjs'], { cwd: root, timeout: 2000 });
    assert.notEqual(initial.status, 0, `${fixture.id}: initial fixture already passes`);
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const taskResult: BenchmarkTaskResult = {
  id: 'x',
  title: 'x',
  group: 'tests',
  difficulty: 'basic',
  status: 'passed',
  finalVerifiedSuccess: true,
  firstPatchPass: true,
  regression: false,
  toolRecovery: true,
  toolRecoveryAttempts: 1,
  toolRecoveries: 1,
  toolCalls: 2,
  tokens: 10,
  durationMs: 20,
  changedFiles: ['x.js'],
  askHumanCount: 0,
};
const report = createReport(
  { schemaVersion: 3, runId: 'test', generatedAt: 'now', model: 'test', promptHash: 'abc', selection: 'all' },
  [taskResult],
);
assert.equal(report.summary.finalVerifiedSuccessRate, 1);
assert.equal(report.summary.firstPatchPassRate, 1);
assert.equal(report.summary.toolRecoveryRate, 1);
assert.match(renderSummary(report), /1\/1 passed/);
assert.equal(report.summary.askHumanCount, 0);
const baseline = createRecordedBaseline(report);
assert.equal(parseBenchmarkBaseline(baseline).status, 'recorded');
assert.equal(compareBenchmarkReport(report, baseline).status, 'passed');
assert.equal(
  compareBenchmarkPreflight(
    { schemaVersion: 3, model: report.model, promptHash: report.promptHash, taskIds: ['x'] },
    baseline,
  ).status,
  'passed',
);
assert.equal(
  compareBenchmarkPreflight(
    { schemaVersion: 3, model: 'different-model', promptHash: report.promptHash, taskIds: ['x'] },
    baseline,
  ).status,
  'failed',
);

const malformedBaseline = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
const malformedReport = malformedBaseline.report as Record<string, unknown>;
const malformedSummary = malformedReport.summary as Record<string, unknown>;
malformedSummary.toolRecoveryRate = null;
assert.throws(() => parseBenchmarkBaseline(malformedBaseline), /toolRecoveryRate contradicts task results/);
const malformedStatus = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
const malformedTasks = (malformedStatus.report as Record<string, unknown>).tasks as Array<Record<string, unknown>>;
malformedTasks[0].status = 'garbage';
assert.throws(() => parseBenchmarkBaseline(malformedStatus), /status is unknown/);
const contradictoryTask = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
const contradictoryTasks = (contradictoryTask.report as Record<string, unknown>).tasks as Array<
  Record<string, unknown>
>;
contradictoryTasks[0].status = 'failed';
assert.throws(() => parseBenchmarkBaseline(contradictoryTask), /status contradicts finalVerifiedSuccess/);
const impossibleRecovery = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
const impossibleTasks = (impossibleRecovery.report as Record<string, unknown>).tasks as Array<Record<string, unknown>>;
impossibleTasks[0].toolRecoveryAttempts = 3;
assert.throws(() => parseBenchmarkBaseline(impossibleRecovery), /toolRecoveryAttempts exceeds toolCalls/);

const baselineRoot = mkdtempSync(path.join(tmpdir(), 'mocode-baseline-smoke-'));
try {
  const baselinePath = path.join(baselineRoot, 'baseline.json');
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ schemaVersion: 3, status: 'not-recorded', suiteSize: 1, description: 'placeholder' })}\n`,
  );
  writeBenchmarkBaseline(baselinePath, baseline);
  assert.equal(readBenchmarkBaseline(baselinePath).status, 'recorded');
  assert.deepEqual(
    readdirSync(baselineRoot).filter((name) => name.endsWith('.tmp')),
    [],
    'atomic replacement must not leave temporary files',
  );
} finally {
  rmSync(baselineRoot, { recursive: true, force: true });
}

let copyAttempts = 0;
let removals = 0;
const failedCapture = createFirstPatchCapture('workspace', 'copy-failure', {
  createContainer: () => 'container',
  copyWorkspace: () => {
    copyAttempts++;
    throw new Error('copy failed');
  },
  removeContainer: () => {
    removals++;
    throw new Error('cleanup failed');
  },
});
failedCapture.capture(false);
failedCapture.capture(true);
failedCapture.capture(true);
assert.equal(copyAttempts, 1, 'a failed first snapshot must not retry on later mutation batches');
assert.equal(removals, 1);
assert.equal(failedCapture.snapshotRoot(), undefined);
failedCapture.dispose();
const cleanupFailureCapture = createFirstPatchCapture('workspace', 'cleanup-failure', {
  createContainer: () => 'container',
  copyWorkspace: () => undefined,
  removeContainer: () => {
    throw new Error('cleanup failed');
  },
});
cleanupFailureCapture.capture(true);
assert.doesNotThrow(() => cleanupFailureCapture.dispose(), 'snapshot cleanup must be fail-soft');

const regressedReport = createReport(
  {
    schemaVersion: 3,
    runId: 'regressed',
    generatedAt: report.generatedAt,
    model: report.model,
    promptHash: report.promptHash,
    selection: report.selection,
  },
  [{ ...taskResult, status: 'failed', finalVerifiedSuccess: false, firstPatchPass: false, toolRecoveries: 0 }],
);
const comparison = compareBenchmarkReport(regressedReport, baseline);
assert.equal(comparison.status, 'failed');
assert.ok(comparison.issues.some((issue) => issue.metric === 'passed'));
assert.ok(comparison.issues.some((issue) => issue.metric === 'firstPatchPass'));
assert.ok(comparison.issues.some((issue) => issue.metric === 'toolRecovery'));

const timeoutReport = createReport(
  { schemaVersion: 3, runId: 'timeout', generatedAt: 'now', model: 'test', promptHash: 'abc', selection: 'hard' },
  [
    {
      ...taskResult,
      id: 'late',
      title: 'late',
      group: 'resilience',
      difficulty: 'hard',
      status: 'timeout',
      finalVerifiedSuccess: false,
      firstPatchPass: false,
      toolRecovery: false,
      toolRecoveryAttempts: 0,
      toolRecoveries: 0,
      toolCalls: 1,
      tokens: 1,
      durationMs: 10,
      changedFiles: [],
    },
  ],
);
assert.equal(timeoutReport.summary.passed, 0);
assert.equal(timeoutReport.summary.toolRecoveryRate, null);

// Headless eval assembly must preserve the production system prefix and expose routed tools to the main provider call.
{
  interface CapturedRequest {
    messages?: Array<{ role: string; content?: unknown }>;
    tools?: Array<{ function: { name: string } }>;
  }

  const previousMode = getAgentMode();
  const previousSessionId = getCurrentSessionId();
  let capturedRequest: CapturedRequest | null = null;
  let routeRequest: { input: string; previousGroups?: readonly string[]; planMode?: boolean } | null = null;
  const systemPrompt = buildCodingEvalSystemPrompt('coding-eval');

  try {
    const turn = await assembleCodingEvalTurn('Fix the implementation and run its verifier.', undefined, systemPrompt, {
      route: async (request) => {
        routeRequest = request;
        return {
          groups: ['workspace-write', 'shell-debug'],
          inheritPrevious: false,
          confidence: 0.95,
          reason: 'The task requires editing files and running verification.',
          latencyMs: 1,
          fallback: false,
        };
      },
    });

    assert.equal(turn.history[0]?.role, 'system');
    assert.equal(turn.history[0]?.content, systemPrompt);
    assert.match(systemPrompt, /^## Identity/);
    const routed = routeRequest as { previousGroups?: readonly string[]; planMode?: boolean } | null;
    assert.ok(routed, 'tool router must be called');
    assert.deepEqual(routed.previousGroups, []);
    assert.equal(routed.planMode, false);

    const policyNames = turn.toolPolicy.snapshot(false).tools.map((tool) => tool.function.name);
    for (const name of ['read_file', 'write_file', 'edit_file', 'run_command']) {
      assert.ok(policyNames.includes(name), `coding eval policy must expose ${name}`);
    }

    __setChatCreateImpl(async (body) => {
      capturedRequest = body as unknown as CapturedRequest;
      return (async function* () {
        yield { choices: [{ delta: { content: 'done' } }] };
      })();
    });
    await runAgentCore({
      history: turn.history,
      userInput: 'Fix the implementation and run its verifier.',
      hooks: {},
      maxSteps: 1,
      toolPolicy: turn.toolPolicy,
      initialToolRoute: turn.initialToolRoute,
    });

    const request = capturedRequest as CapturedRequest | null;
    assert.ok(request, 'main provider request must be captured');
    assert.equal(request.messages?.[0]?.role, 'system');
    assert.equal(request.messages?.[0]?.content, systemPrompt);
    const requestToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(requestToolNames.length > 0, 'main provider request must include tools');
    for (const name of ['read_file', 'write_file', 'edit_file', 'run_command']) {
      assert.ok(requestToolNames.includes(name), `main provider request must include ${name}`);
    }
  } finally {
    __setChatCreateImpl(null);
    clearSkillActivation();
    setCurrentSessionId(previousSessionId, process.cwd());
    setAgentMode(previousMode);
  }
}

console.log(
  `coding benchmark smoke: passed (${codingTasks.length} fixtures checked, incl. baseline v3 + runtime assembly)`,
);
