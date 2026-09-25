import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';

describe('SessionStore usage.jsonl', () => {
  let root: string;
  let store: SessionStore;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'mocode-usage-'));
    store = new SessionStore({ sessionsRoot: root, getCurrentSessionId: () => undefined });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('appends and reads records', () => {
    store.appendUsage('s1', { step: 0, inputTokens: 10 });
    store.appendUsage('s1', { step: 1, inputTokens: 20 });
    const rows = store.readUsage('s1') as Array<{ step: number; inputTokens: number }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.inputTokens),
      [10, 20],
    );
  });

  it('returns empty for missing file and skips corrupt lines', () => {
    assert.deepEqual(store.readUsage('nope'), []);
  });
});
