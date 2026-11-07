// Supervisor 的工具面：对话 REPL 只挂这一小撮控制面工具，模型看不到 read_file / run_command，
// 因此它无法自己"顺手改代码"——所有实际工作都必须经 Worke（孤立 lane）落地。
//
// 与 CLI 的对应关系是一比一：dispatch / ask / tell / close / integrate / review / cancel / status /
// workspaces。区别只在两处：
//   - 调度器挂在后台跑（supervisor.ts 的 drive 循环），工具立即返回；
//   - `supervise_apply` 单独成一个工具并声明 risk='confirm'，每次真正合入真实工作区都要人按一下。

import type { Tool, ToolOutcome } from '../tools/types.js';
import type { SupervisorRuntime } from './supervisor.js';
import type { TaskChangePolicy } from './types.js';

function ok(output: string): ToolOutcome {
  return { status: 'success', code: 'OK', retryable: false, output };
}

function fail(message: string): ToolOutcome {
  return { status: 'error', code: 'EXECUTION_ERROR', retryable: false, output: `错误:${message}` };
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((item) => String(item).trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

const CHANGE_POLICY = ['read_only', 'isolated_write'] as const;
function changePolicy(value: unknown): TaskChangePolicy | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return (CHANGE_POLICY as readonly string[]).includes(text) ? (text as TaskChangePolicy) : undefined;
}

/** 对话里可用的全部控制面工具名（REPL 用它收窄工具面）。 */
export const SUPERVISOR_TOOL_NAMES: readonly string[] = [
  'supervise_workspaces',
  'supervise_status',
  'supervise_dispatch',
  'supervise_ask',
  'supervise_tell',
  'supervise_close',
  'supervise_integrate',
  'supervise_apply',
  'supervise_review',
  'supervise_cancel',
  'supervise_approve',
];

export function createSupervisorTools(supervisor: SupervisorRuntime): Tool[] {
  const workspaces: Tool = {
    name: 'supervise_workspaces',
    description:
      "List the workspaces on this machine that have run mocode, plus each one's git state, recent sessions and open lanes. " +
      'Call this before dispatching when you are unsure which directory the user means.',
    risk: 'safe',
    capabilities: { effect: 'read', concurrency: 'parallel' },
    parameters: {
      type: 'object',
      properties: {
        scanRoot: {
          type: 'string',
          description: 'Optional directory to scan (depth ≤ 3) for extra workspaces that have never registered.',
        },
      },
    },
    async execute(args) {
      try {
        const scan = typeof args.scanRoot === 'string' && args.scanRoot ? [args.scanRoot] : [];
        return ok(
          scan.length > 0
            ? (await import('./workspaces.js')).formatWorkspaces(supervisor.workspaces()) +
                `(scanRoot ${scan[0]} is not applied at runtime; pass it via the CLI --scan-roots flag.)\n`
            : supervisor.formatWorkspaces(),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const status: Tool = {
    name: 'supervise_status',
    description:
      'Show orchestration status: with runId, the full task/lane table of that run; without it, every live run on this machine. ' +
      'Use it to answer "how is it going" and to decide whether to dispatch more work.',
    risk: 'safe',
    capabilities: { effect: 'read', concurrency: 'parallel' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id, e.g. 20261106-222105-292d. Omit to list live runs.' },
        includeFinished: {
          type: 'boolean',
          description: 'When runId is omitted, also list recently finished runs from each workspace.',
        },
      },
    },
    async execute(args) {
      try {
        const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
        if (runId) return ok(supervisor.status(runId));
        const live = supervisor.status();
        if (args.includeFinished !== true) return ok(live);
        const recent = supervisor
          .recentRuns(2)
          .map(({ run, workspaceRoot }) => `${run.id} · ${run.status} · ${workspaceRoot} · ${run.objective}`)
          .join('\n');
        return ok(`${live}\n\nRecent runs:\n${recent || '(none)'}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const dispatch: Tool = {
    name: 'supervise_dispatch',
    description: [
      'Dispatch work to a mocode worker in a specific workspace, then return immediately (the worker runs in the background).',
      "Target selection: with runId → append to that run; else the workspace's live run if it has one (continues that lane and its session); else a new run is created.",
      'If the run is still working, the task is queued and added automatically when the current batch finishes — say so, do not claim it started.',
      "Workers run in an isolated lane (git worktree for git repos, a copy for plain directories); the user's directory is not touched until an explicit apply.",
    ].join(' '),
    risk: 'safe',
    capabilities: { effect: 'process', concurrency: 'serial', supportsAbort: false },
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            'The task for the worker. Be concrete: what to do, where, and what "done" means. The worker sees its lane\'s session history plus this text.',
        },
        workspace: {
          type: 'string',
          description:
            'Absolute (or cwd-relative) workspace directory. Omit to use the supervisor cwd. Must be a git repository root or a plain directory.',
        },
        lane: {
          type: 'string',
          description:
            'Lane id. Reuse an existing lane id to continue that lane/session; omit to derive one from the task id.',
        },
        title: { type: 'string', description: 'Short label (≤80 chars) shown in status output.' },
        runId: { type: 'string', description: 'Append to this existing run instead of choosing one automatically.' },
        taskId: { type: 'string', description: 'Explicit task id; omit to auto-number task-N.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must complete first.',
        },
        changePolicy: {
          type: 'string',
          enum: [...CHANGE_POLICY],
          description:
            'read_only for investigation/status questions, isolated_write (default) when the worker should edit the lane.',
        },
        requiredChecks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands the worker must report as passed, e.g. ["npm run typecheck"].',
        },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Human-readable acceptance criteria carried in the task contract.',
        },
        allow: { type: 'array', items: { type: 'string' }, description: 'Glob paths the worker may change.' },
        deny: { type: 'array', items: { type: 'string' }, description: 'Glob paths the worker must not change.' },
      },
      required: ['objective'],
    },
    async execute(args) {
      try {
        const objective = typeof args.objective === 'string' ? args.objective : '';
        return ok(
          await supervisor.dispatch({
            objective,
            workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
            lane: typeof args.lane === 'string' ? args.lane : undefined,
            title: typeof args.title === 'string' ? args.title : undefined,
            runId: typeof args.runId === 'string' ? args.runId : undefined,
            taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
            dependsOn: strings(args.dependsOn),
            requiredChecks: strings(args.requiredChecks),
            acceptanceCriteria: strings(args.acceptanceCriteria),
            changePolicy: changePolicy(args.changePolicy),
            allow: strings(args.allow),
            deny: strings(args.deny),
          }),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const ask: Tool = {
    name: 'supervise_ask',
    description:
      "Ask a lane a status question: the message is delivered as a real turn into that lane's existing worker session (read-only task). " +
      'Use it to find out what a worker actually did, what it verified, and what is left. Queued if the run is still working.',
    risk: 'safe',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id that owns the lane.' },
        lane: { type: 'string', description: 'Lane id to ask.' },
        question: { type: 'string', description: 'The question or status request.' },
      },
      required: ['runId', 'lane', 'question'],
    },
    async execute(args) {
      try {
        return ok(
          await supervisor.laneTurn('ask', {
            runId: String(args.runId ?? ''),
            lane: String(args.lane ?? ''),
            text: String(args.question ?? ''),
          }),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const tell: Tool = {
    name: 'supervise_tell',
    description:
      "Send a steering message into a lane's existing worker session: a binding constraint for the rest of its work (scope, style, stop doing X). " +
      'Queued if the run is still working.',
    risk: 'safe',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id that owns the lane.' },
        lane: { type: 'string', description: 'Lane id to steer.' },
        message: { type: 'string', description: 'The constraint or correction.' },
      },
      required: ['runId', 'lane', 'message'],
    },
    async execute(args) {
      try {
        return ok(
          await supervisor.laneTurn('tell', {
            runId: String(args.runId ?? ''),
            lane: String(args.lane ?? ''),
            text: String(args.message ?? ''),
          }),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const close: Tool = {
    name: 'supervise_close',
    description:
      'Close a lane: export its accumulated diff to the run artifacts, archive the lane session, and drop the execution site. ' +
      'Close only when the user says the work batch is finished; a closed lane can be reopened by dispatching to it again.',
    risk: 'safe',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id that owns the lane.' },
        lane: { type: 'string', description: 'Lane id to close.' },
      },
      required: ['runId', 'lane'],
    },
    async execute(args) {
      try {
        return ok(await supervisor.closeLane(String(args.runId ?? ''), String(args.lane ?? '')));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const integrate: Tool = {
    name: 'supervise_integrate',
    description:
      'Dry-run the integration of closed lanes back into the real workspace: per lane, whether its patch applies cleanly, which files it touches, ' +
      'and what blocks it (open lane, missing patch, dirty working tree, conflict). Nothing is written. Requires a closed lane.',
    risk: 'safe',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id.' },
        lane: { type: 'string', description: 'Only plan this lane; omit for every lane of the run.' },
      },
      required: ['runId'],
    },
    async execute(args) {
      try {
        return ok(
          supervisor.integrate(String(args.runId ?? ''), {
            lane: typeof args.lane === 'string' ? args.lane : undefined,
            apply: false,
          }),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const apply: Tool = {
    name: 'supervise_apply',
    description:
      'Apply the closed lane patches into the real workspace (git apply, no commit). The user confirms this through a permission panel every time. ' +
      'Only call after supervise_integrate reported every lane as ready, and only when the user asked for the work to land.',
    risk: 'confirm',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id.' },
        lane: { type: 'string', description: 'Only apply this lane; omit for every ready lane of the run.' },
      },
      required: ['runId'],
    },
    async execute(args) {
      try {
        return ok(
          supervisor.integrate(String(args.runId ?? ''), {
            lane: typeof args.lane === 'string' ? args.lane : undefined,
            apply: true,
          }),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const review: Tool = {
    name: 'supervise_review',
    description:
      'Ask the supervisor model for a "is this run finished?" verdict over the run\'s handoffs and evidence (one model call). ' +
      'Use it when the queue is drained and you need a second opinion before closing lanes. dryRun returns the evidence pack without calling the model.',
    risk: 'safe',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id.' },
        dryRun: { type: 'boolean', description: 'Return the evidence pack only; no model call, no ledger write.' },
      },
      required: ['runId'],
    },
    async execute(args) {
      try {
        return ok(await supervisor.review(String(args.runId ?? ''), { dryRun: args.dryRun === true }));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const approve: Tool = {
    name: 'supervise_approve',
    description: [
      'Answer a worker that is paused waiting for a human: a tool-permission request or a question the worker asked with ask_human.',
      'Use the approval id from the snapshot / supervise_status. For a choice, pass the option label as value; for free text, pass the text.',
      "The worker resumes inside the same session. Never answer on the operator's behalf without telling them what you answered — this is the one place a wrong click changes the work.",
    ].join(' '),
    risk: 'confirm',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: {
        approvalId: {
          type: 'string',
          description:
            'Approval id from the snapshot or supervise_status (e.g. 8f2c…), or its 1-based index in the pending list.',
        },
        action: {
          type: 'string',
          enum: ['selected', 'submitted', 'cancelled'],
          description:
            'selected = pick one of the offered options; submitted = send free text; cancelled = refuse (the worker is told the human declined).',
        },
        value: { type: 'string', description: 'The chosen option label, or the free-text answer. Omit for cancelled.' },
      },
      required: ['approvalId', 'action'],
    },
    async execute(args) {
      try {
        const action = String(args.action ?? '');
        if (!['selected', 'submitted', 'cancelled'].includes(action)) {
          return fail(`action must be selected, submitted or cancelled (got "${action}").`);
        }
        return ok(
          supervisor.answerApproval(
            String(args.approvalId ?? ''),
            action as 'selected' | 'submitted' | 'cancelled',
            typeof args.value === 'string' && args.value ? args.value : undefined,
          ),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const cancel: Tool = {
    name: 'supervise_cancel',
    description:
      'Request cancellation of a run: running workers are stopped, lanes are closed and the run becomes terminal. ' +
      'Irreversible — confirm with the user first unless they explicitly asked to cancel.',
    risk: 'confirm',
    capabilities: { effect: 'process', concurrency: 'serial' },
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id.' } },
      required: ['runId'],
    },
    async execute(args) {
      try {
        return ok(await supervisor.cancel(String(args.runId ?? '')));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  return [workspaces, status, dispatch, ask, tell, close, integrate, apply, review, cancel, approve];
}
