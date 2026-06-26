import { stdout } from 'node:process';
import { ui } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 等待动画:在 await 长操作(chat / 工具执行)时旋转,避免终端「卡死」错觉。
 * TTY 下用 `\r` 原地刷新 braille 帧;非 TTY 退化为启动时打印一行静态提示。
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private msg = '';

  start(msg: string): void {
    this.stop();
    this.msg = msg;
    if (!ui.isTTY) {
      stdout.write(`${ui.dim}${msg}…${ui.reset}\n`);
      return;
    }
    this.frame = 0;
    // 首帧延迟一拍,避免很快的调用闪一下
    this.timer = setInterval(() => {
      this.render();
      this.frame = (this.frame + 1) % FRAMES.length;
    }, 80);
    this.timer.unref();
  }

  private render(): void {
    const f = FRAMES[this.frame];
    stdout.write(
      `\r${ui.brightMagenta}${f}${ui.reset} ${ui.dim}${this.msg}${ui.reset}\x1B[K`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (ui.isTTY) stdout.write('\r\x1B[K');
  }
}
