import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import type { ChatMessage } from '../src/llm/index.js';

function makeStore(root: string): SessionStore {
  return new SessionStore({ sessionsRoot: root, workspaceRoot: root, getModel: () => 'test-model' });
}

test('session: fork 复制整个会话目录,新副本可独立 load 且原会话不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-session-fork-'));
  const store = makeStore(root);
  try {
    const oldId = '20261101-120000-000-aaaaaaaa';
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    store.save(history, oldId, ['hello'], ['workspace-write']);
    // notes.md(plan/笔记)与任意附属文件必须随目录复制
    writeFileSync(join(root, oldId, 'notes.md'), '## Plan: demo\n- [ ] 1. work', 'utf8');
    writeFileSync(
      join(root, oldId, 'snapshots.json'),
      JSON.stringify({ version: 2, turns: [], snapshots: [] }),
      'utf8',
    );

    const newId = store.forkSession(oldId);
    assert.ok(newId, '分叉应返回新 id');
    assert.notEqual(newId, oldId);

    // 副本与原件都存在;身份字段是新的
    assert.ok(existsSync(join(root, oldId, 'session.json')));
    const forked = store.load(newId!);
    assert.ok(forked);
    assert.equal(forked!.id, newId);
    assert.deepEqual(forked!.history, history);
    assert.deepEqual(forked!.queryHistory, ['hello']);
    assert.deepEqual(forked!.lastToolGroups, ['workspace-write']);
    assert.equal(forked!.createdAt.length > 0, true);

    // notes / snapshots 随目录复制
    assert.equal(readFileSync(join(root, newId!, 'notes.md'), 'utf8'), '## Plan: demo\n- [ ] 1. work');
    assert.ok(existsSync(join(root, newId!, 'snapshots.json')));

    // 原会话身份不变
    const original = store.load(oldId);
    assert.equal(original!.id, oldId);

    // currentSessionId 不被 fork 改动
    assert.equal(store.getCurrentSessionId(), undefined);

    // 新会话出现在列表最前(createdAt 更新)
    assert.equal(store.list(1)[0]?.id, newId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session: fork 把历史与文件里的旧路径指针重写到新 id', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-session-fork-ptr-'));
  const store = makeStore(root);
  try {
    const oldId = '20261101-120000-000-bbbbbbbb';
    const oldPtr = `.mocode/sessions/${oldId}/compacted/seg-001.md`;
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'check archive' },
      { role: 'assistant', content: `see ${oldPtr} for details` },
    ];
    store.save(history, oldId, [], []);
    // compacted 资产与 notes 里的旧路径指针都应被重写
    const compactedDir = join(root, oldId, 'compacted');
    mkdirSync(compactedDir, { recursive: true });
    writeFileSync(join(compactedDir, 'seg-001.md'), `pointer ${oldPtr}`, 'utf8');
    writeFileSync(join(root, oldId, 'trace.jsonl'), JSON.stringify({ asset: oldPtr }) + '\n', 'utf8');
    // .tmp 残留不进副本
    writeFileSync(join(root, oldId, 'session.json.tmp'), 'garbage', 'utf8');

    const newId = store.forkSession(oldId)!;
    const newPtr = `.mocode/sessions/${newId}/compacted/seg-001.md`;

    const forked = store.load(newId);
    assert.match(
      String((forked!.history[2] as { content: string }).content),
      new RegExp(newPtr.replace(/[.]/g, '\\.')),
    );
    assert.doesNotMatch(String((forked!.history[2] as { content: string }).content), /bbbbbbbb/);
    assert.equal(readFileSync(join(root, newId, 'compacted', 'seg-001.md'), 'utf8'), `pointer ${newPtr}`);
    assert.equal(readFileSync(join(root, newId, 'trace.jsonl'), 'utf8'), JSON.stringify({ asset: newPtr }) + '\n');
    assert.equal(existsSync(join(root, newId, 'session.json.tmp')), false);

    // 原会话指针保持原样
    const original = store.load(oldId);
    assert.equal((original!.history[2] as { content: string }).content, `see ${oldPtr} for details`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session: fork 源目录不存在时返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-session-fork-miss-'));
  const store = makeStore(root);
  try {
    assert.equal(store.forkSession('20261101-120000-000-cccccccc'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
