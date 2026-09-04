import { stdin } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, visColToCharCol, padEndAnsi, truncateDisplay } from './render.js';
import * as layout from './layout.js';
import * as mouse from './mouse.js';
import { copyToClipboard, readClipboard } from './clipboard.js';
import { t } from '../i18n/index.js';

/**
 * 输入面板(TUI 内专属弹窗,Ctrl+G 唤起):记事本式多行编辑体验,**不外调 $EDITOR**。
 *
 * 定位:长 prompt 草稿 / 审查文稿的"安全网"——弹窗里 Enter 就是换行(不再触发发送),
 * 编辑动作全部 TUI 内闭环(光标移动 / 选区 / 复制剪切粘贴 / 撤销重做 / 软换行)。
 * 确认(Ctrl+S)只是把内容**填回输入框**,不自动发送——用户可以再看一遍再发。
 *
 * 渲染:直接 ANSI 写屏,画在 content 区(1..contentBottom)之上;关闭后
 * layout.repaintViewport() 整幅重画还原,内容缓冲不受影响(弹窗不进 content buffer)。
 *
 * 交互约定:
 *  - Enter / Ctrl+J      换行(弹窗内永远不发送)
 *  - Ctrl+S              确认:内容填回输入框(Ctrl+Enter 同义,终端可区分时)
 *  - Esc                 取消:丢弃弹窗内改动,输入框保持原样
 *  - Ctrl+C / X / V      复制 / 剪切 / 粘贴(有选区时;同步系统剪贴板)
 *  - Ctrl+Z / Y          撤销 / 重做;Ctrl+A 全选;Shift+方向键扩选
 *  - Ctrl+←/→ 词跳;Ctrl+Backspace/W 词删;Ctrl+U/K 删到行首/行尾
 *  - Ctrl+Home/End 文档首尾;PgUp/PgDn 翻页
 *  - 鼠标:左键点击定位光标 / 按住拖动选区 / 纯点击清选区(Ctrl+A 后点一下即取消);
 *    右键有选区=复制(并清高亮)、无选区=粘贴;滚轮滚动文本区(可滚离光标翻看)
 */

/** 弹窗内边距外扩:左右各留 2 列,顶部从 content 区第 2 行起。 */
const MARGIN_X = 2;
const TOP = 2;

export interface ComposerResult {
  /** 确认时的文本(null = 取消)。 */
  text: string | null;
}

export interface ComposerOpts {
  /** 初始内容(通常带入输入框现有文本);光标置末尾。 */
  initialText?: string;
}

// ── 纯逻辑:软换行(可单测)──

/** 一条展示行:logical 行号 + 在该行内的起始码点偏移 + 原文切片(无 ANSI)。 */
export interface WrapRow {
  li: number;
  start: number;
  text: string;
}

/**
 * 单逻辑行 → 展示行(软换行)。贪心:超宽时优先回退到最近的空格后断行(英文单词不腰斩),
 * 无空格(中文/长 token)按字符断。width 为可见列宽(中文按 2)。
 */
export function wrapLogicalLine(text: string, width: number): WrapRow[] {
  const w = Math.max(1, width);
  const chars = [...text];
  if (chars.length === 0) return [{ li: -1, start: 0, text: '' }];
  const rows: WrapRow[] = [];
  let start = 0;
  while (start < chars.length) {
    let rowW = 0;
    let end = start;
    let breakAfter = -1; // 最近一个空格之后的位置(码点索引,绝对)
    let j = start;
    while (j < chars.length) {
      const cw = displayWidth(chars[j] ?? '');
      if (rowW + cw > w) break;
      rowW += cw;
      j++;
      end = j;
      if (chars[j - 1] === ' ') breakAfter = j;
    }
    if (end < chars.length && end === start) {
      end = start + 1; // 单字符超宽(极窄终端):保底推进,防死循环
    } else if (end < chars.length && breakAfter - start >= 2) {
      end = breakAfter; // 词边界回退(断在空格后,空格留在上一行);至少留 2 字符,防空格独占一行
    }
    rows.push({ li: -1, start, text: chars.slice(start, end).join('') });
    start = end;
  }
  return rows;
}

/** 全文档 → 展示行序列(带 logical 行号)。 */
export function wrapAll(lines: readonly string[], width: number): WrapRow[] {
  const out: WrapRow[] = [];
  for (let li = 0; li < lines.length; li++) {
    for (const r of wrapLogicalLine(lines[li] ?? '', width)) out.push({ li, start: r.start, text: r.text });
  }
  return out;
}

// ── 纯逻辑:位置与选区(可单测)──

export interface Pos {
  line: number;
  /** 行内码点偏移(Array.from 口径)。 */
  col: number;
}

export interface Span {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

export function posCmp(a: Pos, b: Pos): number {
  return a.line - b.line || a.col - b.col;
}

/** anchor + cursor → 有序选区;相等时为 null(无选区)。 */
export function normSel(anchor: Pos, cur: Pos): Span | null {
  if (posCmp(anchor, cur) === 0) return null;
  return posCmp(anchor, cur) < 0
    ? { sl: anchor.line, sc: anchor.col, el: cur.line, ec: cur.col }
    : { sl: cur.line, sc: cur.col, el: anchor.line, ec: anchor.col };
}

export function spanText(lines: readonly string[], s: Span): string {
  if (s.sl === s.el) {
    const line = [...(lines[s.sl] ?? '')];
    return line.slice(s.sc, s.ec).join('');
  }
  const parts: string[] = [[...(lines[s.sl] ?? '')].slice(s.sc).join('')];
  for (let i = s.sl + 1; i < s.el; i++) parts.push(lines[i] ?? '');
  parts.push([...(lines[s.el] ?? '')].slice(0, s.ec).join(''));
  return parts.join('\n');
}

/** 删除选区,返回 { line, col } 为删除后的光标位;lines 原地更新。 */
export function deleteSpan(lines: string[], s: Span): Pos {
  const head = [...(lines[s.sl] ?? '')].slice(0, s.sc).join('');
  const tail = [...(lines[s.el] ?? '')].slice(s.ec).join('');
  if (s.sl === s.el) {
    lines[s.sl] = head + tail;
  } else {
    lines.splice(s.sl, s.el - s.sl + 1, head + tail);
  }
  return { line: s.sl, col: [...head].length };
}

// ── 弹窗主体 ──

/** emitKeypressEvents 后 stdin 会发 'keypress',该事件不在 ReadStream 类型里。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(event: 'keypress', listener: (str: string, key: Key) => void): this;
}

const CUP = (row: number, col: number) => `\x1B[${row};${col}H`;
const HIDE = '\x1B[?25l';
const SHOW = '\x1B[?25h';
const REVERSE = '\x1B[7m';
const REVERSE_OFF = '\x1B[27m';

const MAX_UNDO = 200;

export async function promptComposer(opts: ComposerOpts = {}): Promise<ComposerResult> {
  if (!layout.isActive()) return { text: null };
  const emitter = stdin as unknown as KeypressEmitter;

  const lines: string[] = (opts.initialText ?? '').split('\n');
  let cur: Pos = { line: lines.length - 1, col: [...(lines[lines.length - 1] ?? '')].length };
  let anchor: Pos | null = null; // 选区锚点(null = 无选区)
  let clip = ''; // 内部剪贴板(系统剪贴板读失败时的兜底)
  let scrollRow = 0; // 展示行滚动偏移

  let done = false;
  let resolve!: (v: ComposerResult) => void;
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  let geoCache = layout.getGeo();
  /** 最近一次 paint 的弹窗几何(1-based 屏坐标),供鼠标点击 → 文本坐标换算;null = 太小没画。 */
  let geoBox: {
    boxTop: number;
    boxBottom: number;
    left: number;
    innerW: number;
    textTop: number;
    textRows: number;
  } | null = null;
  let mouseDragged = false; // 本次按下是否真拖动过(未拖动的 release = 纯点击 → 清选区)
  let wheelOnly = false; // 滚轮刚滚过:下一次 paint 不把光标拉回可视区(允许滚离光标翻看)

  // undo / redo
  interface Snap {
    lines: string[];
    cur: Pos;
    anchor: Pos | null;
  }
  const undoStack: Snap[] = [];
  const redoStack: Snap[] = [];
  let lastUndoKey = '';
  let lastUndoAt = 0;

  const snap = (): Snap => ({
    lines: [...lines],
    cur: { ...cur },
    anchor: anchor ? { ...anchor } : null,
  });

  /** 撤销单位入栈。key 相同且间隔 <600ms 的连续输入(连续打字)合并为一个单位。 */
  function pushUndo(key?: string): void {
    const now = Date.now();
    if (key && key === lastUndoKey && now - lastUndoAt < 600) {
      lastUndoAt = now;
      return;
    }
    undoStack.push(snap());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    lastUndoKey = key ?? '';
    lastUndoAt = now;
  }

  function undo(): void {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(snap());
    lines.length = 0;
    lines.push(...prev.lines);
    cur = { ...prev.cur };
    anchor = prev.anchor ? { ...prev.anchor } : null;
    schedulePaint();
  }

  function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(snap());
    lines.length = 0;
    lines.push(...next.lines);
    cur = { ...next.cur };
    anchor = next.anchor ? { ...next.anchor } : null;
    schedulePaint();
  }

  // ── 选区工具 ──

  const sel = (): Span | null => (anchor ? normSel(anchor, cur) : null);
  const lineLen = (i: number): number => [...(lines[i] ?? '')].length;

  /** 在 pushUndo 之后调用:删除当前选区,光标落到删除点。 */
  function deleteSelection(): void {
    const s = sel();
    if (!s) return;
    cur = deleteSpan(lines, s);
    anchor = null;
  }

  // ── 编辑动作 ──

  /** 插入文本(可含 \n);先删选区。key 传 'type' 供连续输入合并撤销。 */
  function insertText(text: string, key?: string): void {
    if (!text) return;
    pushUndo(key);
    deleteSelection();
    const parts = text.split('\n');
    const line = [...(lines[cur.line] ?? '')];
    const head = line.slice(0, cur.col).join('');
    const tail = line.slice(cur.col).join('');
    if (parts.length === 1) {
      lines[cur.line] = head + text + tail;
      cur = { line: cur.line, col: cur.col + [...text].length };
    } else {
      const first = head + (parts[0] ?? '');
      const last = (parts[parts.length - 1] ?? '') + tail;
      lines.splice(cur.line, 1, first, ...parts.slice(1, -1), last);
      cur = { line: cur.line + parts.length - 1, col: [...(parts[parts.length - 1] ?? '')].length };
    }
    schedulePaint();
  }

  /** 光标移动:extend=Shift 扩选,否则清选区。 */
  function moveTo(p: Pos, extend: boolean): void {
    const old = cur;
    cur = {
      line: Math.max(0, Math.min(p.line, lines.length - 1)),
      col: Math.max(0, Math.min(p.col, lineLen(Math.max(0, Math.min(p.line, lines.length - 1))))),
    };
    if (extend) {
      if (!anchor) anchor = { ...old };
    } else {
      anchor = null;
    }
    schedulePaint();
  }

  /** 词边界:从 col 向 dir(-1/1) 找词边界(空格串 + 连续非空格)。 */
  function wordBoundary(li: number, col: number, dir: -1 | 1): number {
    const chars = [...(lines[li] ?? '')];
    const isWord = (i: number): boolean => {
      const ch = chars[i] ?? '';
      return ch !== ' ' && ch !== '\t';
    };
    let i = col;
    if (dir === -1) {
      while (i > 0 && !isWord(i - 1)) i--;
      while (i > 0 && isWord(i - 1)) i--;
    } else {
      while (i < chars.length && !isWord(i)) i++;
      while (i < chars.length && isWord(i)) i++;
    }
    return i;
  }

  function delWord(dir: -1 | 1): void {
    if (sel()) {
      pushUndo('del');
      deleteSelection();
      schedulePaint();
      return;
    }
    pushUndo('delword');
    const li = cur.line;
    const target = wordBoundary(li, cur.col, dir);
    const chars = [...(lines[li] ?? '')];
    const from = Math.min(cur.col, target);
    const to = Math.max(cur.col, target);
    if (to > from) {
      lines[li] = [...chars.slice(0, from), ...chars.slice(to)].join('');
      cur = { line: li, col: from };
    }
    schedulePaint();
  }

  function delToLineEdge(toEnd: boolean): void {
    pushUndo('delhead');
    deleteSelection();
    const li = cur.line;
    const chars = [...(lines[li] ?? '')];
    if (toEnd) {
      if (cur.col < chars.length) {
        lines[li] = chars.slice(0, cur.col).join('');
      } else if (li < lines.length - 1) {
        // 行尾:吞掉换行(与 readline C-k 一致)
        lines.splice(li, 2, (lines[li] ?? '') + (lines[li + 1] ?? ''));
      }
    } else {
      if (cur.col > 0) {
        lines[li] = chars.slice(cur.col).join('');
        cur = { line: li, col: 0 };
      } else if (li > 0) {
        const prevLen = lineLen(li - 1);
        lines.splice(li - 1, 2, (lines[li - 1] ?? '') + (lines[li] ?? ''));
        cur = { line: li - 1, col: prevLen };
      }
    }
    schedulePaint();
  }

  function backspace(): void {
    pushUndo('bs');
    if (sel()) {
      deleteSelection();
      schedulePaint();
      return;
    }
    if (cur.col > 0) {
      const chars = [...(lines[cur.line] ?? '')];
      lines[cur.line] = [...chars.slice(0, cur.col - 1), ...chars.slice(cur.col)].join('');
      cur = { line: cur.line, col: cur.col - 1 };
    } else if (cur.line > 0) {
      const prevLen = lineLen(cur.line - 1);
      lines.splice(cur.line - 1, 2, (lines[cur.line - 1] ?? '') + (lines[cur.line] ?? ''));
      cur = { line: cur.line - 1, col: prevLen };
    }
    schedulePaint();
  }

  function deleteKey(): void {
    pushUndo('del');
    if (sel()) {
      deleteSelection();
      schedulePaint();
      return;
    }
    const chars = [...(lines[cur.line] ?? '')];
    if (cur.col < chars.length) {
      lines[cur.line] = [...chars.slice(0, cur.col), ...chars.slice(cur.col + 1)].join('');
    } else if (cur.line < lines.length - 1) {
      lines.splice(cur.line, 2, (lines[cur.line] ?? '') + (lines[cur.line + 1] ?? ''));
    }
    schedulePaint();
  }

  // ── 光标 ↔ 展示行换算 ──

  function dispRows(): WrapRow[] {
    const innerW = Math.max(4, geoCache.cols - MARGIN_X * 2 - 2);
    return wrapAll(lines, innerW);
  }

  /** 光标所在展示行 index(-1 找不到时钳到末行)。 */
  function cursorDispIdx(rows: WrapRow[]): number {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.li === cur.line && cur.col >= r.start && cur.col <= r.start + [...r.text].length) return i;
    }
    return rows.length - 1;
  }

  /** 上下移动一行(按展示行)。 */
  function moveVertically(delta: -1 | 1, extend: boolean): void {
    const rows = dispRows();
    const idx = cursorDispIdx(rows);
    const target = Math.max(0, Math.min(rows.length - 1, idx + delta));
    const r = rows[target];
    if (!r) return;
    // 保持视觉列:当前光标视觉列 → 目标展示行同列
    const curRow = rows[idx];
    const curText = curRow ? curRow.text : '';
    const curOff = cur.col - (curRow ? curRow.start : 0);
    const vis = displayWidth([...curText].slice(0, Math.max(0, curOff)).join(''));
    const charCol = visColToCharCol(r.text, vis);
    moveTo({ line: r.li, col: r.start + charCol }, extend);
  }

  function moveByPage(delta: 1 | -1, extend: boolean): void {
    const rows = dispRows();
    const visible = Math.max(1, textRowCount());
    const idx = cursorDispIdx(rows);
    const target = Math.max(0, Math.min(rows.length - 1, idx + delta * visible));
    const r = rows[target];
    if (!r) return;
    moveTo({ line: r.li, col: r.start }, extend);
  }

  // ── 绘制 ──

  /** 文本区可用行数 = 弹窗总高 - 顶栏(含上边框) - 提示行(含中分隔) - 底边框。 */
  function textRowCount(): number {
    const g = geoCache;
    const boxTop = Math.min(TOP, Math.max(1, g.contentBottom - 5));
    const boxBottom = g.contentBottom - 1;
    return Math.max(1, boxBottom - boxTop - 2);
  }

  function schedulePaint(): void {
    if (paintTimer || done) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      paint();
    }, 16);
    paintTimer.unref?.();
  }

  function paint(): void {
    if (done) return;
    geoCache = layout.getGeo();
    const g = geoCache;
    if (g.contentBottom - 5 < 4 || g.cols < 24) {
      geoBox = null; // 终端太小:不画( rarely )
      return;
    }
    const boxTop = Math.min(TOP, Math.max(1, g.contentBottom - 5));
    const boxBottom = g.contentBottom - 1;
    const left = MARGIN_X + 1; // 1-based 起边框列
    const right = g.cols - MARGIN_X;
    const innerW = right - left - 1;
    const textTop = boxTop + 1;
    const textRows = textRowCount();
    const hintRow = boxBottom - 1;
    geoBox = { boxTop, boxBottom, left, innerW, textTop, textRows };

    const rows = dispRows();
    // 滚动:光标展示行保持可见(滚轮翻看后例外——允许滚离光标,下次键盘/鼠标操作再拉回)
    const cIdx = cursorDispIdx(rows);
    if (!wheelOnly) {
      if (cIdx < scrollRow) scrollRow = cIdx;
      else if (cIdx >= scrollRow + textRows) scrollRow = cIdx - textRows + 1;
    }
    wheelOnly = false;
    scrollRow = Math.max(0, scrollRow);

    const s = sel();
    const total = [...lines.join('\n')].length;
    const curVis = displayWidth([...(lines[cur.line] ?? '')].slice(0, cur.col).join(''));

    let buf = HIDE;
    // 顶栏:标题 + 右侧位置
    const title = ` ${t('composer.title')} `;
    const posInfo = `${t('composer.pos', { row: cur.line + 1, total: lines.length, col: curVis + 1, chars: total })} `;
    const titleW = displayWidth(title);
    const posW = displayWidth(posInfo);
    const fill = Math.max(0, innerW - titleW - posW - 2);
    buf += CUP(boxTop, left);
    buf += `${ui.accent}╭─${ui.bold}${title}${ui.reset}${ui.accent}${'─'.repeat(fill)}${posInfo}─╮${ui.reset}`;

    // 文本行
    const blank = ' '.repeat(innerW);
    for (let i = 0; i < textRows; i++) {
      buf += CUP(textTop + i, left);
      const r = rows[scrollRow + i];
      if (!r) {
        buf += `${ui.accent}│${ui.reset}${blank}${ui.accent}│${ui.reset}`;
        continue;
      }
      buf += `${ui.accent}│${ui.reset}${renderRow(r, s, innerW)}${ui.accent}│${ui.reset}`;
    }

    // 提示行(居中:截断后左右平分补空格,余数列归左)
    const hintText = truncateDisplay(t('composer.hint'), innerW);
    const hintW = displayWidth(hintText);
    const padL = Math.floor((innerW - hintW) / 2);
    const padR = Math.max(0, innerW - hintW - padL);
    buf += CUP(hintRow, left);
    buf += `${ui.accent}├${ui.reset}${ui.dim}${' '.repeat(padL)}${hintText}${' '.repeat(padR)}${ui.reset}${ui.accent}┤${ui.reset}`;

    // 底边框
    buf += CUP(boxBottom, left);
    buf += `${ui.accent}╰${'─'.repeat(innerW)}╯${ui.reset}`;

    // 光标(滚轮翻看把光标滚出可视区时不画,防 CUP 落到边框/提示行上)
    const cr = rows[cIdx];
    if (cr) {
      const rowIdx = cIdx - scrollRow;
      if (rowIdx >= 0 && rowIdx < textRows) {
        const vis = displayWidth([...cr.text].slice(0, cur.col - cr.start).join(''));
        buf += CUP(textTop + rowIdx, left + 1 + vis) + SHOW;
      } else {
        buf += SHOW;
      }
    } else {
      buf += SHOW;
    }
    try {
      layout.writeDirect(buf);
    } catch {
      // 忽略:极端时序下 stdout 已不可写
    }
  }

  /** 一条展示行 → 带选区反白的渲染文本(定宽 padEnd,padEndAnsi 剥 ANSI 算宽)。 */
  function renderRow(r: WrapRow, s: Span | null, innerW: number): string {
    const chars = [...r.text];
    const text = chars.join('');
    if (!s || s.sl > r.li || s.el < r.li) return padEndAnsi(text, innerW);
    const s0 = r.li === s.sl ? s.sc : 0;
    const e0 = r.li === s.el ? s.ec : lineLen(r.li); // 选区延伸到本行末
    const from = Math.max(s0, r.start);
    const to = Math.min(e0, r.start + chars.length);
    if (to <= from) return padEndAnsi(text, innerW);
    const a = from - r.start;
    const b = to - r.start;
    const out =
      chars.slice(0, a).join('') + REVERSE + chars.slice(a, b).join('') + REVERSE_OFF + chars.slice(b).join('');
    return padEndAnsi(out, innerW);
  }

  // ── 鼠标(经 layout.setOverlayMouseHandler 接管;弹窗期间消费全部事件防背景重画覆盖)──

  /** 屏坐标(1-based,SGR 报表原值)→ 文本 Pos。落在文本区外的行(边框/标题/提示行)返回 null。 */
  function screenToPos(row: number, col: number): Pos | null {
    const box = geoBox;
    if (!box) return null;
    if (row < box.textTop || row >= box.textTop + box.textRows) return null;
    const rows = dispRows();
    const idx = scrollRow + (row - box.textTop);
    if (idx < 0) return null;
    if (idx >= rows.length) {
      // 点到文本末尾下方的空白区:光标置文档末
      const last = lines.length - 1;
      return { line: last, col: lineLen(last) };
    }
    const r = rows[idx];
    if (!r) return null;
    // 屏列(1-based)→ 行内可见列(0-based,点击边框/超右界时钳到 [0, innerW])
    const vis = Math.max(0, Math.min(col - box.left - 1, box.innerW));
    const charCol = visColToCharCol(r.text, vis);
    return { line: r.li, col: Math.min(r.start + charCol, lineLen(r.li)) };
  }

  /** overlay 鼠标处理器:返回 true = layout 不再默认处理(选区/翻页会 repaintViewport 覆盖弹窗)。 */
  function onMouse(e: mouse.MouseEvent): boolean {
    if (done) return false;
    if (e.type === 'wheel') {
      if (!geoBox) return false; // 弹窗没画(终端太小):放行给 layout 滚背景
      const rows = dispRows();
      const maxScroll = Math.max(0, rows.length - geoBox.textRows);
      scrollRow = Math.max(0, Math.min(maxScroll, scrollRow + (e.dir > 0 ? -3 : 3)));
      wheelOnly = true; // 允许滚离光标
      schedulePaint();
      return true;
    }
    // 右键(单击 = press→release 未拖动):有选区→复制并清高亮;无选区→粘贴。与主输入框一致。
    if (e.button === 2 && e.type === 'release') {
      if (sel()) {
        copySel(false);
        anchor = null; // 复制后清高亮:视觉确认"已复制",也解了 Ctrl+A 后选不掉的困境
        schedulePaint();
      } else {
        void pasteClip();
      }
      return true;
    }
    if (e.button !== 0) return true; // 中键等:吞掉,不穿透
    if (e.type === 'press') {
      const p = screenToPos(e.row, e.col);
      if (p) {
        cur = p;
        anchor = { ...p }; // 锚点=按下位:后续拖动即成选区
        mouseDragged = false;
        schedulePaint();
      }
      return true;
    }
    if (e.type === 'drag') {
      if (!anchor) return true;
      const p = screenToPos(e.row, e.col);
      if (p && (p.line !== cur.line || p.col !== cur.col)) {
        cur = p;
        mouseDragged = true;
        schedulePaint();
      }
      return true;
    }
    if (e.type === 'release') {
      // 纯点击(未拖动):清选区——Ctrl+A 全选后点一下即可取消
      if (anchor && !mouseDragged) {
        anchor = null;
        schedulePaint();
      }
      return true;
    }
    return true;
  }

  // ── 生命周期 ──

  function finish(text: string | null): void {
    if (done) return;
    done = true;
    if (paintTimer) {
      clearTimeout(paintTimer);
      paintTimer = null;
    }
    try {
      process.removeListener('SIGWINCH', onResize);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    layout.setOverlayMouseHandler(null); // 注销接管,鼠标交还 layout(输入框框选/右键粘贴)
    stdin.pause();
    resolve({ text });
  }

  function onResize(): void {
    setTimeout(() => paint(), 50); // layout 自己的 SIGWINCH 重画可能在我们之后跑,稍等再画
  }

  function copySel(cut: boolean): void {
    const s = sel();
    if (!s) return;
    clip = spanText(lines, s);
    copyToClipboard(clip); // 尽力而为写系统剪贴板
    if (cut) {
      pushUndo('cut');
      cur = deleteSpan(lines, s);
      anchor = null;
    }
    schedulePaint();
  }

  async function pasteClip(): Promise<void> {
    let text = '';
    try {
      text = (await readClipboard()) ?? '';
    } catch {
      text = clip;
    }
    if (!text) text = clip;
    if (!text) return;
    insertText(text.replace(/\r\n?/g, '\n'), 'paste');
  }

  function onKey(_str: string, key?: Key): void {
    if (done || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;

    const isReturn = key.name === 'return' || key.name === 'enter';

    // Esc:取消(输入框保持原样)
    if (key.name === 'escape') {
      finish(null);
      return;
    }
    // Ctrl+S / Ctrl+Enter:确认填回(弹窗内 Enter 永远只是换行)
    if ((key.ctrl && key.name === 's') || (key.ctrl && isReturn)) {
      finish(lines.join('\n'));
      return;
    }
    // Ctrl+C:有选区=复制,无选区=什么都不做(取消用 Esc,别劫持复制习惯)
    if (key.ctrl && key.name === 'c') {
      copySel(false);
      return;
    }
    if (key.ctrl && key.name === 'x') {
      copySel(true);
      return;
    }
    if (key.ctrl && key.name === 'v') {
      void pasteClip();
      return;
    }
    if (key.ctrl && key.name === 'z') {
      undo();
      return;
    }
    if (key.ctrl && key.name === 'y') {
      redo();
      return;
    }
    if (key.ctrl && key.name === 'a') {
      anchor = { line: 0, col: 0 };
      cur = { line: lines.length - 1, col: lineLen(lines.length - 1) };
      schedulePaint();
      return;
    }
    if (key.ctrl && key.name === 'u') {
      delToLineEdge(false);
      return;
    }
    if (key.ctrl && key.name === 'k') {
      delToLineEdge(true);
      return;
    }
    if (key.ctrl && key.name === 'delete') {
      delWord(1);
      return;
    }
    if ((key.ctrl && key.name === 'backspace') || (key.ctrl && key.name === 'w')) {
      delWord(-1);
      return;
    }

    const extend = !!key.shift;

    switch (key.name) {
      case 'backspace':
        if (!key.ctrl) backspace();
        return;
      case 'delete':
        if (!key.ctrl) deleteKey();
        return;
      case 'left':
        if (key.ctrl) {
          const t = wordBoundary(cur.line, cur.col, -1);
          moveTo({ line: cur.line, col: t }, extend);
        } else if (cur.col > 0) {
          moveTo({ line: cur.line, col: cur.col - 1 }, extend);
        } else if (cur.line > 0) {
          moveTo({ line: cur.line - 1, col: lineLen(cur.line - 1) }, extend);
        }
        return;
      case 'right':
        if (key.ctrl) {
          const t = wordBoundary(cur.line, cur.col, 1);
          moveTo({ line: cur.line, col: t }, extend);
        } else if (cur.col < lineLen(cur.line)) {
          moveTo({ line: cur.line, col: cur.col + 1 }, extend);
        } else if (cur.line < lines.length - 1) {
          moveTo({ line: cur.line + 1, col: 0 }, extend);
        }
        return;
      case 'up':
        moveVertically(-1, extend);
        return;
      case 'down':
        moveVertically(1, extend);
        return;
      case 'home':
        if (key.ctrl) {
          moveTo({ line: 0, col: 0 }, extend);
        } else {
          moveTo({ line: cur.line, col: 0 }, extend);
        }
        return;
      case 'end':
        if (key.ctrl) {
          moveTo({ line: lines.length - 1, col: lineLen(lines.length - 1) }, extend);
        } else {
          moveTo({ line: cur.line, col: lineLen(cur.line) }, extend);
        }
        return;
      case 'pageup':
        moveByPage(-1, extend);
        return;
      case 'pagedown':
        moveByPage(1, extend);
        return;
      default:
        break;
    }

    // 换行:Enter / Ctrl+J(弹窗内永不发送)
    if (isReturn || (key.ctrl && key.name === 'j')) {
      insertText('\n', 'nl');
      return;
    }
    if (key.name === 'tab') {
      insertText('  ');
      return;
    }

    // 可打印字符(粘贴会逐字符到达;insertText 撤销合并让大粘贴仍是一个撤销单位)。
    // FEFF(BOM 字符)过滤:终端级粘贴绕过 readClipboard 的剥离,会把它敲进文本渲染成方块。
    const s = key.sequence ?? '';
    if (s && s >= ' ' && s !== '\uFEFF' && !key.ctrl && !key.meta) {
      insertText(s, 'type');
    }
  }

  return new Promise<ComposerResult>((res) => {
    resolve = res;
    try {
      stdin.setRawMode(true);
    } catch {
      res({ text: null });
      return;
    }
    layout.setOverlayMouseHandler(onMouse); // 弹窗期间接管鼠标:点击定位/拖选/右键复制粘贴/滚轮
    stdin.resume();
    emitter.on('keypress', onKey);
    try {
      process.on('SIGWINCH', onResize);
    } catch {
      // 忽略
    }
    paint();
  });
}
