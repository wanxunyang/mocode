import { stdout } from 'node:process';
import { ui } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 等待动画:在 await 长操作(chat / 工具执行 / 压缩)时旋转,避免「卡死」错觉。
 *
 * 两种渲染模式:
 *  - onFrame 回调(TUI 态):帧经回调刷状态行(layout.drawStatusBar),内容区保持静止、底栏转圈;
 *    不在内容行用 \r\x1B[K 原地刷(那会擦内容、与滚动区域冲突)。
 *  - 无回调(非 TTY / 旧路径):\r\x1B[K 原地刷 braille 帧;非 TTY 退化为启动时打印一行静态提示。
 *
 * stop() 仅在确实旋转过(有 timer)时清场,避免对从未 start 的实例误清状态行。
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private msg = '';

  constructor(
    private readonly onFrame?: (msg: string, frame: string | null) => void
  ) {}

  start(msg: string): void {
    this.stop();
    this.msg = msg;
    if (!ui.isTTY) {
      stdout.write(`${ui.dim}${msg}…${ui.reset}\n`);
      return;
    }
    if (this.onFrame) {
      const cb = this.onFrame;
      this.frame = 0;
      cb(msg, FRAMES[0]); // 立即首帧,状态行即刻反映
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        cb(msg, FRAMES[this.frame]);
      }, 80);
      this.timer.unref();
      return;
    }
    this.frame = 0;
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
    if (!this.timer) return; // 未旋转:不清场(避免误清状态行)
    clearInterval(this.timer);
    this.timer = null;
    if (this.onFrame) {
      this.onFrame(this.msg, null); // 状态行去帧,保留状态文字
    } else if (ui.isTTY) {
      stdout.write('\r\x1B[K');
    }
  }
}
