/**
 * plan_update 入参 → 计划进度快照（纯函数，无 node 依赖）。
 *
 * 为什么单独成模块：这份解析有两个消费方，且它们跑在不同进程/环境里 ——
 *   · 主进程（main.ts）把 n/m 写进侧栏任务行；
 *   · 渲染层（renderer.ts）画会话区顶部的计划面板。
 * 两边各写一份解析必然走样（tool 的 normalizeArguments 已经踩过这个坑：模型爱用
 * label/text/doing 这类变体），所以归一化规则只在这里定义一次。
 *
 * 两种输入都要吃：
 *   · tool_started 的 args 是**模型原始入参**（尚未过 tool 的 normalizeArguments）；
 *   · 会话历史里回放的 args 也可能是这些变体。
 * 因此这里按 plan_update 的 normalizeArguments 同一套别名表做宽容解析，
 * 解析不出来就返回 null —— 宁可面板不出现，也不能显示错的计划。
 */

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStepView {
  title: string;
  content: string;
  status: PlanStepStatus;
  activeForm?: string;
}

export interface PlanSnapshot {
  title: string;
  goal?: string;
  steps: PlanStepView[];
  done: number;
  total: number;
  /** 当前进行中的步骤（无 in_progress 时取第一个未完成步骤）。 */
  current?: PlanStepView;
  /** 面板一行用的当前步短文案。 */
  currentLabel?: string;
  allDone: boolean;
  /** 内容指纹（含状态）：用于判断面板是否需要重绘。 */
  signature: string;
  /**
   * 计划身份（不含状态）：标题 + 各步标题。
   * 用于「用户手动关掉后，同一条计划的进度更新不要把它再弹出来」——
   * 而换了一份新计划（标题或步骤集合变了）就该重新出现。
   */
  identity: string;
}

const PENDING_WORDS = ['pending', 'todo', 'to-do', 'open', 'not_started', 'not-started'];
const ACTIVE_WORDS = ['in_progress', 'in-progress', 'inprogress', 'doing', 'current', 'active', 'wip'];
const DONE_WORDS = ['completed', 'complete', 'done', 'finished', 'checked'];

/** 状态别名归一化（与 src/tools/builtins/plan-update.ts 的 normalizeStatus 保持一致）。 */
export function normalizePlanStatus(raw: unknown): PlanStepStatus {
  const value = String(raw ?? 'pending').trim().toLowerCase();
  if (ACTIVE_WORDS.includes(value)) return 'in_progress';
  if (DONE_WORDS.includes(value)) return 'completed';
  if (PENDING_WORDS.includes(value)) return 'pending';
  return 'pending';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从模型入参里挑第一个非空字符串（按别名优先顺序）。 */
function pick(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return '';
}

const TITLE_KEYS = ['title', 'label', 'heading', 'step_title', 'short_title'] as const;
const CONTENT_KEYS = ['content', 'text', 'task', 'description'] as const;

function parseSteps(raw: unknown): PlanStepView[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStepView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const step = entry as Record<string, unknown>;
    const content = pick(step, CONTENT_KEYS) || pick(step, TITLE_KEYS);
    if (!content) continue;
    const title = pick(step, TITLE_KEYS);
    const activeForm = pick(step, ['active_form', 'activeForm']);
    steps.push({
      // 短标签缺失时用正文首句，面板才有东西可显示；正文本身仍然完整保留。
      title: title || content.split(/[。；;.\n]/)[0]!.slice(0, 60),
      content,
      status: normalizePlanStatus(step.status),
      ...(activeForm ? { activeForm } : {}),
    });
  }
  return steps;
}

/**
 * 解析 plan_update 的 arguments。接受 JSON 字符串（事件里的原样入参）或已解析的对象。
 * 无有效 steps 时返回 null —— 工具本身会以「steps 不能为空」失败，面板不该显示半份计划。
 */
export function parsePlan(raw: unknown): PlanSnapshot | null {
  let args: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    args = raw as Record<string, unknown>;
  }
  if (!args) return null;

  const steps = parseSteps(args.steps);
  if (!steps.length) return null;
  const title = pick(args, ['title', 'name', 'goal']) || steps[0]!.title;
  const goal = text(args.goal);
  const done = steps.filter((step) => step.status === 'completed').length;
  const current = steps.find((step) => step.status === 'in_progress') ?? steps.find((step) => step.status !== 'completed');
  const allDone = done === steps.length;
  const currentLabel = allDone
    ? undefined
    : (current?.activeForm || current?.title || current?.content.split('\n')[0] || undefined);
  return {
    title,
    ...(goal ? { goal } : {}),
    steps,
    done,
    total: steps.length,
    ...(current && !allDone ? { current } : {}),
    ...(currentLabel ? { currentLabel } : {}),
    allDone,
    signature: [title, ...steps.map((step) => `${step.status}:${step.title}:${step.content.slice(0, 120)}`)].join('|'),
    identity: [title, ...steps.map((step) => `${step.title}:${step.content.slice(0, 120)}`)].join('|'),
  };
}