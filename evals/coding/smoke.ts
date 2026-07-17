import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codingTasks, selectTasks } from './fixtures.js';
import { createReport, renderSummary } from './report.js';
import { parseBenchmarkArgs } from './runner.js';

assert.equal(codingTasks.length, 60);
assert.equal(new Set(codingTasks.map(t => t.id)).size, 60);
assert.ok(codingTasks.every(t => t.files.length >= 2 && t.verificationCommand && t.goal));
assert.equal(selectTasks('monorepo').length, 4);
assert.equal(selectTasks('hard').length, 20);
assert.equal(selectTasks('advanced').length, 20);
assert.deepEqual(selectTasks('single-01,multi-01').map(t => t.id), ['single-01', 'multi-01']);
assert.equal(parseBenchmarkArgs(['--group', 'types']).selection, 'types');
assert.equal(parseBenchmarkArgs([]).selection, '');
assert.equal(parseBenchmarkArgs(['--timeout', '300000']).timeoutMs, 300000);
assert.throws(() => parseBenchmarkArgs(['--timeout', '0']), /positive/);

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

const report = createReport({ schemaVersion: 2, runId: 'test', generatedAt: 'now', model: 'test', promptHash: 'abc', selection: 'all' }, [{
  id: 'x', title: 'x', group: 'tests', difficulty: 'basic', status: 'passed', finalVerifiedSuccess: true,
  firstPatchPass: true, regression: false, toolRecovery: false, toolCalls: 2,
  tokens: 10, durationMs: 20, unverifiedCompletion: false, changedFiles: ['x.js'],
}]);
assert.equal(report.summary.finalVerifiedSuccessRate, 1);
assert.match(renderSummary(report), /1\/1 passed/);
const timeoutReport = createReport({ schemaVersion: 2, runId: 'timeout', generatedAt: 'now', model: 'test', promptHash: 'abc', selection: 'hard' }, [{
  id: 'late', title: 'late', group: 'resilience', difficulty: 'hard', status: 'timeout',
  finalVerifiedSuccess: false, firstPatchPass: false, regression: false, toolRecovery: false,
  toolCalls: 1, tokens: 1, durationMs: 10, unverifiedCompletion: false, changedFiles: [],
}]);
assert.equal(timeoutReport.summary.passed, 0);
console.log('coding benchmark smoke: 15/15 passed (60 fixtures checked)');
