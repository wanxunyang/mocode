import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, padEndDisplay, truncateDisplay, visColToCharCol } from './render.js';
import * as layout from './layout.js';
import * as mouse from './mouse.js';

export interface SlashCommand {
  name: string;
  desc: string;
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
  // initialLines(运行中 typeahead 预填):用调用方给的行初始化,光标置末行末尾。
  let lines: string[] =
    opts.initialLines && opts.initialLines.length > 0
      ? [...opts.initialLines]
      : [''];
  let cl = lines.length - 1; // 光标行(0-based)= 末行
  let cc = lines[cl].length; // 光标在该行的字符索引 = 末行末尾
  let justSawCR = false; // \r\n 合一:粘贴的 \r 折行后,紧跟的 \n 吞掉(避免折两行)
  let chip: string | null = null; // 原子粘贴块:整段封进 [预览…],不可编辑;提交时拼回全文
  let chipPre = ''; // chip 之前已存在的文本(粘贴发生时光标前的原文,原样多行保留,不截断);随 chip 一起提交/删除
  let menuOpen = false;
  let selected = 0;
  let filtered: SlashCommand[] = [];
  const MENU_MAX_VISIBLE = 5;
  let menuTop = 0; // 窗口首项在 filtered 中的索引,菜单最多显示 MENU_MAX_VISIBLE 条
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
    const maxName = Math.max(...windowItems.map((c) => displayWidth(c.name)));
    const hasMoreAbove = menuTop > 0;
    const hasMoreBelow = menuTop + visibleCount < filtered.length;
    return windowItems.map((c, i) => {
      const globalIdx = menuTop + i;
      // 选中项:▸ 与文字均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = globalIdx === selected;
      const color = isSel ? `${ui.cyan}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.cyan}${ui.bold}▸${ui.reset}` : ' ';
      const name = padEndDisplay(c.name, maxName);
      // 首/末附加滚动指示(▲/▼)而非替换整行
      let desc = c.desc;
      let scrollHint = '';
      if (i === 0 && hasMoreAbove) scrollHint = ' ▲';
      if (i === windowItems.length - 1 && hasMoreBelow) scrollHint = ' ▼';
      const hintW = displayWidth(scrollHint);
      const descW = cols - maxName - 5 - hintW; // marker + 空格 + 2 间距 + hint
      const descStr = descW > 0 ? truncateDisplay(desc, descW) : '';
      return `${marker} ${color}${name}${ui.reset}  ${color}${descStr}${ui.reset}${ui.dim}${scrollHint}${ui.reset}`;
    });
  }

  /** 当前光标在该行的显示列(供 layout 定位光标)。 */
  function cursorCol(): number {
    return displayWidth(lines[cl].slice(0, cc));
  }

  /** chip 预览前缀:行数 + 字符数(字符 <1K 直出,≥1K 缩为 X.XK)。比"前 20 字符截断"对 CJK 更友好
   * ——后者在中文里 20 列只够 10 个汉字就截没,几乎看不到内容;元信息密度更高、长度可预测。 */
  function chipPrefix(): string {
    if (!chip) return '';
    const lines = chip.split('\n').length;
    const chars = chip.length;
    const charStr = chars < 1000 ? `${chars} 字符` : `${(chars / 1000).toFixed(1)}K 字符`;
    return `[📋 ${lines} 行 · ${charStr}] `;
  }
  /** chipPre 按行拆分(粘贴发生前光标之前已有的文本,可能多行,原样保留在 chip 之前)。 */
  function chipPreLines(): string[] {
    return chip ? chipPre.split('\n') : [];
  }
  /** 供 layout 画的行:chipPre 的行原样排在前面,最后一行接上 chip 前缀 + suffix 第 0 行
   * (chip 原子显示,不可编辑;chipPre 同样不可直接编辑,光标只活在 suffix)。 */
  function dispLines(): string[] {
    if (!chip) return lines;
    const pre = chipPreLines();
    const lastPre = pre[pre.length - 1];
    const mergedRow = lastPre + chipPrefix() + lines[0];
    return [...pre.slice(0, -1), mergedRow, ...lines.slice(1)];
  }
  /** 供 layout 定位光标行:chipPre 多出的行数计入偏移(suffix 的 cl=0 对应 chipPre 最后一行所在的合并行)。 */
  function dispCursorLine(): number {
    return chip ? chipPreLines().length - 1 + cl : cl;
  }
  /** 供 layout 定位光标列:chip 在合并行(cl===0)时偏移 chipPre 末行宽度 + chipPrefix 宽度。 */
  function dispCursorCol(): number {
    if (!chip || cl !== 0) return cursorCol();
    const pre = chipPreLines();
    return displayWidth(pre[pre.length - 1]) + displayWidth(chipPrefix()) + cursorCol();
  }
  /** 在光标处插入文本(含换行则拆行)。供短粘贴 finalize 落为可编辑文本。 */
  function insertText(text: string): void {
    const parts = text.split('\n');
    const before = lines[cl].slice(0, cc);
    const after = lines[cl].slice(cc);
    const newLines: string[] = [before + parts[0]];
    for (let i = 1; i < parts.length; i++) newLines.push(parts[i]);
    newLines[newLines.length - 1] += after;
    lines.splice(cl, 1, ...newLines);
    cl = cl + parts.length - 1;
    // 光标置于插入文本末尾 = 原 before + 末段长度(指向插入文本之后、after 之前)。
    // 旧值 parts[...].length 漏算 before → 光标落到插入文本内部(行中间)→ 后续打字插到中间(bug)。
    cc = before.length + parts[parts.length - 1].length;
  }
  /** 落一段粘贴文本(长/短判定与 chip 逻辑,finalizePaste 与鼠标点击贴入共用)。
   * 长粘贴落 chip 时不再吞掉用户已打的字:光标前的文本并入 chipPre(原样保留,与 chip 一起原子化),
   * 光标后的文本留在 suffix(lines)——即"前段文字 [长文本…] 后段文字"而非清空覆盖。 */
  function applyPastedText(buf: string): void {
    if (!buf) return;
    const isLong = buf.split('\n').length > 8 || buf.length > 200;
    if (isLong) {
      const before = lines[cl].slice(0, cc);
      const after = lines[cl].slice(cc);
      if (chip == null) {
        // 首次起 chip:光标前的行(含之前的整行)转入 chipPre,光标后的部分留作 suffix 首行。
        chipPre = [...lines.slice(0, cl), before].join('\n');
        chip = buf;
      } else {
        // 已有 chip:光标前若已打了字(chip 之后、本次粘贴之前),并入 chip 尾部保留(不丢字),
        // 光标后的部分仍留作 suffix 首行。
        chip = before ? chip + '\n' + before + '\n' + buf : chip + '\n' + buf;
      }
      lines = [after, ...lines.slice(cl + 1)];
      cl = 0;
      cc = 0;
    } else {
      insertText(buf);
    }
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

  function computeFiltered(): void {
    if (cl === 0 && lines[0].startsWith('/')) {
      filtered = opts.commands.filter((c) => c.name.startsWith(lines[0]));
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
    layout.paintInput({
      prompt: opts.prompt,
      lines: dispLines(),
      cursorLine: dispCursorLine(),
      cursorCol: dispCursorCol(),
      menu: menuLines().length ? { lines: menuLines() } : null,
    });
  }

  /** 鼠标点击输入框:把 layout 算出的(dispLine, dispCol——与 paintInput 同坐标系)
   *  写回 prompt 的 source of truth(cl, cc)→ redraw。
   *  - 无 chip 时 dispLine 即 cl、dispCol 是 lines[cl] 内显示列;
   *  - 有 chip 时 dispLine 多了 chipPre 的行偏移、dispCol 多了 chipPre + chipPrefix 的列偏移,分别扣回。
   *  点击落在 chipPre / chip 区域(行 < chipPre.length - 1,或合并行行首)→ 收敛到 suffix 第 0 行起点,
   *  把光标"走出 chip"到最自然位置(用户的直觉就是"点 chip 区域 = 回 suffix 起点")。 */
  function applyExternalCursor(dispLine: number, dispCol: number): void {
    const pre = chip ? chipPreLines() : [];
    const preLastW = chip ? displayWidth(pre[pre.length - 1] ?? '') : 0;
    const chipPrefW = chip ? displayWidth(chipPrefix()) : 0;
    // 反推 cl
    let newCl: number;
    if (chip) {
      if (dispLine < pre.length - 1) {
        // 落在 chipPre 行(非末行)→ 走出 chip,光标归 suffix 第 0 行起点
        newCl = 0;
      } else if (dispLine === pre.length - 1) {
        // 合并行(cl=0),扣掉 pre 行数
        newCl = 0;
      } else {
        // chipPre 行数之后 = dispLines 的 cl + (pre.length - 1)
        newCl = dispLine - (pre.length - 1);
        if (newCl >= lines.length) newCl = lines.length - 1;
        if (newCl < 0) newCl = 0;
      }
    } else {
      newCl = Math.max(0, Math.min(dispLine, lines.length - 1));
    }
    // 反推 cc:扣掉 chipPre 末行宽 + chipPrefix 宽,得到 lines[newCl] 内的显示列,再 visColToCharCol
    const lineText = lines[newCl] ?? '';
    let inLineVis = dispCol;
    if (chip && newCl === 0) inLineVis = Math.max(0, dispCol - preLastW - chipPrefW);
    if (inLineVis < 0) inLineVis = 0;
    const newCc = Math.min(visColToCharCol(lineText, inLineVis), lineText.length);
    cl = newCl;
    cc = newCc;
    // 收起菜单/过滤态(若点击位置不在菜单区):菜单行数被点击冲掉就关菜单,回到纯文本编辑
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

  /** 提交:菜单打开时先补全选中项到第 0 行。chipPre + chip + suffix 依次拼回全文(保留粘贴前后原有文字)。 */
  function submit(): void {
    if (menuOpen && filtered[selected]) {
      lines = [filtered[selected].name];
      cl = 0;
      cc = lines[0].length;
    }
    const suffix = lines.join('\n');
    let content = suffix;
    if (chip) {
      content = suffix.length > 0 ? chip + '\n' + suffix : chip;
      if (chipPre) content = chipPre + '\n' + content;
    }
    finish(content === '' ? [''] : content.split('\n'));
  }

  /** 插换行:在光标处断行。 */
  function insertNewline(): void {
    const after = lines[cl].slice(cc);
    lines[cl] = lines[cl].slice(0, cc);
    lines.splice(cl + 1, 0, after);
    cl++;
    cc = 0;
    computeFiltered();
    redraw();
  }

  /** 清空输入(含 chip / 斜杠菜单 / 粘贴缓冲):Ctrl+C 在有内容时调用——清空而非退出。 */
  function clearInput(): void {
    if (layout.isScrolled()) layout.resetScroll(); // 回尾(若滚动回看),再清空
    lines = [''];
    cl = 0;
    cc = 0;
    chip = null;
    chipPre = '';
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

  /** Ctrl+C:有内容(已打字 / 多行 / chip / 菜单草稿 / 粘贴缓冲 / 粘贴中)则清空,再按一次(空)才退出(仿 fish / Claude Code)。 */
  function onCtrlC(): void {
    const hasContent =
      chip != null ||
      lines.length > 1 ||
      lines.some((l) => l !== '') ||
      pasteParts.length > 0 ||
      pasting;
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

    // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页,Ctrl+↑↓ 与 plain ↑/↓ 每次 5 行。
    // plain ↑/↓ 仅在单行输入且菜单关闭时作滚动(多行编辑留给光标移动,菜单打开留给选项);
    // 兼鼠标滚轮——alt 屏内(经 \x1B[?1007h)滚轮转发 ↑/↓,1 行/格太慢故放大到 5。
    const plainArrowScroll =
      (key.name === 'up' || key.name === 'down') &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      lines.length <= 1 &&
      !(menuOpen && filtered.length > 0);
    if (
      key.name === 'pageup' ||
      key.name === 'pagedown' ||
      (key.ctrl && (key.name === 'up' || key.name === 'down')) ||
      plainArrowScroll
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
      if (lines.every((l) => l === '') && cl === 0 && cc === 0) finish(null);
      return;
    }
    if (key.ctrl && key.name === 'a') {
      cc = 0;
      redraw();
      return;
    }
    if (key.ctrl && key.name === 'e') {
      cc = lines[cl].length;
      redraw();
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
      case 'backspace':
        if (cc > 0) {
          lines[cl] = lines[cl].slice(0, cc - 1) + lines[cl].slice(cc);
          cc--;
          computeFiltered();
          redraw();
        } else if (cl > 0) {
          // 行首退格:并入上一行
          const cur = lines[cl];
          cc = lines[cl - 1].length;
          lines[cl - 1] = lines[cl - 1] + cur;
          lines.splice(cl, 1);
          cl--;
          computeFiltered();
          redraw();
        } else if (chip) {
          // 光标在 suffix 开头(紧贴 ] 后):退格删整个 chip(原子),chipPre 还原为可编辑行,
          // 光标落在 chipPre 末尾(紧接原来打的字继续编辑)。
          const preLines = chipPre ? chipPre.split('\n') : [''];
          lines = [...preLines.slice(0, -1), preLines[preLines.length - 1] + lines[0], ...lines.slice(1)];
          cl = preLines.length - 1;
          cc = preLines[preLines.length - 1].length;
          chip = null;
          chipPre = '';
          computeFiltered();
          redraw();
        }
        return;
      case 'up':
        if (menuOpen && filtered.length) {
          selected = (selected - 1 + filtered.length) % filtered.length;
          redraw();
        } else if (cl > 0) {
          cl--;
          cc = Math.min(cc, lines[cl].length);
          redraw();
        }
        return;
      case 'down':
        if (menuOpen && filtered.length) {
          selected = (selected + 1) % filtered.length;
          redraw();
        } else if (cl < lines.length - 1) {
          cl++;
          cc = Math.min(cc, lines[cl].length);
          redraw();
        }
        return;
      case 'tab':
        if (menuOpen && filtered[selected]) {
          lines[0] = filtered[selected].name;
          cl = 0;
          cc = lines[0].length;
          computeFiltered();
          redraw();
        }
        return;
      case 'escape':
        menuOpen = false;
        filtered = [];
        selected = 0;
        menuTop = 0;
        redraw();
        return;
      case 'left':
        if (cc > 0) {
          cc--;
          redraw();
        } else if (cl > 0) {
          cl--;
          cc = lines[cl].length;
          redraw();
        }
        return;
      case 'right':
        if (cc < lines[cl].length) {
          cc++;
          redraw();
        } else if (cl < lines.length - 1) {
          cl++;
          cc = 0;
          redraw();
        }
        return;
      case 'home':
        cc = 0;
        redraw();
        return;
      case 'end':
        cc = lines[cl].length;
        redraw();
        return;
    }

    // 可打印字符(>= 空格,非 ctrl/meta)
    const s = key.sequence ?? '';
    if (s && s >= ' ' && !key.ctrl && !key.meta) {
      lines[cl] = lines[cl].slice(0, cc) + s + lines[cl].slice(cc);
      cc += s.length;
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
  const hint = '↑↓ 选择 · Enter 回滚到该轮 · Esc 取消';
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
      const color = isSel ? `${ui.cyan}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.cyan}${ui.bold}▸${ui.reset}` : ' ';
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
    const base = '↑↓ 选择 · Enter 续接 · Esc 取消';
    if (!canToggle) return base;
    return showAll
      ? `↑↓ 选择 · Enter 续接 · a 仅最近${cap} · Esc 取消`
      : `↑↓ 选择 · Enter 续接 · a 全部(${items.length}) · Esc 取消`;
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
      const color = isSel ? `${ui.cyan}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.cyan}${ui.bold}▸${ui.reset}` : ' ';
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

  const hint = '↑↓ 选择 · Enter 切换 · Esc 取消';

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
      const color = isSel ? `${ui.cyan}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.cyan}${ui.bold}▸${ui.reset}` : ' ';
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
  const hint = '↑↓ 选择 · Enter 确认 · Esc 保留文件';
  const items = [
    `撤销文件改动${fileCount > 0 ? `(${fileCount} 个文件恢复到回滚前)` : ''}`,
    '只撤销消息,保留文件改动',
  ];
  let selected = 0; // 默认聚焦首项(撤销文件)
  let resolved = false;
  let resolve!: (v: boolean | null) => void;
  let reject!: (e: Error) => void;

  function menuLines(): string[] {
    const cols = layout.getGeo().cols;
    return items.map((text, idx) => {
      const isSel = idx === selected;
      const color = isSel ? `${ui.cyan}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.cyan}${ui.bold}▸${ui.reset}` : ' ';
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
