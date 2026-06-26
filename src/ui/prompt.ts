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
  let lines: string[] = [''];
  let cl = 0; // 光标行(0-based)
  let cc = 0; // 光标在该行的字符索引
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
