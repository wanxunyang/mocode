import type { Key } from 'node:readline';

export interface SlashCommand {
  /** 当前菜单层显示的名称。根节点通常以 / 开头，子节点使用相对名称。 */
  name: string;
  desc: string;
  /** 叶子节点实际写入输入框的命令；默认使用从根节点拼出的路径。 */
  value?: string;
  /** false 表示选择后只补全、不立即提交，供需要继续输入参数的命令使用。 */
  submit?: boolean;
  /** 子菜单；存在时 Enter/Tab 进入下一层，而不是提交当前节点。 */
  children?: SlashCommand[];
}

export interface SlashMenuItem {
  node: SlashCommand;
  /** 从根节点拼出的菜单路径，例如 /model switch。 */
  input: string;
}

/** 输入框里的一段内容。frozen=false 是可编辑文本(可含换行)；frozen=true 是只读粘贴块(原子,
 *  提交时拼回原文)。整篇输入是 Seg[]：可编辑段与粘贴块交替，光标永远落在某个可编辑段上。
 *  多个粘贴块之间夹的可编辑段就是「粘贴之间敲的字」，可直接编辑——这是相对旧版单 chip 模型的核心改进。 */
export interface Seg {
  frozen: boolean;
  text: string;
}

export interface PromptOpts {
  /** 纯文本 prompt(无 ANSI),如 '❯ '。 */
  prompt: string;
  /** 斜杠命令列表,仅用于菜单显示与过滤。 */
  commands: SlashCommand[];
  /** 预填初始行(运行中 typeahead 缓冲 → 下一轮 INPUT 态预填);光标置末行末尾。 */
  initialLines?: string[];
  /**
   * 历史 query 候选(最近在前),供 Ctrl+R / Ctrl+P 模糊搜索面板用;不传则不启用该面板。
   * 可传数组,也可传工厂函数(惰性求值)——跨会话聚合要扫盘,仅在面板真正打开时才调。
   */
  history?: readonly string[] | (() => readonly string[]);
  /** Shift+Tab 循环切换 agent 模式(auto ↔ plan)的回调;repl 注入(翻 agentMode + 重写 history[0] + 设状态行 modeTag)。回调后 prompt 自调 redraw() 刷新底栏。 */
  onCycleMode?: () => void;
}

/** emitKeypressEvents 后 stdin 会发 'keypress',但该事件不在 ReadStream 类型里,单独声明。 */
export interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(
    event: 'keypress',
    listener: (str: string, key: Key) => void
  ): this;
}

export interface SessionPickerItem {
  id: string;
  title: string;
  subtitle?: string;
}
