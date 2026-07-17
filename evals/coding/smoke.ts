import assert from 'node:assert/strict';
import { codingTasks, selectTasks } from './fixtures.js';
import { createReport, renderSummary } from './report.js';
import { parseBenchmarkArgs } from './runner.js';

assert.equal(codingTasks.length, 20);
assert.equal(new Set(codingTasks.map(t => t.id)).size, 20);
assert.ok(codingTasks.every(t => t.files.length >= 2 && t.verificationCommand && t.goal));
assert.equal(selectTasks('monorepo').length, 2);
assert.deepEqual(selectTasks('single-01,multi-01').map(t => t.id), ['single-01', 'multi-01']);
assert.equal(parseBenchmarkArgs(['--group', 'types']).selection, 'types');
assert.equal(parseBenchmarkArgs([]).selection, '');

const report = createReport({ schemaVersion: 1, runId: 'test', generatedAt: 'now', model: 'test', promptHash: 'abc', selection: 'all' }, [{
  id: 'x', title: 'x', group: 'tests', status: 'passed', finalVerifiedSuccess: true,
  firstPatchPass: true, regression: false, toolRecovery: false, toolCalls: 2,
  tokens: 10, durationMs: 20, unverifiedCompletion: false, changedFiles: ['x.js'],
}]);
assert.equal(report.summary.finalVerifiedSuccessRate, 1);
assert.match(renderSummary(report), /1\/1 passed/);
console.log('coding benchmark smoke: 9/9 passed');
