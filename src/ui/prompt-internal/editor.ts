import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from '../theme.js';
import { displayWidth, padEndDisplay, truncateDisplay, visColToCharCol, wrapByDisplayWidth } from '../render.js';
import * as layout from '../layout.js';
import * as mouse from '../mouse.js';
import { t } from '../../i18n/index.js';
import { promptComposer } from '../composer.js';
import { promptHistorySearch } from '../history-picker.js';
import {
  CONFIRM_SEND_MS,
  LONG_INPUT_CHARS,
  confirmSendMode,
  ensurePasteDetector,
  pasteState,
} from './paste.js';
import type {
  KeypressEmitter,
  PromptOpts,
  Seg,
  SlashCommand,
  SlashMenuItem,
} from './types.js';

/** 非 TTY / 未进 alt screen 时退化为普通 readline 行输入(无菜单、单行)。 */
function questionFallback(prompt: string): Promise<string> {
  return new Promise<string>((res, rej) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(prompt, (answer: string) => {
      rl.close();
      res(answer);
    });
    rl.on('error', (e) => {
      rl.close();
      rej(e);
    });
  });
}

/**
 * 读多行输入;TUI 下经 layout.paintInput 把输入框画在固定底栏、斜杠菜单向上展开进内容区底。
 * 换行:Ctrl+J / Alt+Enter / Shift+Enter(终端区分时)/ 粘贴的 LF。Enter 提交。返回行数组;null=空缓冲 Ctrl+D。
 * 非 TTY 退化为 readline.question(单行,返回 [answer])。raw 模式下 Ctrl+C 先恢复终端再 reject('SIGINT')。
 *
 * 渲染全归 layout(prompt 只持有编辑状态:lines / 光标 / 菜单),prompt 不直接发 ANSI 区域控制,
 * 避免 readline 光标错位与区域越界——颜色仅用在菜单行字符串里(由 layout 原样贴入)。
 */
export async function promptWithSlashMenu(
  opts: PromptOpts
): Promise<string[] | null> {
  if (!layout.isActive()) {
    const a = await questionFallback(opts.prompt);
    return [a];
  }

  const emitter = stdin as unknown as KeypressEmitter;
  const promptW = displayWidth(opts.prompt);
  // initialLines(运行中 typeahead 预填):用调用方给的行初始化;光标置文末。
  // 整篇输入是一个 Seg[]:可编辑段与粘贴块交替。光标永远落在某个可编辑段(segs[curSeg].frozen===false)上。
  let segs: Seg[] =
    opts.initialLines && opts.initialLines.length > 0
      ? [{ frozen: false, text: opts.initialLines.join('\n') }]
      : [{ frozen: false, text: '' }];
  let curSeg = 0; // 光标所在段(始终可编辑)
  let curOff = segs[0].text.length; // 段内字符偏移 = 文末
  let justSawCR = false; // \r\n 合一:粘贴的 \r 折行后,紧跟的 \n 吞掉(避免折两行)
  let menuOpen = false;
  let selected = 0;
  let filtered: SlashMenuItem[] = [];
  const MENU_MAX_VISIBLE = 7;
  let menuTop = 0; // 窗口首项在 filtered 中的索引,菜单最多显示 MENU_MAX_VISIBLE 条
  /** Ctrl+C 清空前的缓冲快照(Ctrl+Z 还原一次);单次生效,还原后即清。 */
  let undoSnapshot: {
    segs: Seg[];
    curSeg: number;
    curOff: number;
  } | null = null;
  /** 二次确认武装截止时刻(绝对 ms);0=未武装。见 submit() 与 MOCODE_CONFIRM_SEND。 */
  let confirmArmedUntil = 0;
  let resolved = false;
  let resolve!: (v: string[] | null) => void;
  let reject!: (e: Error) => void;
  /** 菜单行(预渲染,带色)——向上展开进内容区底,由 layout 贴入。最多显示 MENU_MAX_VISIBLE 条,支持上下滚动。 */
  function menuLines(): string[] {
    if (!menuOpen || filtered.length === 0) return [];
    const cols = layout.getGeo().cols;
    const visibleCount = Math.min(MENU_MAX_VISIBLE, filtered.length);
    // 保 selected 在窗口内:selected 顶到上/下边界时才挪 menuTop
    if (selected < menuTop) menuTop = selected;
    else if (selected >= menuTop + visibleCount) menuTop = selected - visibleCount + 1;
    const windowItems = filtered.slice(menuTop, menuTop + visibleCount);
    const maxName = Math.max(
      ...windowItems.map((item) => displayWidth(item.node.name + (item.node.children?.length ? ' ›' : ''))),
    );
    const hasMoreAbove = menuTop > 0;
    const hasMoreBelow = menuTop + visibleCount < filtered.length;
    return windowItems.map((item, i) => {
      const c = item.node;
      const globalIdx = menuTop + i;
      // 选中项:▸ 与文字均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = globalIdx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const branchSuffix = c.children?.length ? ' ›' : '';
      const name = padEndDisplay(c.name + branchSuffix, maxName);
      // 首/末附加滚动指示(▲/▼)而非替换整行
      const desc = c.desc;
      let scrollHint = '';
      if (i === 0 && hasMoreAbove) scrollHint = ' ▲';
      if (i === windowItems.length - 1 && hasMoreBelow) scrollHint = ' ▼';
      const hintW = displayWidth(scrollHint);
      const descW = cols - maxName - 5 - hintW; // marker + 空格 + 2 间距 + hint
      const descStr = descW > 0 ? truncateDisplay(desc, descW) : '';
      return `${marker} ${color}${name}${ui.reset}  ${color}${descStr}${ui.reset}${ui.dim}${scrollHint}${ui.reset}`;
    });
  }

  /** 单个 chip 的展示 token:[📋 行数 · 字符数] (含尾部空格,使相邻 chip 之间留空隙)。 */
  function chipToken(text: string): string {
    const lineCount = text.split('\n').length;
    const charCount = text.length;
    const lineText = t('prompt.lines', { count: lineCount });
    const charText = t('prompt.chars', {
      count: charCount < 1000 ? charCount : `${(charCount / 1000).toFixed(1)}K`,
    });
    return `[📋 ${lineText} · ${charText}] `;
  }

  /** 构建整段显示:可编辑段按原文(含换行)展开,粘贴块(chip)折叠成一行 token 内联在光标原位。
   *  返回展示行数组,以及每个段在"展示串"(= 展示行以 \n 拼接)中的字符起点,供光标正/反向映射。
   *  关键不变量:展示串与 segs 的"段贡献"长度一致(可编辑段贡献其原文长度,含其中 \n;
   *  chip 贡献其 token 长度,无 \n),故 segStart 同时是 dispLines.join('\n') 内的字符偏移。 */
  function buildDisplay(): { lines: string[]; segStart: number[] } {
    const out: string[] = [];
    const segStart: number[] = [];
    let gLen = 0;
    for (const s of segs) {
      segStart.push(gLen);
      if (!s.frozen) {
        const ls = s.text.split('\n');
        if (out.length === 0) out.push(...ls);
        else {
          out[out.length - 1] += ls[0];
          for (let k = 1; k < ls.length; k++) out.push(ls[k]);
        }
        gLen += s.text.length;
      } else {
        const tok = chipToken(s.text);
        if (out.length === 0) out.push(tok);
        else out[out.length - 1] += tok;
        gLen += tok.length;
      }
    }
    if (out.length === 0) out.push('');
    return { lines: out, segStart };
  }

  /** 当前光标段内显示列。 */
  function cursorCol(): number {
    return displayWidth(segs[curSeg].text.slice(0, curOff));
  }

  /** 光标 → 展示 (行, 列)。展示行内的列以显示宽度计。 */
  function cursorDisp(): { line: number; col: number } {
    const { lines: dispLines, segStart } = buildDisplay();
    const off = segStart[curSeg] + curOff;
    let remaining = off;
    let dl = 0;
    let dispColChars = 0;
    for (; dl < dispLines.length; dl++) {
      const L = dispLines[dl].length;
      if (remaining <= L) {
        dispColChars = remaining;
        break;
      }
      remaining -= L + 1;
    }
    if (dl >= dispLines.length) {
      dl = Math.max(0, dispLines.length - 1);
      dispColChars = dispLines[dl].length;
    }
    return { line: dl, col: displayWidth(dispLines[dl].slice(0, dispColChars)) };
  }

  /** 展示 (行, 显示列) → 段内字符偏移。供 ↑/↓ 移动后重新定位,以及鼠标点击的反向映射。 */
  function dispColToCharInLine(dispLine: number, dispCol: number): number {
    const { lines } = buildDisplay();
    const ln = lines[dispLine] ?? '';
    return visColToCharCol(ln, dispCol);
  }

  /** 展示 (行, 字符内偏移) → 段+偏移。光标永远落在可编辑段;点中 chip 则吸附到最近的可编辑边界。 */
  function mapDispToCursor(dispLine: number, charInLine: number): { seg: number; off: number } {
    const { lines: dispLines, segStart } = buildDisplay();
    let off = 0;
    for (let k = 0; k < dispLine && k < dispLines.length; k++) off += dispLines[k].length + 1;
    off += Math.max(0, Math.min(charInLine, (dispLines[dispLine] ?? '').length));
    for (let i = 0; i < segs.length; i++) {
      const start = segStart[i];
      const len = segs[i].frozen ? chipToken(segs[i].text).length : segs[i].text.length;
      // 可编辑段用闭区间;只读块用半开区间——其结束边界归紧随其后的可编辑段,
      // 否则光标恰好停在 chip 后的可编辑段开头时,会被误判落在 chip 上(边界争用)。
      const inside = segs[i].frozen ? off >= start && off < start + len : off >= start && off <= start + len;
      if (inside) {
        if (!segs[i].frozen) return { seg: i, off: off - start };
        // 落在只读块内:按就近原则吸附——靠近左沿→其前可编辑段末尾,靠近右沿→其后可编辑段开头。
        const distStart = off - start;
        const distEnd = start + len - off;
        return distStart <= distEnd ? editableEndBefore(i) : editableStartAfter(i);
      }
    }
    return lastEditableEnd();
  }
  function editableStartAfter(i: number): { seg: number; off: number } {
    let j = i + 1;
    while (j < segs.length && segs[j].frozen) j++;
    if (j < segs.length) return { seg: j, off: 0 };
    return lastEditableEnd();
  }
  function editableEndBefore(i: number): { seg: number; off: number } {
    let j = i - 1;
    while (j >= 0 && segs[j].frozen) j--;
    if (j >= 0) return { seg: j, off: segs[j].text.length };
    return firstEditableStart();
  }
  function firstEditableStart(): { seg: number; off: number } {
    for (let j = 0; j < segs.length; j++) if (!segs[j].frozen) return { seg: j, off: 0 };
    return { seg: 0, off: 0 };
  }
  function lastEditableEnd(): { seg: number; off: number } {
    for (let j = segs.length - 1; j >= 0; j--) if (!segs[j].frozen) return { seg: j, off: segs[j].text.length };
    return { seg: 0, off: 0 };
  }
  /** 在光标处插入文本(含换行则落进当前可编辑段,原样保留)。供短粘贴与可打印字符共用。 */
  function insertText(text: string): void {
    const s = segs[curSeg].text;
    segs[curSeg].text = s.slice(0, curOff) + text + s.slice(curOff);
    curOff += text.length;
  }
  /** 落一段粘贴文本:长粘贴 → 在此处插入一个只读 chip(把当前可编辑段从光标切开成「前段 + chip + 后段」),
   *  短粘贴 → 作为可编辑文本插入。连续长粘贴会产生相邻 chip,各自独立;两次粘贴之间敲的字是可编辑段,
   *  可直接编辑、也可退格删掉任一 chip。光标落在 chip 之后的可编辑段(即使为空也保留,保证光标有落点)。 */
  function applyPastedText(buf: string): void {
    if (!buf) return;
    const isLong = buf.split('\n').length > 8 || buf.length > 200;
    if (!isLong) {
      insertText(buf);
      computeFiltered();
      redraw();
      return;
    }
    const s = segs[curSeg].text;
    const before = s.slice(0, curOff);
    const after = s.slice(curOff);
    const newSegs: Seg[] = [];
    if (before) newSegs.push({ frozen: false, text: before });
    newSegs.push({ frozen: true, text: buf });
    newSegs.push({ frozen: false, text: after }); // 始终保留可编辑后缀(可为空),保证光标有落点
    segs.splice(curSeg, 1, ...newSegs);
    curSeg = curSeg + (before ? 2 : 1); // 落到 chip 之后的可编辑段
    curOff = 0;
    computeFiltered();
    redraw();
  }
  /** 粘贴结束:长粘贴(>8 行或 >200 字符)落/并进 chip(原子,整段封预览),短粘贴落为可编辑文本。 */
  function finalizePaste(): void {
    if (resolved) {
      pasteState.pasteParts = [];
      return;
    }
    const buf = pasteState.pasteParts.join('');
    pasteState.pasteParts = [];
    justSawCR = false;
    applyPastedText(buf);
  }
  /** 鼠标右键单击输入框(未拖动)时 layout 读剪贴板后回调:与键盘粘贴走同一落地逻辑(长/短判定)。 */
  function onMousePaste(text: string): void {
    if (resolved) return;
    applyPastedText(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  }

  /** 根据输入文本找到当前层。prefix 始终包含已进入分支及末尾空格。 */
  function menuContext(input: string): { nodes: SlashCommand[]; prefix: string } {
    let nodes = opts.commands;
    let prefix = '';
    while (true) {
      const branch = nodes.find(
        (node) => node.children?.length && input.startsWith(`${prefix}${node.name} `),
      );
      if (!branch?.children) return { nodes, prefix };
      prefix = `${prefix}${branch.name} `;
      nodes = branch.children;
    }
  }

  function computeFiltered(): void {
    const firstLine = buildDisplay().lines[0] ?? '';
    if (firstLine.startsWith('/')) {
      const { nodes, prefix } = menuContext(firstLine);
      filtered = nodes
        .map((node): SlashMenuItem => ({ node, input: `${prefix}${node.name}` }))
        .filter((item) => item.input.startsWith(firstLine));
      menuOpen = filtered.length > 0;
      if (selected >= filtered.length) {
        selected = 0;
        menuTop = 0;
      }
    } else {
      filtered = [];
      menuOpen = false;
      menuTop = 0;
    }
  }

  function redraw(): void {
    const { lines } = buildDisplay();
    const cur = cursorDisp();
    // 空输入引导:缓冲为空时输入框内画 dim ghost 占位(含 /help 提示),让用户知道怎么开始;
    // 一旦有输入(打字/粘贴/补全)isEmpty 变 false,下一帧占位即消失。
    const isEmpty = segs.length === 1 && !segs[0].frozen && segs[0].text === '';
    // 二次确认已武装:把提示画成菜单行(向上展开进内容区底,输入框上方),黄色 + 图标。
    // 不复用 placeholder —— layout 只在输入行为空时画 placeholder,而武装态必然有内容。
    const armed = confirmArmedUntil > Date.now();
    const menu = menuLines();
    const menuView = menu.length
      ? { lines: menu }
      : armed
        ? { lines: [`${ui.yellow}${t('prompt.confirmSendHint')}${ui.reset}`] }
        : null;
    layout.paintInput({
      prompt: opts.prompt,
      lines,
      cursorLine: cur.line,
      cursorCol: cur.col,
      menu: menuView,
      placeholder: isEmpty ? t('prompt.emptyPlaceholder') : undefined,
    });
  }

  /** 鼠标点击输入框:layout 已把"屏 tap 位置"以 (flatIdx, inSegVis) 形式传进来
   *  (flatIdx = flat 中的绝对段号;inSegVis = 段内显示列)。本函数把点击位还原成 (段, 偏移) → redraw。
   *  点中只读粘贴块时吸附到最近的可编辑边界(见 mapDispToCursor)。 */
  function applyExternalCursor(flatIdx: number, inSegVis: number): void {
    const g = layout.getGeo();
    const promptW = displayWidth(opts.prompt);
    const W = Math.max(1, g.cols - promptW);
    const { lines: dispLs } = buildDisplay();
    const lineVis: string[][] = dispLs.map((l) => wrapByDisplayWidth(l, W));
    const flat: string[] = [];
    for (const lv of lineVis) for (const r of lv) flat.push(r);

    let dispLine: number;
    let charInLine: number;

    if (flat.length === 0) {
      dispLine = 0;
      charInLine = 0;
    } else {
      const safeIdx = Math.max(0, Math.min(flatIdx, flat.length - 1));
      const seg = flat[safeIdx];
      const segW = displayWidth(seg);
      const safeInSeg = Math.max(0, Math.min(inSegVis, segW));
      const inChar = visColToCharCol(seg, safeInSeg);

      // safeIdx → (dispLine, segInLine)
      let dl = 0;
      let segInLine = safeIdx;
      while (dl < lineVis.length && segInLine >= lineVis[dl].length) {
        segInLine -= lineVis[dl].length;
        dl++;
      }
      if (dl >= lineVis.length) {
        dl = lineVis.length - 1;
        segInLine = lineVis[dl].length - 1;
      }
      let segStartChars = 0;
      const segsVis = lineVis[dl];
      for (let s = 0; s < segInLine; s++) segStartChars += segsVis[s]?.length ?? 0;
      charInLine = Math.max(0, Math.min(segStartChars + inChar, dispLs[dl]?.length ?? 0));
      dispLine = dl;
    }

    const { seg, off } = mapDispToCursor(dispLine, charInLine);
    curSeg = seg;
    curOff = off;
    // 收起菜单/过滤态:点击输入框关闭菜单,回到纯文本编辑。
    if (menuOpen) {
      menuOpen = false;
      filtered = [];
      selected = 0;
      menuTop = 0;
    }
    justSawCR = false;
    computeFiltered();
    redraw();
  }

  function cleanup(): void {
    layout.setPasteHandler(null);
    layout.setCursorChangeHandler(null);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    if (pasteState.pasteTimer) {
      clearTimeout(pasteState.pasteTimer);
      pasteState.pasteTimer = null;
    }
    pasteState.pasting = false;
    pasteState.pasteParts = [];
    pasteState.onPasteEnd = null;
    stdin.pause();
  }

  function finish(value: string[] | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  /**
   * 应用当前菜单项。分支节点只进入下一层；叶子节点补全 value/input。
   * 返回 true 表示调用方应立即提交，false 表示仍留在输入态。
   */
  function applySelected(submitLeaf: boolean): boolean {
    const item = filtered[selected];
    if (!menuOpen || !item) return submitLeaf;

    if (item.node.children?.length) {
      segs = [{ frozen: false, text: `${item.input} ` }];
      curSeg = 0;
      curOff = segs[0].text.length;
      selected = 0;
      menuTop = 0;
      computeFiltered();
      redraw();
      return false;
    }

    segs = [{ frozen: false, text: item.node.value ?? item.input }];
    curSeg = 0;
    curOff = segs[0].text.length;
    computeFiltered();
    if (!submitLeaf || item.node.submit === false) {
      redraw();
      return false;
    }
    return true;
  }

  /** 提交:菜单打开时先应用选中项;分支进入子菜单,需要参数的叶子只补全。
   *  段序列直接按原文(可编辑段原文 + 粘贴块原文)拼接——所见即所得,不再额外插换行。
   *
   *  二次确认(MOCODE_CONFIRM_SEND=long,默认关):长/多行输入首次 Enter 只"武装"并显示提示行,
   *  CONFIRM_SEND_MS 内再按一次 Enter 才真发;任何其它键都会解除武装(见 onKey 顶部)——
   *  误触一次 Enter 发不出去,而正常发送只是多敲一下。 */
  function submit(): void {
    if (menuOpen && !applySelected(true)) return;
    const content = segs.map((s) => s.text).join('');
    const now = Date.now();
    if (confirmSendMode() === 'long' && isLongInput(content) && now > confirmArmedUntil) {
      confirmArmedUntil = now + CONFIRM_SEND_MS;
      redraw();
      return;
    }
    confirmArmedUntil = 0;
    finish(content === '' ? [''] : content.split('\n'));
  }

  /** 长输入判定:≥2 行 或 ≥120 码点(单行短消息不触发二次确认,免得打扰日常)。 */
  function isLongInput(text: string): boolean {
    if (text.indexOf('\n') >= 0) return true;
    return [...text].length >= LONG_INPUT_CHARS;
  }

  /** 插换行:在光标处断行(落进当前可编辑段)。 */
  function insertNewline(): void {
    insertText('\n');
    computeFiltered();
    redraw();
  }

  /** 光标移到当前可编辑段内的行首/行尾(不含段内 \n)。 */
  function moveToLineStart(): void {
    const s = segs[curSeg].text;
    curOff = s.lastIndexOf('\n', curOff - 1) + 1;
    redraw();
  }
  function moveToLineEnd(): void {
    const s = segs[curSeg].text;
    const ne = s.indexOf('\n', curOff);
    curOff = ne < 0 ? s.length : ne;
    redraw();
  }

  /** Ctrl+U:删到行首(当前可编辑段内的当前行;已在行首则 no-op,不跨入相邻粘贴块)。 */
  function deleteToLineStart(): void {
    const s = segs[curSeg].text;
    const ls = s.lastIndexOf('\n', curOff - 1) + 1;
    if (ls === curOff) return;
    segs[curSeg].text = s.slice(0, ls) + s.slice(curOff);
    curOff = ls;
    computeFiltered();
    redraw();
  }

  /** Ctrl+K:删到行尾(当前可编辑段内的当前行;已在行尾则 no-op,不跨入相邻粘贴块)。 */
  function deleteToLineEnd(): void {
    const s = segs[curSeg].text;
    const ne = s.indexOf('\n', curOff);
    if (ne < 0) {
      if (curOff === s.length) return;
      segs[curSeg].text = s.slice(0, curOff);
    } else {
      segs[curSeg].text = s.slice(0, curOff) + s.slice(ne + 1);
    }
    computeFiltered();
    redraw();
  }

  /** Ctrl+Z:还原被 Ctrl+C 清掉的输入(单次)。 */
  function restoreUndo(): void {
    const snap = undoSnapshot;
    if (!snap) return;
    segs = snap.segs.map((s) => ({ ...s }));
    curSeg = Math.min(snap.curSeg, segs.length - 1);
    curOff = Math.min(snap.curOff, segs[curSeg].text.length);
    undoSnapshot = null;
    computeFiltered();
    redraw();
  }

  /**
   * 清空输入(含粘贴块 / 斜杠菜单 / 粘贴缓冲):Ctrl+C 在有内容时调用——清空而非退出。
   * 清空前留一份快照供 Ctrl+Z 还原——手滑按在输入框上时,正在写的长 prompt 不至于白打。
   */
  function clearInput(): void {
    if (layout.isScrolled()) layout.resetScroll(); // 回尾(若滚动回看),再清空
    undoSnapshot = { segs: segs.map((s) => ({ ...s })), curSeg, curOff };
    segs = [{ frozen: false, text: '' }];
    curSeg = 0;
    curOff = 0;
    menuOpen = false;
    filtered = [];
    selected = 0;
    menuTop = 0;
    if (pasteState.pasteTimer) {
      clearTimeout(pasteState.pasteTimer);
      pasteState.pasteTimer = null;
    }
    pasteState.pasting = false;
    pasteState.pasteParts = [];
    justSawCR = false;
    computeFiltered();
    redraw();
  }

  /** Ctrl+C:有内容(已打字 / 多行 / 粘贴块 / 菜单草稿 / 粘贴缓冲 / 粘贴中)则清空,再按一次(空)才退出(仿 fish)。 */
  function onCtrlC(): void {
    const flat = segs.map((s) => s.text).join('');
    const hasContent = flat.length > 0 || menuOpen || pasteState.pasteParts.length > 0 || pasteState.pasting;
    if (hasContent) {
      clearInput();
      return;
    }
    cleanup();
    reject(new Error('SIGINT'));
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;

    // 鼠标 fragment(SGR 报表被 readline 拆碎):mouse.swallow 重组并派发 MouseEvent 给
    // layout.handleMouseEvent(滚轮/框选/复制全在那处理);此处只需吞掉 fragment 不进 pasteParts/输入框。
    if (mouse.swallow(key.sequence ?? '')) return;

    // 二次确认已武装:任何非「提交键」都解除武装(继续编辑 / 换行 / 删除都算放弃这次提交)。
    if (confirmArmedUntil) {
      const isSubmitKey =
        (key.name === 'return' || key.name === 'enter') && !key.shift && !key.meta && !key.ctrl;
      if (!isSubmitKey) {
        confirmArmedUntil = 0;
        redraw();
      }
    }

    // Shift+Tab:循环切换 agent 模式(auto ↔ plan)。不插字符、不提交、不影响输入文本;
    // 回调由 repl 注入(翻 agentMode + 重写 history[0] + 设状态行 modeTag),再 redraw() 经
    // paintInput 重画底栏(状态行 chip 即时刷新 + 光标留输入框)。置于 case 'tab' 之前,故不触发菜单补全。
    if (key.shift && key.name === 'tab') {
      opts.onCycleMode?.();
      redraw();
      return;
    }

    // Ctrl+C:有内容则清空,再按一次(空)才退出——置顶,使粘贴中也能被截到(否则被 pasting 分支吞掉)
    if (key.ctrl && key.name === 'c') {
      onCtrlC();
      return;
    }

    // 粘贴中:把键累积进 pasteParts(换行 \r\n 合一),不编辑 lines;末尾 finalizePaste 统一落 chip/文本
    if (pasteState.pasting) {
      const s = key.sequence ?? '';
      const isReturn = key.name === 'return' || key.name === 'enter';
      if (s === '\n' && justSawCR) {
        justSawCR = false; // \r\n 的 \n:已随 \r 折行,吞掉
        return;
      }
      if (isReturn || s === '\r' || s === '\n') {
        justSawCR = s === '\r'; // \r 标记,待可能的尾随 \n
        pasteState.pasteParts.push('\n');
        return;
      }
      justSawCR = false;
      // FEFF(BOM 字符)过滤:其他应用写入剪贴板的正文可能带 BOM,终端级粘贴逐字符灌入时
      // 会敲进输入框(charWidth 按 1 列算但终端渲染成缺字形方块)
      if (s && s >= ' ' && s !== '\uFEFF' && !key.ctrl && !key.meta) pasteState.pasteParts.push(s);
      return;
    }

    // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页，Ctrl+↑/↓ 每次 5 行。
    // 裸 ↑/↓ 优先给斜杠菜单与多行光标，二者都不适用时按滚轮量滚动回看(与鼠标滚轮同一入口)。
    if (
      key.name === 'pageup' ||
      key.name === 'pagedown' ||
      (key.ctrl && (key.name === 'up' || key.name === 'down'))
    ) {
      const pageH = layout.getGeo().contentBottom;
      if (key.name === 'pageup') layout.scrollBy(pageH);
      else if (key.name === 'pagedown') layout.scrollBy(-pageH);
      else if (key.name === 'up') layout.scrollBy(5);
      else layout.scrollBy(-5);
      return;
    }

    // 滚动回看时打字 / 编辑不回尾(保持历史视图,便于边看历史边编辑);仅 Enter 提交时回尾(见下方 submit 前)。

    // Ctrl+C 已在 onKey 顶部统一处理(清空或退出);Ctrl+D:空缓冲退出,否则忽略
    if (key.ctrl && key.name === 'd') {
      if (segs.map((s) => s.text).join('') === '') finish(null);
      return;
    }
    if (key.ctrl && key.name === 'a') {
      moveToLineStart();
      return;
    }
    if (key.ctrl && key.name === 'q') {
      // 行首的对称搭档:与 Ctrl+E(行尾)同处顶行相邻(Q/E),左=起始右=结束。
      // Ctrl+A 仍作别名保留(全 app 一致:运行中预填、权限面板都用 Ctrl+A 跳开头)。
      moveToLineStart();
      return;
    }
    if (key.ctrl && key.name === 'e') {
      moveToLineEnd();
      return;
    }

    // Ctrl+Z:还原被 Ctrl+C 清掉的输入。无快照时 no-op。
    if (key.ctrl && key.name === 'z') {
      restoreUndo();
      return;
    }

    // 行级删除:Ctrl+U 删到行首,Ctrl+K 删到行尾(均在当前可编辑段内,不跨入相邻粘贴块)。
    // 词级删除/跳转(Ctrl+W / Ctrl+← 等)刻意不做:终端序列各终端发得不一样
    // (Ctrl+Backspace 在多数终端发 \x08,与裸退格无从区分),做一半会变成按了没反应的哑键。
    if (key.ctrl && key.name === 'u') {
      deleteToLineStart();
      return;
    }
    if (key.ctrl && key.name === 'k') {
      deleteToLineEnd();
      return;
    }

    // Ctrl+G:打开输入面板弹窗(记事本式编辑,Enter=换行不发送;确认只填回不发送)。
    if (key.ctrl && key.name === 'g') {
      void openComposer();
      return;
    }
    // Ctrl+R / Ctrl+P:历史模糊搜索。Ctrl+R 对齐 bash 反向搜索语义,Ctrl+P 对齐 previous-history 语义,
    // 两者是同一个面板——记住哪个都行。
    if (key.ctrl && (key.name === 'r' || key.name === 'p')) {
      void openHistorySearch();
      return;
    }

    const isReturn = key.name === 'return' || key.name === 'enter';

    // 换行:Ctrl+J / Ctrl+Enter / Alt+Enter(meta)/ Shift+Enter(终端区分时)/ lone LF
    // (粘贴的 CR/LF 已在上方 pasting 分支累积进 pasteParts,不会到此)
    // Ctrl+Enter:readline 解析得到 key.ctrl=true && isReturn 走这条路;少数老 xterm 把
    // Ctrl+Enter 当裸 \r 发(没 ctrl flag)→ 落到下方「提交」分支做 Enter 处理,
    // 此时用 Ctrl+J 兜底。
    const wantNewline =
      (key.ctrl && key.name === 'j') ||
      (key.ctrl && isReturn) ||
      (key.meta && isReturn) ||
      (key.shift && isReturn) ||
      (key.sequence === '\n' && !key.ctrl);

    if (wantNewline) {
      insertNewline();
      return;
    }
    // 提交(键盘 plain Enter):回尾(若滚动回看)再发送——发消息时跳到底部开始 agent 输出
    if (isReturn && !key.shift && !key.meta && !key.ctrl) {
      if (layout.isScrolled()) layout.resetScroll();
      submit();
      return;
    }

    switch (key.name) {
      case 'backspace': {
        const s = segs[curSeg].text;
        if (curOff > 0) {
          segs[curSeg].text = s.slice(0, curOff - 1) + s.slice(curOff);
          curOff--;
          computeFiltered();
          redraw();
        } else if (curSeg > 0) {
          const prev = segs[curSeg - 1];
          if (prev.frozen) {
            // 紧贴粘贴块后沿退格:删整块(原子)
            segs.splice(curSeg - 1, 1);
            curSeg--;
            curOff = 0;
          } else {
            // 并回上一个可编辑段
            prev.text += segs[curSeg].text;
            const joinOff = prev.text.length - segs[curSeg].text.length;
            segs.splice(curSeg, 1);
            curSeg--;
            curOff = joinOff;
          }
          computeFiltered();
          redraw();
        }
        return;
      }
      case 'delete': {
        const s = segs[curSeg].text;
        if (curOff < s.length) {
          segs[curSeg].text = s.slice(0, curOff) + s.slice(curOff + 1);
          computeFiltered();
          redraw();
        } else if (curSeg < segs.length - 1) {
          const next = segs[curSeg + 1];
          if (next.frozen) segs.splice(curSeg + 1, 1); // 并掉下一个粘贴块
          else {
            segs[curSeg].text += next.text;
            segs.splice(curSeg + 1, 1);
          }
          computeFiltered();
          redraw();
        }
        return;
      }
      case 'up':
        if (menuOpen && filtered.length) {
          selected = (selected - 1 + filtered.length) % filtered.length;
          redraw();
        } else {
          const { line, col } = cursorDisp();
          if (line > 0) {
            const m = mapDispToCursor(line - 1, dispColToCharInLine(line - 1, col));
            curSeg = m.seg;
            curOff = m.off;
            redraw();
          } else {
            layout.scrollWheel(1); // 等同鼠标滚轮上滚一格
          }
        }
        return;
      case 'down':
        if (menuOpen && filtered.length) {
          selected = (selected + 1) % filtered.length;
          redraw();
        } else {
          const { lines: dispLines } = buildDisplay();
          const { line, col } = cursorDisp();
          if (line < dispLines.length - 1) {
            const m = mapDispToCursor(line + 1, dispColToCharInLine(line + 1, col));
            curSeg = m.seg;
            curOff = m.off;
            redraw();
          } else {
            layout.scrollWheel(-1); // 等同鼠标滚轮下滚一格
          }
        }
        return;
      case 'tab':
        if (menuOpen && filtered[selected]) applySelected(false);
        return;
      case 'escape': {
        const { prefix } = menuContext(buildDisplay().lines[0] ?? '');
        if (prefix) {
          // 子层 Esc 回到父节点；例如 /model sw → /model。
          segs = [{ frozen: false, text: prefix.trimEnd() }];
          curSeg = 0;
          curOff = segs[0].text.length;
          selected = 0;
          menuTop = 0;
          computeFiltered();
        } else {
          menuOpen = false;
          filtered = [];
          selected = 0;
          menuTop = 0;
        }
        redraw();
        return;
      }
      case 'left': {
        if (curOff > 0) {
          curOff--;
          redraw();
        } else if (curSeg > 0) {
          let p = curSeg - 1;
          while (p >= 0 && segs[p].frozen) p--;
          if (p >= 0) {
            curSeg = p;
            curOff = segs[p].text.length;
            redraw();
          }
        }
        return;
      }
      case 'right': {
        const s = segs[curSeg].text;
        if (curOff < s.length) {
          curOff++;
          redraw();
        } else if (curSeg < segs.length - 1) {
          let nx = curSeg + 1;
          while (nx < segs.length && segs[nx].frozen) nx++;
          if (nx < segs.length) {
            curSeg = nx;
            curOff = 0;
            redraw();
          }
        }
        return;
      }
      case 'home':
        moveToLineStart();
        return;
      case 'end':
        moveToLineEnd();
        return;
    }

    // 可打印字符(>= 空格,非 ctrl/meta)
    const s = key.sequence ?? '';
    if (s && s >= ' ' && !key.ctrl && !key.meta) {
      insertText(s);
      computeFiltered();
      redraw();
    }
  }

  /**
   * Ctrl+G:打开 TUI 内「输入面板」弹窗(记事本式多行编辑,**不外调 $EDITOR**)。
   * 弹窗里 Enter 就是换行,不会再触发发送;确认(Ctrl+S)只把内容填回输入框,不自动发送。
   * 期间必须摘掉主 keypress 监听:弹窗关闭后终端可能残留按键事件,不摘会被当成输入吞掉。
   */
  async function openComposer(): Promise<void> {
    if (resolved) return;
    const before = segs.map((s) => s.text).join('');
    emitter.removeListener('keypress', onKey);
    let result: { text: string | null };
    try {
      result = await promptComposer({ initialText: before });
    } finally {
      emitter.on('keypress', onKey);
      stdin.resume();
      // 弹窗是直写覆盖层,关闭后整幅重画还原 content 区
      layout.repaintViewport();
    }
    if (resolved) return; // 极端路径:弹窗期间被 finish
    if (result.text != null && result.text !== before) {
      undoSnapshot = { segs: segs.map((s) => ({ ...s })), curSeg, curOff }; // Ctrl+Z 可还原回弹窗前
      segs = [{ frozen: false, text: result.text }];
      curSeg = 0;
      curOff = segs[0].text.length;
    }
    computeFiltered();
    redraw();
  }

  /**
   * Ctrl+R / Ctrl+P:历史模糊搜索面板。
   * Enter 只把选中项**填回输入框**(安全网:找回来的长 prompt 通常还要改),Ctrl+Enter 才直接发送。
   */
  async function openHistorySearch(): Promise<void> {
    if (resolved || !opts.history) return;
    // 惰性求值:跨会话聚合要读盘,只在面板真正打开时做
    const historyItems = typeof opts.history === 'function' ? opts.history() : opts.history;
    if (historyItems.length === 0) return;
    const before = segs.map((s) => s.text).join('');
    emitter.removeListener('keypress', onKey);
    let picked: { text: string; send: boolean } | null = null;
    try {
      picked = await promptHistorySearch({ items: historyItems, initialQuery: before });
    } finally {
      emitter.on('keypress', onKey);
      stdin.resume();
    }
    if (resolved) return;
    if (picked) {
      segs = [{ frozen: false, text: picked.text }];
      curSeg = 0;
      curOff = segs[0].text.length;
      computeFiltered();
      if (picked.send) {
        submit();
        return;
      }
    }
    redraw();
  }

  return new Promise<string[] | null>((res, rej) => {
    resolve = res;
    reject = rej;
    // 清掉上一轮可能残留的粘贴状态:子面板(历史搜索)不装 paste sink,粘贴的字会逐字符进它的输入框,
    // 但共享的 pasteParts 不会有人消费 —— 残留会让 Ctrl+C 的"有内容"判定误判。
    if (pasteState.pasteTimer) {
      clearTimeout(pasteState.pasteTimer);
      pasteState.pasteTimer = null;
    }
    pasteState.pasting = false;
    pasteState.pasteParts = [];
    justSawCR = false;
    ensurePasteDetector(); // 首次调用在 emitKeypressEvents 之前装 data 监听器(保序:mine 先于 解析器)
    pasteState.onPasteEnd = finalizePaste; // 粘贴结束回调:落 chip 或保留文本
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      // isTTY 但 setRawMode 失败(罕见):退化为 readline,不注册 setPasteHandler(不走 cleanup,防泄漏)
      questionFallback(opts.prompt).then(
        (a) => res([a]),
        (e) => rej(e)
      );
      return;
    }
    layout.setPasteHandler(onMousePaste); // 鼠标右键单击输入框(未拖动)→ 读剪贴板贴入;cleanup 时注销
    layout.setCursorChangeHandler(applyExternalCursor); // 鼠标左键单击输入框(未拖动)→ 改 cl/cc 到点击位;cleanup 时注销
    stdin.resume();
    emitter.on('keypress', onKey);
    computeFiltered();
    redraw();
  });
}
