/**
 * read_file 重复读短路(#token-efficiency P2)。
 *
 * 实例化 scope:每个用户 turn(runAgentCore)创建一个 {@link ReadDedup},经
 * ToolContext 透传给 read_file。刻意不做进程全局单例——其他工具测试直接调
 * `readFileTool.execute`、stage replay 重放历史时不应被跨用例状态污染。
 *
 * 「内容是否仍在 context」不靠扫 history,而靠 trim 结果通知:
 * - {@link ReadDedup.beginStep}:model-turn 每步调一次,钉住当前 step;
 * - {@link ReadDedup.markContextChanged}:trim 发生任何 history 内容变更
 *   (摘要重建 / 微压缩)后由 model-turn 统一调用,旧条目全部失活。
 */
interface ReadEntry {
  /** 1-based inclusive 实际返回行区间。 */
  startLine: number;
  endLine: number;
  hash: string;
  step: number;
  /** true = 自读取后未发生过内容变更,内容应当仍在 context。 */
  hot: boolean;
}

const MAX_RANGES_PER_PATH = 5;
const MAX_PATHS = 200;

export class ReadDedup {
  /** Map 保序:超容量时删最老(第一个)key。 */
  private readonly entries = new Map<string, ReadEntry[]>();
  private currentStep = 0;

  /** model-turn 每步调用:钉住 step(指针消息里展示 "since step K")。 */
  beginStep(step: number): void {
    this.currentStep = step;
  }

  /** trim 变更 history 内容后调用:所有存活条目失活(其内容可能已不在 context)。 */
  markContextChanged(): void {
    for (const list of this.entries.values()) for (const e of list) e.hot = false;
  }

  private touch(path: string): ReadEntry[] {
    let list = this.entries.get(path);
    if (list) {
      // LRU:命中路径挪到末尾。
      this.entries.delete(path);
    } else {
      list = [];
      if (this.entries.size >= MAX_PATHS) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(path, list);
    return list;
  }

  /** 记录一次实际返回的读取(全量返回之后调用)。 */
  record(path: string, startLine: number, endLine: number, hash: string): void {
    const list = this.touch(path);
    list.push({ startLine, endLine, hash, step: this.currentStep, hot: true });
    while (list.length > MAX_RANGES_PER_PATH) list.shift();
  }

  /**
   * 查询重复读命中:存在 hot 条目,其行区间覆盖请求区间、hash 相同。
   * 无命中返 null(调用方照常全量返回)。
   */
  findUnchanged(path: string, startLine: number, endLine: number, hash: string): { step: number; hash: string } | null {
    const list = this.entries.get(path);
    if (!list) return null;
    // 从新到旧找。
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.hot && e.hash === hash && e.startLine <= startLine && e.endLine >= endLine) {
        return { step: e.step, hash };
      }
    }
    return null;
  }
}

/** 每用户 turn 一个 scope。 */
export function createReadDedup(): ReadDedup {
  return new ReadDedup();
}
