// 活跃 plan 的进程级状态(共享叶子)。
//
// 职责:
//  - 跟踪「当前会话的活跃 plan」——单 plan/会话(state 缓存,store 是文件源)。
//  - 暴露 onActivePlanChange listener(repl 借此刷 status 行 + history[0])。
//
// 与 mode.ts 同形态:零依赖、不落盘、不反向引用业务;被 plan/、tools/builtins/todolist.ts、repl 依赖。
//
// 不在子 agent 持久化(子 agent 走 spawn,独立 history,不该继承主 plan——但 plan 文件本身在 sandboxRoot
// 下,子 agent 仍能 readPlan 看到全部历史 plan;state 缓存不传,只属于主 agent)。

import { getActivePlan, setActivePlan as setStoreActivePlan, getActivePlanSummary } from './active.js';

export type { ActivePlanSnapshot } from './active.js';
export {
  getActivePlan,
  setActivePlan,
  clearActivePlan,
  onActivePlanChange,
  hasActivePlan,
  getActivePlanSummary,
} from './active.js';
