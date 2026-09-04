// layout 共享可变状态单例。
//
// 全屏 TUI 的各职责模块(screen / content-write / scroll / statusbar / input-paint / mouse)
// 读写同一批游标与缓存:contentRow 由 content-write 写、scroll 与 input-paint 读;
// planRows 同时驱动 statusbar 撑高与 geo 重算。这种交叉引用做不成依赖注入(会立刻循环),
// 故收进单一对象,各模块 import 同一实例。
//
// 约定:
//  - 只放**可变**运行态。纯常量(esc 序列表 / SCROLL_LOCK_MS / RUNNING_FRAMES 等)留在使用它的模块。
//  - 字段按职责分组,组名与 layout-internal/ 下的文件划分对齐。
//  - 不要在模块顶层读 state 快照(如 `const x = state.scrollOffset`)——必须每次现取,
//    否则跨 await / 定时器会读到过期值。

import type * as mouse from '../mouse.js';
import type { InputView } from '../layout-types.js';

/** token 用量(后端不开 include_usage 时 cachedTokens 缺省)。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

/** 状态栏底料:repl 每轮 setStatusBase 写入,drawStatusBar 每次现读。 */
export interface StatusBase {
  model: string;
  contextBar: string; // 调用方用 renderContextBarInline 算好的带色串
  cwd: string;
  modeTag?: string; // 模式标识:repl 传 'Auto' / 'Plan'(两段式布局左段显示)
  /** 活跃 plan 短摘要(无 plan=undefined,空串=有 plan 但 chip 不显)。 */
  planSummary?: string;
  lastTurnUsage?: TokenUsage;
}

/** 内容区框选选区。以「绝对缓冲行索引 + 显示列」存(不用屏坐标)——
 *  滚动/追加新内容后 abs 索引仍稳定指向同段文字,故拖过多屏、触边自动翻页也能连续扩展。 */
export interface Selection {
  anchorLine: number; // 起点绝对行索引(content 快照 0-based)
  anchorCol: number; // 起点显示列(0-based)
  endLine: number;
  endCol: number;
  dragged: boolean; // 是否真拖动过(纯点击不复制,只清选区)
}

/**
 * 输入框反白选区:与内容区 selection 平行存在,坐标基于 lastView.lines(逻辑行 + display_col)。
 * - dragged=false 时是纯点击,松开后立即清掉(光标已定好,选区不必要)
 * - dragged=true 时保留高亮,等右键 release 复制;文本改动后由 paintInput 入口签名检测清空
 * 不参与内容区选区:两套选区互不污染,各自接自己的右键复制 / paste。
 */
export interface InputSelection {
  anchor: { line: number; col: number };
  end: { line: number; col: number };
  dragged: boolean;
}

export const state = {
  // ── 屏幕生命周期(alt screen / console 劫持 / resize / 退出钩子) ──
  active: false,
  consoleHookInstalled: false,
  mode: 'input' as 'input' | 'running',
  resizeTimer: null as NodeJS.Timeout | null,
  lastTerminalCols: 0,
  exitHandler: null as (() => void) | null,
  sigwinchHandler: null as (() => void) | null,

  // ── 几何(底栏高度,contentBottom = rows - footerH) ──
  footerH: 6, // 1 虚拟空行 + 1 spinner行 + 1 上线 + 输入行数 + 1 下线 + 1 model行(两行式底栏)

  // ── 内容写入(续写位 / markdown 流式段 / banner / 欢迎块) ──
  contentRow: 1, // 续写位行(1-based,屏坐标,[1,contentBottom])
  contentCol: 1, // 续写位列(1-based)
  segmentStartRow: 1, // 当前 md 段起始屏行(供 contentWriteMd 定位段末续写位;段内行数由 content 段标记跟踪)
  /** markdown 流式段:agent onText 的 chunk 累积到 mdBuf,每 chunk 把整段经 renderMarkdown
   *  渲成自洽行,replace 缓冲段(content.setLines)+ repaintViewport 重画。mdActive 期间任何
   *  非 md 写(contentWrite)先 commitMd 收尾(清 segMark,后续写不再被 setLines 截断)。 */
  mdActive: false,
  mdBuf: '',
  bannerH: 0,
  welcomeStart: -1, // 块起点(content.committedRows 口径的绝对行索引)
  welcomeRows: 0, // 块行数(0 = 屏上无欢迎块)

  // ── 滚动与流式暂停(回看冻结 / 打字期停物理写) ──
  scrollOffset: 0, // 滚动回看距尾行数(0=尾,跟随新内容);>0 时 viewport 显历史、状态行显滚动指示
  scrollLockUntil: 0, // 发消息轮首滚动锁(绝对时间戳 ms,0=未锁):吸收 stdin 残留滚轮事件,防 resetScroll 回尾后被重新滚上去
  /** 运行态用户打字时暂停流式物理写:流式每个 token 要 cup 到 contentRow 写入,IME 候选窗逐光标移动跟踪会跟过去;
   *  用户打字期间只喂缓冲、不物理写,光标留输入框;停手 USER_ACTIVE_PAUSE_MS 后 flush 重画缓冲内容。 */
  userActiveUntil: 0, // 打字活跃截止时刻(Date.now()+PAUSE);0=未活跃
  flushTimer: null as NodeJS.Timeout | null, // 用户停手后 flush 缓冲内容(repaintViewport)

  // ── 状态栏(底栏文案 / spinner / 走时 / plan chip / live 帧位) ──
  base: null as StatusBase | null,
  /** 运行态实时 token 用量(agent core 流式推送,轮末 repl 清 undefined)。
   *  composeModelLine 在 RUNNING 态把它画成 chip 放 context 进度条左侧;
   *  不主动触发重画——RUNNING 态 turnTimer 80ms 心跳重画自然取最新值。 */
  liveUsage: undefined as TokenUsage | undefined,
  statusText: '',
  spinnerFrame: undefined as string | undefined,
  turnStart: null as number | null, // RUNNING 态起点(Date.now());INPUT 态为 null。composeStatus 据此拼走时。
  turnTimer: null as NodeJS.Timeout | null, // 走时刷新计时器(独立于 spinner):流式期间 spinner 停转,由它续刷状态行。
  /** 当前 plan chip 占用脚栏行数(1 或 2)。composePlanLines 每次重算后写入。
   *  驱动 paintInput setRegion(fh) 动态撑高脚栏;drawStatusBar 据此画 1/2 行 plan,
   *  与 spinner/上线/输入/下线/model 行的 +1/+2/+3/+4/+5 偏移天然一致(contentBottom 自动重算)。 */
  planRows: 1 as 1 | 2,
  runningFrame: -1, // 运行态状态行 chip 心跳帧(转圈帧 明灭);INPUT 态 -1 退回静态 ●
  /** 上一次 paintLiveAtCursor 实际画帧的屏坐标(0=未画)。clearLiveAtCursor 清"这行"而非当前续写位——
   *  防 spinner 运行期间续写位漂移时清错行、旧帧行残留(见 557e678 移除 isStreamingPaused 后的间歇性 frame 泄漏)。 */
  frameRow: 0,
  frameCol: 0,

  // ── 输入框绘制(上次视图 / 菜单擦除坐标 / 粘贴与光标回调) ──
  lastView: null as InputView | null,
  lastMenuStartRow: 0, // 上次菜单起始屏行(供擦除)
  lastMenuRows: 0,
  /** 上次画过输入框的 lastView 签名(lines 数 + 每行 display_w 累加);变了说明 prompt.ts 改了文本 → 选区锚点失效,清掉。 */
  lastInputSig: '',
  pasteHandler: null as ((text: string) => void) | null,
  /** 鼠标点击输入框 → prompt.ts(文本 source of truth)提供的光标应用回调;
   *  layout 只做"点击 → 算新位置"的映射,实际改 cl/cc 归 prompt(同 pasteHandler 套路)。
   *  若未注册(非输入态/未进 prompt):仅做视觉反馈,cl/cc 不变。 */
  cursorChangeHandler: null as ((line: number, col: number) => void) | null,

  // ── 鼠标选区(内容区框选 / 输入框反白 / picker 期禁鼠标) ──
  selection: null as Selection | null,
  selecting: false, // 左键按下中(press→release 之间)
  mouseEnabled: true, // 导航菜单(picker)期间置 false:只吞报表不做选区/滚动,防菜单被 viewport 重画覆盖
  inputSelection: null as InputSelection | null,
  /** overlay 鼠标接管者(composer 输入面板等全屏弹窗)。非 null 时所有鼠标事件先喂给它,
   *  返回 true = 已消费(不再走 layout 默认处理);弹窗自己消费全部事件,
   *  防止背景选区/翻页触发 repaintViewport 重画覆盖弹窗。传 null 注销。 */
  overlayMouseHandler: null as ((e: mouse.MouseEvent) => boolean) | null,
};

export type LayoutState = typeof state;
