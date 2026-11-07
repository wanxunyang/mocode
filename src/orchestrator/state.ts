import path from 'node:path';
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type LaneInput,
  type NewOrchestrationEvent,
  type OrchestrationDefinition,
  type OrchestrationEvent,
  type OrchestrationLane,
  type OrchestrationRun,
  type OrchestrationTask,
  type RunBudget,
  type RunPolicy,
  type TaskInput,
} from './types.js';

/** 并发与收工判定的默认策略；`policy` 缺省或局部给出时用它补齐。 */
export const DEFAULT_RUN_POLICY: RunPolicy = {
  maxConcurrentWorkers: 6,
  maxConcurrentPerWorkspace: 6,
  reviewOnIdle: true,
};

function normalizePolicy(input: Partial<RunPolicy> | undefined): RunPolicy {
  const policy = { ...DEFAULT_RUN_POLICY };
  if (!input) return policy;
  for (const key of ['maxConcurrentWorkers', 'maxConcurrentPerWorkspace'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) throw new Error(`policy.${key} must be a positive integer.`);
    policy[key] = value;
  }
  if (input.reviewOnIdle !== undefined) policy.reviewOnIdle = input.reviewOnIdle === true;
  if (input.budget) {
    const budget: RunBudget = {};
    for (const key of ['maxTokensPerRun', 'maxWallClockMs'] as const) {
      const value = input.budget[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`policy.budget.${key} must be a positive number.`);
      }
      budget[key] = Math.floor(value);
    }
    // 空 budget 与「不限」等价，不写进账本，避免看起来像已配置。
    if (Object.keys(budget).length > 0) policy.budget = budget;
  }
  return policy;
}

const TERMINAL_TASKS = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_TASKS = new Set(['dispatching', 'running']);
const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled']);
const LANE_MODES = new Set(['worktree', 'copy', 'inplace']);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function stringArray(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeTask(input: TaskInput): OrchestrationTask {
  if (!input || typeof input !== 'object') throw new Error('Each task must be an object.');
  assertText(input.id, 'task.id');
  if (!TASK_ID_RE.test(input.id)) {
    throw new Error(`task.id must match ${TASK_ID_RE.source}: ${input.id}`);
  }
  assertText(input.title, `task ${input.id} title`);
  if (input.lane !== undefined && (typeof input.lane !== 'string' || !TASK_ID_RE.test(input.lane.trim()))) {
    throw new Error(`task ${input.id} lane must match ${TASK_ID_RE.source}`);
  }
  assertText(input.objective, `task ${input.id} objective`);
  if (input.changePolicy !== undefined && !['read_only', 'isolated_write'].includes(input.changePolicy)) {
    throw new Error(`Task ${input.id} has an unsupported changePolicy.`);
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    throw new Error(`Task ${input.id} maxAttempts must be a positive integer.`);
  }
  return {
    id: input.id,
    lane: input.lane?.trim() || input.id,
    title: input.title.trim(),
    contract: {
      objective: input.objective.trim(),
      scope: {
        allow: stringArray(input.scope?.allow, ['**/*'], `task ${input.id} scope.allow`),
        deny: stringArray(input.scope?.deny, ['.git/**'], `task ${input.id} scope.deny`),
      },
      acceptanceCriteria: stringArray(input.acceptanceCriteria, [], `task ${input.id} acceptanceCriteria`),
      requiredChecks: stringArray(input.requiredChecks, [], `task ${input.id} requiredChecks`),
      changePolicy: input.changePolicy ?? 'isolated_write',
    },
    dependsOn: stringArray(input.dependsOn, [], `task ${input.id} dependsOn`),
    status: 'pending',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
  };
}

export function createInitialRun(
  id: string,
  workspaceRoot: string,
  definition: OrchestrationDefinition,
  now = new Date().toISOString(),
): OrchestrationRun {
  assertText(id, 'run id');
  assertText(definition.objective, 'objective');
  if (!Array.isArray(definition.tasks) || definition.tasks.length === 0) {
    throw new Error('An orchestration requires at least one task.');
  }
  const tasks: Record<string, OrchestrationTask> = {};
  for (const input of definition.tasks) {
    const task = normalizeTask(input);
    if (tasks[task.id]) throw new Error(`Duplicate task id: ${task.id}`);
    tasks[task.id] = task;
  }
  for (const task of Object.values(tasks)) {
    for (const dependency of task.dependsOn) {
      if (!tasks[dependency]) throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
    }
  }
  assertAcyclic(tasks);
  const explicitLaneIds = new Set(definition.tasks.flatMap((input) => (input.lane?.trim() ? [input.lane.trim()] : [])));
  const lanes = normalizeLanes(workspaceRoot, definition.lanes, tasks, explicitLaneIds);
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    id,
    objective: definition.objective.trim(),
    workspaceRoot,
    status: 'running',
    sequence: 0,
    tasks,
    lanes,
    /** 跑空后是否直接收尾；false 时进入 idle 等待继续派活（长驻 lane）。 */
    autoClose: definition.autoClose === true,
    policy: normalizePolicy(definition.policy),
    cancellationRequested: false,
    createdAt: now,
    updatedAt: now,
  };
}

function assertAcyclic(tasks: Record<string, OrchestrationTask>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Task graph contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks[id].dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(tasks)) visit(id);
}

/**
 * Lane 是执行现场（worktree + 会话）的归属单位。声明式 lanes 可以指向别的仓库；
 * 未声明的 lane 按「Run 自己的 workspaceRoot」隐式建一条，因此旧的 dag.json 不受影响。
 */
function normalizeLanes(
  workspaceRoot: string,
  inputs: LaneInput[] | undefined,
  tasks: Record<string, OrchestrationTask>,
  explicitLaneIds: ReadonlySet<string>,
): Record<string, OrchestrationLane> {
  const lanes: Record<string, OrchestrationLane> = {};
  const declare = (input: LaneInput): void => {
    if (!input || typeof input !== 'object') throw new Error('Each lane must be an object.');
    assertText(input.id, 'lane.id');
    if (!TASK_ID_RE.test(input.id)) throw new Error(`lane.id must match ${TASK_ID_RE.source}: ${input.id}`);
    if (lanes[input.id]) throw new Error(`Duplicate lane id: ${input.id}`);
    if (input.mode !== undefined && !LANE_MODES.has(input.mode)) {
      throw new Error(`lane ${input.id} has an unsupported mode: ${String(input.mode)}`);
    }
    lanes[input.id] = {
      id: input.id,
      workspaceRoot: path.resolve(workspaceRoot, input.workspaceRoot ?? '.'),
      // 缺省 worktree：CLI 会在建 Run 前按工作区是否 git 仓库把 mode 补全。
      mode: input.mode ?? 'worktree',
      allowInplace: input.allowInplace === true,
      keepWorktree: input.keepWorktree === true,
    };
  };
  for (const input of inputs ?? []) declare(input);
  const declared = (inputs ?? []).length > 0;
  for (const task of Object.values(tasks)) {
    if (lanes[task.lane]) continue;
    // 声明了 lanes 又显式写了指向不存在的 lane，多半是拼写错误：宁可报错，也不要静默
    // 新开一条 worktree + 新会话。未写 lane（缺省=task.id）仍按需隐式创建。
    if (declared && explicitLaneIds.has(task.lane)) {
      throw new Error(`Task ${task.id} references unknown lane ${task.lane}.`);
    }
    lanes[task.lane] = {
      id: task.lane,
      workspaceRoot: path.resolve(workspaceRoot),
      mode: 'worktree',
      allowInplace: false,
      keepWorktree: false,
    };
  }
  return lanes;
}

export function makeEvent(run: OrchestrationRun, event: NewOrchestrationEvent): OrchestrationEvent {
  return {
    ...event,
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    sequence: run.sequence + 1,
    timestamp: new Date().toISOString(),
  } as OrchestrationEvent;
}

function taskOf(run: OrchestrationRun, id: string): OrchestrationTask {
  const task = run.tasks[id];
  if (!task) throw new Error(`Unknown orchestration task: ${id}`);
  return task;
}

export function reduceEvent(current: OrchestrationRun | undefined, event: OrchestrationEvent): OrchestrationRun {
  if (event.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) throw new Error('Unsupported orchestration event schema.');
  if (event.type === 'run.created') {
    if (current) throw new Error('run.created can only be the first event.');
    if (event.sequence !== 1 || event.data.run.sequence !== 0 || event.data.run.status !== 'running') {
      throw new Error('run.created must initialize a running run at sequence 1.');
    }
    return { ...event.data.run, sequence: event.sequence, updatedAt: event.timestamp };
  }
  if (!current) throw new Error(`Event ${event.type} appeared before run.created.`);
  // 终态冻结账本；`idle` 仍可追加（长驻 lane：跑空后继续 dispatch）。
  if (TERMINAL_RUNS.has(current.status)) throw new Error(`Run ${current.id} is already ${current.status}.`);
  if (event.sequence !== current.sequence + 1) {
    throw new Error(`Expected orchestration event ${current.sequence + 1}, received ${event.sequence}.`);
  }
  const run: OrchestrationRun = structuredClone(current);
  run.sequence = event.sequence;
  run.updatedAt = event.timestamp;
  // lane 是后加的概念：P1 早期创建的 Run 没有 lanes 字段，恢复时补成空表以免读路径抛错。
  run.lanes ??= {};
  run.autoClose ??= false;
  run.policy ??= { ...DEFAULT_RUN_POLICY };
  for (const lane of Object.values(run.lanes)) {
    // 旧 Run 的 lane 没有 mode：P1 只有 worktree 一档。
    lane.mode ??= 'worktree';
    lane.allowInplace ??= false;
  }

  if (event.type === 'task.added') {
    // 只在静默态接受追加：running 时任务图应当已经规划完毕，允许追加会让调度依据漂移。
    // `awaiting_user` 与 `idle` 一样是「没人在跑」的静默态，追加后由 run.resumed 唤醒。
    if (run.status !== 'idle' && run.status !== 'awaiting_user') {
      throw new Error(`Run ${run.id} can only accept new tasks while idle.`);
    }
    const task = normalizeTask(event.data.task);
    if (run.tasks[task.id]) throw new Error(`Duplicate task id: ${task.id}`);
    for (const dependency of task.dependsOn) {
      if (!run.tasks[dependency]) throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
    }
    if (!run.lanes[task.lane]) {
      // 追加任务可以落到已有 lane 上，也可以隐式新建一条（用 Run 的 workspaceRoot）。
      run.lanes[task.lane] = {
        id: task.lane,
        workspaceRoot: run.workspaceRoot,
        mode: 'worktree',
        allowInplace: false,
        keepWorktree: false,
      };
    }
    run.tasks[task.id] = task;
  } else if (event.type === 'run.idle') {
    if (run.status !== 'running') throw new Error(`Run ${run.id} cannot idle from ${run.status}.`);
    if (Object.values(run.tasks).some((task) => ACTIVE_TASKS.has(task.status))) {
      throw new Error(`Run ${run.id} cannot idle while a task is active.`);
    }
    run.status = 'idle';
  } else if (event.type === 'run.awaiting_user') {
    if (run.status !== 'running') throw new Error(`Run ${run.id} cannot await a user from ${run.status}.`);
    if (Object.values(run.tasks).some((task) => ACTIVE_TASKS.has(task.status))) {
      throw new Error(`Run ${run.id} cannot await a user while a task is active.`);
    }
    run.status = 'awaiting_user';
    run.awaitingReason = event.data.reason;
    // 冻结壁钟消耗：预算判定不再随人等待的时长增长。
    run.usage = {
      tokens: run.usage?.tokens ?? 0,
      wallClockMs: Date.parse(event.timestamp) - Date.parse(run.budgetWindowStart ?? run.createdAt),
    };
  } else if (event.type === 'run.budget_exhausted') {
    if (run.status !== 'running') throw new Error(`Run ${run.id} cannot exhaust its budget from ${run.status}.`);
    run.usage = {
      tokens: event.data.limit === 'tokens' ? event.data.used : (run.usage?.tokens ?? 0),
      wallClockMs: event.data.limit === 'wall_clock' ? event.data.used : (run.usage?.wallClockMs ?? 0),
    };
  } else if (event.type === 'run.resumed') {
    if (run.status !== 'idle' && run.status !== 'awaiting_user') {
      throw new Error(`Run ${run.id} cannot resume from ${run.status}.`);
    }
    run.status = 'running';
    run.awaitingReason = undefined;
    // 预算按「一段连续自主工作」算：人一旦介入就重新开一个窗口，
    // 否则超限的 Run 一 resume 就立刻又超限，等于永远蹬不动。
    run.budgetWindowStart = event.timestamp;
    run.usage = { tokens: 0, wallClockMs: 0 };
  } else if (event.type === 'run.reviewed') {
    // 收工判定只是建议：它不改变 Run 状态，也不允许在终态账本上追加（上面已拦）。
    run.lastReview = event.data.review;
  } else if (event.type === 'conflict.serialized') {
    // 纯观测事件：审计“哪些写任务因为改同一批文件而被串行”。不改任务状态，不广播。
    if (!run.tasks[event.data.taskId]) throw new Error(`Unknown orchestration task: ${event.data.taskId}`);
  } else if (event.type === 'run.cancel_requested') {
    if (run.cancellationRequested) throw new Error(`Run ${run.id} already has a cancellation request.`);
    run.cancellationRequested = true;
  } else if (event.type === 'run.completed') {
    if (!Object.values(run.tasks).every((task) => task.status === 'completed')) {
      throw new Error(`Run ${run.id} cannot complete while tasks remain unfinished.`);
    }
    run.status = 'completed';
  } else if (event.type === 'run.failed') {
    if (Object.values(run.tasks).some((task) => ACTIVE_TASKS.has(task.status))) {
      throw new Error(`Run ${run.id} cannot fail while a task is active.`);
    }
    run.status = 'failed';
  } else if (event.type === 'run.cancelled') {
    if (!run.cancellationRequested) throw new Error(`Run ${run.id} cannot cancel without a cancellation request.`);
    if (Object.values(run.tasks).some((task) => !TERMINAL_TASKS.has(task.status))) {
      throw new Error(`Run ${run.id} cannot cancel while tasks remain non-terminal.`);
    }
    run.status = 'cancelled';
  } else if ('laneId' in event.data) {
    const lane = run.lanes[event.data.laneId];
    if (!lane) throw new Error(`Unknown orchestration lane: ${event.data.laneId}`);
    if (event.type === 'lane.opened') {
      if (lane.closed) throw new Error(`Lane ${lane.id} is already closed.`);
      // 允许重开：崩溃恢复后执行现场可能已被销毁，Worker 会新建一个并重新上报基线。
      lane.worktreePath = event.data.worktreePath;
      lane.baseTree = event.data.baseTree;
      lane.baselineTree = event.data.baseTree;
      lane.baseIndex = event.data.baseIndex;
      lane.baselineIndex = event.data.baseIndex;
    } else if (event.type === 'lane.reopened') {
      // 显式 --reuse：现场已删除，只把会话历史接回来，基线等 Worker 重新上报。
      if (!lane.closed) throw new Error(`Lane ${lane.id} is not closed.`);
      lane.closed = undefined;
      lane.worktreePath = undefined;
      lane.baseTree = undefined;
      lane.baselineTree = undefined;
      lane.baseIndex = undefined;
      lane.baselineIndex = undefined;
    } else if (event.type === 'lane.session') {
      if (lane.closed) throw new Error(`Lane ${lane.id} is already closed.`);
      lane.sessionId = event.data.sessionId;
    } else if (event.type === 'lane.checkpoint') {
      if (!lane.worktreePath) throw new Error(`Lane ${lane.id} has no open worktree.`);
      if (lane.closed) throw new Error(`Lane ${lane.id} is already closed.`);
      lane.baselineTree = event.data.baselineTree;
      lane.baselineIndex = event.data.baselineIndex;
    } else if (event.type === 'lane.closed') {
      if (lane.closed) throw new Error(`Lane ${lane.id} is already closed.`);
      lane.closed = {
        reason: event.data.reason,
        patchPath: event.data.patchPath,
        sessionArchivePath: event.data.sessionArchivePath,
        kept: event.data.kept,
        error: event.data.error,
      };
    }
  } else if ('taskId' in event.data) {
    const task = taskOf(run, event.data.taskId);
    if (event.type === 'task.approval_requested') {
      // 人工介入只可能发生在任务真的在跑的时候：dispatching 太早（Host 还没起来），
      // 已是终态则说明这是迟到的上报，忽略会让「谁在等」永久悬空，所以直接拒绝。
      if (!['dispatching', 'running'].includes(task.status)) {
        throw new Error(`Task ${task.id} cannot request approval from ${task.status}.`);
      }
      task.approvals ??= {};
      if (task.approvals[event.data.approval.id]) {
        throw new Error(`Task ${task.id} already has a pending approval ${event.data.approval.id}.`);
      }
      task.approvals[event.data.approval.id] = { ...event.data.approval, taskId: task.id };
    } else if (event.type === 'task.approval_resolved') {
      const approval = task.approvals?.[event.data.approvalId];
      if (!approval) throw new Error(`Task ${task.id} has no approval ${event.data.approvalId}.`);
      if (approval.resolved) throw new Error(`Approval ${event.data.approvalId} is already resolved.`);
      approval.resolved = event.data.resolution;
    } else if (event.type === 'task.ready') {
      if (!['pending', 'failed', 'interrupted'].includes(task.status)) {
        throw new Error(`Task ${task.id} cannot become ready from ${task.status}.`);
      }
      if (!task.dependsOn.every((id) => run.tasks[id]?.status === 'completed')) {
        throw new Error(`Task ${task.id} cannot become ready before its dependencies complete.`);
      }
      if (task.status !== 'pending' && task.attempts >= task.maxAttempts) {
        throw new Error(`Task ${task.id} has exhausted its attempts.`);
      }
      task.status = 'ready';
      task.error = undefined;
      task.finishedAt = undefined;
    } else if (event.type === 'task.deferred') {
      // 被槽位/租约/冲突挡住：任务保持 ready，只把「为什么在等」记进 lastEvent，供 status 展示。
      if (task.status !== 'ready') throw new Error(`Task ${task.id} cannot defer from ${task.status}.`);
      task.lastEvent = event.data.blockedBy
        ? `deferred (${event.data.reason}) by ${event.data.blockedBy}`
        : `deferred (${event.data.reason})`;
    } else if (event.type === 'task.dispatching') {
      if (task.status !== 'ready') throw new Error(`Task ${task.id} cannot dispatch from ${task.status}.`);
      if (event.data.attempt !== task.attempts + 1 || event.data.attempt > task.maxAttempts) {
        throw new Error(`Task ${task.id} received invalid attempt ${event.data.attempt}.`);
      }
      task.status = 'dispatching';
      task.attempts = event.data.attempt;
      task.workerId = event.data.workerId;
      task.sessionId = undefined;
      task.workspacePath = event.data.workspacePath;
      task.patchPath = undefined;
      task.sessionArchivePath = undefined;
      task.output = undefined;
      task.error = undefined;
      // 新 attempt 的 Worker 是全新进程：上一轮的挂起审批不可能再被回答，清掉以免控制面显示幽灵请求。
      task.approvals = undefined;
      task.lastEvent = undefined;
      task.startedAt = undefined;
      task.finishedAt = undefined;
    } else if (event.type === 'task.started') {
      if (task.status !== 'dispatching') throw new Error(`Task ${task.id} cannot start from ${task.status}.`);
      task.status = 'running';
      task.sessionId = event.data.sessionId ?? task.sessionId;
      task.workspacePath = event.data.workspacePath ?? task.workspacePath;
      task.startedAt = event.timestamp;
    } else if (event.type === 'task.progress') {
      if (!['dispatching', 'running'].includes(task.status))
        throw new Error(`Task ${task.id} cannot report progress from ${task.status}.`);
      task.lastEvent = event.data.message;
      task.sessionId = event.data.sessionId ?? task.sessionId;
    } else if (event.type === 'task.completed') {
      if (!['dispatching', 'running'].includes(task.status))
        throw new Error(`Task ${task.id} cannot complete from ${task.status}.`);
      if (
        event.data.handoff.taskId !== task.id ||
        event.data.handoff.attempt !== task.attempts ||
        event.data.handoff.outcome !== 'completed'
      ) {
        throw new Error(`Task ${task.id} received a mismatched completion handoff.`);
      }
      task.status = 'completed';
      task.output = event.data.handoff;
      task.sessionId = event.data.sessionId ?? task.sessionId;
      task.workspacePath = event.data.workspacePath ?? task.workspacePath;
      task.patchPath = event.data.patchPath;
      task.sessionArchivePath = event.data.sessionArchivePath;
      task.error = undefined;
      task.finishedAt = event.timestamp;
      // 预算按“已完成任务上报的 usage”累加；缺报按 0，不猜测。
      if (event.data.handoff.tokens) {
        run.usage = {
          tokens: (run.usage?.tokens ?? 0) + event.data.handoff.tokens,
          wallClockMs: 0,
        };
      }
    } else if (event.type === 'task.failed' || event.type === 'task.interrupted') {
      if (!['dispatching', 'running'].includes(task.status))
        throw new Error(`Task ${task.id} cannot stop from ${task.status}.`);
      const expectedOutcome = event.type === 'task.failed' ? 'failed' : 'interrupted';
      if (
        event.data.handoff &&
        (event.data.handoff.taskId !== task.id ||
          event.data.handoff.attempt !== task.attempts ||
          event.data.handoff.outcome !== expectedOutcome)
      ) {
        throw new Error(`Task ${task.id} received a mismatched ${expectedOutcome} handoff.`);
      }
      task.status = expectedOutcome;
      task.error = event.data.error;
      task.output = event.data.handoff;
      task.sessionId = event.data.sessionId ?? task.sessionId;
      task.workspacePath = event.data.workspacePath ?? task.workspacePath;
      task.patchPath = event.data.patchPath;
      task.sessionArchivePath = event.data.sessionArchivePath;
      task.finishedAt = event.timestamp;
    } else if (event.type === 'task.cancelled') {
      if (TERMINAL_TASKS.has(task.status)) throw new Error(`Task ${task.id} is already terminal.`);
      task.status = 'cancelled';
      task.error = event.data.reason;
      task.finishedAt = event.timestamp;
    }
  }
  return run;
}

export function isRunTerminal(run: OrchestrationRun): boolean {
  return run.status !== 'running' && run.status !== 'idle' && run.status !== 'awaiting_user';
}

/** Run 是否还能接活（running / idle / awaiting_user）；`awaiting_user` 用 dispatch 唤醒。 */
export function isRunLive(run: OrchestrationRun): boolean {
  return !isRunTerminal(run);
}
