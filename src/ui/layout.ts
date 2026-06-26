import { stdout } from 'node:process';
import {
  charWidth,
  displayWidth,
  truncateDisplay,
  ansiDisplayWidth,
  stripAnsi,
} from './render.js';
import { ui } from './theme.js';

/**
 * 全屏 TUI 布局(参考 Claude Code):alt screen + 单滚动区域(内容区)+ 区域外固定底栏(状态行 + 输入框)。
 *
 * 只依赖最成熟、Windows(WT / conhost)最稳的 ANSI 子集:
 *  - alt screen        \x1B[?1049h / \x1B[?1049l
 *  - DECSTBM 滚动区域  \x1B[<top>;<bottom>r   (区域内写满自动在区域内滚动,区域外底栏不被顶)
 *  - 逐行擦除          \x1B[2K / \x1B[K        (菜单 / 思考折叠 / 清屏,绝不用 ED \x1B[J 做边界擦除)
 *  - CUP 绝对定位      \x1B[<row>;<col>H
 * 不用原点模式(\x1B[?6h)、不依赖 ED 边界、不用 DECSC/DECRC、不用 IL/DL/SU/SD——这些在 conhost 上不可靠。
 *
 * 续写位(contentRow / contentCol)由 contentWrite 按字符宽度 + 折行模拟跟踪;CUP 到它即可随时回到内容续写位,
 * 故底栏刷新(状态行 / spinner)无需保存/恢复光标——CUP 回续写位即可。
 *
 * 关键洞察:prompt 与流式不同时活跃。INPUT 态光标常驻输入框、不调 drawStatusBar;RUNNING 态光标在续写位、
 * spinner 经 drawStatusBar 刷状态行后 CUP 回续写位。两态切换不重设区域(底栏高度恒 = 2),仅多行输入换行撑高时才 setRegion。
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
}

export interface InputView {
  prompt: string; // 纯文本 prompt(无 ANSI),如 '❯ '
  lines: string[]; // 全部输入行(prompt.ts 持有,layout 负责按高度开窗)
  cursorLine: number; // 0-based,lines 内行号
  cursorCol: number; // 显示宽度列(0-based)
  menu: { lines: string[] } | null; // 预渲染菜单行(带色),向上展开进内容区底
  dim?: boolean; // true=运行态占位(整行 dim)
}

// ── 内部状态 ──
let active = false;
let mode: 'input' | 'running' = 'input';
let footerH = 2; // 1 状态行 + 输入行数
let contentRow = 1; // 续写位行(1-based,屏坐标,[1,contentBottom])
let contentCol = 1; // 续写位列(1-based)
let segmentStartRow = 1; // 当前思考段起始行(供 eraseSegmentBack 精确擦除,修预存 wrapping 漏擦 bug)
let segLines = 0; // 当前段内累计物理行推进数(\n/折行/tab 换行),不受滚动钳位影响——据此判断段是否滚出过
let segActive = false; // 是否处于段中(beginSegment 后到 eraseSegmentBack 前)
let base: { model: string; contextBar: string; cwd: string } | null = null;
let statusText = '';
let spinnerFrame: string | undefined;
let lastView: InputView | null = null;
let lastMenuStartRow = 0; // 上次菜单起始屏行(供擦除)
let lastMenuRows = 0;
let resizeTimer: NodeJS.Timeout | null = null;
let exitHandler: (() => void) | null = null;
let sigwinchHandler: (() => void) | null = null;

const esc = {
  altOn: '\x1B[?1049h',
  altOff: '\x1B[?1049l',
  cursorShow: '\x1B[?25h',
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

export function contentMode(): void {
  if (!active) return;
  stdout.write(cup(contentRow, contentCol));
}

/**
 * 内容区正文写:CUP 到续写位 + 写出 + 按字符宽度/折行更新续写位。滚动区域内写满自动在区域内滚动,
 * 底栏在区域外不被顶。非 TTY / 未激活:直接 stdout.write(内联退化)。
 *
 * 续写位跟踪按**剥离 ANSI 后的可见文本**计算——SGR 颜色码在终端是 0 宽,若按原串逐字符算会把
 * `[2m` 等可打印字符算成宽度,导致续写位与实际光标脱钩。故先 stripAnsi 再模拟。
 */
export function contentWrite(s: string): void {
  if (!active || !ui.isTTY) {
    stdout.write(s);
    return;
  }
  stdout.write(cup(contentRow, contentCol) + s);
  const g = getGeo();
  const cols = g.cols;
  const bottom = g.contentBottom;
  const advanceRow = (r: number): number => (r >= bottom ? bottom : r + 1); // 到底则滚动,续写位留底
  const tracked = stripAnsi(s); // 按"可见"跟踪(ANSI 0 宽)
  for (const ch of tracked) {
    if (ch === '\n') {
      contentRow = advanceRow(contentRow);
      if (segActive) segLines++;
      contentCol = 1;
      continue;
    }
    if (ch === '\r') {
      contentCol = 1;
      continue;
    }
    if (ch === '\t') {
      const next = Math.floor((contentCol - 1) / 8) * 8 + 8 + 1;
      if (next > cols) {
        contentRow = advanceRow(contentRow);
        if (segActive) segLines++;
        contentCol = 1;
      } else contentCol = next;
      continue;
    }
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw === 0) continue; // 组合符 / 零宽:不推进
    if (contentCol + cw - 1 > cols) {
      // 当前行放不下:折行
      contentRow = advanceRow(contentRow);
      if (segActive) segLines++;
      contentCol = 1;
    }
    contentCol += cw;
  }
}

/** 标记当前续写位为一个段(思考段)起点,供 eraseSegmentBack 精确擦除。 */
export function beginSegment(): void {
  segmentStartRow = contentRow;
  segLines = 0;
  segActive = true;
}

/**
 * 擦除当前段的可见行(逐行 \x1B[2K,不用 ED——ED 会清穿底栏),续写位回段可见顶。
 *
 * 段物理行数 segLines(累计 \n/折行/tab 换行,不受滚动钳位影响)+ 末行若有内容算 1 = segRows。
 * 与段起点到内容区底的可用行 available 比较:
 *  - segRows > available:段写满触发过区域滚动,整屏都是段内容(前置内容已被滚出),
 *    从内容区顶 contentTop 擦——修「按绝对屏行 segmentStartRow 擦、滚动后段起点已滚出 →
 *    上方残留原始思考尾巴、折叠标题落在屏中」的 bug。
 *  - 否则未滚动:从段起点 segmentStartRow 擦。
 * 不越界到区域外(不擦底栏)。返回擦除行数。
 */
export function eraseSegmentBack(): number {
  if (!active) {
    segActive = false;
    return 0;
  }
  const g = getGeo();
  const segRows = segLines + (contentCol > 1 ? 1 : 0);
  const available = g.contentBottom - segmentStartRow + 1;
  let start = segRows > available ? g.contentTop : segmentStartRow;
  if (start < g.contentTop) start = g.contentTop;
  let rows = (contentRow - start) + (contentCol > 1 ? 1 : 0);
  const maxRows = g.contentBottom - start + 1;
  if (rows > maxRows) rows = maxRows;
  segActive = false;
  if (rows <= 0) return 0;
  let p = '';
  for (let i = 0; i < rows; i++) {
    p += cup(start + i, 1) + esc.clearLine;
  }
  stdout.write(p);
  contentRow = start;
  contentCol = 1;
  stdout.write(cup(contentRow, contentCol));
  return rows;
}

/** 清空内容区(保留底栏):全屏清 + 重设区域 + 续写位归 (1,1)。底栏由调用方随后重画。 */
export function clearContent(): void {
  if (!active) return;
  stdout.write('\x1B[1;1H\x1B[2J');
  setRegion(footerH);
  contentRow = 1;
  contentCol = 1;
  segmentStartRow = 1;
  segLines = 0;
  segActive = false;
  stdout.write(esc.home);
}

// ── 状态行 ──

/** 组合状态行可见串(带色),按 cols 截断防溢出(不折到输入行)。 */
function composeStatus(status: StatusBarData, cols: number): string {
  const sep = '  ';
  const sepW = sep.length;
  const lead = `◆ `;
  const model = truncateDisplay(status.model, 22);
  const ctx = status.contextBar; // 已带色
  const ctxW = ansiDisplayWidth(ctx);
  const st = (status.spinnerFrame ? status.spinnerFrame + ' ' : '') + status.status;
  const stW = displayWidth(st);
  const fixed = displayWidth(lead) + displayWidth(model) + sepW * 3 + ctxW + stW;
  const cwdBudget = cols - fixed - 1;
  const cwd = cwdBudget >= 6 ? truncateDisplay(status.cwd, cwdBudget) : '';
  return [
    `${ui.brightCyan}${lead}${ui.reset}${ui.bold}${model}${ui.reset}`,
    sep,
    ctx,
    sep,
    `${ui.dim}${cwd}${ui.reset}`,
    sep,
    `${status.spinnerFrame ? ui.brightMagenta : ui.dim}${st}${ui.reset}`,
  ].join('');
}

/** 画状态行(光标回续写位)。RUNNING 态 spinner 频繁调。 */
export function drawStatusBar(status?: StatusBarData): void {
  if (!active || !base) return;
  const s = status ?? { ...base, status: statusText, spinnerFrame };
  const g = getGeo();
  const statusRow = g.contentBottom + 1;
  stdout.write(cup(statusRow, 1) + esc.clearLine + composeStatus(s, g.cols));
  stdout.write(cup(contentRow, contentCol)); // 回续写位(不用 DECSC,直接 CUP 到跟踪位)
}

/** 更新易变状态(状态文字 + spinner 帧)并重画状态行。spinner / agent 用。 */
export function setStatus(status: string, frame?: string): void {
  statusText = status;
  spinnerFrame = frame;
  drawStatusBar();
}

/** 更新状态行基线(模型 / context / cwd)。repl 在轮次边界调。 */
export function setStatusBase(b: {
  model: string;
  contextBar: string;
  cwd: string;
}): void {
  base = b;
}

// ── 输入区(底栏输入框 + 向上菜单)──

/** 计算输入可见窗口(超 maxInputRows 时滑窗保光标可见),返回可见行 + 光标在窗口内行号。 */
function windowInput(
  lines: string[],
  cursorLine: number,
  rows: number
): { win: string[]; visLine: number } {
  const maxInputRows = Math.max(1, Math.floor(rows * 0.4));
  if (lines.length <= maxInputRows) return { win: lines, visLine: cursorLine };
  let start = Math.max(0, cursorLine - maxInputRows + 1);
  start = Math.min(start, lines.length - maxInputRows);
  return {
    win: lines.slice(start, start + maxInputRows),
    visLine: cursorLine - start,
  };
}

/**
 * 画输入区:擦旧菜单 → (必要时)setRegion → 画状态行 + 输入行 + 向上菜单,光标留输入框(dim 时回续写位)。
 * prompt.ts 每次按键调;enterInputMode / enterRunningMode 也调(空 / dim)。
 */
export function paintInput(view: InputView): void {
  if (!active || !base) return;
  lastView = view;
  const preGeo = getGeo();

  // 1. 擦旧菜单(用上次记录的起始行 + 行数,与本次几何无关——setRegion 不动屏幕内容)
  if (lastMenuRows > 0) {
    let p = '';
    for (let i = 0; i < lastMenuRows; i++) {
      p += cup(lastMenuStartRow + i, 1) + esc.clearLine;
    }
    stdout.write(p);
    lastMenuRows = 0;
  }

  // 2. 算输入行数 + 必要时 setRegion
  const inputRows = view.dim
    ? 1
    : windowInput(view.lines, view.cursorLine, preGeo.rows).win.length;
  const needFooterH = 1 + inputRows;
  let g = preGeo;
  if (needFooterH !== footerH) g = setRegion(needFooterH);

  // 3. 状态行(footerH 变或始终重画——便宜且避免旧状态行残留)
  const statusRow = g.contentBottom + 1;
  const status: StatusBarData = { ...base, status: statusText, spinnerFrame };
  stdout.write(
    cup(statusRow, 1) + esc.clearLine + composeStatus(status, g.cols)
  );

  // 4. 输入行(g.contentBottom+2 .. rows)
  const promptW = displayWidth(view.prompt);
  const firstInputRow = g.contentBottom + 2;
  const inputRowsAvail = g.footerH - 1;
  const win = view.dim
    ? [{ win: view.lines.slice(0, 1), visLine: 0 }]
    : [windowInput(view.lines, view.cursorLine, g.rows)];
  const { win: winLines, visLine } = win[0];
  for (let i = 0; i < inputRowsAvail; i++) {
    const line = winLines[i] ?? '';
    const r = firstInputRow + i;
    const prefix = i === 0 ? view.prompt : ' '.repeat(promptW);
    const text = view.dim
      ? `${ui.dim}${prefix}${line}${ui.reset}`
      : `${prefix}${line}`;
    stdout.write(cup(r, 1) + esc.clearLine + text);
  }

  // 5. 向上菜单(画在内容区底,底栏正上方)
  if (view.menu && view.menu.lines.length > 0) {
    const menuRows = Math.min(view.menu.lines.length, g.contentBottom);
    const menuStart = g.contentBottom - menuRows + 1;
    let p = '';
    for (let i = 0; i < menuRows; i++) {
      p += cup(menuStart + i, 1) + esc.clearLine + view.menu.lines[i];
    }
    stdout.write(p);
    lastMenuStartRow = menuStart;
    lastMenuRows = menuRows;
  }

  // 6. 光标
  if (view.dim) {
    stdout.write(cup(contentRow, contentCol));
  } else {
    const r = firstInputRow + visLine;
    const col = promptW + view.cursorCol + 1;
    stdout.write(cup(r, col));
  }
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
  if (active && base) {
    setRegion(2);
    paintInput({
      prompt: '❯ ',
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
    });
  }
}

/** 进入运行态:底栏输入行改 dim 占位,光标回续写位。footerH 恒 2。 */
export function enterRunningMode(status: string, placeholder: string): void {
  mode = 'running';
  statusText = status;
  spinnerFrame = undefined;
  if (active && base) {
    setRegion(2);
    paintInput({
      prompt: '❯ ',
      lines: [placeholder],
      cursorLine: 0,
      cursorCol: 0,
      menu: null,
      dim: true,
    });
    contentMode();
  }
}

// ── alt screen 生命周期 + 钩子 ──

export function enterAltScreen(): void {
  if (active || !ui.isTTY) return;
  active = true;
  stdout.write(esc.altOn);
  setRegion(2);
  contentRow = 1;
  contentCol = 1;
  segmentStartRow = 1;

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
      setRegion(footerH); // 用新 rows 重设区域(contentBottom 变)
      repaint();
    }, 100);
    resizeTimer?.unref?.();
  };
  process.on('SIGWINCH', sigwinchHandler);
}

/** 复原:复位 margins + 显光标 + 退 alt。幂等。 */
export function exitAltScreen(): void {
  if (!active) return;
  active = false;
  try {
    stdout.write('\x1B[r'); // 复位 DECSTBM margins
    stdout.write(esc.cursorShow);
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
}

export function isActive(): boolean {
  return active;
}
