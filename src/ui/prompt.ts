import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Key } from 'node:readline';
import { ui } from './theme.js';
import { displayWidth, padEndDisplay, truncateDisplay } from './render.js';

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

/** 非 TTY / raw 不可用时退化为普通 readline 行输入(无菜单)。 */
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
 * 读一行输入;TTY 下输入以 / 开头时在 prompt 行下方渲染方向键可选的下拉菜单(边打边过滤)。
 * 非 TTY 退化为 readline.question(无菜单)。返回 null 表示空缓冲时 Ctrl+D;
 * raw 模式下 Ctrl+C 先恢复终端再 reject(new Error('SIGINT')),交调用方 catch。
 */
export async function promptWithSlashMenu(
  opts: PromptOpts
): Promise<string | null> {
  if (!stdin.isTTY || !stdout.isTTY) {
    return questionFallback(opts.prompt);
  }

  const emitter = stdin as unknown as KeypressEmitter;
  const promptW = displayWidth(opts.prompt);
  let buf = '';
  let cursor = 0;
  let menuOpen = false;
  let selected = 0;
  let filtered: SlashCommand[] = [];
  let prevMenuRows = 0;
  let resolved = false;
  let resolve!: (v: string | null) => void;
  let reject!: (e: Error) => void;

  function computeFiltered(): void {
    if (buf.startsWith('/')) {
      filtered = opts.commands.filter((c) => c.name.startsWith(buf));
      menuOpen = filtered.length > 0;
      if (selected >= filtered.length) selected = 0;
    } else {
      filtered = [];
      menuOpen = false;
    }
  }

  function placeCursor(): void {
    const col = promptW + displayWidth(buf.slice(0, cursor));
    stdout.write(`\r\x1B[${col}C`);
  }

  function redraw(): void {
    // 1. 擦旧菜单(用旧行数,处理菜单收缩 5→2→0)
    if (prevMenuRows > 0) stdout.write(`\x1B[${prevMenuRows}A\x1B[J`);
    // 2. prompt 行(单行擦,见 spinner.ts:34,43)
    stdout.write(`\r\x1B[K${opts.prompt}${buf}`);
    // 3. 菜单
    let rows = 0;
    if (menuOpen && filtered.length > 0) {
      const cols = stdout.columns ?? 80;
      const maxName = Math.max(...filtered.map((c) => displayWidth(c.name)));
      const lines = filtered.map((c, i) => {
        const marker = i === selected ? `${ui.cyan}▸${ui.reset}` : ' ';
        const name = padEndDisplay(c.name, maxName);
        const descW = cols - maxName - 5; // marker + 空格 + 2 间距
        const desc = descW > 0 ? truncateDisplay(c.desc, descW) : '';
        return `${marker} ${ui.dim}${name}${ui.reset}  ${ui.dim}${desc}${ui.reset}`;
      });
      stdout.write('\n' + lines.join('\n'));
      rows = filtered.length;
      stdout.write(`\x1B[${rows}A`); // 回到 prompt 行(见 agent/index.ts:49)
    }
    prevMenuRows = rows;
    placeCursor();
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

  function finish(value: string | null): void {
    if (resolved) return;
    resolved = true;
    if (prevMenuRows > 0) stdout.write(`\x1B[${prevMenuRows}A\x1B[J`);
    stdout.write(`\r\x1B[K${opts.prompt}${buf}\n`);
    cleanup();
    resolve(value);
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
      if (buf.length === 0) finish(null);
      return;
    }

    switch (key.name) {
      case 'return':
      case 'enter':
        if (menuOpen && filtered[selected]) {
          buf = filtered[selected].name;
          cursor = buf.length;
        }
        finish(buf);
        return;
      case 'backspace':
        if (cursor > 0) {
          buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
          cursor--;
          computeFiltered();
          redraw();
        }
        return;
      case 'up':
        if (menuOpen && filtered.length) {
          selected = (selected - 1 + filtered.length) % filtered.length;
          redraw();
        }
        return;
      case 'down':
        if (menuOpen && filtered.length) {
          selected = (selected + 1) % filtered.length;
          redraw();
        }
        return;
      case 'tab':
        if (menuOpen && filtered[selected]) {
          buf = filtered[selected].name;
          cursor = buf.length;
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
        if (cursor > 0) {
          cursor--;
          placeCursor();
        }
        return;
      case 'right':
        if (cursor < buf.length) {
          cursor++;
          placeCursor();
        }
        return;
    }

    // 可打印字符(>= 空格,非 ctrl/meta)
    const s = key.sequence ?? '';
    if (s && s >= ' ' && !key.ctrl && !key.meta) {
      buf = buf.slice(0, cursor) + s + buf.slice(cursor);
      cursor += s.length;
      computeFiltered();
      redraw();
    }
  }

  return new Promise<string | null>((res, rej) => {
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
      questionFallback(opts.prompt).then(res, rej);
      return;
    }
    stdin.resume();
    emitter.on('keypress', onKey);
    computeFiltered();
    redraw();
  });
}
