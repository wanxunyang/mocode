import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationEvidence } from '../../src/verification/evidence.js';
import type { ToolOutcome } from '../../src/tools/types.js';

const ok: ToolOutcome = { status: 'success', code: 'OK', retryable: false, output: '' };
const edit = { ...ok, changedFiles: ['src/a.js'] };

test('reports checks that passed after edits once, without claiming other checks passed', () => {
  const evidence = createVerificationEvidence();
  evidence.observe('run_command', { command: 'npm test' }, ok);
  assert.equal(evidence.takeReminder(), undefined);
  evidence.observe('edit_file', null, edit);
  evidence.observe('run_command', { command: 'node --test tests/parser.test.js' }, ok);
  evidence.observe('run_command', { command: 'npm run typecheck' }, ok);
  evidence.observe('read_file', null, ok);
  const reminder = evidence.takeReminder();
  assert.match(reminder ?? '', /Passed: `node --test tests\/parser.test.js`/);
  assert.match(reminder ?? '', /Passed: `npm run typecheck`/);
  assert.match(reminder ?? '', /explicitly requested fresh checks/);
  assert.equal(evidence.takeReminder(), undefined);
});

test('a failure, new edit, user update or unrelated process cannot leave its old success active', () => {
  const evidence = createVerificationEvidence();
  const check = { command: 'npm test' };
  evidence.observe('edit_file', null, edit);
  const pass = () => evidence.observe('run_command', check, ok);
  for (const invalidate of [
    () => evidence.observe('run_command', check, { ...ok, status: 'error', code: 'PROCESS_FAILED' }),
    () => evidence.observe('edit_file', null, edit),
    () => evidence.observe('run_command', { command: 'npm test && npm run build' }, ok),
    () => evidence.observe('run_command', check, { ...ok, changedFiles: ['cache.json'] }),
    () => evidence.observe('dev_server', null, ok),
    () => evidence.invalidate(),
  ]) {
    pass();
    invalidate();
    assert.equal(evidence.takeReminder(), undefined);
  }
});
