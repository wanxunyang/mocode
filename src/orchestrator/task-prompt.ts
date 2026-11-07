// 派给 worker 的任务提示词，以及从回答里回收机器可读交接块。
//
// 两个执行器共用这一份，只有一处差异：**能不能问人**。
//   - headless（`HostWorkerExecutor`）：没有人在看那根管道，`ask_human` 被禁用，遇事只能报风险；
//   - 可视 lane（`LaneReplExecutor`）：那就是一个真 mocode REPL，人就在屏幕前，`ask_human` 正常可用。
// 这个差异用 `interactive` 一个开关表达，避免两份提示词各自漂移。

import type { TaskValidation, WorkerTaskRequest } from './types.js';

function dependencyContext(request: WorkerTaskRequest): string {
  const items = request.task.dependsOn.flatMap((id) => {
    const dependency = request.run.tasks[id];
    if (!dependency?.output) return [];
    return [
      {
        taskId: id,
        summary: dependency.output.summary,
        changedFiles: dependency.output.changedFiles,
        artifacts: dependency.output.artifacts,
        risks: dependency.output.risks,
      },
    ];
  });
  return items.length > 0 ? JSON.stringify(items, null, 2) : 'No upstream task handoffs.';
}

export interface TaskPromptOptions {
  /** true = 这个 worker 跑在可见终端里，人可以回答它。 */
  interactive?: boolean;
}

export function taskPrompt(request: WorkerTaskRequest, options: TaskPromptOptions = {}): string {
  const { run, task, attempt, lane } = request;
  const mode = lane?.mode ?? 'worktree';
  const continued = lane?.sessionId
    ? `\nYou are continuing an existing session in this lane (task ${task.id}, attempt ${attempt}). Earlier work in this lane is already on disk — inspect it before redoing anything.`
    : '';
  const workspaceNote =
    mode === 'worktree'
      ? 'You are a complete mocode agent in a git worktree (the lane workspace) created from HEAD: uncommitted changes from the main workspace are intentionally absent, so read the code before assuming.'
      : mode === 'copy'
        ? 'You are a complete mocode agent in an isolated copy of a non-git workspace (the lane workspace). Your writes land in the copy only; the original directory is untouched and the operator reviews a diff afterwards.'
        : 'You are a complete mocode agent running directly inside the workspace, in place. Every file you write takes effect immediately for the user: prefer additive, reversible edits and never delete or bulk-rewrite files without evidence.';
  const humanNote = options.interactive
    ? 'The operator can see this terminal and may type into it at any time; when a decision is genuinely ambiguous or irreversible, use `ask_human` and wait for the answer.'
    : 'You cannot ask the human: `ask_human` is disabled in supervised workers — if a required decision is ambiguous or risky, stop and report it as a risk/open question instead of guessing.';
  return `# Super Agent worker task\n\nRun: ${run.id}\nTask: ${task.id} (${task.title})\nAttempt: ${attempt}\nLane: ${lane?.id ?? task.lane}\nOverall objective: ${run.objective}\n\n## Objective\n${task.contract.objective}\n\n## Upstream handoffs\n${dependencyContext(request)}\n\n## Boundaries\n- Change policy: ${task.contract.changePolicy}\n- Allowed scope: ${task.contract.scope.allow.join(', ')}\n- Denied scope: ${task.contract.scope.deny.join(', ')}\n- Acceptance criteria:\n${task.contract.acceptanceCriteria.map((item) => `  - ${item}`).join('\n') || '  - Complete the objective and report evidence.'}\n- Required checks:\n${task.contract.requiredChecks.map((item) => `  - ${item}`).join('\n') || '  - Choose the smallest relevant validation.'}\n\n${workspaceNote}${continued} Finish only this task. Do not commit or push. ${humanNote} If the task is read_only, do not modify files. End with a concise human-readable handoff, followed by exactly one machine-readable block in this form:\n<mocode_handoff>{"summary":"...","validation":[{"command":"...","status":"passed|failed","detail":"..."}],"risks":["..."]}</mocode_handoff>`;
}

export interface ParsedHandoff {
  found: boolean;
  summary: string;
  validation?: TaskValidation[];
  risks?: string[];
}

/** 解析 worker 回答里的 `<mocode_handoff>` 块；没有块时整段回答就是摘要。 */
export function parseHandoff(text: string): ParsedHandoff {
  const match = /<mocode_handoff>([\s\S]*?)<\/mocode_handoff>/i.exec(text);
  if (!match) return { found: false, summary: text.trim() };
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    const validation = Array.isArray(value.validation)
      ? value.validation.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const item = entry as Record<string, unknown>;
          if (typeof item.command !== 'string' || (item.status !== 'passed' && item.status !== 'failed')) return [];
          return [
            {
              command: item.command,
              status: item.status,
              ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
            } satisfies TaskValidation,
          ];
        })
      : undefined;
    const risks = Array.isArray(value.risks)
      ? value.risks.filter((item): item is string => typeof item === 'string')
      : undefined;
    return {
      found: true,
      summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : text.trim(),
      validation,
      risks,
    };
  } catch {
    return {
      found: false,
      summary: text.trim(),
      risks: ['Worker returned an invalid <mocode_handoff> JSON block.'],
    };
  }
}

/**
 * 完成前的最小校验：报告里写了失败的检查、必需检查没报通过、只读任务动了文件，都算没完成。
 * 返回 undefined 表示可以判 completed。
 */
export function handoffViolation(
  request: WorkerTaskRequest,
  parsed: Pick<ParsedHandoff, 'validation'>,
): string | undefined {
  const failedValidation = parsed.validation?.find((item) => item.status === 'failed');
  if (failedValidation) return `Worker reported a failed validation: ${failedValidation.command}`;
  const missingChecks = request.task.contract.requiredChecks.filter(
    (command) => !parsed.validation?.some((item) => item.command === command && item.status === 'passed'),
  );
  if (missingChecks.length > 0) return `Worker did not report required checks as passed: ${missingChecks.join(', ')}`;
  return undefined;
}
