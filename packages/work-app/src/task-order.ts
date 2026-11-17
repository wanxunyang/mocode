/**
 * 侧栏任务排序键的**数据修正**规则（纯函数，无 fs / 无 electron）。
 *
 * 背景：`updatedAt` 是侧栏的「最近一次用户发言」时间，排序全靠它。旧版接管历史会话
 * （`work:adopt-session`）一律把 `updatedAt` 写成 `now`，于是「点开一条几周前的会话
 * 看一眼」= 把它顶成最新活动。真机上还出现过成批写坏：多条 11 月初的老任务的
 * `updatedAt` 全落在同一个亚秒窗口里。
 *
 * 单条会话的真实「最后活动时间」只有磁盘上的 session.json mtime 说得清。这里不直接
 * 改数据，只算出「哪些任务的时间明显对不上、应该改成什么」，由调用方落盘 —— 规则可单测。
 */

/**
 * 允许的漂移上限，超过就认定为写坏。
 *
 * 正常节奏下 updatedAt（用户发消息的那一刻）与 session.json mtime（host 写盘）相差
 * 不超过几秒；run 结束后 mtime 通常还比 updatedAt 更晚。留一小时余量是为了容忍
 * 「发了消息但 host 冷启动 + 排队很久」这类正常晚写，避免把真实活动时间往回拨。
 */
export const SORT_KEY_DRIFT_MS = 60 * 60 * 1000;

export interface SortKeyTask {
  id: string;
  status: string;
  sessionId?: string;
  updatedAt: string;
}

export interface SortKeyRepair {
  taskId: string;
  from: string;
  to: string;
}

/**
 * 算出需要修正排序键的任务。
 *
 * 跳过运行中 / 等人 / 排队中的任务：它们的时间戳是刚刚发生的真实事件，
 * 回退成会话 mtime 反而会让「我正在跑的任务」掉出置顶区。
 * `lastActiveOf` 返回 null（会话已归档但索引缺失 / 目录被清）时同样跳过 —— 没有证据不动数据。
 */
export function planSortKeyRepair(
  tasks: ReadonlyArray<SortKeyTask>,
  lastActiveOf: (task: SortKeyTask) => string | null,
): SortKeyRepair[] {
  const repairs: SortKeyRepair[] = [];
  for (const task of tasks) {
    if (!task.sessionId) continue;
    if (task.status === 'running' || task.status === 'waiting' || task.status === 'queued') continue;
    const lastActive = lastActiveOf(task);
    if (!lastActive) continue;
    const updated = Date.parse(task.updatedAt);
    const active = Date.parse(lastActive);
    if (!Number.isFinite(updated) || !Number.isFinite(active)) continue;
    if (updated - active <= SORT_KEY_DRIFT_MS) continue;
    repairs.push({ taskId: task.id, from: task.updatedAt, to: lastActive });
  }
  return repairs;
}