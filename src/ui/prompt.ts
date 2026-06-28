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
}

/** emitKeypressEvents 后 stdin 会发 'keypress',但该事件不在 ReadStream 类型里,单独声明。 */
interface KeypressEmitter {
  on(event: 'keypress', listener: (str: string, key: Key) => void): this;
  removeListener(
    event: 'keypress',
    listener: (str: string, key: Key) => void
  ): this;
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
      const marker = i === selected ? `${ui.cyan}▸${ui.reset}` : ' ';
      const name = padEndDisplay(c.name, maxName);
      const descW = cols - maxName - 5; // marker + 空格 + 2 间距
      const desc = descW > 0 ? truncateDisplay(c.desc, descW) : '';
      return `${marker} ${ui.dim}${name}${ui.reset}  ${ui.dim}${desc}${ui.reset}`;
    });
  }

  /** 当前光标在该行的显示列(供 layout 定位光标)。 */
  function cursorCol(): number {
    return displayWidth(lines[cl].slice(0, cc));
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
      lines,
      cursorLine: cl,
      cursorCol: cursorCol(),
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
    stdin.pause();
  }

  function finish(value: string[] | null): void {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  }

  /** 提交:菜单打开时先补全选中项到第 0 行。 */
  function submit(): void {
    if (menuOpen && filtered[selected]) {
      lines = [filtered[selected].name];
      cl = 0;
      cc = lines[0].length;
    }
    finish(lines);
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

  function onKey(_str: string, key?: Key): void {
    if (resolved || !key) return;

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

    // raw 模式下 Ctrl+C 不触发 SIGINT,作为按键到达:先恢复终端再 reject
    if (key.ctrl && key.name === 'c') {
      cleanup();
      reject(new Error('SIGINT'));
      return;
    }
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
    // 换行:Ctrl+J / Alt+Enter(meta)/ Shift+Enter(终端区分时)/ 粘贴的 LF
    const wantNewline =
      (key.ctrl && key.name === 'j') ||
      (key.meta && isReturn) ||
      (key.shift && isReturn) ||
      (key.sequence === '\n' && !key.ctrl);

    // 换行(Ctrl+J / Alt+Enter / Shift+Enter / 粘贴 LF)
    if (wantNewline) {
      insertNewline();
      return;
    }
    // 提交(plain Enter)
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
      const marker = idx === selected ? `${ui.cyan}▸${ui.reset}` : ' ';
      const num = `${ui.dim}${idx + 1}${ui.reset}`;
      const text = truncateDisplay(items[idx].firstLine, cols - 6);
      return `${marker} ${num} ${ui.dim}${text}${ui.reset}`;
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
