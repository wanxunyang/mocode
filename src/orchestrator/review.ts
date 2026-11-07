// 收工判定（Supervisor review）：队列跑空时问一次模型「这一趟活是否真的干完了」。
//
// 为什么需要它：确定性调度器只能看到「所有任务都 completed」，看不到「用户的原始目标是否被满足」。
// 一个任务可能合法地 completed 却漏了验收标准里的一半。这里把每个 handoff 的摘要、改动文件、
// 已跑检查、未跑检查、验收标准摊平给模型，让它给 done / continue 的建议。
//
// 它只是**建议**：判定不改变 Run 状态，也不自动关闭 lane。收工仍由用户（或 autoClose）决定。

import { chat, type ChatMessage } from '../llm/index.js';
import type { OrchestrationRun, RunReview, TaskHandoff } from './types.js';

const REVIEW_TIMEOUT_MS = 90_000;

function describeTask(task: OrchestrationRun['tasks'][string]): string {
  const handoff: TaskHandoff | undefined = task.output;
  const lines = [`- ${task.id} [${task.status}] ${task.title}`, `  objective: ${task.contract.objective}`];
  if (task.contract.acceptanceCriteria.length > 0) {
    lines.push(`  acceptance: ${task.contract.acceptanceCriteria.join(' | ')}`);
  }
  if (handoff) {
    lines.push(`  handoff: ${handoff.summary.trim() || '(empty)'}`);
    lines.push(`  changed: ${handoff.changedFiles.length > 0 ? handoff.changedFiles.join(', ') : '(none)'}`);
    if (handoff.validation.length > 0) {
      lines.push(`  checks: ${handoff.validation.map((item) => `${item.command}=${item.status}`).join(', ')}`);
    }
    if (handoff.risks.length > 0) lines.push(`  risks: ${handoff.risks.join(' | ')}`);
  } else if (task.error) {
    lines.push(`  error: ${task.error}`);
  }
  if (task.lastEvent) lines.push(`  last event: ${task.lastEvent}`);
  return lines.join('\n');
}

/** 把一次 Run 摊成给模型的判定材料；导出便于测试与 `supervise review --dry-run`。 */
export function buildReviewPrompt(run: OrchestrationRun): string {
  const lanes = Object.values(run.lanes).map(
    (lane) =>
      `- ${lane.id} (${lane.mode}) ${lane.workspaceRoot}${lane.closed ? ` [closed: ${lane.closed.reason}]` : ''}`,
  );
  return [
    `Run objective: ${run.objective}`,
    '',
    'Lanes:',
    ...(lanes.length > 0 ? lanes : ['- (none)']),
    '',
    'Tasks:',
    ...Object.values(run.tasks).map(describeTask),
  ].join('\n');
}

const REVIEW_INSTRUCTION = [
  'You are a supervisor deciding whether an orchestration run has finished its work.',
  'Read the run objective, the lanes, and every task handoff below.',
  'Judge only from the evidence shown. Do not assume work happened if it is not reported.',
  'Reply with ONE JSON object and nothing else:',
  '{"verdict":"done"|"continue","rationale":"one or two sentences","remaining":["concrete follow-up tasks"]}',
  'Use "done" only when the objective is covered by the reported work; "continue" when work is missing or unverified.',
  '"remaining" must be empty when verdict is "done".',
].join('\n');

function parseReview(
  content: string | null,
  raw: string | null,
): { verdict: RunReview['verdict']; rationale: string; remaining: string[] } | null {
  const source = content ?? raw;
  if (!source) return null;
  const text = source.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      verdict?: unknown;
      rationale?: unknown;
      remaining?: unknown;
    };
    const verdict = parsed.verdict === 'done' || parsed.verdict === 'continue' ? parsed.verdict : 'unknown';
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
    const remaining = Array.isArray(parsed.remaining)
      ? parsed.remaining.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [];
    return { verdict, rationale, remaining };
  } catch {
    return null;
  }
}

export interface ReviewOptions {
  /** 关闭模型调用，只产出判定材料（CLI `review --dry-run`）。 */
  dryRun?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 跑一次收工判定。任何失败都收敛成 `verdict: unknown` + error，绝不抛错——
 * 判定失败不该让一个已经跑完的 Run 变成失败。
 */
export async function reviewRun(run: OrchestrationRun, options: ReviewOptions = {}): Promise<RunReview> {
  const createdAt = new Date().toISOString();
  if (options.dryRun) {
    return { verdict: 'unknown', rationale: buildReviewPrompt(run), remaining: [], createdAt };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REVIEW_TIMEOUT_MS);
  // 不依赖 AbortSignal.any（Node 20.3+）：外部取消手动转发到自己的 controller。
  const forward = (): void => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: REVIEW_INSTRUCTION },
      { role: 'user', content: buildReviewPrompt(run) },
    ];
    const result = await chat(messages, {}, controller.signal, undefined, {
      reasoningEffort: 'low',
      maxAttempts: 2,
    });
    const parsed = parseReview(result.content, null);
    if (!parsed) {
      return {
        verdict: 'unknown',
        rationale: '',
        remaining: [],
        createdAt,
        error: 'Reviewer returned no parsable JSON.',
      };
    }
    return { ...parsed, createdAt };
  } catch (error) {
    return {
      verdict: 'unknown',
      rationale: '',
      remaining: [],
      createdAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forward);
  }
}

/** 是否值得为这一趟 Run 再跑一次判定：已经判定过、且没有新完成的活时跳过。 */
export function needsReview(run: OrchestrationRun): boolean {
  if (!run.lastReview) return true;
  // 没有任务带 finishedAt（还没跑完任何活）时没有新证据，不必重判。
  const newest = Object.values(run.tasks)
    .map((task) => task.finishedAt ?? '')
    .sort()
    .at(-1);
  return (newest ?? '') > run.lastReview.createdAt;
}
