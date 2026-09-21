/**
 * GUI 动作台账(L2)单测 —— design-notes/vision-window.md Part 10。
 *
 * 锁定的契约:
 *   - §10.2 复用 computer 既有 output 文本构成一行"意图 + 观察",不开新采集通道;
 *   - §10.5 语义纪律:"no visible change" 不升级成成功断言(保留现成措辞,无显式状态位);
 *   - §10.4(3) 有界:只留最近 24 条,序号单调递增(裁剪后不回退);
 *   - §10.4(4)(b) 写入失败静默:不影响 computer 动作本身;
 *   - §10.3 独立文件:台账写入不得触碰 notes.md(否则污染 mtime 信号与 plan nag)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { setCurrentSessionId } from '../src/session/state.js';
import {
  GUI_ACTIONS_FILENAME,
  GUI_ACTIONS_MAX_ENTRIES,
  appendGuiAction,
  buildGuiActionsSection,
  countGuiActions,
  formatGuiActionLine,
  getGuiActionsFilePath,
  parseComputerOutput,
  readGuiActionEntries,
} from '../src/session/gui-actions.js';

const SESSION_ID = 'gui-actions-test-session';
let tmpRoot = '';
let prevRoot: string | null = null;

/** 差分命中:和既有 observation 后缀一致(computer.ts:634-637 的措辞,阈值 2%)。 */
const NO_CHANGE = (summary: string, diff = '1.20'): string =>
  `${summary}. No visible change on screen (frame diff ${diff}% < 2.00% threshold) — no new screenshot is attached; ` +
  'the previous screenshot is still current. If you expected a change, the action likely did not take effect: ' +
  're-check the target coordinates or try a different approach.';

const RE_CAPTURED = (summary: string): string =>
  `${summary}. Screen re-captured (primary screen 1920×1080 physical, shown at 960×540): ` +
  'inspect the attached screenshot to verify the result before the next action.';

function sessionDir(): string {
  return path.join(tmpRoot, '.mocode', 'sessions', SESSION_ID);
}

function ledgerPath(): string {
  return path.join(sessionDir(), GUI_ACTIONS_FILENAME);
}

function notesPath(): string {
  return path.join(sessionDir(), 'notes.md');
}

function writeNotes(content: string): void {
  fs.writeFileSync(notesPath(), content, 'utf8');
}

function setup(): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-gui-actions-'));
  prevRoot = setSandboxRoot(tmpRoot);
  setCurrentSessionId(SESSION_ID, tmpRoot);
}

function teardown(): void {
  setSandboxRoot(prevRoot);
  setCurrentSessionId(undefined, tmpRoot);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test('parseComputerOutput: 回灌分支 → intent + re-captured', () => {
  const entry = parseComputerOutput(RE_CAPTURED('left_click at (512, 300)'));
  assert.deepEqual(entry, { intent: 'left_click (512, 300)', observation: 're-captured' });
});

test('parseComputerOutput: 差分命中分支保留 no visible change 措辞并带上 diff', () => {
  const entry = parseComputerOutput(NO_CHANGE('pressed key combo "ctrl+s"'));
  assert.equal(entry?.intent, 'key "ctrl+s"');
  assert.equal(entry?.observation, 'no visible change, diff 1.20%');
});

test('parseComputerOutput: type 只报字符数,不回显明文', () => {
  const entry = parseComputerOutput(RE_CAPTURED('typed 18 characters'));
  assert.deepEqual(entry, { intent: 'type 18 chars', observation: 're-captured' });
});

test('parseComputerOutput: mouse_move / drag / scroll / wait / screenshot / zoom', () => {
  assert.equal(parseComputerOutput(RE_CAPTURED('moved cursor to (10, 20)'))?.intent, 'mouse_move (10, 20)');
  assert.equal(
    parseComputerOutput(RE_CAPTURED('dragged from (100, 200) to (300, 400)'))?.intent,
    'drag (100, 200) -> (300, 400)',
  );
  assert.equal(
    parseComputerOutput(RE_CAPTURED('scrolled down by 3 at (640, 360)'))?.intent,
    'scroll down 3 (640, 360)',
  );
  assert.equal(parseComputerOutput(RE_CAPTURED('waited 500ms'))?.intent, 'wait 500ms');
  assert.equal(parseComputerOutput('Zoomed into region [0,0,100,100] → screenshot pixels …')?.intent, 'zoom');
  assert.equal(parseComputerOutput('Screenshot captured (primary screen 1920×1080 physical …).')?.intent, 'screenshot');
});

test('parseComputerOutput: 失败动作也入账(记 error,不静默丢弃)', () => {
  const entry = parseComputerOutput('computer action failed: capture backend unavailable');
  assert.equal(entry?.intent, 'failed');
  assert.match(entry?.observation ?? '', /^error: capture backend unavailable$/);
});

test('parseComputerOutput: 非 computer 输出/空串返 null', () => {
  assert.equal(parseComputerOutput(''), null);
  assert.equal(parseComputerOutput('some unrelated tool output'), null);
});

test('appendGuiAction: 逐条追加并保持最近 N 条上界,序号单调递增', () => {
  setup();
  try {
    const total = GUI_ACTIONS_MAX_ENTRIES + 6;
    for (let i = 0; i < total; i++) {
      appendGuiAction(RE_CAPTURED(`left_click at (${i * 10}, 0)`));
    }
    const lines = readGuiActionEntries();
    assert.equal(lines.length, GUI_ACTIONS_MAX_ENTRIES, '超过上界只保留最近 N 条');
    const lastSeq = Number(/^(\d+)\./.exec(lines[lines.length - 1])?.[1]);
    const firstSeq = Number(/^(\d+)\./.exec(lines[0])?.[1]);
    assert.equal(lastSeq, total, '序号等于动作总数(裁剪后不回退)');
    assert.equal(firstSeq, total - GUI_ACTIONS_MAX_ENTRIES + 1);
    assert.equal(countGuiActions(), GUI_ACTIONS_MAX_ENTRIES);
  } finally {
    teardown();
  }
});

test('appendGuiAction: 写盘失败静默(会话目录被同名文件占用)', () => {
  setup();
  try {
    // 会话 id 对应的路径被占成一个**普通文件** → mkdir/writeFileSync 抛 ENOTDIR,
    // 台账必须吞掉,不得把异常抛回 computer 动作。
    fs.mkdirSync(path.join(tmpRoot, '.mocode', 'sessions'), { recursive: true });
    fs.writeFileSync(sessionDir(), 'not a directory', 'utf8');
    assert.equal(appendGuiAction(RE_CAPTURED('left_click at (1, 1)')), 0, '写失败返 0 且不抛');
    assert.equal(readGuiActionEntries().length, 0);
  } finally {
    teardown();
  }
});

test('appendGuiAction: 不触碰 notes.md(mtime 是 plan nag 的信号,不能被台账污染)', () => {
  setup();
  try {
    fs.mkdirSync(sessionDir(), { recursive: true });
    const original = '## Plan: keep prefix stable\n### Steps\n- [ ] 1. verify\n';
    writeNotes(original);
    const before = fs.statSync(notesPath());
    appendGuiAction(NO_CHANGE('left_click at (42, 42)'));
    appendGuiAction(RE_CAPTURED('typed 5 characters'));
    const after = fs.statSync(notesPath());
    assert.equal(fs.readFileSync(notesPath(), 'utf8'), original, 'notes.md 内容不变');
    assert.equal(after.mtimeMs, before.mtimeMs, 'notes.md mtime 不变');
    assert.ok(fs.existsSync(ledgerPath()), '台账落在独立文件 gui-actions.log');
  } finally {
    teardown();
  }
});

test('buildGuiActionsSection: 有台账时输出段 + 像素优先纪律;空台账返空串', () => {
  setup();
  try {
    assert.equal(buildGuiActionsSection(), '', '空台账零开销');
    appendGuiAction(NO_CHANGE('left_click at (512, 300)'));
    appendGuiAction(RE_CAPTURED('typed 18 characters'));
    const section = buildGuiActionsSection();
    assert.match(section, /^## GUI actions \(most recent last; from the live action ledger\)/);
    assert.match(section, /1\. left_click \(512, 300\)\s+→ no visible change, diff 1\.20%/);
    assert.match(section, /2\. type 18 chars\s+→ re-captured/);
    assert.match(section, /the screenshot wins/, '必须带「像素优先」的纪律说明(§10.5)');
  } finally {
    teardown();
  }
});

test('formatGuiActionLine: 意图列对齐到固定宽度', () => {
  const short = formatGuiActionLine(7, { intent: 'key "ctrl+s"', observation: 'no visible change' });
  const long = formatGuiActionLine(8, { intent: 'drag (100, 200) -> (300, 400)', observation: 're-captured' });
  assert.match(short, /^7\. key "ctrl\+s"\s+→ no visible change$/);
  assert.match(long, /^8\. drag \(100, 200\) -> \(300, 400\) → re-captured$/, '超长意图退化为一个空格分隔');
});

test('getGuiActionsFilePath: 与 notes.md 同目录;无会话时返 null', () => {
  setup();
  try {
    assert.equal(getGuiActionsFilePath(), ledgerPath());
    setCurrentSessionId(undefined, tmpRoot);
    assert.equal(getGuiActionsFilePath(), null);
  } finally {
    teardown();
  }
});
