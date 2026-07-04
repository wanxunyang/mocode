// plan 子系统 barrel:
//  - store:文件级 CRUD(markdown 解析/序列化,落盘原子)
//  - active:进程级活跃 plan 缓存 + 变更通知(单 plan/会话)
//  - buildActivePlanSection:给 systemPrompt 用的活跃 plan 摘要段
//
// 被 repl 依赖(注入 systemPrompt + 状态行 + listener 注册)+ tools/builtins/todolist 依赖。

export {
  // types
  type Plan,
  type PlanStep,
  type PlanStatus,
  type StepStatus,
  // store
  plansDir,
  archiveDir,
  planPath,
  ensurePlansDir,
  ensureArchiveDir,
  newPlanId,
  parsePlan,
  serializePlan,
  readPlan,
  writePlan,
  deletePlan,
  deletePlanAnywhere,
  updatePlan,
  listPlans,
  archivePlan,
  unarchivePlan,
  renderPlanForLLM,
  renderPlanChip,
} from './store.js';

export {
  type ActivePlanSnapshot,
  getActivePlan,
  setActivePlan,
  clearActivePlan,
  onActivePlanChange,
  hasActivePlan,
  getActivePlanSummary,
} from './active.js';

import type { Plan } from './store.js';
import { getActivePlan } from './active.js';
import { renderPlanForLLM } from './store.js';

const ACTIVE_PLAN_HEADER = '## 当前活跃计划';

/**
 * 拼给 systemPrompt 注入的活跃 plan 摘要段。
 *  - 无活跃 plan → 空串(repl 直接跳过拼接,systemPrompt 长度不变)。
 *  - 有 → 紧凑 markdown(目标 + 步骤 checkbox + 进度日志末 5 条),header + 内容。
 *
 * 触发:setActivePlan 后由 repl listener 调;也供 buildSystemMessage 直接同步取(repl 入口)。
 * 上限:超 MAX_ACTIVE_PLAN_CHARS 截到尾部(罕见,plan 文件本身就小)。
 */
export function buildActivePlanSection(): string {
  const p = getActivePlan();
  if (!p) return '';
  const body = renderPlanForLLM(p);
  const full = `${ACTIVE_PLAN_HEADER}\n${body}`;
  if (full.length <= MAX_ACTIVE_PLAN_CHARS) return full;
  return full.slice(0, MAX_ACTIVE_PLAN_CHARS) + '\n…(plan 摘要已截断)';
}

/** 注入 systemPrompt 的活跃 plan 摘要上限(字符)。 */
export const MAX_ACTIVE_PLAN_CHARS = 3000;
