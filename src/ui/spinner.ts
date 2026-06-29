import { stdout } from 'node:process';
import { ui } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 当前活跃 spinner:`start()` 的 TTY 路径登记,`stop()` 不清——供 `pauseCurrent()` 在介入面板
 * (ask_human)进入前停转,避免 onFrame 的 `paintLiveAtCursor` 每 80ms 覆盖面板。同进程同时刻至多一个在转;
 * 下次 `start()` 自动替换引用,无泄漏。非 TTY 路径不登记(无 onFrame,无需暂停)。
 */
let activeSpinner: Spinner | null = null;

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
    activeSpinner = this; // TTY 路径:登记为当前可暂停 spinner(介入面板进入前 pauseCurrent 停转)
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

  /**
   * 暂停当前活跃 spinner(供 ask_human 介入面板进入前停转,避免 onFrame 覆盖面板)。
   * 未转则 no-op(stop 内 `!this.timer` 守护);停转时 onFrame(msg,null) 触发 clearLiveAtCursor 清续写位帧。
   * 不 resume——ask_human 的活儿就是面板本身,退出后 agent 的 spinner.stop() 是 no-op,下一轮 start 自然重启。
   */
  static pauseCurrent(): void {
    activeSpinner?.stop();
  }
}
