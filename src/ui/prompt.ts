import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, padEndDisplay, truncateDisplay, visColToCharCol, wrapByDisplayWidth } from './render.js';
import * as layout from './layout.js';
import * as mouse from './mouse.js';
import { t } from '../i18n/index.js';

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

interface SlashMenuItem {
  node: SlashCommand;
  /** 从根节点拼出的菜单路径，例如 /model switch。 */
  input: string;
}

/** 输入框里的一段内容。frozen=false 是可编辑文本(可含换行)；frozen=true 是只读粘贴块(原子,
 *  提交时拼回原文)。整篇输入是 Seg[]：可编辑段与粘贴块交替，光标永远落在某个可编辑段上。
 *  多个粘贴块之间夹的可编辑段就是「粘贴之间敲的字」，可直接编辑——这是相对旧版单 chip 模型的核心改进。 */
interface Seg {
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
  /** Shift+Tab 循环切换 agent 模式(auto ↔ plan)的回调;repl 注入(翻 agentMode + 重写 history[0] + 设状态行 modeTag)。回调后 prompt 自调 redraw() 刷新底栏。 */
  onCycleMode?: () => void;
}

/** emitKeypressEvents 后 stdin 会发 'keypress',但该事件不在 ReadStream 类型里,单独声明。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(
    event: 'keypress',
    listener: (str: string, key: Key) => void
  ): this;
}

// ── 粘贴检测(块级 + 时间窗)──
// 块级:多字节大块(len>8)或含 CR/LF 的小块 = 粘贴(键盘单键 1 字节,Enter=\r 单字节)。
// 时间窗:每块重置 50ms 计时器,静默 50ms 即"粘贴结束"→ onPasteEnd。跨多块的大粘贴(块间 <50ms)累积进
// 同一个 pasteParts、末尾一次性落 chip——避免"首块成 chip、后续块泄成文本"。粘贴中 onKey 把键累积进
// pasteParts(不编辑 lines)。不启用 bracketed paste——emitKeypressEvents 会把 \x1B[200~ 标记当按键砸进输入框。
let pasting = false;
let pasteParts: string[] = [];
let pasteTimer: NodeJS.Timeout | null = null;
let onPasteEnd: (() => void) | null = null; // 粘贴结束回调(prompt 注入:落 chip 或保留为文本)
let pasteDetectorInstalled = false;
function ensurePasteDetector(): void {
  if (pasteDetectorInstalled) return;
  pasteDetectorInstalled = true;
  stdin.on('data', (chunk: Buffer | string) => {
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // 剔除 SGR 鼠标报告(\x1B[<…M/m,连半截也匹配):拖拽选区时终端连续发 motion 报表,
    // 一个 chunk 里可能拼多条(22+ 字符 > 16 阈值)误判粘贴 50ms、把后续真按键泄进 pasteParts。
    const text = raw.replace(/\x1b\[<[0-9;]*[Mm]/g, '');
    const hasNL = text.indexOf('\r') >= 0 || text.indexOf('\n') >= 0;
    // 按字符数(码点)判粘贴,非字节:CJK 汉字占 3 UTF-8 字节,旧阈值(len>8 字节)会把 IME 提交的
    // 3-10 个汉字误判为粘贴 → 进 50ms 缓冲 → finalizePaste→insertText 落字(且旧 insertText 把光标
    // 置插入文本长度而非末尾,致"后续打字插到行中间")。改:含换行(多行粘贴)或 >16 字符(大块单行
    // 粘贴)才算粘贴;普通 IME 提交走正常按键路径(逐字直插、光标随进、无延迟)。
    const charCount = [...text].length;
    if (!(charCount > 16 || (charCount > 1 && hasNL))) return;
    pasting = true;
    if (pasteTimer) clearTimeout(pasteTimer);
    const t = setTimeout(() => {
      pasteTimer = null;
      pasting = false;
      onPasteEnd?.();
    }, 50);
    t.unref();
    pasteTimer = t;
  });
}

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
      pasteParts = [];
      return;
    }
    const buf = pasteParts.join('');
    pasteParts = [];
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
    layout.paintInput({
      prompt: opts.prompt,
      lines,
      cursorLine: cur.line,
      cursorCol: cur.col,
      menu: menuLines().length ? { lines: menuLines() } : null,
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
    if (pasteTimer) {
      clearTimeout(pasteTimer);
      pasteTimer = null;
    }
    pasting = false;
    pasteParts = [];
    onPasteEnd = null;
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
   *  段序列直接按原文(可编辑段原文 + 粘贴块原文)拼接——所见即所得,不再额外插换行。 */
  function submit(): void {
    if (menuOpen && !applySelected(true)) return;
    const content = segs.map((s) => s.text).join('');
    finish(content === '' ? [''] : content.split('\n'));
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
    if (pasteTimer) {
      clearTimeout(pasteTimer);
      pasteTimer = null;
    }
    pasting = false;
    pasteParts = [];
    justSawCR = false;
    computeFiltered();
    redraw();
  }

  /** Ctrl+C:有内容(已打字 / 多行 / 粘贴块 / 菜单草稿 / 粘贴缓冲 / 粘贴中)则清空,再按一次(空)才退出(仿 fish)。 */
  function onCtrlC(): void {
    const flat = segs.map((s) => s.text).join('');
    const hasContent = flat.length > 0 || menuOpen || pasteParts.length > 0 || pasting;
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
    if (pasting) {
      const s = key.sequence ?? '';
      const isReturn = key.name === 'return' || key.name === 'enter';
      if (s === '\n' && justSawCR) {
        justSawCR = false; // \r\n 的 \n:已随 \r 折行,吞掉
        return;
      }
      if (isReturn || s === '\r' || s === '\n') {
        justSawCR = s === '\r'; // \r 标记,待可能的尾随 \n
        pasteParts.push('\n');
        return;
      }
      justSawCR = false;
      if (s && s >= ' ' && !key.ctrl && !key.meta) pasteParts.push(s);
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

  return new Promise<string[] | null>((res, rej) => {
    resolve = res;
    reject = rej;
    ensurePasteDetector(); // 首次调用在 emitKeypressEvents 之前装 data 监听器(保序:mine 先于 解析器)
    onPasteEnd = finalizePaste; // 粘贴结束回调:落 chip 或保留文本
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

/**
 * 轮次选择菜单(供 /rollback 菜单化选择):↑/↓ 导航、Enter 选中、Esc/Ctrl+D 取消。
 * 把 items 画成向上展开的菜单(经 layout.paintInput,与斜杠菜单同套渲染),输入框行作操作提示。
 * 返回选中的 0-based 下标;null=取消 / 非 TTY / 空列表。纯导航(不收文本输入)。
 * 长列表(超屏高)自动开窗保光标可见;默认聚焦末项(最新轮次,靠近输入框)。
 */
export async function promptTurnPicker(
  items: { firstLine: string }[]
): Promise<number | null> {
  if (!layout.isActive() || items.length === 0) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  const hint = t('prompt.chooseRollback');
  let selected = items.length - 1; // 默认聚焦最新(末项,菜单底、靠近输入框)
  let resolved = false;
  let resolve!: (v: number | null) => void;
  let reject!: (e: Error) => void;

  /** 菜单行(带开窗):超屏高时以 selected 为中心取窗,保光标可见;末项在底(靠近输入框)。 */
  function menuLines(): string[] {
    const g = layout.getGeo();
    const maxRows = Math.max(1, g.contentBottom);
    let start = 0;
    if (items.length > maxRows) {
      start = Math.max(
        0,
        Math.min(selected - Math.floor(maxRows / 2), items.length - maxRows)
      );
    }
    const count = Math.min(maxRows, items.length);
    const cols = g.cols;
    return Array.from({ length: count }, (_, i) => {
      const idx = start + i;
      // 选中项:▸/序号/正文均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = `${color}${idx + 1}${ui.reset}`;
      const text = truncateDisplay(items[idx].firstLine, cols - 6);
      return `${marker} ${num} ${color}${text}${ui.reset}`;
    });
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [hint],
      cursorLine: 0,
      cursorCol: displayWidth(hint),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true); // 恢复鼠标框选/滚轮(面板期间被禁,防拖拽覆盖菜单)
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: number | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return; // 鼠标 fragment 吞掉(框选已禁,滚轮 handleMouseEvent no-op)
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + items.length) % items.length;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % items.length;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(selected);
        return;
      case 'escape':
        finish(null);
        return;
    }
  }

  return new Promise<number | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false); // 面板期间禁鼠标框选/滚轮(防拖拽 viewport 重画覆盖菜单)
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}

/**
 * 会话选择菜单(供 /resume 菜单化选择):↑/↓ 导航、Enter 续接、Esc/Ctrl+D 取消、a 切换「仅最近 N / 全部」。
 * 把 items 画成向上展开的菜单(经 layout.paintInput,与斜杠菜单 / 轮次菜单同套渲染),输入框行作操作提示。
 * 默认仅显示最近 N 条(默认 N=10,取 items 前缀——调用方按 createdAt 降序传入则前缀=最新 N);
 * items 多于 N 时按 a 展开全部,再按 a 折回最近 N。选中项 cyan+bold + ▸ 高亮(同 promptTurnPicker)。
 * 返回选中的 item(含 id);null=取消 / 非 TTY / 空列表。纯导航(不收文本输入)。
 * 长列表(超屏高)自动开窗保光标可见;默认聚焦首项(最新会话,Enter 即续接最近一条)。
 */
export interface SessionPickerItem {
  id: string;
  title: string;
  subtitle?: string;
}
export async function promptSessionPicker(
  items: SessionPickerItem[],
  recentCap = 10
): Promise<SessionPickerItem | null> {
  if (!layout.isActive() || items.length === 0) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  const cap = Math.max(1, recentCap);
  const canToggle = items.length > cap; // 不超过 cap 时无切换意义(本就全显)
  let showAll = !canToggle; // 超过 cap 才默认折叠到最近 N,否则全显
  let selected = 0; // 默认聚焦首项(调用方降序传入 → 最新会话)
  let resolved = false;
  let resolve!: (v: SessionPickerItem | null) => void;
  let reject!: (e: Error) => void;

  /** 当前可见项:折叠态取前 cap 条(=最近 N),展开态取全部。 */
  function visible(): SessionPickerItem[] {
    return showAll ? items : items.slice(0, cap);
  }
  /** 输入框行的操作提示;折叠态显「a 全部(N)」,展开态显「a 仅最近N」。不超 cap 时无 a 项。 */
  function hint(): string {
    const base = t('prompt.chooseResume');
    if (!canToggle) return base;
    return showAll
      ? t('prompt.recent', { count: cap })
      : t('prompt.all', { count: items.length });
  }

  /** 菜单行(带开窗):超屏高时以 selected 为中心取窗,保光标可见。行格式:▸ N  title  subtitle。 */
  function menuLines(): string[] {
    const g = layout.getGeo();
    const cols = g.cols;
    const maxRows = Math.max(1, g.contentBottom);
    const vis = visible();
    let start = 0;
    if (vis.length > maxRows) {
      start = Math.max(
        0,
        Math.min(selected - Math.floor(maxRows / 2), vis.length - maxRows)
      );
    }
    const count = Math.min(maxRows, vis.length);
    return Array.from({ length: count }, (_, i) => {
      const idx = start + i;
      // 选中项:▸/序号/正文/副标题均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = String(idx + 1);
      const it = vis[idx];
      const title = it.title || '(无)';
      const sub = it.subtitle ?? '';
      const leadW = displayWidth(num) + 4; // "▸ " + num + "  "
      let subW = sub ? displayWidth(sub) + 2 : 0; // "  " + sub
      let titleW = cols - leadW - subW;
      if (titleW < 4 && sub) {
        // 太窄:先丢副标题把空间让给标题
        subW = 0;
        titleW = cols - leadW;
      }
      const titleT = titleW > 0 ? truncateDisplay(title, titleW) : '';
      const subPart = subW > 0 ? `  ${sub}` : '';
      return `${marker} ${color}${num}  ${titleT}${subPart}${ui.reset}`;
    });
  }

  function redraw(): void {
    const h = hint();
    layout.paintInput({
      prompt: '❯ ',
      lines: [h],
      cursorLine: 0,
      cursorCol: displayWidth(h),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: SessionPickerItem | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    // a 切换「仅最近 N / 全部」:纯导航菜单无文本输入,a 自由;key.name 不分大小写,Shift+A 亦触发。
    if (canToggle && key.name === 'a' && !key.ctrl && !key.meta) {
      showAll = !showAll;
      const vis = visible();
      if (selected > vis.length - 1) selected = vis.length - 1; // 折回 cap 时选中项越界则钳到末项
      redraw();
      return;
    }
    const n = visible().length;
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + n) % n;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % n;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(visible()[selected] ?? null);
        return;
      case 'escape':
        finish(null);
        return;
    }
  }

  return new Promise<SessionPickerItem | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false);
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}

/**
 * 主题选择菜单(供 /theme):↑/↓ 导航、Enter 切换、Esc/Ctrl+D 取消、Ctrl+C 抛 SIGINT(调用方 try/catch)。
 * 复用 SessionPickerItem 形状({id,title,subtitle?});选中项 cyan+bold + ▸ 高亮(同 /resume 菜单)。
 * 返回选中的 item(含 id);null=取消 / 非 TTY / 空列表。纯导航(不收文本输入)。
 * 长列表超屏高自动开窗保光标可见;默认聚焦首项。
 */
export async function promptThemePicker(
  items: SessionPickerItem[]
): Promise<SessionPickerItem | null> {
  if (!layout.isActive() || items.length === 0) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  let selected = 0;
  let resolved = false;
  let resolve!: (v: SessionPickerItem | null) => void;
  let reject!: (e: Error) => void;

  const hint = t('prompt.chooseSwitch');

  /** 菜单行(带开窗):超屏高时以 selected 为中心取窗,保光标可见。行格式:▸ N  title  subtitle。 */
  function menuLines(): string[] {
    const g = layout.getGeo();
    const cols = g.cols;
    const maxRows = Math.max(1, g.contentBottom);
    let start = 0;
    if (items.length > maxRows) {
      start = Math.max(
        0,
        Math.min(selected - Math.floor(maxRows / 2), items.length - maxRows)
      );
    }
    const count = Math.min(maxRows, items.length);
    return Array.from({ length: count }, (_, i) => {
      const idx = start + i;
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = String(idx + 1);
      const it = items[idx];
      const title = it.title || '(无)';
      const sub = it.subtitle ?? '';
      const leadW = displayWidth(num) + 4; // "▸ " + num + "  "
      let subW = sub ? displayWidth(sub) + 2 : 0; // "  " + sub
      let titleW = cols - leadW - subW;
      if (titleW < 4 && sub) {
        subW = 0;
        titleW = cols - leadW;
      }
      const titleT = titleW > 0 ? truncateDisplay(title, titleW) : '';
      const subPart = subW > 0 ? `  ${sub}` : '';
      return `${marker} ${color}${num}  ${titleT}${subPart}${ui.reset}`;
    });
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [hint],
      cursorLine: 0,
      cursorCol: displayWidth(hint),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: SessionPickerItem | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    const n = items.length;
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + n) % n;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % n;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(items[selected] ?? null);
        return;
      case 'escape':
        finish(null);
        return;
    }
  }

  return new Promise<SessionPickerItem | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false);
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}

/**
 * 回滚方式二选一菜单(供 /rollback 选完轮次后):↑/↓ 导航、Enter 确认、Esc/Ctrl+D 保留文件。
 * 两个选项:1=撤销文件改动(恢复到回滚前);2=只撤销消息,保留文件改动。
 * 复用轮次/会话菜单的渲染骨架(raw mode + layout.paintInput 的 menu),选中项 cyan+bold + ▸ 高亮。
 * 返回 true=撤销文件 / false=只撤销消息 / null=取消(调用方按 false=保留文件处理)。
 * 默认聚焦首项(撤销文件)。无文件改动时调用方不应调此菜单(直接走只撤销消息)。
 */
export async function promptRevertChoice(fileCount: number): Promise<boolean | null> {
  if (!layout.isActive()) return null;
  const emitter = stdin as unknown as KeypressEmitter;
  const hint = t('prompt.keepFiles');
  const detail = fileCount > 0 ? t('prompt.revertDetail', { count: fileCount }) : '';
  const items = [
    t('prompt.revertFiles', { detail }),
    t('prompt.messagesOnly'),
  ];
  let selected = 0; // 默认聚焦首项(撤销文件)
  let resolved = false;
  let resolve!: (v: boolean | null) => void;
  let reject!: (e: Error) => void;

  function menuLines(): string[] {
    const cols = layout.getGeo().cols;
    return items.map((text, idx) => {
      const isSel = idx === selected;
      const color = isSel ? `${ui.accent}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
      const num = `${color}${idx + 1}${ui.reset}`;
      const t = truncateDisplay(text, cols - 6);
      return `${marker} ${num} ${color}${t}${ui.reset}`;
    });
  }

  function redraw(): void {
    layout.paintInput({
      prompt: '❯ ',
      lines: [hint],
      cursorLine: 0,
      cursorCol: displayWidth(hint),
      menu: { lines: menuLines() },
    });
  }

  function cleanup(): void {
    layout.setMouseEnabled(true);
    try {
      stdin.setRawMode(false);
    } catch {
      // 忽略
    }
    emitter.removeListener('keypress', onKey);
    stdin.pause();
  }
  function finish(value: boolean | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;
    if (mouse.swallow(key.sequence ?? '')) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
    if (key.ctrl && key.name === 'd') {
      finish(null);
      return;
    }
    switch (key.name) {
      case 'up':
        selected = (selected - 1 + items.length) % items.length;
        redraw();
        return;
      case 'down':
        selected = (selected + 1) % items.length;
        redraw();
        return;
      case 'return':
      case 'enter':
        finish(selected === 0); // true=撤销文件, false=只撤销消息
        return;
      case 'escape':
        finish(null); // 取消=保留文件
        return;
    }
  }

  return new Promise<boolean | null>((res, rej) => {
    resolve = res;
    reject = rej;
    layout.setMouseEnabled(false);
    ensurePasteDetector();
    readline.emitKeypressEvents(stdin);
    let rawOk = true;
    try {
      stdin.setRawMode(true);
    } catch {
      rawOk = false;
    }
    if (!rawOk) {
      res(null);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    redraw();
  });
}
