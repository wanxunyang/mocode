// L1 选区纯计算:归一化 / 取文本 / 高亮 / 输入框坐标映射(无副作用、不写屏)。
// 从 layout-internal/core.ts 按依赖分层拆出;可变运行态集中在 ./state.ts。

import { charWidth, displayWidth, wrapByDisplayWidth, stripAnsi, sliceByDisplayCol } from '../render.js';
import * as content from '../content.js';
import { readClipboard } from '../clipboard.js';
import type { InputView } from '../layout-types.js';
import { state } from './state.js';
import { getGeo } from './screen.js';

/** 选区归一化(anchor/end 按阅读顺序排序为 start/end)。无选区返 null。 */
export function normalizeSelection(): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
  if (!state.selection) return null;
  const a = { line: state.selection.anchorLine, col: state.selection.anchorCol };
  const b = { line: state.selection.endLine, col: state.selection.endCol };
  const aFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
  return aFirst
    ? { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col }
    : { startLine: b.line, startCol: b.col, endLine: a.line, endCol: a.col };
}

/** 给自洽带色行的显示列区间 [colStart,colEnd) 套「统一亮黄底 + 黑字」。
 *  强制重设前/背景,无视原 SGR:md 字符常带 ui.dim / ui.cyan / ui.gray 等,
 *  仅靠 SGR 7 反转对比度极弱;改用显式「亮黄底 SGR 103 + 黑前景 SGR 30」,
 *  跨终端一致。退反白用 0 清 SGR,行末 active SGR 自然续接。
 *  关键:反白 active 期间**吃掉所有行内 SGR**(不让前景色干扰)——否则
 *  行内首个 \x1B[2m(dim)/\x1B[36m(cyan)/\x1B[1m(bold) 进选区后仍生效,
 *  前景被压回原色,整片亮黄底被切割、看着「花」;直穿则带 dim 等,对比不足。
 *  反白外 SGR 直穿,保留原色。 */
export const SEL_OPEN = '\x1B[30;103m'; // 30:黑前景 | 103:亮黄背景

export const SEL_OFF = '\x1B[0m'; // 全清 SGR,行末 active 状态续接

export function highlightRange(line: string, colStart: number, colEnd: number): string {
  if (colEnd <= colStart) return line;
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  let w = 0;
  let out = '';
  let opened = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // SGR 段:反白内直接吃,不让行内前景色进选区;反白外直穿,保留原色。
      if (opened) continue;
      out += parts[i];
      continue;
    }
    for (const ch of parts[i]) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
      if (!opened && w >= colStart && w < colEnd) {
        out += SEL_OPEN;
        opened = true;
      }
      if (opened && w >= colEnd) {
        out += SEL_OFF;
        opened = false;
      }
      out += ch;
      w += cw;
    }
  }
  if (opened) out += SEL_OFF;
  return out;
}

/** 从归一化选区抠出纯文本(去 ANSI,按显示列裁切,行间 \n 拼接)。越界行跳过(缓冲被 trim 等边界情况)。 */
export function extractSelectionText(sel: {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}): string {
  const out: string[] = [];
  for (let abs = sel.startLine; abs <= sel.endLine; abs++) {
    const raw = content.lineAt(abs);
    if (raw == null) continue;
    const plain = stripAnsi(raw);
    const lineW = displayWidth(plain);
    const colStart = abs === sel.startLine ? sel.startCol : 0;
    const colEnd = abs === sel.endLine ? sel.endCol : lineW;
    out.push(sliceByDisplayCol(plain, colStart, colEnd));
  }
  return out.join('\n');
}

/** 输入框选区归一化:按 (line, col) 字典序排成 start/end。无选区返 null。 */
export function normalizeInputSelection(): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} | null {
  if (!state.inputSelection) return null;
  const a = state.inputSelection.anchor;
  const b = state.inputSelection.end;
  const aFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
  return aFirst
    ? { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col }
    : { startLine: b.line, startCol: b.col, endLine: a.line, endCol: a.col };
}

/** 从归一化输入框选区抠出纯文本(lines 上不带 ANSI,直接按 display_col 切)。越界行跳到该行末尾。 */
export function extractInputSelectionText(sel: {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}): string {
  if (!state.lastView) return '';
  const out: string[] = [];
  for (let l = sel.startLine; l <= sel.endLine; l++) {
    const raw = state.lastView.lines[l];
    if (raw == null) continue;
    const lineW = displayWidth(raw);
    const colStart = l === sel.startLine ? sel.startCol : 0;
    const colEnd = l === sel.endLine ? sel.endCol : lineW;
    out.push(sliceByDisplayCol(raw, colStart, colEnd));
  }
  return out.join('\n');
}

/** 输入框 lastView 签名:lines 数 + 每行 display_w 累加;任何键改动 lines 即变化,用作 inputSelection 失效判据。 */
export function inputViewSig(view: InputView | null | undefined): string {
  if (!view) return '';
  return view.lines.length + '|' + view.lines.map((l) => displayWidth(l).toString()).join(',');
}

/** 屏行是否落在底栏输入行范围内(paintInput 的 firstInputRow..firstInputRow+inputRowsAvail-1)。 */
export function isInputRow(row: number): boolean {
  const g = getGeo();
  const firstInputRow = g.contentBottom + 3 + state.planRows;
  const inputRowsAvail = Math.max(0, g.footerH - 4 - state.planRows);
  return row >= firstInputRow && row < firstInputRow + inputRowsAvail;
}

/** 右键单击输入行(未拖动的 press→release):读剪贴板 + 回调 pasteHandler 贴入。异步但不阻塞其他事件。 */
export function pasteIntoInput(): void {
  if (!state.pasteHandler) return;
  const handler = state.pasteHandler;
  readClipboard()
    .then((text) => {
      if (text && state.active) handler(text);
    })
    .catch(() => {});
}

/**
 * 把屏(行,列)反推到 (lines 行号, 行内 display_col, flatIdx, 段内显示列),
 * 算法与 setInputCursorFromClick 抽出前等价——基于 lastView 的"折行 + 滚动窗"几何,
 * 与 paintInput 的 windowInputVis 同源(startVis 同锚),保证 press/drag 落点 = 画上高亮位置。
 * 越界点(空行)→ 落末行末段末。
 */
export function inputScreenToInputPos(
  screenRow: number,
  screenCol: number,
): { line: number; displayCol: number; flatIdx: number; inSegVis: number } | null {
  if (!state.lastView) return null;
  const g = getGeo();
  const promptW = displayWidth(state.lastView.prompt);
  const firstInputRow = g.contentBottom + 3 + state.planRows;
  const inputRowsAvail = Math.max(0, g.footerH - 4 - state.planRows);

  // 输入框可视区的 (visRow, visCol) 屏幕坐标 → 0-based。
  // 点到可视区末行之下(空白区)→ 落到最末可视行(光标归最后一段);isInputRow 已挡可视区之上的点击。
  const visRow = Math.max(0, Math.min(screenRow - firstInputRow, Math.max(0, inputRowsAvail - 1)));
  // 屏幕列 (1-based SGR) → 显示列 (0-based),再扣 prompt 宽;尾点容许越界 clip 到 >=0。
  const visCol = Math.max(0, screenCol - 1 - promptW);

  // 复刻 windowInputVis 的折行 + 滚动窗(输入态, lines 全量参与)。
  // lastView.lines 在 prompt 的 redraw() 中为 dispLines()(含 chip pre 行 / chip prefix 列);
  // chip 模式下点击 chip 区域也走同一算法,与 paintInput 的视协议(段接缝除外)一致。
  const cols = Math.max(1, g.cols - promptW);
  const lineVis: string[][] = state.lastView.lines.map((l) => wrapByDisplayWidth(l, cols));
  const flat: string[] = [];
  for (const lv of lineVis) for (const r of lv) flat.push(r);
  const totalVis = flat.length;
  const maxInputRows = Math.max(1, Math.floor(g.rows * 0.4));

  // 起窗偏移:用 lastView 当前光标位置作为锚(与 paintInput 同算法)。
  let curVisLine = 0;
  {
    const clRows = lineVis[state.lastView.cursorLine] ?? [''];
    let acc = 0;
    for (let i = 0; i < clRows.length; i++) {
      const rw = displayWidth(clRows[i]);
      if (state.lastView.cursorCol <= acc + rw) {
        curVisLine = i;
        break;
      }
      acc += rw;
      curVisLine = i;
    }
  }
  let curAbs = curVisLine;
  for (let i = 0; i < state.lastView.cursorLine; i++) curAbs += lineVis[i].length;
  const startVis =
    totalVis > maxInputRows ? Math.max(0, Math.min(curAbs - maxInputRows + 1, totalVis - maxInputRows)) : 0;

  // 点到可视区末行之下(空行)→ 等价"光标在最末可视行的字符串末尾"。
  if (startVis + visRow >= totalVis) {
    const lastFlatIdx = totalVis - 1;
    // 把 lastFlatIdx 反推到 (line, segInLine)
    let lastLine = 0;
    let lastSegInLine = lastFlatIdx;
    while (lastLine < lineVis.length && lastSegInLine >= lineVis[lastLine].length) {
      lastSegInLine -= lineVis[lastLine].length;
      lastLine++;
    }
    if (lastLine >= lineVis.length) {
      lastLine = lineVis.length - 1;
      lastSegInLine = lineVis[lastLine].length - 1;
    }
    // lines[lastLine] 内 display_col = 前 segInLine 段 display_w + 末段 display_w
    let inLineDisplayCol = 0;
    for (let s = 0; s <= lastSegInLine; s++) inLineDisplayCol += displayWidth(lineVis[lastLine][s] ?? '');
    return {
      line: lastLine,
      displayCol: inLineDisplayCol,
      flatIdx: lastFlatIdx,
      inSegVis: displayWidth(flat[lastFlatIdx]), // 段末
    };
  }

  // flatIdx = 点击可视段在 flat 中的绝对索引(startVis + visRow)
  const flatIdx = startVis + visRow;
  // 把 flatIdx 反推到 (line, segInLine) — line 给 paintInput 用(同 lines[cursorLine] 行号),
  // segInLine 给 prompt 做 cl/cc 反推用。
  let line = 0;
  let segInLine = flatIdx;
  while (line < lineVis.length && segInLine >= lineVis[line].length) {
    segInLine -= lineVis[line].length;
    line++;
  }
  if (line >= lineVis.length) {
    line = lineVis.length - 1;
    segInLine = lineVis[line].length - 1;
  }
  // lines[line] 内 display_col = 前 segInLine 段 display_w 累加 + 段内显示列。
  let inLineDisplayCol = 0;
  for (let s = 0; s < segInLine; s++) inLineDisplayCol += displayWidth(lineVis[line][s] ?? '');
  const seg = flat[flatIdx];
  const segW = displayWidth(seg);
  const inSeg = Math.min(visCol, segW); // 段尾点击容许越界 clip 到段末
  return {
    line,
    displayCol: inLineDisplayCol + inSeg,
    flatIdx,
    inSegVis: inSeg,
  };
}
