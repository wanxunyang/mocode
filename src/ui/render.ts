import { stdout } from 'node:process';
import { ui } from './theme.js';

/**
 * 清空整屏 + 滚动缓冲(向上滚动可见的历史输出),光标归位。
 * 进入会话时调用,让终端只剩当前 agent 对话。非 TTY 时空操作。
 */
export function clearScreen(): void {
  if (!ui.isTTY) return;
  // [2J 清整屏 · [3J 清滚动缓冲 · [H 光标回到左上
  stdout.write('\x1B[2J\x1B[3J\x1B[H');
}

export interface BannerInfo {
  model: string;
  baseURL: string;
  cwd: string;
}

/** 启动横幅:模型 / 后端 / 工作目录 / 内置命令。纯渲染,不依赖 config。 */
export function printBanner(info: BannerInfo): void {
  const { dim, bold, cyan, reset } = ui;
  stdout.write(`${bold}${cyan}终端编码 Agent${reset}\n`);
  stdout.write(`${dim}模型  ${info.model}  ·  后端  ${info.baseURL}${reset}\n`);
  stdout.write(`${dim}工作目录  ${info.cwd}${reset}\n`);
  stdout.write(`${dim}/exit 退出  ·  /clear 清空历史${reset}\n`);
  stdout.write(`${dim}${'─'.repeat(48)}${reset}\n`);
}
