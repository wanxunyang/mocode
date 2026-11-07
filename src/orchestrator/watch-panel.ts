// `mocode supervise watch`（无 run id）= 监管工作台面板。
//
// 为什么不复用 REPL 的 layout 栈：那套是「内容区 + 固定底栏 + 输入框」的单对话布局，
// 有 spinner、状态栏心跳、DECSTBM 滚动区、markdown 重排等一堆为对话服务的状态。
// 工作台是一次性全屏只读视图，自己管 alt screen 更简单，也不会与 REPL 全局单例互相污染
// （面板退出后 REPL 仍然干净）。
//
// 交互：↑/↓ 或 j/k 移动，g/G 首尾，Enter 无副作用（宽屏已常驻详情），r 立即刷新，q/Esc 退出。
// 非 TTY 或 `--json` 走 `formatBoardSnapshot` 一次性输出，脚本可直接消费。

import { stdin, stdout } from 'node:process';
import readline from 'node:readline';
import { ui } from '../ui/theme.js';
import { boardRows, collectBoard, renderBoard, type BoardSnapshot } from './board.js';
import type { WorkspaceInfo } from './workspaces.js';

export interface BoardPanelOptions {
  /** 已知工作区（含 cwd）。 */
  workspaces: readonly WorkspaceInfo[];
  /** 自动刷新间隔（毫秒）；<=0 关闭自动刷新。默认 1500。 */
  refreshMs?: number;
  /** 每帧之后回调（测试与 --json 用）。 */
  onFrame?: (board: BoardSnapshot, frame: { lines: string[]; selected: number }) => void;
  /** 注入用：收集快照（默认 collectBoard）。 */
  collect?: (workspaces: readonly WorkspaceInfo[]) => BoardSnapshot;
  /** 注入用：退出条件（默认等 q / Esc / Ctrl-C）。只在测试里换掉。 */
  shouldExit?: () => boolean;
}

const ESC = '\x1B[';
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const CURSOR_OFF = `${ESC}?25l`;
const CURSOR_ON = `${ESC}?25h`;
const CLEAR_BELOW = `${ESC}0J`;

function collect(options: BoardPanelOptions): BoardSnapshot {
  if (options.collect) return options.collect(options.workspaces);
  return collectBoard({ workspaces: options.workspaces });
}

/** 每帧：整屏重画（工作台行数不多，全量写比增量 diff 稳，且不会残留旧字符）。 */
function paint(lines: readonly string[]): void {
  let frame = `${ESC}H`;
  for (const line of lines) {
    // 行尾 EL：上一帧更长时不会留下尾巴。
    frame += `${line}${ESC}K\r\n`;
  }
  stdout.write(`${frame}${CLEAR_BELOW}`);
}

/**
 * 进入面板直到用户退出。返回进程退出码（0 = 正常退出，130 = Ctrl-C）。
 * 非 TTY 不进入面板：返回 1 并给出提示，让调用方退化到一次性快照。
 */
export async function runBoardPanel(options: BoardPanelOptions): Promise<number> {
  if (!stdout.isTTY || !stdin.isTTY) return 1;

  let board = collect(options);
  let rows = boardRows(board);
  let selected = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const height = (): number => stdout.rows || 24;
  const width = (): number => stdout.columns || 80;

  const draw = (): void => {
    const rendered = renderBoard(board, { cols: width(), rows: height(), selected });
    rows = rendered.rows;
    if (rows.length > 0) selected = Math.min(selected, rows.length - 1);
    paint(rendered.lines);
    options.onFrame?.(board, { lines: rendered.lines, selected });
  };

  const refresh = (): void => {
    board = collect(options);
    rows = boardRows(board);
    if (rows.length > 0) selected = Math.min(selected, rows.length - 1);
    draw();
  };

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    process.removeListener('SIGWINCH', onResize);
    stdin.removeListener('keypress', onKey);
    try {
      stdin.setRawMode(false);
    } catch {
      // 非 TTY / 不支持：忽略
    }
    stdin.pause();
    stdout.write(`${CURSOR_ON}${ALT_OFF}`);
  };

  const onResize = (): void => draw();

  function onKey(_str: string, key: readline.Key): void {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      resolveExit(130);
      return;
    }
    switch (key.name) {
      case 'q':
      case 'escape':
        cleanup();
        resolveExit(0);
        return;
      case 'up':
      case 'k':
        if (rows.length > 0) selected = (selected - 1 + rows.length) % rows.length;
        draw();
        return;
      case 'down':
      case 'j':
        if (rows.length > 0) selected = (selected + 1) % rows.length;
        draw();
        return;
      case 'g':
        selected = 0;
        draw();
        return;
      case 'G':
        selected = Math.max(0, rows.length - 1);
        draw();
        return;
      case 'r':
        refresh();
        return;
      default:
        return;
    }
  }

  let resolveExit!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  stdout.write(`${ALT_ON}${CURSOR_OFF}`);
  readline.emitKeypressEvents(stdin);
  try {
    stdin.setRawMode(true);
  } catch {
    // 不支持 raw：按键不会来，但画面仍可看；交给定时器/信号退出。
  }
  stdin.resume();
  stdin.on('keypress', onKey);
  process.on('SIGWINCH', onResize);
  draw();

  const interval = options.refreshMs ?? 1500;
  if (interval > 0) {
    timer = setInterval(refresh, interval);
    timer.unref?.();
  }
  if (options.shouldExit) {
    const poll = setInterval(() => {
      if (options.shouldExit?.()) {
        cleanup();
        resolveExit(0);
      }
    }, 20);
    poll.unref?.();
  }

  return done;
}

/** 面板头部的说明行，供 `--help` 与文档引用。 */
export const BOARD_HINT = `${ui.dim}监管工作台：↑↓ 选择 · r 刷新 · q 退出（mocode supervise watch <run-id> 看单个 Run 的事件流）${ui.reset}`;
