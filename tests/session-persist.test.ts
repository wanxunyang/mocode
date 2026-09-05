import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config/index.js';
import type { ChatMessage } from '../src/llm/index.js';
import { loadSession, saveSession } from '../src/session/persist.js';

test('session: lastToolGroups 可往返，并在加载时过滤未知或损坏的组名', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-session-route-test-'));
  const previousSessionDir = config.sessionDir;
  config.sessionDir = root;
  const id = '20260905-120000';
  const sessionFile = join(root, id, 'session.json');
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'continue implementation' },
  ];

  try {
    saveSession(history, id, ['continue implementation'], ['workspace-write', 'shell-debug']);
    const roundTrip = loadSession(id);
    assert.ok(roundTrip);
    assert.deepEqual(roundTrip.lastToolGroups, ['workspace-write', 'shell-debug']);

    const record = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
    record.lastToolGroups = ['workspace-write', 'bogus', null, 42, 'mcp'];
    writeFileSync(sessionFile, JSON.stringify(record), 'utf8');
    assert.deepEqual(loadSession(id)?.lastToolGroups, ['workspace-write', 'mcp']);

    record.lastToolGroups = { invalid: true };
    writeFileSync(sessionFile, JSON.stringify(record), 'utf8');
    assert.equal(loadSession(id)?.lastToolGroups, undefined, '非数组字段按旧 session 处理');

    writeFileSync(sessionFile, '{broken-json', 'utf8');
    assert.equal(loadSession(id), null, '整份 session 损坏时应 fail closed');
  } finally {
    config.sessionDir = previousSessionDir;
    rmSync(root, { recursive: true, force: true });
  }
});
