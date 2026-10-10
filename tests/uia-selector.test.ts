/**
 * UIA 选择器纯函数单测(design-notes/computer-use-rpa.md §2.3/§2.9)。
 * 基于 JSON fixture 树离线跑,不碰 COM/进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelector,
  clearElementRefNames,
  formatSnapshot,
  isInteractive,
  isStableAutomationId,
  lookupElementRefName,
  matchSelector,
  parseRawTree,
  rectCenter,
  rectToNorm,
  selectDisplayNodes,
  setElementRefNames,
  type UiaRawTree,
} from '../src/runtime/uia-selector.js';

type N = {
  parent: number;
  role: string;
  name?: string;
  automationId?: string;
  patterns?: string[];
  rect?: { x: number; y: number; w: number; h: number };
  isPassword?: boolean;
  value?: string;
  offscreen?: boolean;
};

/** 用简写节点表构造树;depth/path 由 parent 推导。 */
function makeTree(defs: N[], processName = 'notepad', title = '无标题 - 记事本'): UiaRawTree {
  const depth: number[] = [];
  const pathOf: string[] = [];
  const childCount = new Map<number, number>();
  const nodes = defs.map((d, i) => {
    if (i === 0) {
      depth[0] = 0;
      pathOf[0] = '';
    } else {
      const k = childCount.get(d.parent) ?? 0;
      childCount.set(d.parent, k + 1);
      depth[i] = depth[d.parent] + 1;
      pathOf[i] = pathOf[d.parent] ? `${pathOf[d.parent]}.${k}` : String(k);
    }
    return {
      parent: i === 0 ? -1 : d.parent,
      path: pathOf[i],
      depth: depth[i],
      role: d.role,
      name: d.name ?? '',
      automationId: d.automationId ?? '',
      className: '',
      rect: d.rect ?? { x: 10 * i, y: 10 * i, w: 20, h: 10 },
      enabled: true,
      offscreen: d.offscreen ?? false,
      isPassword: d.isPassword ?? false,
      patterns: d.patterns ?? [],
      value: d.value,
    };
  });
  return parseRawTree({
    window: { hwnd: 42, title, processName, pid: 7, rect: { x: 0, y: 0, w: 1000, h: 800 } },
    nodes,
    truncated: false,
    elapsedMs: 5,
  });
}

// 记事本式:菜单栏 + 编辑区 + 两个同名列表项(只靠 index 区分)。
const NOTEPAD = makeTree([
  { parent: -1, role: 'Window', name: '无标题 - 记事本' }, // 0
  { parent: 0, role: 'MenuBar', name: '应用程序', automationId: 'MenuBar' }, // 1
  { parent: 1, role: 'MenuItem', name: '文件', patterns: ['expand'] }, // 2
  { parent: 1, role: 'MenuItem', name: '编辑', patterns: ['expand'] }, // 3
  { parent: 0, role: 'Document', name: '文本编辑器', automationId: '15', patterns: ['value'], value: 'hello' }, // 4
  { parent: 0, role: 'List', name: '最近' }, // 5
  { parent: 5, role: 'ListItem', name: 'a.txt' }, // 6
  { parent: 5, role: 'ListItem', name: 'a.txt' }, // 7
  { parent: 0, role: 'Pane', name: '' }, // 8
  { parent: 8, role: 'Button', name: '关闭', automationId: 'Close', patterns: ['invoke'] }, // 9
]);

test('isStableAutomationId: 纯数字与 GUID 视为不稳定', () => {
  assert.equal(isStableAutomationId('Close'), true);
  assert.equal(isStableAutomationId('15'), false);
  assert.equal(isStableAutomationId(''), false);
  assert.equal(isStableAutomationId('{3F2504E0-4F89-11D3-9A0C-0305E82C3301}'), false);
});

test('buildSelector: 稳定 automationId 优先,且省略无区分度的祖先', () => {
  const sel = buildSelector(NOTEPAD, 9)!;
  assert.deepEqual(sel.path, [{ role: 'Button', automationId: 'Close' }]);
  assert.equal(sel.window.processName, 'notepad');
  assert.equal(matchSelector(NOTEPAD, sel)?.id, 9);
});

test('buildSelector: 自增数字 id 回退到 role+name', () => {
  const sel = buildSelector(NOTEPAD, 4)!;
  assert.deepEqual(sel.path, [{ role: 'Document', name: '文本编辑器' }]);
});

test('buildSelector: 重名兄弟用 index 补位,并能各自命中', () => {
  const s6 = buildSelector(NOTEPAD, 6)!;
  const s7 = buildSelector(NOTEPAD, 7)!;
  assert.equal(s6.path.at(-1)?.index, 0);
  assert.equal(s7.path.at(-1)?.index, 1);
  assert.equal(matchSelector(NOTEPAD, s6)?.id, 6);
  assert.equal(matchSelector(NOTEPAD, s7)?.id, 7);
});

test('buildSelector: 根节点或越界 id 返回 null', () => {
  assert.equal(buildSelector(NOTEPAD, 0), null);
  assert.equal(buildSelector(NOTEPAD, 99), null);
});

test('matchSelector: 无 index 的歧义匹配返回 null,宁可失败不点错', () => {
  const sel = { window: { processName: 'notepad' }, path: [{ role: 'ListItem', name: 'a.txt' }] };
  assert.equal(matchSelector(NOTEPAD, sel), null);
});

test('matchSelector: 窗口进程不符返回 null(大小写不敏感)', () => {
  const sel = buildSelector(NOTEPAD, 9)!;
  assert.equal(matchSelector(NOTEPAD, { ...sel, window: { processName: 'NOTEPAD' } })?.id, 9);
  assert.equal(matchSelector(NOTEPAD, { ...sel, window: { processName: 'calc' } }), null);
});

test('matchSelector: 布局变化(插入新容器层)后选择器仍能定位', () => {
  const sel = buildSelector(NOTEPAD, 9)!;
  const shifted = makeTree([
    { parent: -1, role: 'Window', name: '无标题 - 记事本' },
    { parent: 0, role: 'Pane', name: 'wrapper' },
    { parent: 1, role: 'Pane', name: '' },
    { parent: 2, role: 'Button', name: '关闭', automationId: 'Close', patterns: ['invoke'] },
  ]);
  assert.equal(matchSelector(shifted, sel)?.id, 3);
});

test('matchSelector: 非法 nameRegex 不抛错,视为不匹配', () => {
  const sel = { window: { processName: 'notepad' }, path: [{ nameRegex: '([' }] };
  assert.equal(matchSelector(NOTEPAD, sel), null);
});

test('parseRawTree: 单元素数组标量化与密码 value 双保险', () => {
  const tree = parseRawTree({
    window: { processName: 'app', title: 't' },
    nodes: {
      parent: -1,
      role: 'Window',
      name: 'w',
      patterns: 'invoke',
      isPassword: true,
      value: 'secret',
    },
  });
  assert.equal(tree.nodes.length, 1);
  assert.deepEqual(tree.nodes[0].patterns, ['invoke']);
  assert.equal(tree.nodes[0].value, undefined);
  assert.throws(() => parseRawTree({ nodes: [] }), /empty element tree/);
});

test('isInteractive / selectDisplayNodes: 过滤容器、离屏与空矩形,按序编号', () => {
  const tree = makeTree([
    { parent: -1, role: 'Window' },
    { parent: 0, role: 'Pane' },
    { parent: 0, role: 'Button', name: 'ok' },
    { parent: 0, role: 'Button', name: 'hidden', offscreen: true },
    { parent: 0, role: 'Button', name: 'empty', rect: { x: 0, y: 0, w: 0, h: 0 } },
    { parent: 0, role: 'Custom', name: 'x', patterns: ['toggle'] },
  ]);
  assert.equal(isInteractive(tree.nodes[1]), false);
  const { items, truncated } = selectDisplayNodes(tree, 10);
  assert.deepEqual(
    items.map((i) => [i.ref, i.node.name]),
    [
      ['e1', 'ok'],
      ['e2', 'x'],
    ],
  );
  assert.equal(truncated, false);
  assert.equal(selectDisplayNodes(tree, 1).truncated, true);
});

test('rectToNorm / rectCenter: 叠加多屏原点换算', () => {
  const g = { physW: 2000, physH: 1000, originX: 100, originY: 50 };
  assert.deepEqual(rectToNorm({ x: 100, y: 50, w: 200, h: 100 }, g), [0, 0, 100, 100]);
  assert.deepEqual(rectToNorm({ x: 1100, y: 550, w: 20, h: 10 }, g), [500, 500, 10, 10]);
  assert.deepEqual(rectCenter({ x: 10, y: 20, w: 30, h: 41 }), [25, 41]);
});

test('formatSnapshot: 头部、norm 矩形、value、sparse 与浏览器提示', () => {
  const g = { physW: 1000, physH: 1000, originX: 0, originY: 0 };
  const { items, truncated } = selectDisplayNodes(NOTEPAD, 120);
  const text = formatSnapshot(NOTEPAD, items, { generation: 3, truncated, maxNodes: 120, geometry: g });
  assert.match(text, /^UI elements of window "无标题 - 记事本" \(notepad\.exe\), generation 3, \d+ nodes/);
  assert.match(text, /Document {2}"文本编辑器" value="hello"/);
  assert.match(text, /Button {2}"关闭" {2}\[90, 90, 20, 10\] {2}invoke/);
  assert.doesNotMatch(text, /sparse/);

  const sparse = makeTree(
    [
      { parent: -1, role: 'Window' },
      { parent: 0, role: 'Button', name: 'x' },
    ],
    'chrome',
    'G',
  );
  const s = selectDisplayNodes(sparse, 120);
  const out = formatSnapshot(sparse, s.items, { generation: 1, truncated: false, maxNodes: 120, geometry: g });
  assert.match(out, /UIA tree is sparse/);
  assert.match(out, /prefer the browser tool/);
});

test('ref 名称登记表: 整体替换且可清空', () => {
  const { items } = selectDisplayNodes(NOTEPAD, 120);
  setElementRefNames(items);
  const close = items.find((i) => i.node.name === '关闭')!;
  assert.deepEqual(lookupElementRefName(close.ref), { role: 'Button', name: '关闭' });
  setElementRefNames(items.slice(0, 1));
  assert.equal(lookupElementRefName(close.ref), undefined);
  clearElementRefNames();
  assert.equal(lookupElementRefName('e1'), undefined);
});
