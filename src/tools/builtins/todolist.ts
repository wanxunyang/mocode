// todolist 工具:LLM 的「工作记事本」——把隐式思考外化为持久 checklist,抗压缩、可视化。
//
// 落地:plan/store.ts(文件源)+ plan/active.ts(进程级活跃缓存)+ 本工具(写盘 + 通知 listener)。
//
// 契约对齐「调度器永不抛错、永远返回字符串」(tools/registry.ts executeTool)。
// 单 plan/会话:create 前若有 in_progress 活跃 plan → 拒绝(避免误覆盖);finish/abandoned 后可再建。
//
// 工具返回:把当前 plan 紧凑渲染给 LLM(不只返操作结果——让 LLM 单次调用后看到完整状态,无需再 read)。

import type { Tool } from '../types.js';
import {
  newPlanId,
  readPlan,
  writePlan,
  updatePlan,
  listPlans,
  archivePlan,
  unarchivePlan,
  deletePlanAnywhere,
  renderPlanForLLM,
  localIsoTimestamp,
  type Plan,
  type StepStatus,
  type PlanStatus,
} from '../../plan/store.js';
import { getActivePlan, setActivePlan, hasActivePlan, clearActivePlan } from '../../plan/active.js';
import { MAX_OUTPUT } from '../constants.js';

const VALID_STATUS: ReadonlySet<StepStatus> = new Set([
  'pending', 'in_progress', 'done', 'skipped', 'failed',
]);
const VALID_PLAN_STATUS: ReadonlySet<PlanStatus> = new Set([
  'in_progress', 'finished', 'abandoned',
]);

// ── 工具定义 ──

export const todolistTool: Tool = {
  name: 'todolist',
  description: [
    'Maintain a working "notepad" plan in .mocode/plans/<id>.md (file-based, survives context compression).',
    'For complex multi-step tasks (≥3 file changes or ≥5 tool calls expected, OR user says "先计划再执行" / "plan then do"), CALL THIS FIRST to write the plan, then update each step as you go.',
    'For simple single-step tasks, skip it and just execute.',
    'Single plan per session: create refuses if an in-progress plan already exists — finish or abandon it first.',
    'Lifecycle: finish AUTO-ARCHIVES the plan to .mocode/plans/archive/ (history preserved, active dir stays clean). To revisit, call list with scope=archived or unarchive. Use delete to permanently remove a plan (any location).',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'read', 'update', 'add_step', 'finish', 'list', 'delete', 'unarchive'],
        description: 'create=新计划;read=读当前活跃;update=改步骤状态;add_step=追加步骤;finish=收尾(自动归档);list=列计划;delete=永久删除;unarchive=从归档还原到活跃',
      },
      title: { type: 'string', description: 'create 必填:计划标题' },
      goal: { type: 'string', description: 'create 可选:目标描述(写进「目标」段)' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'create 必填:步骤标题数组(从 1 起自动编号)',
      },
      step_id: {
        type: 'number',
        description: 'update 必填:步骤编号(1-based;create 后 read 返回的 id)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done', 'skipped', 'failed'],
        description: 'update 必填:目标状态',
      },
      note: {
        type: 'string',
        description: 'update / finish 可选:追加到进度日志的一行说明(可空)',
      },
      plan_status: {
        type: 'string',
        enum: ['finished', 'abandoned'],
        description: 'finish 必填:finished=完成;abandoned=放弃(中途取消)。finished 触发自动归档。',
      },
      scope: {
        type: 'string',
        enum: ['active', 'archived', 'all'],
        description: 'list 可选:范围(active=默认,仅进行中;archived=仅归档;all=全)。',
      },
      id: {
        type: 'string',
        description: 'delete / unarchive 必填:目标 plan id(list 可拿到)。',
      },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action ?? '');
    try {
      switch (action) {
        case 'create':     return doCreate(args);
        case 'read':       return doRead();
        case 'update':     return doUpdate(args);
        case 'add_step':   return doAddStep(args);
        case 'finish':     return doFinish(args);
        case 'list':       return doList(args);
        case 'delete':     return doDelete(args);
        case 'unarchive':  return doUnarchive(args);
        default:
          return `错误:未知 action「${action}」,合法值:create / read / update / add_step / finish / list / delete / unarchive。`;
      }
    } catch (e) {
      // 兜底:工具内部不抛,但防御性 catch 一道(契约对齐「永不抛」)。
      const why = e instanceof Error ? e.message : String(e);
      return `错误:todolist 内部异常: ${why}`;
    }
  },
};

// ── actions ──

function doCreate(args: Record<string, unknown>): string {
  const title = String(args.title ?? '').trim();
  if (!title) return '错误:create 必填 title。';
  const goal = String(args.goal ?? '').trim();
  const rawSteps = Array.isArray(args.steps) ? args.steps : null;
  if (!rawSteps || rawSteps.length === 0) return '错误:create 必填 steps(非空字符串数组)。';
  const steps = rawSteps
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 0);
  if (steps.length === 0) return '错误:create 的 steps 全是空字符串。';

  if (hasActivePlan()) {
    const cur = getActivePlan();
    return `错误:已存在进行中的 plan「${cur?.title ?? ''}」(id=${cur?.id ?? ''}),需先 finish 后再建。`;
  }

  // 旧 plan 残留(finished/abandoned)→ 允许新建,不删历史(用户可后续 read 历史 plan)
  const now = localIsoTimestamp();
  const plan: Plan = {
    id: newPlanId(),
    title,
    status: 'in_progress',
    created: now,
    updated: now,
    goal,
    steps: steps.map((t, i) => ({ id: i + 1, title: t, status: 'pending' })),
    log: [{ at: now, text: `创建计划: ${steps.length} 步` }],
  };
  if (!writePlan(plan)) return '错误:写 plan 文件失败(检查 .mocode/plans 目录权限)。';
  setActivePlan(plan);
  return renderSuccess('create', plan);
}

function doRead(): string {
  const cur = getActivePlan();
  if (!cur) {
    // 兜底:state 缓存空但文件可能存在(sandboxRoot 切了 / 进程重启)→ 列 plans 找一个最新的 in_progress
    const fallback = findInProgressFromDisk();
    if (fallback) {
      setActivePlan(fallback);
      return renderSuccess('read', fallback);
    }
    return '错误:无活跃 plan。先用 action=create 开一个。';
  }
  // 重新读盘以保最新(其他路径可能改了文件)
  const fresh = readPlan(cur.id);
  if (fresh) setActivePlan(fresh);
  return renderSuccess('read', fresh ?? cur);
}

function doUpdate(args: Record<string, unknown>): string {
  const cur = getActivePlan();
  if (!cur) return '错误:无活跃 plan 可 update。先 create。';
  const stepId = Number(args.step_id);
  if (!Number.isFinite(stepId) || stepId < 1) {
    return `错误:update 必填 step_id(>=1 的整数),收到「${args.step_id}」。`;
  }
  const status = String(args.status ?? '') as StepStatus;
  if (!VALID_STATUS.has(status)) {
    return `错误:update 的 status 非法「${status}」,合法:pending / in_progress / done / skipped / failed。`;
  }
  const note = String(args.note ?? '').trim();

  const updated = updatePlan(cur.id, (p) => {
    const step = p.steps.find((s) => s.id === stepId);
    if (!step) return false; // 无改动,工具返错
    step.status = status;
    const at = new Date().toISOString();
    const logText = note || `step ${stepId} → ${status}`;
    p.log.push({ at, text: logText });
    return p;
  });
  if (!updated) {
    return `错误:update 失败(找不到 step_id=${stepId},可能 plan 已不存在或 step 编号越界)。`;
  }
  // step 不存在(updatePlan 内 mutator 返 false → updatePlan 返原对象,需二次校验)
  if (!updated.steps.some((s) => s.id === stepId)) {
    return `错误:找不到 step_id=${stepId}(plan 共 ${updated.steps.length} 步)。`;
  }
  setActivePlan(updated);
  return renderSuccess('update', updated);
}

function doAddStep(args: Record<string, unknown>): string {
  const cur = getActivePlan();
  if (!cur) return '错误:无活跃 plan 可 add_step。先 create。';
  const text = String(args.title ?? args.note ?? '').trim();
  if (!text) return '错误:add_step 必填 title(单条步骤标题)。';

  const updated = updatePlan(cur.id, (p) => {
    const nextId = p.steps.length > 0 ? Math.max(...p.steps.map((s) => s.id)) + 1 : 1;
    p.steps.push({ id: nextId, title: text, status: 'pending' });
    p.log.push({ at: new Date().toISOString(), text: `add step: ${text}` });
    return p;
  });
  if (!updated) return '错误:add_step 写盘失败。';
  setActivePlan(updated);
  return renderSuccess('add_step', updated);
}

function doFinish(args: Record<string, unknown>): string {
  const cur = getActivePlan();
  if (!cur) return '错误:无活跃 plan 可 finish。';
  const ps = String(args.plan_status ?? 'finished') as PlanStatus;
  if (!VALID_PLAN_STATUS.has(ps)) {
    return `错误:finish 的 plan_status 非法「${ps}」,合法:finished / abandoned。`;
  }
  const note = String(args.note ?? '').trim();

  const updated = updatePlan(cur.id, (p) => {
    p.status = ps;
    p.log.push({
      at: localIsoTimestamp(),
      text: note || (ps === 'finished' ? '完成' : '放弃'),
    });
    return p;
  });
  if (!updated) return '错误:finish 写盘失败。';
  setActivePlan(updated);

  // finished → 自动归档到 plans/archive/(历史完整保留,活跃目录保持干净)。
  //   abandoned → 不归档(用户想丢就丢,但仍在 plans/ 下,可显式 delete 删掉)。
  let archived = false;
  if (ps === 'finished') {
    archived = archivePlan(updated.id);
  }
  // finish 后清活跃缓存(下轮 read 自动从 in_progress 列表兜底,本会话不再「活跃」)
  clearActivePlan();
  const archivedNote = ps === 'finished'
    ? (archived ? '(已自动归档到 plans/archive/)' : '(⚠ 归档失败,plan 仍留在 plans/,可手动 list 排查)')
    : '';
  return `${renderSuccess('finish', updated)}\n${archivedNote}`.trimEnd();
}

function doList(args: Record<string, unknown>): string {
  const scopeRaw = String(args.scope ?? 'active');
  const scope: 'active' | 'archived' | 'all' =
    scopeRaw === 'archived' || scopeRaw === 'all' ? scopeRaw : 'active';
  const plans = listPlans(scope);
  if (plans.length === 0) {
    return `list: 无 ${scope === 'active' ? '进行中' : scope === 'archived' ? '已归档' : ''}plan。`;
  }
  // 一行一条:id | status | 标题 | 进度
  const lines = [`list (${scope},${plans.length} 条):`];
  for (const p of plans) {
    const done = p.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    const status = p.status === 'in_progress' ? 'live' : p.status === 'finished' ? 'done' : 'gone';
    lines.push(`  ${p.id}  [${status}]  ${p.title}  (${done}/${p.steps.length})`);
  }
  return lines.join('\n');
}

function doDelete(args: Record<string, unknown>): string {
  const id = String(args.id ?? '').trim();
  if (!id) return '错误:delete 必填 id(从 list 拿)。';
  // 安全护栏:active 状态下不能直接 delete 当前活跃(避免误删正在用的 plan)
  const cur = getActivePlan();
  if (cur && cur.id === id) {
    return `错误:不能 delete 当前活跃 plan「${cur.title}」,需先 finish(自动归档)再 delete 归档副本。`;
  }
  const ok = deletePlanAnywhere(id);
  if (!ok) return `错误:delete 失败,id「${id}」在 plans/ 和 plans/archive/ 都找不到。`;
  return `delete ✓: 已永久删除「${id}」(.mocode/plans/ 与 archive/ 都不再存在)。`;
}

function doUnarchive(args: Record<string, unknown>): string {
  const id = String(args.id ?? '').trim();
  if (!id) return '错误:unarchive 必填 id(从 list scope=archived 拿)。';
  if (!unarchivePlan(id)) {
    return `错误:unarchive 失败,id「${id}」在 plans/archive/ 找不到(可能已还原,或被 delete)。`;
  }
  // 还原后读一次拿回 plan 对象(若 status=in_progress 还可顺手恢复为活跃)
  const fresh = readPlan(id);
  if (!fresh) return `unarchive ✓: 「${id}」已还原到 plans/(读取失败,但文件在)。`;
  if (fresh.status === 'in_progress') {
    setActivePlan(fresh);
    return `${renderSuccess('unarchive', fresh)}\n(已自动设为活跃)。`.trimEnd();
  }
  return `${renderSuccess('unarchive', fresh)}\n(注:该 plan 状态为 ${fresh.status},未自动激活 —— 显式 create 才激活)`;
}

// ── helpers ──

/** 从盘上找一个 in_progress plan(进程级 state 丢失/首次访问时兜底)。无 → null。 */
function findInProgressFromDisk(): Plan | null {
  const all = listPlans();
  return all.find((p) => p.status === 'in_progress') ?? null;
}

/** 工具结果统一格式:`<action>: <一行摘要>\n\n<完整 plan 渲染>`。
 *  超 MAX_OUTPUT 截 plan 渲染尾部(罕见;plan 文件本身就小)。 */
function renderSuccess(action: string, p: Plan): string {
  const done = p.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const head = `${action} ✓: 「${p.title}」 进度 ${done}/${p.steps.length} (status=${p.status})`;
  const body = renderPlanForLLM(p);
  const full = `${head}\n\n${body}`;
  if (full.length <= MAX_OUTPUT) return full;
  return full.slice(0, MAX_OUTPUT) + `\n\n…(plan 渲染已截断 ${full.length - MAX_OUTPUT} 字符)`;
}
