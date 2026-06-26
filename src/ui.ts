import { stdout } from 'node:process';

/**
 * 终端 UI 辅助:TTY 感知的 ANSI 颜色 + 清屏。
 * 非 TTY(管道 / 重定向)时颜色退化为空串、清屏为空操作,
 * 避免把转义码原样打到日志里。
 */
const isTTY = Boolean(stdout.isTTY);
const wrap = (code: string) => (isTTY ? code : '');

export const ui = {
  isTTY,
  reset: wrap('\x1B[0m'),
  bold: wrap('\x1B[1m'),
  dim: wrap('\x1B[2m'),
  red: wrap('\x1B[31m'),
  green: wrap('\x1B[32m'),
  yellow: wrap('\x1B[33m'),
  cyan: wrap('\x1B[36m'),
  gray: wrap('\x1B[90m'),
};

/**
 * 清空整屏 + 滚动缓冲(向上滚动可见的历史输出),光标归位。
 * 进入会话时调用,让终端只剩当前 agent 对话。
 */
export function clearScreen(): void {
  if (!isTTY) return;
  // [2J 清整屏 · [3J 清滚动缓冲 · [H 光标回到左上
  stdout.write('\x1B[2J\x1B[3J\x1B[H');
}
