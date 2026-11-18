/** 屏幕坐标不会随窗口移动而改变，拖动时不要混用 client 坐标。 */
export class PetGesture {
  private start: { x: number; y: number } | null = null;
  private last = { x: 0, y: 0 };
  private dragging = false;

  begin(x: number, y: number): void {
    this.start = { x, y };
    this.last = { x, y };
    this.dragging = false;
  }

  move(x: number, y: number): { x: number; y: number } | null {
    if (!this.start) return null;
    if (!this.dragging && Math.hypot(x - this.start.x, y - this.start.y) < 6) return null;
    this.dragging = true;
    const delta = { x: x - this.last.x, y: y - this.last.y };
    this.last = { x, y };
    return delta;
  }

  finish(): 'click' | 'drag' | null {
    const result = this.start ? (this.dragging ? 'drag' : 'click') : null;
    this.cancel();
    return result;
  }

  cancel(): void {
    this.start = null;
    this.dragging = false;
  }
}

export type PetAction = 'pat' | 'hug' | 'wave' | 'jump' | 'spin';
const DURATIONS: Record<PetAction, number> = { pat: 2400, hug: 2800, wave: 2300, jump: 2400, spin: 3000 };

/** 互动暂时覆盖任务动作；结束后回到最新任务状态，轮询不会吞掉用户点击。 */
export class PetInteraction {
  private reaction: { action: PetAction; started: number } | null = null;
  private dragStarted: number | null = null;

  trigger(action: PetAction, now: number): void {
    this.dragStarted = null;
    this.reaction = { action, started: now };
  }

  tap(head: boolean, now: number): PetAction {
    const action = head ? 'pat' : 'hug';
    this.trigger(action, now);
    return action;
  }

  startDrag(now: number): void {
    if (this.dragStarted !== null) return;
    this.trigger('spin', now);
    this.dragStarted = now;
  }

  endDrag(now: number): void {
    if (this.dragStarted === null) return;
    // 松手后转完当前这一圈，不从头重播，也不突然停在背面。
    const elapsed = Math.max(0, now - this.dragStarted) % DURATIONS.spin;
    this.reaction = { action: 'spin', started: now - elapsed };
    this.dragStarted = null;
  }

  current(now: number): { action: PetAction; elapsed: number; progress: number } | null {
    if (this.dragStarted !== null) {
      const elapsed = Math.max(0, now - this.dragStarted) % DURATIONS.spin;
      return { action: 'spin', elapsed: elapsed / 1000, progress: elapsed / DURATIONS.spin };
    }
    if (!this.reaction) return null;
    const elapsed = Math.max(0, now - this.reaction.started);
    const duration = DURATIONS[this.reaction.action];
    if (elapsed >= duration) {
      this.reaction = null;
      return null;
    }
    return { action: this.reaction.action, elapsed: elapsed / 1000, progress: elapsed / duration };
  }
}
