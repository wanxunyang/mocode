/**
 * 常驻子进程的空闲回收。
 *
 * 为什么需要:computer use 的两个常驻进程(注入器 / 抓屏)都是**惰性**启动的 —— 第一次真正
 * 用到才 spawn。但「惰性启动」只解决了「不用时不起」,没解决「用完了不退」:/cu 开着、用户
 * 去做别的事(写代码、看 diff、甚至只是去吃个饭),那两个 PowerShell 进程会一直挂在后台。
 *
 * 所以生命周期是四段式:惰性启动 → 每次调用 touch 续期 → 空闲 N 分钟自动回收 → 退出时强制回收。
 *
 * 关键细节:`setTimeout(...).unref()`。不 unref 的话这个定时器本身就是一个 active handle,
 * 会让 Node 主进程在 REPL 想退出时退不出去 —— 表现为「输 /exit 卡住几秒才走」。
 */
export class IdleGuard {
  private timer: NodeJS.Timeout | null = null;

  /**
   * @param idleMs 空闲多久回收。<= 0 表示永不自动回收(只靠显式 dispose)。
   * @param onIdle 回收回调,必须幂等(可能由超时、dispose、进程崩溃多方触发)。
   */
  constructor(
    private readonly idleMs: number,
    private readonly onIdle: () => void | Promise<void>,
  ) {}

  /** 每次成功调用后续期。 */
  touch(): void {
    this.stop();
    if (this.idleMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.onIdle();
    }, this.idleMs);
    // 见文件头:不 unref 会吊住 Node 退出。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get armed(): boolean {
    return this.timer !== null;
  }
}

/**
 * 读一个毫秒数环境变量,非法值回落默认。
 *
 * 空串必须回落:`Number('')` 是 0,而 0 在本模块语义里是「关闭自动回收」—— 用户在 .env 里
 * 写 `MOCODE_CU_CAPTURE_IDLE_MS=`(清空/注释掉的常见写法)会被静默解读成「永不回收」,
 * 于是又回到留孤儿 PowerShell 的老问题。空 = 没配 = 用默认,只有显式写 0 才是 0。
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}
