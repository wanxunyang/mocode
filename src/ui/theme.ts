import { stdout } from 'node:process';

/**
 * 终端 UI 主题:TTY 感知的 ANSI 颜色。
 * 非 TTY(管道 / 重定向)时颜色退化为空串,避免把转义码原样打到日志里。
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
  blue: wrap('\x1B[34m'),
  cyan: wrap('\x1B[36m'),
  gray: wrap('\x1B[90m'),
  magenta: wrap('\x1B[35m'),
  brightCyan: wrap('\x1B[96m'),
  brightMagenta: wrap('\x1B[95m'),
};
