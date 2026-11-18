import type { PetTask } from './pet-state.js';

/** 气泡由新事件触发；重复轮询和 updatedAt 变化不能让它常驻。 */
export class PetBubble {
  private taskKey = '';
  private until = 0;

  observeTask(task: Pick<PetTask, 'id' | 'status' | 'plan'>): boolean {
    const key = JSON.stringify([task.id, task.status, task.plan?.done, task.plan?.total]);
    if (key === this.taskKey) return false;
    this.taskKey = key;
    return ['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(task.status);
  }

  show(now: number, durationMs = 3500): void {
    this.until = now + durationMs;
  }

  visible(now: number): boolean {
    return now < this.until;
  }
}
