// 从 ui/layout.ts 提取的类型定义
export interface Geo {
  rows: number;
  cols: number;
  footerH: number;
  contentTop: number; // 恒 1
  contentBottom: number; // rows - footerH
}

export interface StatusBarData {
  model: string;
  contextBar: string; // 调用方用 renderContextBarInline 算好的带色串
  cwd: string;
  status: string; // '空闲' | '思考中' | '执行 read_file' …
  spinnerFrame?: string; // 可选 spinner 帧(运行态)
  modeTag?: string; // 模式标识:repl 传 'Auto' / 'Plan'(两段式布局左段显示)
  /** 活跃 plan 短摘要(无 plan=undefined,空串=有 plan 但 chip 不显)。repl 透传 getActivePlanSummary()。 */
  planSummary?: string;
  /** 本轮最后一条 token 用量(modeTag chip 右边显示)。后端不开 include_usage 时 undefined。
   *  cachedTokens 可选 —— 后端未报或老 ChatUsage 字面量不带此字段时 UI 不会显示缓存标记。 */
  lastTurnUsage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
}

export interface InputView {
  prompt: string; // 纯文本 prompt(无 ANSI),如 '❯ '
  lines: string[]; // 全部输入行(prompt.ts 持有,layout 负责按高度开窗)
  cursorLine: number; // 0-based,lines 内行号
  cursorCol: number; // 显示宽度列(0-based)
  menu: { lines: string[] } | null; // 预渲染菜单行(带色),向上展开进内容区底
  dim?: boolean; // true=运行态占位(整行 dim)
  placeholder?: string; // dim 态:无打字时的 ghost 占位文本(画在光标右侧);INPUT 态:缓冲为空时的 dim 引导占位(画在 prompt 右侧,prompt.ts 传入)
}
