// 活跃 plan 进程级缓存:单 plan/会话的内存状态 + 变更通知。
//
// 仿 src/agent/mode.ts 形态:零依赖、setter/getter/listener,不反向引用业务。
// todo 工具每次改 plan → 调 setActivePlan(newPlan) → listener 触发(repl 刷 status 行 + history[0])。
// store 仍是文件源(本缓存与之可能短暂不一致——以文件为准,缓存仅供快速读)。

import type { Plan } from './store.js';
import { renderPlanChip } from './store.js';

export interface ActivePlanSnapshot {
  id: string;
  title: string;
  status: Plan['status'];
  done: number;
  total: number;
}

let active: Plan | null = null;

type Listener = (snap: ActivePlanSnapshot | null) => void;
const listeners = new Set<Listener>();

/** 取当前活跃 plan(完整对象,工具用)。无 → null。 */
export function getActivePlan(): Plan | null {
  return active;
}

/** 设活跃 plan。同一 id 重复设也走 listener(repl 借此刷 status 行——即使内容未变,显式刷新有助)。 */
export function setActivePlan(plan: Plan | null): void {
  active = plan;
  const snap = plan ? toSnapshot(plan) : null;
  for (const cb of listeners) {
    try { cb(snap); } catch { /* listener 抛错不阻断其他 listener */ }
  }
}

/** 清活跃 plan(plan finish/abandon 后由 repl/todolist 调)。 */
export function clearActivePlan(): void {
  setActivePlan(null);
}

/** 注册活跃 plan 变更监听器。返注销函数(不常用,模式 listener 一次性常驻)。 */
export function onActivePlanChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 是否有活跃 plan(in_progress 状态)。finished/abandoned 不算「活跃」。 */
export function hasActivePlan(): boolean {
  return active !== null && active.status === 'in_progress';
}

/** 给 status 行用的极简摘要(避免调用方读 Plan 全字段)。无 → 空串。 */
/** 状态行 chip 用的短摘要(无 ANSI 颜色,由 layout 上色)。maxWidth 默认 56,留 room 给右段。 */
export function getActivePlanSummary(maxWidth: number = 56): string {
  return renderPlanChip(active, maxWidth);
}

function toSnapshot(p: Plan): ActivePlanSnapshot {
  const done = p.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { id: p.id, title: p.title, status: p.status, done, total: p.steps.length };
}
