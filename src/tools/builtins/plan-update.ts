import type { Tool, ToolOutcome } from '../types.js';
import {
  PLAN_MAX_STEPS,
  readActivePlanTitle,
  renderPlanSection,
  writePlanToNotes,
  type PlanState,
  type PlanStep,
  type PlanStepStatus,
} from '../../session/notes.js';

const VALID_STATUSES: readonly PlanStepStatus[] = ['pending', 'in_progress', 'completed'];

function err(message: string): ToolOutcome {
  return { status: 'error', code: 'INVALID_ARGUMENTS', retryable: false, output: `错误:${message}` };
}

/** 归一化模型常见的 status 变体,降低调用摩擦(无损兼容,不补造业务值)。 */
function normalizeStatus(raw: unknown): string {
  const s = String(raw ?? 'pending')
    .trim()
    .toLowerCase();
  if (['in_progress', 'in-progress', 'inprogress', 'doing', 'current', 'active', 'wip'].includes(s))
    return 'in_progress';
  if (['completed', 'complete', 'done', 'finished', 'checked'].includes(s)) return 'completed';
  if (['pending', 'todo', 'to-do', 'open', 'not_started', 'not-started'].includes(s)) return 'pending';
  return s;
}

export const planUpdateTool: Tool = {
  name: 'plan_update',
  description:
    'Record and update the session execution plan (the `## Plan:` block in `.mocode/sessions/<id>/notes.md`). ' +
    'Use for any task with 3+ steps or context-loss risk. This REPLACES the whole plan each call, so always pass the full steps array. ' +
    'Rules: at most one step may be in_progress; mark a step completed as soon as its work is done — do not batch updates to end of turn. ' +
    'Give every step a short `title` (≤20 chars, e.g. "编写测试" / "修 status bar") that shows in the status bar, ' +
    'plus a `content` that is self-contained enough to survive context compaction: name the target file/symbol, the change, and how to verify. ' +
    'When every step is completed the plan auto-settles to `## Done:`. Creates notes.md if missing. Safe to call in PLAN mode (writes only the session notepad, never project files).',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Plan title. Required when creating a plan; omit on update to keep the current title.',
      },
      goal: {
        type: 'string',
        description: 'One-line outcome / definition of done (optional).',
      },
      steps: {
        type: 'array',
        description:
          `Full replacement step list (1-${PLAN_MAX_STEPS}). At most one step may be in_progress. ` +
          'Each step should carry both a short `title` and a detailed `content`.',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description:
                'Short scannable label (≤20 chars) shown in the status bar, e.g. "编写测试" / "修 status bar". Keep details in `content`.',
            },
            content: {
              type: 'string',
              description: 'Self-contained step: target file/symbol, the change, and how to verify it.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'pending | in_progress | completed',
            },
            active_form: {
              type: 'string',
              description: 'Optional present-continuous label shown while in_progress (e.g. "Rewriting parser").',
            },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
  // 兼容模型的字段命名偏差:activeForm→active_form;step 用 text/task/description 代替 content;
  // step 短标签用 label/heading/step_title/short_title 代替 title(必须 delete 原字段,
  // 否则 items.additionalProperties=false 会在随后的 schema 校验里拒收)。
  normalizeArguments(args) {
    if (args.activeForm !== undefined && args.active_form === undefined) {
      args.active_form = args.activeForm;
      delete args.activeForm;
    }
    if (Array.isArray(args.steps)) {
      for (const s of args.steps) {
        if (!s || typeof s !== 'object') continue;
        const step = s as Record<string, unknown>;
        if (step.title === undefined) {
          for (const alt of ['label', 'heading', 'step_title', 'short_title']) {
            if (typeof step[alt] === 'string') {
              step.title = step[alt];
              delete step[alt];
              break;
            }
          }
        }
        if (step.content === undefined) {
          for (const alt of ['text', 'task', 'description', 'title']) {
            if (typeof step[alt] === 'string') {
              step.content = step[alt];
              // content 由 title 兜底填补时,不再把它当短标签——否则会渲染成 `**A** — A`。
              if (alt === 'title') step.title = undefined;
              break;
            }
          }
        }
        if (step.activeForm !== undefined && step.active_form === undefined) {
          step.active_form = step.activeForm;
          delete step.activeForm;
        }
        if (step.status !== undefined) step.status = normalizeStatus(step.status);
      }
    }
  },
  async execute(args): Promise<ToolOutcome> {
    const rawSteps = Array.isArray(args.steps) ? args.steps : null;
    if (!rawSteps || rawSteps.length === 0) return err('steps 不能为空(至少 1 步)。');
    if (rawSteps.length > PLAN_MAX_STEPS)
      return err(`steps 最多 ${PLAN_MAX_STEPS} 条,当前 ${rawSteps.length} 条——请合并或拆分阶段。`);

    const steps: PlanStep[] = [];
    let inProgressCount = 0;
    for (let i = 0; i < rawSteps.length; i++) {
      const raw = rawSteps[i] as Record<string, unknown> | null;
      const content = String(raw?.content ?? '').trim();
      if (!content) return err(`第 ${i + 1} 步 content 为空。`);
      const status = normalizeStatus(raw?.status) as PlanStepStatus;
      if (!VALID_STATUSES.includes(status)) {
        return err(`第 ${i + 1} 步 status 非法:"${String(raw?.status)}"(仅 pending/in_progress/completed)。`);
      }
      if (status === 'in_progress') inProgressCount++;
      const activeForm =
        typeof raw?.active_form === 'string' && raw.active_form.trim() ? raw.active_form.trim() : undefined;
      const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined;
      steps.push({
        ...(title ? { title } : {}),
        content,
        status,
        ...(activeForm ? { activeForm } : {}),
      });
    }
    if (inProgressCount > 1) {
      return err(`同一时刻只能有一个 in_progress 步骤,当前 ${inProgressCount} 个——请把其余改回 pending。`);
    }

    // title:新建必填;更新时缺省则沿用当前活跃 plan 的标题。
    let title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) {
      const existing = readActivePlanTitle();
      if (!existing) return err('新建 plan 需要提供 title(更新已有 plan 时可省略)。');
      title = existing;
    }
    const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined;

    const plan: PlanState = { title, ...(goal ? { goal } : {}), steps };
    const result = writePlanToNotes(plan);
    if ('error' in result) {
      return {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        output: `错误:写入 notes.md 失败: ${result.error}`,
      };
    }

    const done = steps.filter((s) => s.status === 'completed').length;
    const rendered = renderPlanSection(plan);
    const settledNote = result.settled ? '已全部完成,自动结算为 `## Done:`。' : '';
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      // plan_update 写内部 notes.md,不作为用户代码 mutation 上报 changedFiles。
      output: `已更新执行计划 "${title}"(${done}/${steps.length} 完成)${settledNote}\n\n${rendered}`,
    };
  },
};
