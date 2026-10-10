/**
 * flow 回放器(design-notes/computer-use-rpa.md §5.3)。
 *
 * 不碰屏幕、不碰 UIA:所有副作用经 RunnerDeps 注入(生产由 run-flow 工具接 computer.ts,单测用假实现)。
 * 失败策略沿用影刀式 onError:每步先重试 retry 次(间隔 retryDelayMs),仍失败则 abort / skip / handoff
 * (默认 retry:1 + handoff,把已完成/失败步和当前屏幕交还模型接手)。
 *
 * 安全约束:
 *   - 元素步骤只按 selector 现场重新定位;selector 失败时,**仅当步骤显式 allowCoordinateFallback:true**
 *     才退回录制坐标。没有 selector 的步骤同理——宁可停下交还模型,也不拿过期坐标盲点;
 *   - TIMEOUT / denied 不重试(与工具层 TIMEOUT 永不重试的契约一致,避免重复烧等待窗口);
 *   - secret 参数的取值不会出现在返回文本里(错误文本里若回显会被打码)。
 */
import type { UiaSelector } from '../runtime/uia-selector.js';
import type { ToolOutcome } from '../tools/types.js';
import {
  DEFAULT_ON_ERROR,
  FLOW_RESERVED_KEYS,
  describeStep,
  renderStep,
  resolveParams,
  type Flow,
  type FlowStep,
} from './flow.js';

/** 一步 computer 调用的结果(ToolOutcome 的子集,便于单测伪造)。 */
export interface StepOutcome {
  status: ToolOutcome['status'];
  code?: string;
  output: string;
  modelAttachments?: ToolOutcome['modelAttachments'];
}

export type RefResolution = { ok: true; ref: string } | { ok: false; error: string };
export type WindowResolution = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export interface RunnerDeps {
  /** 执行一次 computer 调用(参数已是最终形态)。 */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<StepOutcome>;
  /** 把录制的 selector 现场解析成当前 UIA 快照里的 ref。 */
  resolveRef(selector: UiaSelector, signal?: AbortSignal): Promise<RefResolution>;
  /** focus_window:按进程名(+可选标题正则)解析成 computer 能接受的窗口参数({window:'wN'})。 */
  resolveWindow(window: { processName?: string; titleRegex?: string }, signal?: AbortSignal): Promise<WindowResolution>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}

export interface StepRecord {
  /** 1 起。 */
  index: number;
  action: string;
  status: 'ok' | 'skipped' | 'failed';
  attempts: number;
  /** 失败/跳过原因,或"用了坐标回退"之类的提示。 */
  detail?: string;
}

export type FlowRunStatus =
  /** 全部步骤跑完(含被 skip 的)。 */
  | 'completed'
  /** 某步失败且策略为 handoff:交还模型接手。 */
  | 'handoff'
  /** 某步失败且策略为 abort:整体失败。 */
  | 'failed'
  /** 用户中断。 */
  | 'aborted'
  /** 参数不合法,一步都没跑。 */
  | 'rejected';

export interface FlowRunResult {
  status: FlowRunStatus;
  steps: StepRecord[];
  /** 成功执行的步骤数。 */
  completed: number;
  skipped: number;
  /** status 为 handoff/failed 时的失败步(1 起)。 */
  failedStep?: { index: number; description: string; error: string };
  /** rejected 时的原因。 */
  error?: string;
  /** 最近一次带截图的结果,交还模型时让它看到当前屏幕。 */
  attachments?: ToolOutcome['modelAttachments'];
}

/** 低于此长度的 secret 不打码(1-2 个字符会把无关文本也替换花)。 */
const REDACT_MIN_LEN = 3;
const ERROR_CLIP = 400;

/** 步骤里的 computer 参数(去掉 flow 保留键)。 */
function computerArgs(step: FlowStep): Record<string, unknown> {
  const out: Record<string, unknown> = { action: step.action };
  for (const [k, v] of Object.entries(step)) if (!FLOW_RESERVED_KEYS.has(k)) out[k] = v;
  return out;
}

/** selector 失败且显式允许时,把元素步骤改写成按录制坐标执行的动作序列。 */
function coordinateFallbackActions(step: FlowStep): Record<string, unknown>[] {
  const coordinate = step.fallback?.coordinate;
  if (!coordinate) return [];
  if (step.action === 'click_element') {
    const button = step.button;
    const count = step.click_count;
    let action = 'left_click';
    if (button === 'right') action = 'right_click';
    else if (button === 'middle') action = 'middle_click';
    else if (count === 2) action = 'double_click';
    else if (count === 3) action = 'triple_click';
    return [{ action, coordinate }];
  }
  if (step.action === 'set_value') {
    return [
      { action: 'left_click', coordinate },
      { action: 'key', text: 'ctrl+a' },
      { action: 'type', text: typeof step.text === 'string' ? step.text : '' },
    ];
  }
  return [];
}

type Attempt =
  | { ok: true; outcome: StepOutcome; note?: string }
  | { ok: false; error: string; aborted: boolean; retryable: boolean; outcome?: StepOutcome };

function isElementStep(step: FlowStep): boolean {
  return step.action === 'click_element' || step.action === 'set_value';
}

async function attemptStep(step: FlowStep, deps: RunnerDeps): Promise<Attempt> {
  try {
    let argSets: Record<string, unknown>[];
    let note: string | undefined;

    if (isElementStep(step)) {
      const located: RefResolution = step.selector
        ? await deps.resolveRef(step.selector, deps.signal)
        : { ok: false, error: 'this step has no selector' };
      if (located.ok) {
        argSets = [{ ...computerArgs(step), ref: located.ref }];
      } else if (step.allowCoordinateFallback === true && step.fallback) {
        argSets = coordinateFallbackActions(step);
        note = `selector failed (${located.error}); used the recorded coordinates`;
      } else {
        const hint = step.fallback
          ? ' (a recorded coordinate exists, but allowCoordinateFallback is not enabled for this step)'
          : '';
        return {
          ok: false,
          error: `could not locate the element: ${located.error}${hint}`,
          aborted: false,
          retryable: true,
        };
      }
    } else if (step.action === 'focus_window') {
      const win = step.window;
      if (win?.processName) {
        const resolved = await deps.resolveWindow(win, deps.signal);
        if (!resolved.ok) return { ok: false, error: resolved.error, aborted: false, retryable: true };
        argSets = [{ ...computerArgs(step), ...resolved.args }];
      } else if (win?.titleRegex) {
        argSets = [{ ...computerArgs(step), title_regex: win.titleRegex }];
      } else {
        return { ok: false, error: 'focus_window step has no window information', aborted: false, retryable: false };
      }
    } else {
      argSets = [computerArgs(step)];
    }

    let last: StepOutcome | undefined;
    for (const args of argSets) {
      last = await deps.execute(args, deps.signal);
      if (last.status !== 'success') break;
    }
    if (!last) return { ok: false, error: 'nothing to execute for this step', aborted: false, retryable: false };
    if (last.status === 'success') return { ok: true, outcome: last, note };
    return {
      ok: false,
      error: last.output,
      aborted: last.status === 'aborted',
      retryable: last.code !== 'TIMEOUT' && last.status !== 'denied' && last.status !== 'aborted',
      outcome: last,
    };
  } catch (error) {
    const aborted = deps.signal?.aborted === true;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      aborted,
      retryable: !aborted,
    };
  }
}

export async function runFlow(
  flow: Flow,
  given: Record<string, unknown> | undefined,
  deps: RunnerDeps,
): Promise<FlowRunResult> {
  const resolved = resolveParams(flow, given);
  if (!resolved.ok) return { status: 'rejected', steps: [], completed: 0, skipped: 0, error: resolved.error };
  const values = resolved.values;

  const secretValues = Object.entries(flow.params)
    .filter(([, p]) => p.secret)
    .map(([name]) => values[name])
    .filter((v): v is string => typeof v === 'string' && v.length >= REDACT_MIN_LEN);
  const redact = (text: string): string => {
    let out = text;
    for (const s of secretValues) out = out.split(s).join('***');
    return out.length > ERROR_CLIP ? `${out.slice(0, ERROR_CLIP)}…` : out;
  };

  const steps: StepRecord[] = [];
  let completed = 0;
  let skipped = 0;
  let attachments: ToolOutcome['modelAttachments'];

  const finish = (status: FlowRunStatus, failedStep?: FlowRunResult['failedStep'], error?: string): FlowRunResult => ({
    status,
    steps,
    completed,
    skipped,
    ...(failedStep ? { failedStep } : {}),
    ...(error ? { error } : {}),
    ...(attachments ? { attachments } : {}),
  });

  for (let i = 0; i < flow.steps.length; i++) {
    const index = i + 1;
    if (deps.signal?.aborted) return finish('aborted');

    const original = flow.steps[i];
    let step: FlowStep;
    try {
      step = renderStep(original, values);
    } catch (error) {
      return finish('rejected', undefined, error instanceof Error ? error.message : String(error));
    }
    const policy = { ...DEFAULT_ON_ERROR, ...original.onError };
    const maxAttempts = policy.retry + 1;

    let attempts = 0;
    let success: Extract<Attempt, { ok: true }> | undefined;
    let failure: Extract<Attempt, { ok: false }> | undefined;

    while (attempts < maxAttempts) {
      attempts += 1;
      const r = await attemptStep(step, deps);
      if (r.ok) {
        success = r;
        break;
      }
      failure = r;
      if (r.outcome?.modelAttachments?.length) attachments = r.outcome.modelAttachments;
      if (r.aborted) return finish('aborted');
      if (!r.retryable || attempts >= maxAttempts) break;
      try {
        await deps.sleep(policy.retryDelayMs, deps.signal);
      } catch {
        return finish('aborted');
      }
      if (deps.signal?.aborted) return finish('aborted');
    }

    if (success) {
      completed += 1;
      if (success.outcome.modelAttachments?.length) attachments = success.outcome.modelAttachments;
      steps.push({
        index,
        action: original.action,
        status: 'ok',
        attempts,
        ...(success.note ? { detail: redact(success.note) } : {}),
      });
      continue;
    }

    const error = redact(failure?.error ?? 'unknown error');
    if (policy.then === 'skip') {
      skipped += 1;
      steps.push({ index, action: original.action, status: 'skipped', attempts, detail: error });
      continue;
    }
    steps.push({ index, action: original.action, status: 'failed', attempts, detail: error });
    return finish(policy.then === 'abort' ? 'failed' : 'handoff', {
      index,
      description: describeStep(original, index),
      error,
    });
  }

  return finish('completed');
}

/** 面向模型/用户的结果文本。 */
export function formatFlowRunResult(flow: Flow, r: FlowRunResult): string {
  const total = flow.steps.length;
  const skippedLines = r.steps
    .filter((s) => s.status === 'skipped')
    .map((s) => `  - step ${s.index} (${s.action}) skipped: ${s.detail ?? 'failed'}`);
  const noteLines = r.steps
    .filter((s) => s.status === 'ok' && s.detail)
    .map((s) => `  - step ${s.index} (${s.action}): ${s.detail}`);

  switch (r.status) {
    case 'rejected':
      return `Flow "${flow.name}" was not run: ${r.error ?? 'invalid parameters'}`;
    case 'completed': {
      const lines = [
        `Flow "${flow.name}" completed: ${r.completed}/${total} steps ran${r.skipped ? `, ${r.skipped} skipped` : ''}. ` +
          'The attached screenshot (if any) is the final screen; verify the result.',
        ...skippedLines,
        ...noteLines,
      ];
      return lines.join('\n');
    }
    case 'aborted':
      return `Flow "${flow.name}" was interrupted after ${r.completed} of ${total} steps.`;
    case 'failed':
    case 'handoff': {
      const f = r.failedStep;
      const head =
        r.status === 'handoff'
          ? `Flow "${flow.name}" stopped at step ${f?.index}/${total} and is handed back to you.`
          : `Flow "${flow.name}" failed at step ${f?.index}/${total} (onError: abort); no further steps were run.`;
      const lines = [
        head,
        `Step: ${f?.description ?? '(unknown)'}`,
        `Error: ${f?.error ?? 'unknown'}`,
        `Completed before the failure: ${r.completed} step(s)${r.skipped ? `, ${r.skipped} skipped` : ''}.`,
        ...skippedLines,
        ...noteLines,
      ];
      if (r.status === 'handoff') {
        lines.push(
          'The attached screenshot (if any) shows the current screen. Continue the remaining steps manually with computer actions (inspect first), or fix the flow file and run it again.',
        );
      }
      return lines.join('\n');
    }
  }
}
