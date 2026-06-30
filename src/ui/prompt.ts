import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, padEndDisplay, truncateDisplay } from './render.js';
import * as layout from './layout.js';

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
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
  let menuOpen = false;
  let selected = 0;
  let filtered: SlashCommand[] = [];
  let resolved = false;
  let resolve!: (v: string[] | null) => void;
  let reject!: (e: Error) => void;

  /** 菜单行(预渲染,带色)——向上展开进内容区底,由 layout 贴入。 */
  function menuLines(): string[] {
    if (!menuOpen || filtered.length === 0) return [];
    const cols = layout.getGeo().cols;
    const maxName = Math.max(...filtered.map((c) => displayWidth(c.name)));
    return filtered.map((c, i) => {
      // 选中项:▸ 与文字均 cyan+bold(去 dim),未选中项保持 dim——选中行整体高亮。
      const isSel = i === selected;
      const color = isSel ? `${ui.cyan}${ui.bold}` : ui.dim;
      const marker = isSel ? `${ui.cyan}${ui.bold}▸${ui.reset}` : ' ';
      const name = padEndDisplay(c.name, maxName);
      const descW = cols - maxName - 5; // marker + 空格 + 2 间距
      const desc = descW > 0 ? truncateDisplay(c.desc, descW) : '';
      return `${marker} ${color}${name}${ui.reset}  ${color}${desc}${ui.reset}`;
    });
  }

  /** 当前光标在该行的显示列(供 layout 定位光标)。 */
  function cursorCol(): number {
    return displayWidth(lines[cl].slice(0, cc));
  }

  /** chip 预览前缀:整段扁平化(行界→空格,避免框内折行)取前 ~20 列,超长 truncateDisplay 自带 …;末尾空格与 suffix 分隔。 */
  function chipPrefix(): string {
    return chip ? `[${truncateDisplay(chip.split('\n').join(' '), 20)}] ` : '';
  }
  /** 供 layout 画的行:chip 存在时把前缀拼到第 0 行前(chip 原子显示,不可编辑;光标活在 suffix)。 */
  function dispLines(): string[] {
    if (!chip) return lines;
    const pre = chipPrefix();
    return lines.length > 0 ? [pre + lines[0], ...lines.slice(1)] : [pre];
  }
  /** 供 layout 定位光标列:chip 在第 0 行时偏移 chipPrefix 宽度(suffix 光标始终在 chip 之后)。 */
  function dispCursorCol(): number {
    return chip && cl === 0 ? displayWidth(chipPrefix()) + cursorCol() : cursorCol();
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
  /** 粘贴结束:长粘贴(>8 行或 >400 字符)落/并进 chip(原子,整段封预览),短粘贴落为可编辑文本。 */
  function finalizePaste(): void {
    if (resolved) {
      pasteParts = [];
      return;
    }
    const buf = pasteParts.join('');
    pasteParts = [];
    justSawCR = false;
    if (!buf) return;
    const isLong = buf.split('\n').length > 8 || buf.length > 400;
    if (isLong) {
      chip = chip == null ? buf : chip + '\n' + buf; // 多块粘贴:并进同一 chip
      lines = [''];
      cl = 0;
      cc = 0;
    } else {
      insertText(buf);
    }
    computeFiltered();
    redraw();
  }

  function computeFiltered(): void {
    if (cl === 0 && lines[0].startsWith('/')) {
      filtered = opts.commands.filter((c) => c.name.startsWith(lines[0]));
      menuOpen = filtered.length > 0;
      if (selected >= filtered.length) selected = 0;
    } else {
      filtered = [];
      menuOpen = false;
    }
  }

  function redraw(): void {
    layout.paintInput({
      prompt: opts.prompt,
      lines: dispLines(),
      cursorLine: cl,
      cursorCol: dispCursorCol(),
      menu: menuLines().length ? { lines: menuLines() } : null,
    });
  }

  function cleanup(): void {
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

  /** 提交:菜单打开时先补全选中项到第 0 行。chip 与 suffix 拼回全文(chip 在前,换行接 suffix)。 */
  function submit(): void {
    if (menuOpen && filtered[selected]) {
      lines = [filtered[selected].name];
      cl = 0;
      cc = lines[0].length;
    }
    const suffix = lines.join('\n');
    const content = chip ? (suffix.length > 0 ? chip + '\n' + suffix : chip) : suffix;
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
    menuOpen = false;
    filtered = [];
    selected = 0;
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

    // 滚动回看键(优先;不触发回尾):PgUp/PgDn 翻页,Ctrl+↑↓ 与 plain ↑/↓ 单行。
    // plain ↑/↓ 仅在单行输入且菜单关闭时作滚动(多行编辑留给光标移动,菜单打开留给选项);
    // 兼鼠标滚轮——WT alt 屏(经 \x1B[?1007h)滚轮转发 ↑/↓。
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
      else if (key.name === 'up') layout.scrollBy(1);
      else layout.scrollBy(-1);
      return;
    }

    // 其他键:若处于滚动回看,先回尾再处理(打字即回底)
    if (layout.isScrolled()) layout.resetScroll();

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

    // 换行:Ctrl+J / Alt+Enter(meta)/ Shift+Enter(终端区分时)/ lone LF
    // (粘贴的 CR/LF 已在上方 pasting 分支累积进 pasteParts,不会到此)
    const wantNewline =
      (key.ctrl && key.name === 'j') ||
      (key.meta && isReturn) ||
      (key.shift && isReturn) ||
      (key.sequence === '\n' && !key.ctrl);

    if (wantNewline) {
      insertNewline();
      return;
    }
    // 提交(键盘 plain Enter)
    if (isReturn && !key.shift && !key.meta && !key.ctrl) {
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
          // 光标在 suffix 开头(紧贴 ] 后):退格删整个 chip(原子)
          chip = null;
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
      // isTTY 但 setRawMode 失败(罕见):退化为 readline
      questionFallback(opts.prompt).then(
        (a) => res([a]),
        (e) => rej(e)
      );
      return;
    }
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
      caret: false, // 纯导航菜单(非文本输入):不画输入框块状光标,聚焦由菜单 ▸ 标记
    });
  }

  function cleanup(): void {
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
      caret: false, // 纯导航菜单(非文本输入):不画输入框块状光标,聚焦由菜单 ▸ 标记
    });
  }

  function cleanup(): void {
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
