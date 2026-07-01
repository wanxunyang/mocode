import { stdin, stdout } from 'node:process';
import {
  charWidth,
  displayWidth,
  truncateDisplay,
  ansiDisplayWidth,
  wrapByDisplayWidth,
  fmtElapsed,
} from './render.js';
import { ui } from './theme.js';
import * as content from './content.js';
import * as mouse from './mouse.js';
import { renderMarkdown } from './markdown.js';

/**
 * 全屏 TUI 布局(参考 Claude Code):alt screen + 单滚动区域(内容区)+ 区域外固定底栏(状态行 + 输入框)。
 *
 * 只依赖最成熟、Windows(WT / conhost)最稳的 ANSI 子集:
 *  - alt screen        \x1B[?1049h / \x1B[?1049l
 *  - DECSTBM 滚动区域  \x1B[<top>;<bottom>r   (区域内写满自动在区域内滚动,区域外底栏不被顶)
 *  - 逐行擦除          \x1B[2K / \x1B[K        (菜单 / 清屏,绝不用 ED \x1B[J 做边界擦除)
 *  - CUP 绝对定位      \x1B[<row>;<col>H
 * 不用原点模式(\x1B[?6h)、不依赖 ED 边界、不用 DECSC/DECRC、不用 IL/DL/SU/SD——这些在 conhost 上不可靠。
 *
 * 续写位(contentRow / contentCol)由 contentWrite 按字符宽度 + 折行模拟跟踪;CUP 到它即可随时回到内容续写位,
 * 故底栏刷新(状态行 / spinner)无需保存/恢复光标——CUP 回续写位即可。
 *
 * 关键洞察:RUNNING 态也支持 typeahead 输入与滚动回看。INPUT 态光标常驻输入框;RUNNING 态光标在续写位,
 * 运行中打的字经 paintRunningInputEcho 作 dim 回显(占位行换成已打文本,光标仍留续写位,不与流式争用);
 * 运行中可滚动回看——contentWrite 在 scrollOffset>0 时只喂缓冲不物理写(否则新流式覆盖 viewport 历史行),
 * 回尾(scrollOffset===0)才 cup 续写位写出。两态切换不重设区域(底栏高度恒 = 2),仅多行输入换行撑高时才 setRegion。
 *
 * 非 TTY:全部空操作,contentWrite 退化为 stdout.write,与改造前内联行为一致。
 */

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
  modeTag?: string; // 模式标识:plan 模式显黄色 'plan';auto 缺省=不显(状态行干净)
}

export interface InputView {
  prompt: string; // 纯文本 prompt(无 ANSI),如 '❯ '
  lines: string[]; // 全部输入行(prompt.ts 持有,layout 负责按高度开窗)
  cursorLine: number; // 0-based,lines 内行号
  cursorCol: number; // 显示宽度列(0-based)
  menu: { lines: string[] } | null; // 预渲染菜单行(带色),向上展开进内容区底
  dim?: boolean; // true=运行态占位(整行 dim)
  placeholder?: string; // dim 态专用:无打字时的 ghost 占位文本(画在光标右侧)
  caret?: boolean; // true=在光标处画块状光标(反白光标右侧字符,行末反白空格),示"现在在哪输入";默认 true。picker 等非文本输入传 false
}

// ── 内部状态 ──
let active = false;
let mode: 'input' | 'running' = 'input';
let footerH = 4; // 1 状态行 + 1 上线 + 输入行数 + 1 下线(上下线框住输入区)
let contentRow = 1; // 续写位行(1-based,屏坐标,[1,contentBottom])
let contentCol = 1; // 续写位列(1-based)
let segmentStartRow = 1; // 当前 md 段起始屏行(供 contentWriteMd 定位段末续写位;段内行数由 content 段标记跟踪)
let scrollOffset = 0; // 滚动回看距尾行数(0=尾,跟随新内容);>0 时 viewport 显历史、状态行显滚动指示
let base: { model: string; contextBar: string; cwd: string; modeTag?: string } | null = null;
let statusText = '';
let spinnerFrame: string | undefined;
let turnStart: number | null = null; // RUNNING 态起点(Date.now());INPUT 态为 null。composeStatus 据此拼走时。
let turnTimer: NodeJS.Timeout | null = null; // 走时刷新计时器(独立于 spinner):流式期间 spinner 停转,由它续刷状态行。
// 运行态状态行 chip 心跳帧(♥/♡ 明灭)。turnTimer 每 tick 推进一帧,让状态行前导符在 agent
// 运行时跳动——agent 的 spinner 走内容区续写位(paintLiveAtCursor),不调 setStatus,
// 故状态行 chip 靠 turnTimer 独立驱动。INPUT 态 runningFrame=-1,composeStatus 退回静态 ◆。
const RUNNING_FRAMES = ['♥', '♡'];
let runningFrame = -1;
// 运行态用户打字时暂停流式物理写:流式每个 token 要 cup 到 contentRow 写入,IME 候选窗逐光标移动跟踪会跟过去;
// 用户打字期间只喂缓冲、不物理写,光标留输入框;停手 USER_ACTIVE_PAUSE_MS 后 flush 重画缓冲内容。
let userActiveUntil = 0; // 打字活跃截止时刻(Date.now()+PAUSE);0=未活跃
let flushTimer: NodeJS.Timeout | null = null; // 用户停手后 flush 缓冲内容(repaintViewport)
const USER_ACTIVE_PAUSE_MS = 1500;
let lastView: InputView | null = null;
let lastMenuStartRow = 0; // 上次菜单起始屏行(供擦除)
let lastMenuRows = 0;
let resizeTimer: NodeJS.Timeout | null = null;
let exitHandler: (() => void) | null = null;
let sigwinchHandler: (() => void) | null = null;
// markdown 流式段:agent onText 的 chunk 累积到 mdBuf,每 chunk 把整段经 renderMarkdown
// 渲成自洽行,replace 缓冲段(content.setLines)+ repaintViewport 重画。mdActive 期间任何
// 非 md 写(contentWrite)先 commitMd 收尾(清 segMark,后续写不再被 setLines 截断)。
let mdActive = false;
let mdBuf = '';

const esc = {
  altOn: '\x1B[?1049h',
  altOff: '\x1B[?1049l',
  mouseOn: '\x1B[?1000h\x1B[?1006h', // SGR 鼠标:按键事件追踪(1000)+SGR 编码(1006)→ \x1B[<btn;col;rowM,经 mouse.consumeMouse 重组后滚轮滚动。副作用:TUI 内鼠标选区复制失效,按 Shift 用鼠标可让终端放行做原生选区
  mouseOff: '\x1B[?1006l\x1B[?1000l', // 关:反序(先关 SGR 编码再关追踪)
  cursorShow: '\x1B[?25h',
  cursorHide: '\x1B[?25l',
  clearLine: '\x1B[2K',
  home: '\x1B[H',
};

/** CUP(光标绝对定位),钳到 >=1。 */
function cup(row: number, col: number): string {
  return `\x1B[${Math.max(1, Math.round(row))};${Math.max(1, Math.round(col))}H`;
}

export function getGeo(fh: number = footerH): Geo {
  const rows = stdout.rows || 24;
  const cols = stdout.columns || 80;
  const f = Math.max(1, Math.min(fh, rows - 1));
  return {
    rows,
    cols,
    footerH: f,
    contentTop: 1,
    contentBottom: Math.max(1, rows - f),
  };
}

/** (重)设滚动区域 [1, rows-footerH];设完 \x1B[H 归位(conhost 设 DECSTBM 时光标留旧位置行为未定义)。 */
export function setRegion(fh: number): Geo {
  const rows = stdout.rows || 24;
  const oldBottom = Math.max(1, rows - footerH);
  const g = getGeo(fh);
  footerH = g.footerH;
  if (active) {
    stdout.write(`\x1B[1;${g.contentBottom}r`); // DECSTBM: top=1, bottom=contentBottom
    // 底栏缩小:原底栏行变回内容区,清掉残留底栏文本(否则提交多行后旧输入残留在底部)
    if (g.contentBottom > oldBottom) {
      let p = '';
      for (let r = oldBottom + 1; r <= g.contentBottom; r++) {
        p += cup(r, 1) + esc.clearLine;
      }
      stdout.write(p);
    }
    stdout.write(esc.home);
  }
  if (contentRow > g.contentBottom) contentRow = g.contentBottom; // 底栏撑高挤掉内容:钳到新区底
  return g;
}

/** 运行态真光标(隐藏)的归位点 = 输入框光标位:行 = 动态 contentBottom+3(resize 安全),列对齐 renderDimInputRow 的假光标(空→3,有字→❯+截断文本宽+1)。供 IME 锚定。 */
function runningCaretPos(): { row: number; col: number } {
  const g = getGeo();
  const text = lastView?.dim ? lastView.lines[0] ?? '' : '';
  const contentW = Math.max(0, g.cols - 3); // ❯ =2 + 光标=1
  const w = displayWidth(truncateDisplay(text, contentW));
  return { row: g.contentBottom + 3, col: Math.min(g.cols, 2 + w + 1) };
}

export function contentMode(): void {
  if (!active) return;
  const g = getGeo();
  if (mode === 'running' && scrollOffset === 0) {
    // 运行态:真光标归输入框光标位(供 IME 锚定,气泡不跟流式跑);假光标做可见指示
    const p = runningCaretPos();
    stdout.write(cup(p.row, p.col));
  } else {
    // INPUT 态 / 滚动回看:归续写位(滚动回看时归内容区底,viewport 锁历史)
    stdout.write(
      cup(
        scrollOffset === 0 ? contentRow : g.contentBottom,
        scrollOffset === 0 ? contentCol : 1
      )
    );
  }
}

/** 运行态用户是否在打字(近期有按键)——是则暂停流式物理写(contentWrite/drawStatusBar/paintLiveAtCursor 跳过物理写),光标留输入框,IME 候选窗稳定不跟流式跑。 */
export function isStreamingPaused(): boolean {
  return mode === 'running' && Date.now() < userActiveUntil;
}

/**
 * 运行态用户打字时调(repl onRunningKey 每次按键):标记活跃 + 重置 flush 定时器。
 * 活跃期间流式只喂缓冲不物理写(光标不入内容区);用户停手 USER_ACTIVE_PAUSE_MS 后 flush:
 * repaintViewport 重画缓冲内容 + drawStatusBar 刷状态行 + 光标归输入框。
 * 解决 IME 候选窗跟流式输出跑:流式写必须 cup 到 contentRow,IME 逐光标跟踪→气泡跟跑;打字时暂停写则光标不动。
 */
export function setUserActive(): void {
  if (!active || mode !== 'running') return;
  userActiveUntil = Date.now() + USER_ACTIVE_PAUSE_MS;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    userActiveUntil = 0;
    if (active && mode === 'running' && scrollOffset === 0) {
      repaintViewport(); // 重画内容区(显示活跃期间缓冲的流式内容)
      drawStatusBar(); // 刷状态行(活跃期间冻住,现恢复)
      const p = runningCaretPos();
      stdout.write(cup(p.row, p.col));
    }
  }, USER_ACTIVE_PAUSE_MS);
  flushTimer.unref();
}

/**
 * 内容区正文写:CUP 到续写位 + 写出 + 按字符宽度/折行更新续写位 + 同步入 content 缓冲(供滚动回看)。
 * 滚动区域内写满自动在区域内滚动,底栏在区域外不被顶。非 TTY / 未激活:直接 stdout.write(内联退化)。
 *
 * 逐字符分类(按码点取字符,SGR 序列整段识别):SGR 码 → 0 宽跟踪 + content.feedSgr;其他 CSI/OSC → 跳过
 * (callers 理论上不传);\n / 折行 / tab 换行 → 行推进 + content.breakRow;可见字符 → charWidth 跟踪 +
 * content.feedChar。SGR 在终端 0 宽,故续写位只按可见字符推进(与终端实际光标一致)。
 */
export function contentWrite(s: string): void {
  if (!active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  if (mdActive) commitMd(); // 非 md 写接续:先收尾 md 段(清 segMark,否则 setLines 会截到旧段)
  // 滚动回看时(scrollOffset>0)只喂缓冲 + 推进续写位,不物理写——否则新流式内容覆盖 viewport 历史行。
  // 回尾(scrollOffset===0)才物理写;写起点 = 当前续写位(loop 会推进续写位,故先捕获)。
  const startRow = contentRow;
  const startCol = contentCol;
  const g = getGeo();
  const cols = g.cols;
  const bottom = g.contentBottom;
  const advanceRow = (r: number): number => (r >= bottom ? bottom : r + 1); // 到底则滚动,续写位留底
  // 滚动回看冻结(仿 ink store.pushBlock 的 offset+=newLines):scrollOffset>0 时新内容只入缓冲,
  // 但缓冲增长后若 offset 不变,下次 scrollBy→repaintViewport 会取漂移窗口、把新内容画进历史视图
  // (「工具消息跳到上面覆盖」bug;滚回底又正常,因 buffer 正确)。故入缓冲前后算 totalRows 差,
  // offset += 差以冻住视图(窗口停原绝对行,无需 repaint;滚回底自显尾部新内容)。
  const scrolled = scrollOffset > 0;
  const totalBefore = scrolled ? content.totalRows() : 0;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    // SGR 序列 \x1B[...m:0 宽 + 喂缓冲
    const sgr = /^\x1b\[[0-9;]*m/.exec(rest);
    if (sgr) {
      content.feedSgr(sgr[0]);
      i += sgr[0].length;
      continue;
    }
    // 其他 CSI / OSC 序列(兜底跳过,不喂缓冲——callers 不该传控制码)
    if (s[i] === '\x1b') {
      const csi = /^\x1b\[[0-9;]*[A-Za-z]/.exec(rest);
      if (csi) {
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07]*(\x07|\x1b\\)/.exec(rest);
      if (osc) {
        i += osc[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (ch === '\n') {
      contentRow = advanceRow(contentRow);
      content.breakRow();
      contentCol = 1;
      i += ch.length;
      continue;
    }
    if (ch === '\r') {
      contentCol = 1;
      i += ch.length;
      continue;
    }
    if (ch === '\t') {
      const next = Math.floor((contentCol - 1) / 8) * 8 + 8 + 1;
      if (next > cols) {
        contentRow = advanceRow(contentRow);
        content.breakRow();
        contentCol = 1;
      } else contentCol = next;
      i += ch.length;
      continue;
    }
    const cw = charWidth(cp);
    if (cw === 0) {
      i += ch.length;
      continue; // 组合符 / 零宽:不推进
    }
    if (contentCol + cw - 1 > cols) {
      // 当前行放不下:折行
      contentRow = advanceRow(contentRow);
      content.breakRow();
      contentCol = 1;
    }
    contentCol += cw;
    content.feedChar(ch);
    i += ch.length;
  }
  // 跨调用 pending-wrap 提交:循环末若 contentCol>cols(末字符恰好落在最后一列,终端 pending-wrap),
  // 必须在此提交换行——否则下一 chunk 的 cup(startRow, cols+1) 被终端 clamp 到 col=cols 且 CUP 清除
  // pending,下一可打印字符会覆盖上一行末字符(「新输出插到上文中间」bug);paintLiveAtCursor 也会
  // cup 到 cols+1 并 \x1B[2K 擦掉整行。提交后模拟与终端都停在 (下一行,1)、无 pending,等价 ink 的
  // 「新输出永远在底」。代价:chunk 恰在末列结束且下一 chunk 以 \n 开头时多一个空行(cosmetic,远好于覆盖)。
  // 模拟归一化在物理写 guard 之外(滚动态也要保 buffer 自洽);物理补的 \n 在 guard 之内(滚动态/暂停态不物理写)。
  const pendingWrap = contentCol > cols;
  if (pendingWrap) {
    content.breakRow();
    contentRow = advanceRow(contentRow);
    contentCol = 1;
  }
  // 滚动回看冻结:新内容入缓冲后 offset += delta(contentWrite 只增故 ≥0;md 路径可负),钳到 [0, maxOff],
  // viewport 窗口停原绝对行(不漂移到新工具消息)。无需 repaint——窗口未变(屏仍显原历史)。
  if (scrolled) {
    const delta = content.totalRows() - totalBefore;
    if (delta !== 0) {
      const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
      scrollOffset = Math.max(0, Math.min(scrollOffset + delta, maxOff));
    }
  }
  // 物理写(回尾 offset=0 且未暂停):cup 写起点 + s + (pending 时补 \n 提交换行)+ (运行态 cup 回输入框)。
  // 用户打字中(isStreamingPaused)跳过物理写、只喂缓冲——光标不入内容区,IME 候选窗不跟流式跑;
  // 停手后 setUserActive 的 flush 定时器 repaintViewport 重画缓冲内容。
  if (scrollOffset === 0 && !isStreamingPaused()) {
    let out = cup(startRow, startCol) + s;
    if (pendingWrap) out += '\n'; // 滚动区域底行触发 DECSTBM 上滚、中段 LF 下移到 (下一行,1)
    if (mode === 'running') {
      const p = runningCaretPos();
      out += cup(p.row, p.col);
    }
    stdout.write(out);
  }
}

/** 进入 markdown 流式段:标记段起点(layout 续写位 + content.beginSegment),清 accumulator。 */
function beginMdSegment(): void {
  segmentStartRow = contentRow;
  content.beginSegment();
  mdBuf = '';
  mdActive = true;
}

/** 提交 markdown 段:清 accumulator + content.commitSegment(后续非 md 写不再被 setLines 截断)。 */
function commitMd(): void {
  if (!mdActive) return;
  mdActive = false;
  mdBuf = '';
  content.commitSegment();
}

/**
 * markdown 正文写(替代 contentWrite 用于 agent onText):累积 chunk 到 mdBuf,每 chunk 把整段
 * mdBuf 经 renderMarkdown 渲成自洽 ANSI 行,replace 缓冲段(content.setLines 截旧 + 写新),
 * repaintViewport 重画(仅尾 offset=0 且未暂停)。流式安全:未闭合 fence 照常 emit 进行中代码块;
 * renderMarkdown 内部 memo by text 使重复渲染命中缓存。非 TTY / 未激活:直接 stdout.write(与
 * contentWrite 一致,管道流式可见)。
 *
 * 续写位 = 段末下一行(段占 lines.length 行从 segmentStartRow 起);超可视区则滚动留 contentBottom。
 * 物理重画用 repaintViewport(全内容区,原子一次 write 无闪烁)— md 段是缓冲尾,viewport 显尾即显段。
 * 用户打字中(isStreamingPaused)或滚动回看(scrollOffset>0)只更新缓冲,停手 flush / 回尾时显。
 */
export function contentWriteMd(s: string): void {
  if (!active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  if (!mdActive) beginMdSegment();
  mdBuf += s;
  const g = getGeo();
  // 滚动回看冻结(同 contentWrite):scrollOffset>0 时 setLines 替换段会改缓冲行数,若 offset 不变,
  // 下次 scrollBy→repaintViewport 取漂移窗口、把流式正文画进历史视图。故 setLines 前后算 totalRows 差,
  // offset += delta(可负:setLines 重渲染可能缩行)冻住视图。md 段在尾,窗口在上方,冻结后不重叠。
  const scrolled = scrollOffset > 0;
  const totalBefore = scrolled ? content.totalRows() : 0;
  const lines = renderMarkdown(mdBuf, g.cols);
  content.setLines(lines);
  const segRows = lines.length;
  const available = g.contentBottom - segmentStartRow + 1;
  contentRow = segRows >= available ? g.contentBottom : segmentStartRow + segRows;
  contentCol = 1;
  if (scrolled) {
    const delta = content.totalRows() - totalBefore;
    if (delta !== 0) {
      const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
      scrollOffset = Math.max(0, Math.min(scrollOffset + delta, maxOff));
    }
  }
  if (scrollOffset === 0 && !isStreamingPaused()) {
    repaintViewport();
    if (mode === 'running') {
      const p = runningCaretPos();
      stdout.write(cup(p.row, p.col));
    }
  }
}

/**
 * 把一段完整(非流式)assistant 文本一次性渲染成 markdown 写入(供 renderHistory 回显
 * /resume / /rollback 复显上下文):渲染一次 → join('\n') → 经 contentWrite 增量写
 * (无段 erase / 无 repaintViewport,无闪烁)。与流式 contentWriteMd 的区别:不累积 chunk、
 * 不走段替换——一次性把渲染结果当普通带色文本喂入(渲染行各自 ≤ cols、自洽带色,contentWrite
 * 的 SGR/折行状态机原样接纳)。非 TTY:退化为 stdout.write 原文(同 contentWrite)。
 */
export function contentWriteMdOnce(s: string): void {
  if (!active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  const g = getGeo();
  const lines = renderMarkdown(s, g.cols);
  contentWrite(lines.join('\n'));
}

/** 清空内容区(保留底栏):全屏清 + 重设区域 + 续写位归 (1,1) + 清缓冲 + 回尾。底栏由调用方随后重画。 */
export function clearContent(): void {
  if (!active) return;
  stdout.write('\x1B[1;1H\x1B[2J');
  setRegion(footerH);
  contentRow = 1;
  contentCol = 1;
  segmentStartRow = 1;
  scrollOffset = 0;
  mdActive = false;
  mdBuf = '';
  content.reset();
  stdout.write(esc.home);
}


// ── viewport 滚动回看(Phase 2)──

/** 是否处于滚动回看态(offset>0,内容区显历史)。prompt 据此在非滚动键时回尾。 */
export function isScrolled(): boolean {
  return scrollOffset > 0;
}

/**
 * 重画内容区 viewport:按 scrollOffset 取缓冲尾窗,逐行 cup+clearline+rowtext 映射到屏 1..contentBottom。
 * offset=0 即尾窗(== 实时屏,resize / 回尾时用)。清行含 contentBottom——顺带擦 WT 边距漏影(状态行重复)。
 */
export function repaintViewport(): void {
  if (!active) return;
  const g = getGeo();
  const h = g.contentBottom;
  const slice = content.sliceFromEnd(scrollOffset, h);
  let p = '';
  for (let r = 1; r <= h; r++) {
    const line = slice[r - 1] ?? '';
    p += cup(r, 1) + esc.clearLine + line;
  }
  stdout.write(p);
  // 光标:offset=0 回续写位(尾行末,contentWrite 维护);offset>0 留内容区底
  stdout.write(
    cup(scrollOffset === 0 ? contentRow : g.contentBottom, scrollOffset === 0 ? contentCol : 1)
  );
}

/** 滚动 delta 行(正=往新、负=往旧);钳 [0, max(0, total-contentBottom)];变则重画 + 刷底栏(显指示、光标回输入框)。 */
export function scrollBy(delta: number): void {
  if (!active) return;
  const g = getGeo();
  const total = content.totalRows();
  const maxOff = Math.max(0, total - g.contentBottom);
  const off = Math.max(0, Math.min(scrollOffset + delta, maxOff));
  if (off === scrollOffset) return;
  scrollOffset = off;
  repaintViewport();
  repaint();
}

/** 回尾(offset=0);仅当原本滚动过才重画(避免每轮 enterRunningMode 闪烁)。 */
export function resetScroll(): void {
  if (scrollOffset === 0) return;
  scrollOffset = 0;
  repaintViewport();
  repaint();
}

// ── 状态行 ──

/** 组合状态行可见串(带色),按 cols 截断防溢出(不折到输入行)。 */
function composeStatus(status: StatusBarData, cols: number): string {
  const sep = '  ';
  const sepW = sep.length;
  // 运行态(含滚动回看)用心跳帧(♥/♡)替换静态 ◆:agent 跑起来时状态行前导符始终跳动,
  // 滑到上面看历史也能感知 agent 在跑。帧宽=1(与 ◆ 同),fixed 不变,布局不乱。INPUT 态仍显 ◆。
  const spinning = mode === 'running' && runningFrame >= 0;
  const lead = spinning ? `${RUNNING_FRAMES[runningFrame]} ` : `◆ `;
  // 模式 chip:lead 之后、model 之前。auto 显 dim 'auto'(常态),plan 显亮黄 'plan'(切换时颜色+文字都变,明显)。
  const modeChip = status.modeTag
    ? ` ${status.modeTag === 'plan' ? ui.yellow : ui.dim}${status.modeTag}${ui.reset}`
    : '';
  const modeChipW = status.modeTag ? 1 + displayWidth(status.modeTag) : 0; // 1 = 前导空格
  const model = truncateDisplay(status.model, 22);
  const ctx = status.contextBar; // 已带色
  const ctxW = ansiDisplayWidth(ctx);
  // 滚动回看时状态段改显历史指示(无 spinner——滚动只在 INPUT 态)
  const scrolled = scrollOffset > 0;
  let st: string;
  if (scrolled) {
    st = `历史 ↑${scrollOffset} (PgDn 回底)`; // 滚动回看显历史指示,不显走时
  } else {
    // head = spinner 帧 + 状态文字。常态 agent 轮二者皆空:agent spinner 不调 setStatus,
    // 其文字在内联 paintLiveAtCursor 显,状态行不重复——只显走时。命令态(如 /compact 的「压缩中」)
    // 走 setStatus,在此显帧 + 文字(无内联,不重复)。
    const head = (status.spinnerFrame ? status.spinnerFrame + ' ' : '') + status.status;
    if (mode === 'running' && turnStart != null) {
      // RUNNING 态追加走时:整轮从 enterRunningMode 起计时,200ms 计时器续刷使其连续递增。
      st = head ? `${head} · ${fmtElapsed(Date.now() - turnStart)}` : fmtElapsed(Date.now() - turnStart);
    } else {
      st = head; // INPUT 等态(如"空闲")
    }
  }
  const stW = displayWidth(st);
  const fixed = displayWidth(lead) + modeChipW + displayWidth(model) + sepW * 3 + ctxW + stW;
  const cwdBudget = cols - fixed - 1;
  const cwd = cwdBudget >= 6 ? truncateDisplay(status.cwd, cwdBudget) : '';
  return [
    `${spinning ? ui.brightMagenta : ui.brightCyan}${lead}${ui.reset}${modeChip}${ui.bold}${model}${ui.reset}`,
    sep,
    ctx,
    sep,
    `${ui.dim}${cwd}${ui.reset}`,
    sep,
    `${scrolled ? ui.yellow : status.spinnerFrame ? ui.brightMagenta : ui.dim}${st}${ui.reset}`,
  ].join('');
}

/** 画状态行(光标回续写位)。RUNNING 态 spinner 频繁调。 */
export function drawStatusBar(status?: StatusBarData): void {
  if (!active || !base) return;
  if (isStreamingPaused()) return; // 用户打字中:状态行暂不刷(避免光标去 statusRow 扰动 IME),停手后 flush 会刷
  const s = status ?? { ...base, status: statusText, spinnerFrame };
  const g = getGeo();
  const statusRow = g.contentBottom + 1;
  // 一次写入:cup 状态行 + clearLine + 状态 + cup 回(运行态→输入框供 IME 锚定;否则续写位/内容区底)
  let out = cup(statusRow, 1) + esc.clearLine + composeStatus(s, g.cols);
  if (mode === 'running' && scrollOffset === 0) {
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  } else {
    out += cup(scrollOffset === 0 ? contentRow : g.contentBottom, scrollOffset === 0 ? contentCol : 1);
  }
  stdout.write(out);
}

/** 更新易变状态(状态文字 + spinner 帧)并重画状态行。spinner / agent 用。 */
export function setStatus(status: string, frame?: string): void {
  statusText = status;
  spinnerFrame = frame;
  drawStatusBar();
}

/**
 * 启走时刷新计时器:RUNNING 态每 200ms 重画状态行,使 composeStatus 重算 elapsed。
 * 必要性:spinner 在首 token 到达即 stop,思考/正文流式期间状态行不再经 spinner 刷新;
 * 若走时只挂 spinner onFrame,流式那几十秒会冻住。此计时器独立续刷,与 spinner 80ms 重叠幂等无妨。
 * 非 TTY 不启(active=false 时 drawStatusBar 为 no-op)。
 */
function startTurnTimer(): void {
  if (!active) return;
  stopTurnTimer();
  runningFrame = 0; // 进入运行态:启动状态行 chip 心跳(首帧立即生效)
  turnTimer = setInterval(() => {
    runningFrame = (runningFrame + 1) % RUNNING_FRAMES.length; // 推进心跳帧,让前导符跳动
    drawStatusBar();
  }, 200);
  turnTimer.unref();
}

/** 停走时计时器。enterInputMode / exitAltScreen 调。 */
function stopTurnTimer(): void {
  if (turnTimer) {
    clearInterval(turnTimer);
    turnTimer = null;
  }
}

/**
 * 在续写位画一行瞬时活动文本(spinner 帧):不进缓冲、不推进续写位,逐行 clearLine 重画。
 * 仅 TTY + offset=0(实时尾)时物理写屏;滚动态跳过(由状态行 spinner 兜底,且避免覆盖 viewport 历史行)。
 * 配合 clearLiveAtCursor 在 spinner 停时清掉,随后 contentWrite 的结果即写在该行(spinner 不入历史缓冲)。
 */
export function paintLiveAtCursor(text: string): void {
  if (!active || !ui.isTTY || scrollOffset !== 0 || isStreamingPaused()) return;
  // 一次写入:cup 续写位 + clearLine + 帧 + (运行态 cup 回输入框)——避免光标在续写位歇脚被 IME 跟踪
  let out = cup(contentRow, contentCol) + esc.clearLine + text;
  if (mode === 'running') {
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  }
  stdout.write(out);
}

/** 清掉续写位那行瞬时活动文本(配合 paintLiveAtCursor)。 */
export function clearLiveAtCursor(): void {
  if (!active || !ui.isTTY || scrollOffset !== 0 || isStreamingPaused()) return;
  let out = cup(contentRow, contentCol) + esc.clearLine;
  if (mode === 'running') {
    const p = runningCaretPos();
    out += cup(p.row, p.col);
  }
  stdout.write(out);
}

/** 更新状态行基线(模型 / context / cwd / 模式标识)。repl 在轮次边界与切模式时调。 */
export function setStatusBase(b: {
  model: string;
  contextBar: string;
  cwd: string;
  modeTag?: string;
}): void {
  base = b;
}

// ── 输入区(底栏输入框 + 向上菜单)──

/**
 * 把逻辑行软折成可视行并开窗(超 maxInputRows 时滑窗保光标可见)。返回可见可视行文本(已折行)+
 * 光标在窗口内行号 + 光标在该可视行的显示列 + 所需输入行数 + 窗口起始全局可视行号。
 *
 * 光标可视位置按各行**实际**显示宽度逐行累加(不按 width×行号 除法):宽字符(CJK=2)在行尾放不下时
 * 整字折到下行、本行留尾空格,简单除法会把光标算偏;逐行累加 displayWidth 才与终端实际光标一致。
 */

function windowInputVis(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  cols: number,
  promptW: number,
  rows: number
): {
  visRows: string[];
  visLine: number;
  cursorVisCol: number;
  inputRows: number;
  startVis: number;
} {
  const W = Math.max(1, cols - promptW);
  const lineVis: string[][] = lines.map((l) => wrapByDisplayWidth(l, W));
  const flat: string[] = [];
  for (const lv of lineVis) for (const r of lv) flat.push(r);
  const totalVis = flat.length;

  // 光标在其逻辑行内的可视行 / 可视列
  const clRows = lineVis[cursorLine] ?? [''];
  let curVisRow = 0;
  let curVisCol = cursorCol;
  {
    let acc = 0;
    for (let i = 0; i < clRows.length; i++) {
      const rw = displayWidth(clRows[i]);
      if (cursorCol <= acc + rw) {
        curVisRow = i;
        curVisCol = cursorCol - acc;
        break;
      }
      acc += rw;
      curVisRow = i;
      curVisCol = cursorCol - acc;
    }
  }

  // 光标绝对可视行
  let curAbs = 0;
  for (let i = 0; i < cursorLine; i++) curAbs += lineVis[i].length;
  curAbs += curVisRow;

  const maxInputRows = Math.max(1, Math.floor(rows * 0.4));
  let startVis = 0;
  if (totalVis > maxInputRows) {
    startVis = Math.max(
      0,
      Math.min(curAbs - maxInputRows + 1, totalVis - maxInputRows)
    );
  }
  const showCount = Math.min(maxInputRows, totalVis);
  return {
    visRows: flat.slice(startVis, startVis + showCount),
    visLine: curAbs - startVis,
    cursorVisCol: curVisCol,
    inputRows: showCount,
    startVis,
  };
}

/**
 * 把一行纯可见文本(无 ANSI / 零宽)在光标显示列处切成 before/cur/after:
 * cur = 光标右侧那个字符(块状光标"压"在它上面);光标在行末(列 == 行宽)则 cur=''。
 * 供 paintInput 画块状光标——反白 cur(行末反白一个空格),让用户看清"现在在哪输入"。
 *
 * 光标列恒落在字符边界:cursorCol = 显示宽度(slice 整字累加),不进字符内部,故按 acc===col 取字符即可。
 * 宽字符(CJK=2)在行尾放不下时整字折下行,光标列仍在边界,acc 逐字累加 displayWidth 与终端光标一致。
 */
function splitAtVisCol(
  line: string,
  col: number
): { before: string; cur: string; after: string } {
  let acc = 0;
  let i = 0;
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw <= 0) {
      i += ch.length;
      continue; // 零宽(组合符等):不计列,跳过(输入文本一般无,稳妥)
    }
    if (acc === col) {
      return { before: line.slice(0, i), cur: ch, after: line.slice(i + ch.length) };
    }
    acc += cw;
    i += ch.length;
  }
  return { before: line, cur: '', after: '' }; // 光标在行末:无字符可反白
}

/**
 * 画输入区:擦旧菜单 → (必要时)setRegion → 画状态行 + 输入行 + 向上菜单,光标留输入框(dim 时回续写位)。
 * prompt.ts 每次按键调;enterInputMode / enterRunningMode 也调(空 / dim)。
 */
export function paintInput(view: InputView): void {
  if (!active || !base) return;
  lastView = view;
  const preGeo = getGeo();
  // 累积本帧所有 cup/clearLine/文本,末尾一次写出——避免「擦旧菜单」与「重画」分多次 write 时,
  // 终端把中间空白渲染出来 → 菜单/面板切换时闪烁(↑↓ 导航每次 redraw 都全帧擦后重画)。
  let buf = '';

  // 1. 擦旧菜单(用上次记录的起始行 + 行数,与本次几何无关——setRegion 不动屏幕内容)
  if (lastMenuRows > 0) {
    for (let i = 0; i < lastMenuRows; i++) {
      buf += cup(lastMenuStartRow + i, 1) + esc.clearLine;
    }
    lastMenuRows = 0;
  }

  // 2. 算输入可视行(软折行)+ 必要时 setRegion。dim=运行态占位:单行不折行。
  const promptW = displayWidth(view.prompt);
  const vis = view.dim
    ? {
        visRows: [view.lines[0] ?? ''],
        visLine: 0,
        cursorVisCol: 0,
        inputRows: 1,
        startVis: 0,
      }
    : windowInputVis(
        view.lines,
        view.cursorLine,
        view.cursorCol,
        preGeo.cols,
        promptW,
        preGeo.rows
      );
  const needFooterH = 3 + vis.inputRows; // 1 状态 + 1 上线 + 输入行 + 1 下线
  let g = preGeo;
  if (needFooterH !== footerH) {
    // setRegion 自己 write(DECSTBM + 清行 + 归位):先把已累积的擦除 flush 出去保序(擦除用的是旧几何的
    // lastMenuStartRow,须在 setRegion 改区域前落地),再 setRegion,之后 2b..6 重新累积。
    // footerH 不变时(常见:单行输入 / 菜单切换 / ↑↓ 导航)整帧一次 write,终端原子应用,无中间空白→不闪烁。
    if (buf) {
      stdout.write(buf);
      buf = '';
    }
    g = setRegion(needFooterH);
  }

  // 2b. 重画内容末行(底栏上一行)从缓冲:防 WT 边距漏影(状态行重复到该行),并保证该行显正确内容
  {
    const slice = content.sliceFromEnd(scrollOffset, g.contentBottom);
    const line = slice[g.contentBottom - 1] ?? '';
    buf += cup(g.contentBottom, 1) + esc.clearLine + line;
  }

  // 3. 状态行(footerH 变或始终重画——便宜且避免旧状态行残留)
  const statusRow = g.contentBottom + 1;
  const status: StatusBarData = { ...base, status: statusText, spinnerFrame };
  buf += cup(statusRow, 1) + esc.clearLine + composeStatus(status, g.cols);

  // 3b. 上线(输入框顶):满屏宽细线 ─(cyan),框住输入区上边界
  buf += cup(g.contentBottom + 2, 1) + esc.clearLine + ui.cyan + '─'.repeat(g.cols) + ui.reset;

  // 4. 输入行(g.contentBottom+3 .. rows-1)——按可视行画,首行带 prompt、其余缩进 promptW
  const firstInputRow = g.contentBottom + 3;
  const inputRowsAvail = g.footerH - 3; // 去掉状态/上线/下线,留输入行
  const indent = ' '.repeat(promptW);
  const showCaret = view.caret !== false; // 默认 true;picker 等非文本输入传 false 关闭块状光标
  for (let i = 0; i < inputRowsAvail; i++) {
    const line = vis.visRows[i] ?? '';
    const r = firstInputRow + i;
    const prefix = vis.startVis === 0 && i === 0 ? view.prompt : indent;
    let text: string;
    if (view.dim) {
      text = renderDimInputRow(view.prompt, line, view.placeholder ?? '', g.cols);
    } else if (showCaret && i === vis.visLine) {
      // 块状光标:反白光标右侧字符(cur),行末(无字符)反白一个空格——示"现在在哪输入"
      const { before, cur, after } = splitAtVisCol(line, vis.cursorVisCol);
      text = `${prefix}${before}${ui.reverse}${cur || ' '}${ui.reset}${after}`;
    } else {
      text = `${prefix}${line}`;
    }
    buf += cup(r, 1) + esc.clearLine + text;
  }

  // 4b. 下线(输入框底):满屏宽细线 ─(cyan),固定屏底 rows
  buf += cup(g.rows, 1) + esc.clearLine + ui.cyan + '─'.repeat(g.cols) + ui.reset;

  // 5. 向上菜单(画在内容区底,底栏正上方)
  if (view.menu && view.menu.lines.length > 0) {
    const menuRows = Math.min(view.menu.lines.length, g.contentBottom);
    const menuStart = g.contentBottom - menuRows + 1;
    for (let i = 0; i < menuRows; i++) {
      buf += cup(menuStart + i, 1) + esc.clearLine + view.menu.lines[i];
    }
    lastMenuStartRow = menuStart;
    lastMenuRows = menuRows;
  }

  // 6. 光标
  if (view.dim) {
    // 运行态:真光标归输入框光标位(供 IME 锚定);滚动回看时归内容区底(viewport 锁历史)
    const p = runningCaretPos();
    buf += cup(scrollOffset === 0 ? p.row : g.contentBottom, scrollOffset === 0 ? p.col : 1);
  } else {
    const r = firstInputRow + vis.visLine;
    const col = promptW + vis.cursorVisCol + 1;
    buf += cup(r, col);
  }

  if (buf) stdout.write(buf); // 整帧一次写出(footerH 不变时):终端原子应用,无中间空白→不闪烁
}

/**
 * 渲染运行态输入行(dim):❯ + (有打字:dim 文本 + 末尾反白块状光标;无打字:反白光标在起点 + dim 占位 ghost)。
 * 光标是「画出来」的反白块(非真终端光标)——真光标仍归续写位,避开与 contentWrite/drawStatusBar 争用;
 * 输入行在 RUNNING 期间只被按键回显重画(流式/spinner 不碰这行),故画上去的光标能稳住。
 * 内容截断到 cols-promptW-1(留 ❯ 与光标各 1 cell),防超长软折行写穿下线。
 */
function renderDimInputRow(
  prompt: string,
  text: string,
  placeholder: string,
  cols: number
): string {
  const promptW = displayWidth(prompt);
  const caret = `${ui.reverse} ${ui.reset}`; // 反白块状光标(1 cell,与 INPUT 态同款)
  const contentW = Math.max(0, cols - promptW - 1);
  if (text.length > 0) {
    // 有打字:❯ dim + 文本(dim) + 反白光标(末尾)
    return `${ui.dim}${prompt}${truncateDisplay(text, contentW)}${ui.reset}${caret}`;
  }
  // 空:❯ dim + 反白光标(打字起点) + dim 占位 ghost
  const p = placeholder ? truncateDisplay(placeholder, contentW) : '';
  return `${ui.dim}${prompt}${ui.reset}${caret}${ui.dim}${p}${ui.reset}`;
}

/**
 * 运行态 typeahead 回显:定向写输入行(底栏输入框),把 dim 占位换成已打字文本 + 反白块状光标(无打字时光标在起点)。
 * 只 cup 输入行 + clearLine + dim 文本 + 归位——不调 setRegion(运行中禁多行,避免 DECSTBM 抖动)、
 * 不重画状态行/contentBottom、不用 ED。同步 lastView 为 dim 视图(text 与 placeholder 拆开存),使 scrollBy/resize
 * 的 repaint 仍显当前回显 + 光标。真光标归续写位(滚动回看时归内容区底)——不入输入框,假光标已画在行内。
 */
export function paintRunningInputEcho(text: string, placeholder: string): void {
  if (!active || !base) return;
  const g = getGeo();
  const inputRow = g.contentBottom + 3; // 运行态 footerH 恒 4:状态(+1)+上线(+2)+输入行(+3);下线在 rows
  stdout.write(
    cup(inputRow, 1) +
      esc.clearLine +
      renderDimInputRow('❯ ', text, placeholder, g.cols)
  );
  // 同步 lastView:text 与 placeholder 拆开存,使滚动/resize 的 repaint 重画时光标位置正确(空→起点,有字→末尾)
  lastView = {
    prompt: '❯ ',
    lines: [text],
    placeholder,
    cursorLine: 0,
    cursorCol: 0,
    menu: null,
    dim: true,
  };
  // 真光标归输入框光标位(供 IME 锚定,与假光标同位);滚动回看时归内容区底
  const p = runningCaretPos();
  stdout.write(cup(scrollOffset === 0 ? p.row : g.contentBottom, scrollOffset === 0 ? p.col : 1));
}

/** 重画当前视图(resize / 内部用)。 */
export function repaint(): void {
  if (!active || !base) return;
  if (lastView) paintInput(lastView);
  else drawStatusBar();
}

/** 进入输入态:画空输入框 + 状态行,光标入输入框。 */
export function enterInputMode(status: string = '空闲'): void {
  mode = 'input';
  statusText = status;
  spinnerFrame = undefined;
  runningFrame = -1; // 回 INPUT 态:停状态行 chip 旋转,composeStatus 退回静态 ◆
  turnStart = null; // 停走时
  stopTurnTimer();
  // 运行态若有未 flush 的缓冲内容(用户打字暂停了流式写),切回 INPUT 前重画内容区显示之,免丢内容
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (userActiveUntil) {
    userActiveUntil = 0;
    if (active) repaintViewport();
  }
  if (active && base) {
    setRegion(4); // 1 状态 + 1 上线 + 1 输入 + 1 下线
    paintInput({
      prompt: '❯ ',
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
    });
    stdout.write(esc.cursorShow); // 回 INPUT 态:显真光标(运行态藏了)
  }
}

/** 进入运行态:底栏输入行改 dim 占位,光标回续写位。footerH 恒 4(状态+上线+输入+下线)。新轮回尾(确保新内容可见)。 */
export function enterRunningMode(status: string, placeholder: string): void {
  mode = 'running';
  statusText = status;
  spinnerFrame = undefined;
  turnStart = Date.now(); // 起走时(整轮从发起到 enterInputMode 止)
  resetScroll(); // 若上轮 INPUT 滚动过(未打字回底),新轮回尾
  if (active && base) {
    setRegion(4); // 1 状态 + 1 上线 + 1 输入 + 1 下线
    paintInput({
      prompt: '❯ ',
      lines: [''],
      placeholder,
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
      dim: true,
    });
    startTurnTimer(); // 续刷状态行走时(流式期间 spinner 停转,由它兜底)
    contentMode();
    // 真光标可见,停在输入框光标位(供 IME 锚定气泡到光标处)。打字时 setUserActive 暂停流式写、
    // 光标稳定在输入框;流式写时瞬时到 contentRow 但合并写入很快回输入框(光标跟流式是终端常态)。
    // 不再藏光标:藏了 IME 气泡会跑到输入框最右边而非光标处(WT 不锚定隐藏光标)。
  }
}

// ── alt screen 生命周期 + 钩子 ──

export function enterAltScreen(): void {
  if (active || !ui.isTTY) return;
  active = true;
  stdout.write(esc.altOn);
  stdout.write(esc.mouseOn); // SGR 鼠标追踪:滚轮发 \x1B[<btn;col;rowM 报表,经 mouse.consumeMouse 重组 → scrollBy(滚轮滚动靠此 + onKey/onRunningKey 顶部守卫)
  setRegion(4); // 1 状态 + 1 上线 + 1 输入 + 1 下线(底栏始终含上下线)
  contentRow = 1;
  contentCol = 1;
  segmentStartRow = 1;
  scrollOffset = 0;
  mdActive = false;
  mdBuf = '';
  content.reset();

  exitHandler = () => exitAltScreen();
  process.on('exit', exitHandler);

  sigwinchHandler = () => {
    if (!active) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!active) return;
      const g = getGeo(footerH);
      if (contentRow > g.contentBottom) contentRow = g.contentBottom;
      // offset 钳到新 maxOff(高度缩可能使旧 offset 失效)
      const maxOff = Math.max(0, content.totalRows() - g.contentBottom);
      if (scrollOffset > maxOff) scrollOffset = maxOff;
      setRegion(footerH); // 用新 rows 重设区域(contentBottom 变)
      repaintViewport(); // 内容区按新高度 + 当前 offset 重画(物理行不 reflow)
      repaint(); // 底栏重画
    }, 100);
    resizeTimer?.unref?.();
  };
  process.on('SIGWINCH', sigwinchHandler);
}

/** 复原:复位 margins + 显光标 + 退 alt + 还原 raw。幂等。 */
export function exitAltScreen(): void {
  if (!active) return;
  active = false;
  stopTurnTimer(); // 兜底清走时计时器(防异常退出泄漏)
  turnStart = null;
  mouse.resetMouse(); // 清鼠标重组残留(防退出后状态泄漏到下次进 alt 屏)
  // raw 还原独立 try:非 TTY / 不支持时 setRawMode 抛错,不应阻断 stdout 恢复(alt 退屏必须执行)。
  try {
    stdin.setRawMode(false); // 还原 raw(RUNNING 态常驻 raw,退出时必须还原,否则终端残留 raw 模式)
  } catch {
    // 非 TTY / 不支持:忽略
  }
  try {
    stdout.write('\x1B[r'); // 复位 DECSTBM margins
    stdout.write(esc.cursorShow);
    stdout.write(esc.mouseOff); // 关 SGR 鼠标追踪(反序:先 1006l 再 1000l)
    stdout.write(esc.altOff); // 退 alt(恢复主屏 + 光标)
  } catch {
    // 忽略
  }
  if (exitHandler) {
    try {
      process.removeListener('exit', exitHandler);
    } catch {
      // 忽略
    }
    exitHandler = null;
  }
  if (sigwinchHandler) {
    try {
      process.removeListener('SIGWINCH', sigwinchHandler);
    } catch {
      // 忽略
    }
    sigwinchHandler = null;
  }
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  userActiveUntil = 0;
}

export function isActive(): boolean {
  return active;
}
