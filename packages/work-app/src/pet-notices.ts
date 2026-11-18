import type { PetTask } from './pet-state.js';

export type PetNotice = { taskId: string; title: string; status: 'waiting' | 'completed' | 'failed' };

/** 收集所有任务的状态变化，不能只盯当前选中的任务。 */
export class PetTaskNotices {
  private statuses = new Map<string, string>();
  private pending: PetNotice[] = [];

  reset(): void {
    this.statuses.clear();
    this.pending = [];
  }

  update(tasks: readonly PetTask[], enabled = true): void {
    const current = new Map(tasks.map((task) => [task.id, task.status]));
    this.pending = enabled ? this.pending.filter((n) => current.get(n.taskId) === n.status) : [];
    if (enabled)
      for (const task of tasks) {
        const previous = this.statuses.get(task.id);
        if (previous === task.status) continue;
        if (task.status !== 'waiting' && !(previous !== undefined && ['completed', 'failed'].includes(task.status)))
          continue;
        this.pending = this.pending.filter((n) => n.taskId !== task.id);
        this.pending.push({ taskId: task.id, title: task.title, status: task.status as PetNotice['status'] });
      }
    this.statuses = current;
  }

  next(): PetNotice | null {
    const waiting = this.pending.findIndex((n) => n.status === 'waiting');
    return this.pending.splice(waiting < 0 ? 0 : waiting, 1)[0] ?? null;
  }
}

/** 桌面坐标全屏跟随，320px 范围内逐渐转头，范围外保持最大转角。 */
export function petLookAt(cursor: { x: number; y: number }, head: { x: number; y: number }): { x: number; y: number } {
  const dx = cursor.x - head.x,
    dy = cursor.y - head.y;
  const distance = Math.max(320, Math.hypot(dx, dy));
  return { x: dx / distance, y: dy / distance };
}
