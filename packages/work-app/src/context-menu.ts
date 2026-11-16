/**
 * 右键菜单的**决策**部分（纯函数，主进程消费）。
 *
 * 为什么单独抽出来：Electron 默认不弹任何右键菜单，用户在会话里拖选一段回答后右键完全没反应。
 * 补这块时唯一容易做错的是「什么时候该弹」—— 满屏右键都弹「全选」会让人以为点错了东西，
 * 而弹了菜单却没有可用项比不弹更糟。这段判断值得被测试钉住，而 Menu 本身在无头环境里造不出来。
 *
 * 与渲染层的分工：xterm 终端面板自己 `preventDefault` 了 contextmenu（选区复制/无选区粘贴），
 * 实测渲染层 preventDefault 后主进程的 `context-menu` 事件**不会触发**，两者不会双弹。
 */

/** 菜单项标识（主进程据此接 webContents 的原生动作）。 */
export type ContextMenuItemId = 'cut' | 'copy' | 'paste' | 'selectAll' | 'separator';

export interface ContextMenuItem {
  id: ContextMenuItemId;
  /** 置灰（例如输入框为空时的「复制」）。分隔线恒为 false。 */
  disabled?: boolean;
}

/** 决策只需要这几个字段 —— 与 Electron 的 ContextMenuParams 子集同名，便于直接传入。 */
export interface ContextMenuInput {
  isEditable: boolean;
  selectionText: string;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/**
 * 决定右键菜单显示哪些项。
 *
 * 规则：
 *  - 可编辑（输入框 / composer）：剪切 / 复制 / 粘贴 / 全选（按 editFlags 置灰）；
 *  - 不可编辑但有选中文字（回答正文、代码块、diff）：复制 / 全选；
 *  - 其余（图标、空白、无选中的工具行）：空数组 = 不弹菜单。
 */
export function contextMenuPlan(input: ContextMenuInput): ContextMenuItem[] {
  const flags = input.editFlags;
  if (input.isEditable) {
    return [
      { id: 'cut', disabled: !flags.canCut },
      { id: 'copy', disabled: !flags.canCopy },
      { id: 'paste', disabled: !flags.canPaste },
      { id: 'separator' },
      { id: 'selectAll', disabled: !flags.canSelectAll },
    ];
  }
  if (input.selectionText.trim()) {
    return [
      { id: 'copy' },
      { id: 'separator' },
      { id: 'selectAll', disabled: !flags.canSelectAll },
    ];
  }
  return [];
}