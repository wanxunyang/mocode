/**
 * list_windows / focus_window 纯逻辑单测(design-notes/computer-use-rpa.md §4.4)。
 * 用 fixture 数据,不碰 Win32。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWindowList,
  parseRawWindows,
  pickWindow,
  LIST_WINDOWS_MAX,
  LIST_WINDOWS_OUTPUT_PREFIX,
  type RawWindow,
} from '../src/runtime/window-list.js';

const GEO = { physW: 1920, physH: 1080, originX: 0, originY: 0 };

function win(over: Partial<RawWindow> & { hwnd: number }): RawWindow {
  return {
    title: `win-${over.hwnd}`,
    processName: 'app',
    pid: 100 + over.hwnd,
    rect: { x: 0, y: 0, w: 960, h: 540 },
    minimized: false,
    foreground: false,
    toolWindow: false,
    cloaked: false,
    ...over,
  };
}

test('formatWindowList: 过滤空标题 / 工具窗口 / cloaked,编号连续', () => {
  const raw = [
    win({ hwnd: 1, title: '记事本', processName: 'notepad', foreground: true }),
    win({ hwnd: 2, title: '' }),
    win({ hwnd: 3, title: 'Tray popup', toolWindow: true }),
    win({ hwnd: 4, title: 'Other desktop', cloaked: true }),
    win({ hwnd: 5, title: 'Explorer', processName: 'explorer' }),
  ];
  const { items, text } = formatWindowList(raw, GEO);
  assert.deepEqual(
    items.map((i) => [i.ref, i.hwnd]),
    [
      ['w1', 1],
      ['w2', 5],
    ],
  );
  assert.ok(text.startsWith(`${LIST_WINDOWS_OUTPUT_PREFIX}2`));
  assert.match(text, /w1 notepad\.exe "记事本" rect=\[0, 0, 500, 500\] \(foreground\)/);
  assert.doesNotMatch(text, /Tray popup|Other desktop/);
});

test('formatWindowList: 最小化窗口不给矩形,标 minimized', () => {
  const { items, text } = formatWindowList(
    [win({ hwnd: 1, minimized: true, rect: { x: -32000, y: -32000, w: 160, h: 28 } })],
    GEO,
  );
  assert.equal(items[0].norm, null);
  assert.equal(items[0].onPrimary, false);
  assert.match(text, /\(minimized\)/);
  assert.doesNotMatch(text, /rect=/);
});

test('formatWindowList: 副屏窗口标 on secondary display,且无 norm 矩形', () => {
  const { items, text } = formatWindowList([win({ hwnd: 1, rect: { x: 2000, y: 100, w: 800, h: 600 } })], GEO);
  assert.equal(items[0].onPrimary, false);
  assert.equal(items[0].norm, null);
  assert.match(text, /on secondary display/);
});

test('formatWindowList: 主屏原点非零(多屏)时按中心点判断归属并按原点换算', () => {
  const g = { physW: 1920, physH: 1080, originX: 1920, originY: 0 };
  const { items } = formatWindowList([win({ hwnd: 1, rect: { x: 1920, y: 0, w: 960, h: 540 } })], g);
  assert.equal(items[0].onPrimary, true);
  assert.deepEqual(items[0].norm, [0, 0, 500, 500]);
});

test('formatWindowList: 超过上限截断并提示', () => {
  const raw = Array.from({ length: LIST_WINDOWS_MAX + 5 }, (_, i) => win({ hwnd: i + 1 }));
  const { items, truncated, text } = formatWindowList(raw, GEO);
  assert.equal(items.length, LIST_WINDOWS_MAX);
  assert.equal(truncated, true);
  assert.match(text, new RegExp(`first ${LIST_WINDOWS_MAX} shown`));
});

test('formatWindowList: 无窗口时给出明确文案', () => {
  const { items, text } = formatWindowList([], GEO);
  assert.equal(items.length, 0);
  assert.match(text, /no top-level windows/);
});

test('pickWindow: 按 ref 选择;未知 ref 报错并提示重新 list', () => {
  const { items } = formatWindowList([win({ hwnd: 1, title: 'A' }), win({ hwnd: 2, title: 'B' })], GEO);
  const ok = pickWindow(items, { ref: 'w2' });
  assert.ok(ok.ok && ok.item.hwnd === 2);
  const bad = pickWindow(items, { ref: 'w9' });
  assert.ok(!bad.ok && /list_windows/.test(bad.error));
});

test('pickWindow: title_regex 唯一命中(忽略大小写)', () => {
  const { items } = formatWindowList([win({ hwnd: 1, title: 'Notepad' }), win({ hwnd: 2, title: 'Explorer' })], GEO);
  const r = pickWindow(items, { titleRegex: 'notepad$' });
  assert.ok(r.ok && r.item.hwnd === 1);
});

test('pickWindow: title_regex 多匹配返回歧义错误并列出候选,不取第一个', () => {
  const { items } = formatWindowList(
    [win({ hwnd: 1, title: 'doc1 - Word' }), win({ hwnd: 2, title: 'doc2 - Word' })],
    GEO,
  );
  const r = pickWindow(items, { titleRegex: 'Word' });
  assert.ok(!r.ok);
  assert.match(r.error, /ambiguous/);
  assert.match(r.error, /w1/);
  assert.match(r.error, /w2/);
});

test('pickWindow: 无匹配 / 非法正则 / 缺选择器', () => {
  const { items } = formatWindowList([win({ hwnd: 1, title: 'A' })], GEO);
  const none = pickWindow(items, { titleRegex: 'zzz' });
  assert.ok(!none.ok && /no window title matches/.test(none.error));
  const invalid = pickWindow(items, { titleRegex: '(' });
  assert.ok(!invalid.ok && /not a valid regular expression/.test(invalid.error));
  const missing = pickWindow(items, {});
  assert.ok(!missing.ok && /required/.test(missing.error));
});

test('parseRawWindows: 单对象(PowerShell 单元素数组被展开)与缺字段容错', () => {
  const one = parseRawWindows({
    windows: { hwnd: 7, title: 'T', processName: 'p', pid: 3, rect: { x: 1, y: 2, w: 3, h: 4 }, minimized: true },
  });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].rect, { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(one[0].minimized, true);
  assert.equal(one[0].toolWindow, false);

  assert.deepEqual(parseRawWindows({}), []);
  assert.deepEqual(parseRawWindows({ windows: [null, { title: 'no hwnd' }] }), []);
});
