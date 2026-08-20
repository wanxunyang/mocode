/**
 * note_append 工具 + 会话笔记常驻注入单测。
 * 覆盖:appendNoteToSection(新建/追加/保留其它段/非法段)、extractActiveNotesSections
 * (排除 Plan/Done、优先级排序、cap 裁剪)、note_append 工具 execute、
 * reinjectSessionNotesIntoSystem(注入/幂等/清空)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { setCurrentSessionId } from '../src/session/state.js';
import {
  appendNoteToSection,
  extractActiveNotesSections,
} from '../src/session/notes.js';
import { noteAppendTool } from '../src/tools/builtins/note-append.js';
import { reinjectSessionNotesIntoSystem } from '../src/config/index.js';
import type { ToolOutcome } from '../src/tools/types.js';

const SESSION_ID = 'note-test-session';
let tmpRoot = '';

function notesPath(): string {
  return path.join(tmpRoot, '.mocode', 'sessions', SESSION_ID, 'notes.md');
}

function readNotes(): string {
  try { return fs.readFileSync(notesPath(), 'utf8'); } catch { return ''; }
}

function writeNotes(content: string): void {
  fs.mkdirSync(path.dirname(notesPath()), { recursive: true });
  fs.writeFileSync(notesPath(), content, 'utf8');
}

function setup(): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-notes-'));
  setSandboxRoot(tmpRoot);
  setCurrentSessionId(SESSION_ID, tmpRoot);
}

function teardown(): void {
  setSandboxRoot(null);
  setCurrentSessionId(undefined, tmpRoot);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('appendNoteToSection: 文件不存在时创建并写入段+条目', () => {
  setup();
  try {
    const r = appendNoteToSection('findings', 'parser rejects CRLF', 'parser');
    assert.equal('path' in r, true);
    const content = readNotes();
    assert.match(content, /^## Findings/m);
    assert.match(content, /\*\*\[parser\]\*\* parser rejects CRLF/);
  } finally { teardown(); }
});

test('appendNoteToSection: 追加到已有段,Plan 段及其它段原样保留', () => {
  setup();
  try {
    writeNotes('## Plan: x\nGoal: g\n### Steps\n- [ ] 1. a\n\n## Findings\n- old finding\n');
    appendNoteToSection('findings', 'new finding');
    const content = readNotes();
    // Plan 段完整保留
    assert.match(content, /## Plan: x/);
    assert.match(content, /- \[ \] 1\. a/);
    // Findings 段追加:旧条目在,新条目在其后
    assert.match(content, /- old finding\n- new finding/);
  } finally { teardown(); }
});

test('appendNoteToSection: 段不存在时在文件末新建,不破坏已有段', () => {
  setup();
  try {
    writeNotes('## Plan: x\n### Steps\n- [ ] 1. a\n');
    appendNoteToSection('risks', 'API may change');
    const content = readNotes();
    assert.match(content, /## Plan: x/);
    assert.match(content, /## Risks/);
    assert.match(content, /- API may change/);
    // Risks 在 Plan 之后(文件末新建)
    assert.ok(content.indexOf('## Risks') > content.indexOf('## Plan: x'));
  } finally { teardown(); }
});

test('appendNoteToSection: 非法 section 返 error', () => {
  setup();
  try {
    const r = appendNoteToSection('bogus', 'x');
    assert.equal('error' in r, true);
  } finally { teardown(); }
});

test('extractActiveNotesSections: 排除 Plan/Done,按优先级 Risks 先于 Findings', () => {
  setup();
  try {
    writeNotes([
      '## Plan: x', '### Steps', '- [ ] 1. a', '',
      '## Findings', '- f1', '',
      '## Done: old', '- done item', '',
      '## Risks', '- r1', '',
      '## Decisions', '- d1', '',
    ].join('\n'));
    const out = extractActiveNotesSections();
    // Plan/Done 不注入
    assert.doesNotMatch(out, /## Plan:/);
    assert.doesNotMatch(out, /## Done:/);
    assert.doesNotMatch(out, /- done item/);
    // Risks 优先级最高,应排在 Findings 之前
    const risksIdx = out.indexOf('## Risks');
    const findingsIdx = out.indexOf('## Findings');
    assert.ok(risksIdx >= 0 && findingsIdx >= 0, 'Risks/Findings 段都应在');
    assert.ok(risksIdx < findingsIdx, 'Risks 应排在 Findings 之前(优先级高先注入)');
    // 各活跃段正文都在
    assert.match(out, /- f1/);
    assert.match(out, /- r1/);
    assert.match(out, /- d1/);
  } finally { teardown(); }
});

test('extractActiveNotesSections: 超预算时段内从最近条目保留,丢最旧', () => {
  setup();
  try {
    const longEntries = Array.from({ length: 50 }, (_, i) => `- entry ${i} ${'x'.repeat(200)}`);
    writeNotes(`## Findings\n${longEntries.join('\n')}\n`);
    // 小预算触发裁剪
    const out = extractActiveNotesSections(500);
    assert.match(out, /## Findings/);
    // 最近条目(entry 49)保留
    assert.match(out, /entry 49/);
    // 最旧条目(entry 0)被裁掉
    assert.doesNotMatch(out, /entry 0\b/);
  } finally { teardown(); }
});

test('extractActiveNotesSections: 无笔记段时返空串', () => {
  setup();
  try {
    writeNotes('## Plan: x\n### Steps\n- [ ] 1. a\n');
    const out = extractActiveNotesSections();
    assert.equal(out, '');
  } finally { teardown(); }
});

test('note_append 工具: 合法调用写入 notes.md 并返 success', async () => {
  setup();
  try {
    const out = await noteAppendTool.execute({ section: 'risks', entry: 'API may change', tag: 'api' }) as ToolOutcome;
    assert.equal(out.status, 'success');
    assert.match(out.output, /## Risks/);
    const content = readNotes();
    assert.match(content, /## Risks/);
    assert.match(content, /\*\*\[api\]\*\* API may change/);
  } finally { teardown(); }
});

test('note_append 工具: 非法 section 返 error', async () => {
  const out = await noteAppendTool.execute({ section: 'bogus', entry: 'x' }) as ToolOutcome;
  assert.equal(out.status, 'error');
});

test('note_append 工具: entry 为空返 error', async () => {
  const out = await noteAppendTool.execute({ section: 'findings', entry: '   ' }) as ToolOutcome;
  assert.equal(out.status, 'error');
});

test('note_append normalizeArguments: 单数/别名归一到预设 key', () => {
  const cases: Array<[string, string]> = [
    ['finding', 'findings'],
    ['Decision', 'decisions'],
    ['open_question', 'open_questions'],
    ['risks', 'risks'],
    ['question', 'open_questions'],
  ];
  for (const [raw, expected] of cases) {
    const args: Record<string, unknown> = { section: raw, entry: 'x' };
    noteAppendTool.normalizeArguments?.(args);
    assert.equal(args.section, expected, `section "${raw}" 应归一为 "${expected}"`);
  }
});

test('reinjectSessionNotesIntoSystem: 注入笔记段到 system,幂等不累积', () => {
  setup();
  try {
    writeNotes('## Findings\n- important constraint\n');
    const history: Array<{ role: string; content?: string }> = [{ role: 'system', content: 'BASE PROMPT' }];
    const changed = reinjectSessionNotesIntoSystem(history);
    assert.equal(changed, true);
    const c = String(history[0].content);
    assert.match(c, /important constraint/);
    assert.match(c, /session-notes/);
    // 再次注入:幂等,段正文只出现一次
    reinjectSessionNotesIntoSystem(history);
    const c2 = String(history[0].content);
    const matches = c2.match(/important constraint/g) ?? [];
    assert.equal(matches.length, 1, '幂等注入不应累积重复段');
    // BASE PROMPT 保留
    assert.match(c2, /BASE PROMPT/);
  } finally { teardown(); }
});

test('reinjectSessionNotesIntoSystem: 无笔记时清掉残留标记块', () => {
  setup();
  try {
    writeNotes('## Findings\n- constraint\n');
    const history: Array<{ role: string; content?: string }> = [{ role: 'system', content: 'BASE' }];
    reinjectSessionNotesIntoSystem(history); // 注入一次
    assert.match(String(history[0].content), /constraint/);
    // 清空 notes → 重注入应清掉标记块
    writeNotes('');
    reinjectSessionNotesIntoSystem(history);
    const c = String(history[0].content);
    assert.doesNotMatch(c, /constraint/);
    assert.doesNotMatch(c, /session-notes/);
    assert.match(c, /BASE/);
  } finally { teardown(); }
});

test('reinjectSessionNotesIntoSystem: history[0] 非 system 时安全返回 false', () => {
  setup();
  try {
    const history: Array<{ role: string; content?: string }> = [{ role: 'user', content: 'hi' }];
    const changed = reinjectSessionNotesIntoSystem(history);
    assert.equal(changed, false);
  } finally { teardown(); }
});
