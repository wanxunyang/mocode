import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMenuPlan } from '../../packages/work-app/src/context-menu.js';

/**
 * 右键菜单的决策用例。钉三件事：
 *   1. 会话正文拖选后右键**必须**有「复制」（这就是用户报的那个「拉选区点右键没反应」）；
 *   2. 输入框里右键必须是完整的剪切/复制/粘贴；
 *   3. 没有选区、又不可编辑的地方不弹 —— 弹一个只有「全选」的菜单比不弹更让人困惑。
 */

const flags = (
  over: Partial<{ canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }> = {},
) => ({
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: true,
  ...over,
});

const ids = (items: ReturnType<typeof contextMenuPlan>) => items.map((item) => item.id);

test('会话正文有选区：复制 + 全选（不弹剪切/粘贴）', () => {
  const plan = contextMenuPlan({ isEditable: false, selectionText: '  一段回答  ', editFlags: flags() });
  assert.deepEqual(ids(plan), ['copy', 'separator', 'selectAll']);
  // disabled 缺省 = 可点；这里钉住「有选区时复制一定不是灰的」。
  assert.ok(!plan.find((item) => item.id === 'copy')?.disabled);
});

test('不可编辑且无选区：不弹菜单', () => {
  assert.deepEqual(contextMenuPlan({ isEditable: false, selectionText: '', editFlags: flags() }), []);
  // 只有空白也不算选区：整屏都是一个空格时弹「复制」只会把空串写进剪贴板。
  assert.deepEqual(contextMenuPlan({ isEditable: false, selectionText: ' \n\t ', editFlags: flags() }), []);
});

test('输入框（composer）：剪切/复制/粘贴/全选齐全，按 editFlags 置灰', () => {
  const plan = contextMenuPlan({
    isEditable: true,
    selectionText: 'abc',
    editFlags: flags({ canCut: true, canCopy: true, canPaste: true }),
  });
  assert.deepEqual(ids(plan), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
  assert.deepEqual(
    plan.filter((item) => item.id !== 'separator').map((item) => item.disabled),
    [false, false, false, false],
  );
});

test('空的输入框：粘贴仍可用，剪切/复制置灰', () => {
  const plan = contextMenuPlan({ isEditable: true, selectionText: '', editFlags: flags({ canPaste: true }) });
  assert.equal(plan.find((item) => item.id === 'cut')?.disabled, true);
  assert.equal(plan.find((item) => item.id === 'copy')?.disabled, true);
  assert.equal(plan.find((item) => item.id === 'paste')?.disabled, false);
});

test('可编辑但 editFlags.canSelectAll=false：全选置灰而不是消失', () => {
  const plan = contextMenuPlan({ isEditable: true, selectionText: '', editFlags: flags({ canSelectAll: false }) });
  assert.equal(plan.find((item) => item.id === 'selectAll')?.disabled, true);
});

test('可编辑优先于选区：输入框里选中文字也只给一套菜单，不重复复制项', () => {
  const plan = contextMenuPlan({ isEditable: true, selectionText: 'x', editFlags: flags({ canCopy: true }) });
  assert.equal(plan.filter((item) => item.id === 'copy').length, 1);
});
