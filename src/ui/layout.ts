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
}

export interface InputView {
  prompt: string; // 纯文本 prompt(无 ANSI),如 '❯ '
  lines: string[]; // 全部输入行(prompt.ts 持有,layout 负责按高度开窗)
  cursorLine: number; // 0-based,lines 内行号
  cursorCol: number; // 显示宽度列(0-based)
  menu: { lines: string[] } | null; // 预渲染菜单行(带色),向上展开进内容区底
  dim?: boolean; // true=运行态占位(整行 dim)
  caret?: boolean; // true=在光标处画块状光标(反白光标右侧字符,行末反白空格),示"现在在哪输入";默认 true。picker 等非文本输入传 false
}

// ── 内部状态 ──
let active = false;
let mode: 'input' | 'running' = 'input';
let footerH = 2; // 1 状态行 + 输入行数
let contentRow = 1; // 续写位行(1-based,屏坐标,[1,contentBottom])
let contentCol = 1; // 续写位列(1-based)
let segmentStartRow = 1; // 当前思考段起始屏行(供 eraseSegmentBack 定位擦除起点;段内行数由 content 段标记跟踪)
let scrollOffset = 0; // 滚动回看距尾行数(0=尾,跟随新内容);>0 时 viewport 显历史、状态行显滚动指示
let base: { model: string; contextBar: string; cwd: string } | null = null;
let statusText = '';
let spinnerFrame: string | undefined;
let turnStart: number | null = null; // RUNNING 态起点(Date.now());INPUT 态为 null。composeStatus 据此拼走时。
let turnTimer: NodeJS.Timeout | null = null; // 走时刷新计时器(独立于 spinner):流式期间 spinner 停转,由它续刷状态行。
let lastView: InputView | null = null;
let lastMenuStartRow = 0; // 上次菜单起始屏行(供擦除)
let lastMenuRows = 0;
let resizeTimer: NodeJS.Timeout | null = null;
let exitHandler: (() => void) | null = null;
let sigwinchHandler: (() => void) | null = null;

const esc = {
  altOn: '\x1B[?1049h',
  altOff: '\x1B[?1049l',
  altScrollOn: '\x1B[?1007h', // xterm alternate scroll:alt 屏内滚轮转发 ↑/↓(配合 onKey/onRunningKey 的 ↑/↓ 滚动)
  altScrollOff: '\x1B[?1007l',
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
  // 滚动回看时回内容区底(光标不入输入框,viewport 锁历史)
  stdout.write(
    cup(
      scrollOffset === 0 ? contentRow : getGeo().contentBottom,
      scrollOffset === 0 ? contentCol : 1
    )
  );
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
  // 滚动回看时(scrollOffset>0)只喂缓冲 + 推进续写位,不物理写——否则新流式内容覆盖 viewport 历史行。
  // 回尾(scrollOffset===0)才 cup 到续写位物理写出(== 实时屏)。
  if (scrollOffset === 0) stdout.write(cup(contentRow, contentCol) + s);
  const g = getGeo();
  const cols = g.cols;
  const bottom = g.contentBottom;
  const advanceRow = (r: number): number => (r >= bottom ? bottom : r + 1); // 到底则滚动,续写位留底
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
}

/** 标记当前续写位为一个段(思考段)起点:记屏起点(供擦除定位)+ content 段标记(供缓冲同步删)。 */
export function beginSegment(): void {
  segmentStartRow = contentRow;
  content.beginSegment();
}

/**
 * 擦除当前段的可见行(逐行 \x1B[2K,不用 ED——ED 会清穿底栏),续写位回段可见顶;并同步 content 缓冲删段。
 *
 * content.eraseSegment() 返回段物理行数(segLines + 末行部分)并从缓冲删除该段——保证滚动回看只看到
 * 折叠标题、不看到已擦的思考原文。该行数 = segRows,据此判段是否滚出过:
 *  - segRows > available:段写满触发过区域滚动,整屏都是段内容(前置内容已被滚出),从内容区顶 contentTop 擦;
 *  - 否则未滚动:从段起点 segmentStartRow 擦。
 * 不越界到区域外(不擦底栏)。返回擦除的屏幕行数。
 *
 * **滚动回看态(scrollOffset>0)只删缓冲、不物理擦**:段在滚动态经 contentWrite 只喂缓冲、未物理写屏,
 * 屏上无段可见,此时按屏行 \x1B[2K 物理擦会清掉用户正在看的历史视图(思考折叠把整屏擦白,而非在底部默默隐藏)。
 * 故滚动态仅 content.eraseSegment() 删缓冲 + 复位续写位到段起点(使回尾后续写落在折叠标题位),不发任何
 * cup/clearLine;回尾时 repaintViewport 从缓冲重画即显折叠标题。返回 0(未物理擦)。
 */
export function eraseSegmentBack(): number {
  if (!active) return 0;
  const g = getGeo();
  const segRows = content.eraseSegment(); // 删缓冲段,返回段物理行数
  if (segRows <= 0) return 0;
  if (scrollOffset > 0) {
    // 滚动回看态:段未物理写屏,不物理擦(否则清穿历史视图);仅复位续写位到段起点
    contentRow = segmentStartRow;
    contentCol = 1;
    return 0;
  }
  const available = g.contentBottom - segmentStartRow + 1;
  let start = segRows > available ? g.contentTop : segmentStartRow;
  if (start < g.contentTop) start = g.contentTop;
  let rows = (contentRow - start) + (contentCol > 1 ? 1 : 0);
  const maxRows = g.contentBottom - start + 1;
  if (rows > maxRows) rows = maxRows;
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

/** 清空内容区(保留底栏):全屏清 + 重设区域 + 续写位归 (1,1) + 清缓冲 + 回尾。底栏由调用方随后重画。 */
export function clearContent(): void {
  if (!active) return;
  stdout.write('\x1B[1;1H\x1B[2J');
  setRegion(footerH);
  contentRow = 1;
  contentCol = 1;
  segmentStartRow = 1;
  scrollOffset = 0;
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
  const lead = `◆ `;
  const model = truncateDisplay(status.model, 22);
  const ctx = status.contextBar; // 已带色
  const ctxW = ansiDisplayWidth(ctx);
  // 滚动回看时状态段改显历史指示(无 spinner——滚动只在 INPUT 态)
  const scrolled = scrollOffset > 0;
  let st: string;
  if (scrolled) {
    st = `历史 ↑${scrollOffset} (PgDn 回底)`; // 滚动回看显历史指示,不显走时
  } else {
    st = (status.spinnerFrame ? status.spinnerFrame + ' ' : '') + status.status;
    // RUNNING 态追加走时:整轮从 enterRunningMode 起计时,200ms 计时器续刷使其连续递增。
    if (mode === 'running' && turnStart != null) {
      st += ` · ${fmtElapsed(Date.now() - turnStart)}`;
    }
  }
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
    `${scrolled ? ui.yellow : status.spinnerFrame ? ui.brightMagenta : ui.dim}${st}${ui.reset}`,
  ].join('');
}

/** 画状态行(光标回续写位)。RUNNING 态 spinner 频繁调。 */
export function drawStatusBar(status?: StatusBarData): void {
  if (!active || !base) return;
  const s = status ?? { ...base, status: statusText, spinnerFrame };
  const g = getGeo();
  const statusRow = g.contentBottom + 1;
  stdout.write(cup(statusRow, 1) + esc.clearLine + composeStatus(s, g.cols));
  // 回续写位;滚动回看时回内容区底(光标不入输入框,viewport 锁历史)
  stdout.write(
    cup(
      scrollOffset === 0 ? contentRow : g.contentBottom,
      scrollOffset === 0 ? contentCol : 1
    )
  );
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
  turnTimer = setInterval(() => drawStatusBar(), 200);
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
  if (!active || !ui.isTTY || scrollOffset !== 0) return;
  stdout.write(cup(contentRow, contentCol) + esc.clearLine + text);
}

/** 清掉续写位那行瞬时活动文本(配合 paintLiveAtCursor)。 */
export function clearLiveAtCursor(): void {
  if (!active || !ui.isTTY || scrollOffset !== 0) return;
  stdout.write(cup(contentRow, contentCol) + esc.clearLine);
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
  const needFooterH = 1 + vis.inputRows;
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

  // 4. 输入行(g.contentBottom+2 .. rows)——按可视行画,首行带 prompt、其余缩进 promptW
  const firstInputRow = g.contentBottom + 2;
  const inputRowsAvail = g.footerH - 1;
  const indent = ' '.repeat(promptW);
  const showCaret = view.caret !== false; // 默认 true;picker 等非文本输入传 false 关闭块状光标
  for (let i = 0; i < inputRowsAvail; i++) {
    const line = vis.visRows[i] ?? '';
    const r = firstInputRow + i;
    const prefix = vis.startVis === 0 && i === 0 ? view.prompt : indent;
    let text: string;
    if (view.dim) {
      text = `${ui.dim}${prefix}${line}${ui.reset}`;
    } else if (showCaret && i === vis.visLine) {
      // 块状光标:反白光标右侧字符(cur),行末(无字符)反白一个空格——示"现在在哪输入"
      const { before, cur, after } = splitAtVisCol(line, vis.cursorVisCol);
      text = `${prefix}${before}${ui.reverse}${cur || ' '}${ui.reset}${after}`;
    } else {
      text = `${prefix}${line}`;
    }
    buf += cup(r, 1) + esc.clearLine + text;
  }

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
    // 滚动回看时归内容区底(dim=运行态占位,光标不入输入框,viewport 锁历史)
    buf += cup(
      scrollOffset === 0 ? contentRow : g.contentBottom,
      scrollOffset === 0 ? contentCol : 1
    );
  } else {
    const r = firstInputRow + vis.visLine;
    const col = promptW + vis.cursorVisCol + 1;
    buf += cup(r, col);
  }

  if (buf) stdout.write(buf); // 整帧一次写出(footerH 不变时):终端原子应用,无中间空白→不闪烁
}

/**
 * 运行态 typeahead 回显:定向写输入行(底栏输入框),把 dim 占位换成已打字文本(无打字时仍显 placeholder)。
 * 只 cup 输入行 + clearLine + dim 文本 + 归位——不调 setRegion(运行中禁多行,避免 DECSTBM 抖动)、
 * 不重画状态行/contentBottom、不用 ED。同步 lastView 为 dim 视图,使 scrollBy/resize 的 repaint 仍显当前回显。
 * 光标归续写位(滚动回看时归内容区底)——typeahead 无可见输入框光标,避开与 contentWrite/drawStatusBar 争用。
 */
export function paintRunningInputEcho(text: string, placeholder: string): void {
  if (!active || !base) return;
  const g = getGeo();
  const inputRow = g.contentBottom + 2; // 运行态 footerH 恒 2:状态行(contentBottom+1)+ 输入行(contentBottom+2)
  const shown = text.length > 0 ? text : placeholder;
  stdout.write(
    cup(inputRow, 1) + esc.clearLine + `${ui.dim}❯ ${shown}${ui.reset}`
  );
  // 同步 lastView:dim 视图(lines=回显文本),使滚动/resize 的 repaint 不擦掉已打字
  lastView = {
    prompt: '❯ ',
    lines: [shown],
    cursorLine: 0,
    cursorCol: 0,
    menu: null,
    dim: true,
  };
  // 光标归续写位(滚动回看时归内容区底)
  stdout.write(
    cup(
      scrollOffset === 0 ? contentRow : g.contentBottom,
      scrollOffset === 0 ? contentCol : 1
    )
  );
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
  turnStart = null; // 停走时
  stopTurnTimer();
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

/** 进入运行态:底栏输入行改 dim 占位,光标回续写位。footerH 恒 2。新轮回尾(确保新内容可见)。 */
export function enterRunningMode(status: string, placeholder: string): void {
  mode = 'running';
  statusText = status;
  spinnerFrame = undefined;
  turnStart = Date.now(); // 起走时(整轮从发起到 enterInputMode 止)
  resetScroll(); // 若上轮 INPUT 滚动过(未打字回底),新轮回尾
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
    startTurnTimer(); // 续刷状态行走时(流式期间 spinner 停转,由它兜底)
    contentMode();
  }
}

// ── alt screen 生命周期 + 钩子 ──

export function enterAltScreen(): void {
  if (active || !ui.isTTY) return;
  active = true;
  stdout.write(esc.altOn);
  stdout.write(esc.altScrollOn); // alt 屏滚轮转发 ↑/↓(滚轮滚动靠此 + onKey/onRunningKey 的 ↑/↓ 滚动)
  setRegion(2);
  contentRow = 1;
  contentCol = 1;
  segmentStartRow = 1;
  scrollOffset = 0;
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
  // raw 还原独立 try:非 TTY / 不支持时 setRawMode 抛错,不应阻断 stdout 恢复(alt 退屏必须执行)。
  try {
    stdin.setRawMode(false); // 还原 raw(RUNNING 态常驻 raw,退出时必须还原,否则终端残留 raw 模式)
  } catch {
    // 非 TTY / 不支持:忽略
  }
  try {
    stdout.write('\x1B[r'); // 复位 DECSTBM margins
    stdout.write(esc.cursorShow);
    stdout.write(esc.altScrollOff); // 关 alt 屏滚轮转发
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
