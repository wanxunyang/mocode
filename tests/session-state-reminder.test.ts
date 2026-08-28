/**
 * buildSessionStateReminder 单测(prompt 缓存改造)。
 *
 * 背景:会话状态(活跃 plan + 笔记正文)以前由 reinjectSessionStateIntoSystem 追加进
 * history[0],每次 plan_update / note_append 都会改动系统提示,让支持自动前缀缓存的后端
 * 从第一个 token 起全部 miss。现改为 agent/core 每步在 requestHistory **末尾**注入一条
 * ephemeral system 消息,本文件锁定该函数的契约:
 *   - 同时含活跃 Plan 段与笔记段正文;
 *   - Done: 段(已结算 plan)不注入;
 *   - 无 notes.md / 空文件 → 返回 ''(零开销,core 此时不追加任何消息);
 *   - 纯读:不写文件、不改传入的 history。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { setCurrentSessionId } from '../src/session/state.js';
import { buildSessionStateReminder } from '../src/config/index.js';

const SESSION_ID = 'reminder-test-session';
let tmpRoot = '';

function notesPath(): string {
  return path.join(tmpRoot, '.mocode', 'sessions', SESSION_ID, 'notes.md');
}

function writeNotes(content: string): void {
  fs.mkdirSync(path.dirname(notesPath()), { recursive: true });
  fs.writeFileSync(notesPath(), content, 'utf8');
}

function setup(): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-reminder-'));
  setSandboxRoot(tmpRoot);
  setCurrentSessionId(SESSION_ID, tmpRoot);
}

function teardown(): void {
  setSandboxRoot(null);
  setCurrentSessionId(undefined, tmpRoot);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('buildSessionStateReminder: 同时注入活跃 Plan 段与笔记段正文', () => {
  setup();
  try {
    writeNotes(
      '## Plan: ship prefix cache fix\n'
      + 'Goal: stable prefix\n'
      + '### Steps\n'
      + '- [x] 1. add builder\n'
      + '- [ ] 2. wire core\n'
      + '\n'
      + '## Findings\n'
      + '- **[cache]** history[0] rewrite kills the whole prefix\n',
    );
    const out = buildSessionStateReminder();
    assert.match(out, /## Session state/);
    assert.match(out, /ship prefix cache fix/);
    assert.match(out, /wire core/);
    assert.match(out, /history\[0\] rewrite kills the whole prefix/);
  } finally { teardown(); }
});

test('buildSessionStateReminder: 只有笔记段(无 plan)时也注入', () => {
  setup();
  try {
    writeNotes('## Risks\n- token estimate may drift\n');
    const out = buildSessionStateReminder();
    assert.match(out, /token estimate may drift/);
  } finally { teardown(); }
});

test('buildSessionStateReminder: 已结算 plan(## Done:)不注入', () => {
  setup();
  try {
    writeNotes('## Done: finished work\n### Steps\n- [x] 1. all set\n');
    assert.equal(buildSessionStateReminder(), '');
  } finally { teardown(); }
});

test('buildSessionStateReminder: 无 notes.md / 空文件返回空串', () => {
  setup();
  try {
    assert.equal(buildSessionStateReminder(), '', 'notes.md 不存在时应返空串');
    writeNotes('');
    assert.equal(buildSessionStateReminder(), '', '空 notes.md 应返空串');
  } finally { teardown(); }
});

test('buildSessionStateReminder: 纯读——不改 history、不写 notes.md', () => {
  setup();
  try {
    const original = '## Plan: keep prefix stable\n### Steps\n- [ ] 1. verify\n';
    writeNotes(original);
    const history = [{ role: 'system', content: 'BASE PROMPT' }];
    const snapshot = JSON.stringify(history);
    const first = buildSessionStateReminder();
    const second = buildSessionStateReminder();
    assert.equal(first, second, '同一 notes.md 下多次调用结果应逐字节一致');
    assert.equal(JSON.stringify(history), snapshot, 'history 不应被改写');
    assert.equal(fs.readFileSync(notesPath(), 'utf8'), original, 'notes.md 不应被改写');
  } finally { teardown(); }
});
