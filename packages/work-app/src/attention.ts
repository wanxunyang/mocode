/**
 * 「有哪些任务卡在等人」的纯计算（主进程 / 渲染层 / 测试共用）。
 *
 * 为什么单独成模块：这个判断有三个消费方，且都容易各写一套而走样 ——
 *   · 侧栏任务行与空间标题（renderer.ts 的 paintTaskItem / paintProject）
 *   · 标题栏「N 个待处理」徽章
 *   · 主进程决定要不要发系统通知（main.ts）
 * 「谁算在等我」是产品语义，不能在三处各猜一遍。
 */

export interface WaitableTask {
  id: string;
  title: string;
  projectId: string;
  /** task.status === 'waiting' 即 agent 因审批 / ask_human 暂停。 */
  status: string;
  updatedAt: string;
  createdAt?: string;
}

export function isWaitingForHuman(task: { status: string }): boolean {
  return task.status === 'waiting';
}

/**
 * 正在等人工介入的任务，**最久等待的排在最前**。
 *
 * 排序口径：先按 updatedAt 升序（waiting 任务在等的时候不会再被更新，
 * 所以 updatedAt 就是「它从什么时候开始等」的近似），同刻再按 id 保证稳定。
 * 用 updatedAt 而不是 createdAt：一个跑了很久的老任务刚卡住，它比新任务更该被先处理。
 */
export function pendingTasks<T extends WaitableTask>(tasks: readonly T[]): T[] {
  return tasks
    .filter(isWaitingForHuman)
    .sort((left, right) => {
      const delta = left.updatedAt.localeCompare(right.updatedAt);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    });
}

/** 每个空间里有几个任务在等人（键是 projectId，空格子字符串表示「无空间」）。 */
export function pendingByProject<T extends WaitableTask>(tasks: readonly T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!isWaitingForHuman(task)) continue;
    counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  }
  return counts;
}