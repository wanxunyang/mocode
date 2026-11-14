/**
 * 发送队列（纯逻辑，无 DOM / 无 Electron 依赖）。
 *
 * 为什么需要：work-app 之前「正在跑时点发送 = 取消当前运行」（renderer.ts 的 submit）。
 * 想连发两条指令的用户只能等第一条跑完——而 agent 跑一轮动辄几十秒到几分钟。
 *
 * 设计取舍：
 *  - **纯客户端**：不改协议。协议里 run 是「一次一轮」，串行化是界面的事；
 *    放进 host 反而要在 host 里维护「待跑队列 + 取消语义」，收益为零。
 *  - **按任务分队列**：任务 A 在跑时给任务 B 发消息不该排队（B 是空闲的，直接跑）；
 *    切任务也不该丢队列。
 *  - **失败也继续出队**：用户打的字是他想发的东西，前一条失败不是丢弃后续的理由。
 */
export interface QueuedSend<TPayload> {
  /** 排在第几（1 起，仅用于「已排队 n 条」文案）。 */
  seq: number;
  payload: TPayload;
}

export class SendQueue<TPayload> {
  private readonly queues = new Map<string, QueuedSend<TPayload>[]>();
  private seq = 0;

  /** 入队，返回该任务当前排队条数（1 = 刚排进去的那条）。 */
  enqueue(taskId: string, payload: TPayload): number {
    const list = this.queues.get(taskId) ?? [];
    this.seq += 1;
    list.push({ seq: this.seq, payload });
    this.queues.set(taskId, list);
    return list.length;
  }

  /** 出队一条；空队列返回 undefined（调用方据此停下）。 */
  dequeue(taskId: string): QueuedSend<TPayload> | undefined {
    const list = this.queues.get(taskId);
    if (!list || list.length === 0) return undefined;
    const item = list.shift();
    if (list.length === 0) this.queues.delete(taskId);
    return item;
  }

  /** 该任务当前排队条数。 */
  size(taskId: string): number {
    return this.queues.get(taskId)?.length ?? 0;
  }

  /**
   * 只读快照（FIFO 顺序）。给「输入框上方的排队面板」用：
   * 面板要能一次画出全部待发消息，但不该通过 dequeue 改变队列，
   * 也不该拿到内部数组的引用（调用方 push/sort 会直接把队列改坏）。
   */
  snapshot(taskId: string): QueuedSend<TPayload>[] {
    return [...(this.queues.get(taskId) ?? [])];
  }

  /**
   * 清空某任务的队列（删除任务 / 回滚 / 用户手动取消排队时）。
   * 返回被丢弃的条数，供调用方提示——静默丢用户输入是不可接受的。
   */
  clear(taskId: string): number {
    const list = this.queues.get(taskId);
    if (!list) return 0;
    this.queues.delete(taskId);
    return list.length;
  }

  /** 全部排队条数（侧栏/状态行汇总用）。 */
  totalSize(): number {
    let total = 0;
    for (const list of this.queues.values()) total += list.length;
    return total;
  }
}