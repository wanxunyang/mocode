import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkspaceLeaseManager } from './lease.js';
import { needsReview, reviewRun } from './review.js';
import { scopeOverlaps, validateChangedFiles } from './scope.js';
import { OrchestrationStore } from './store.js';
import type {
  ApprovalResolution,
  LaneCloseResult,
  LaneMode,
  LaneRequest,
  NewOrchestrationEvent,
  OrchestrationApproval,
  OrchestrationLane,
  OrchestrationRun,
  OrchestrationTask,
  RunReview,
  TaskHandoff,
  TaskInput,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskResult,
} from './types.js';

export interface SchedulerOptions {
  pollMs?: number;
  cancelGraceMs?: number;
  /** 队列跑空后是否继续等新任务（watch 用）。默认 false：进 idle 就返回。 */
  waitForMore?: boolean;
  /** 注入收工判定（测试用）；缺省走 src/orchestrator/review.ts 的真模型回合。 */
  review?: (run: OrchestrationRun) => Promise<RunReview>;
}

const ACTIVE = new Set(['dispatching', 'running']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled']);

export interface SchedulerHooks {
  onEvent?: (event: NewOrchestrationEvent, run: OrchestrationRun) => void;
}

function readyCandidates(run: OrchestrationRun): OrchestrationTask[] {
  return Object.values(run.tasks).filter((task) => {
    if (task.status === 'failed' || task.status === 'interrupted') return task.attempts < task.maxAttempts;
    return task.status === 'pending' && task.dependsOn.every((id) => run.tasks[id]?.status === 'completed');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 任务最终写在哪：`inplace` 档写共享的原目录（所有 lane 同名冲突），
 * 隔离档位（worktree / copy）各有独立现场，按 lane 区分。
 */
function executionRoot(task: OrchestrationTask, run: OrchestrationRun): string {
  const lane = run.lanes[task.lane];
  if (!lane) return run.workspaceRoot.toLowerCase();
  if ((lane.mode ?? 'worktree') === 'inplace') return lane.workspaceRoot.toLowerCase();
  return `lane:${lane.id}`;
}

function handoff(task: OrchestrationTask, result: WorkerTaskResult): TaskHandoff {
  return {
    taskId: task.id,
    attempt: task.attempts,
    outcome: result.outcome,
    summary: result.summary,
    changedFiles: result.changedFiles,
    validation:
      result.validation ?? task.contract.requiredChecks.map((command) => ({ command, status: 'not_reported' })),
    artifacts: [result.patchPath, result.sessionArchivePath].filter((item): item is string => item !== undefined),
    risks: [...(result.risks ?? []), ...(result.error ? [result.error] : [])],
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
  };
}

/** Control-plane gate: a Worker cannot self-declare completion that violates its task contract. */
function completionViolation(task: OrchestrationTask, result: WorkerTaskResult): string | undefined {
  if (!result.summary.trim()) return 'Worker returned an empty handoff summary.';
  const failed = result.validation?.find((item) => item.status === 'failed');
  if (failed) return `Worker reported a failed validation: ${failed.command}`;
  const missing = task.contract.requiredChecks.filter(
    (command) => !result.validation?.some((item) => item.command === command && item.status === 'passed'),
  );
  if (missing.length > 0) return `Required checks were not reported as passed: ${missing.join(', ')}`;
  if (task.contract.changePolicy === 'read_only' && result.changedFiles.length > 0) {
    return `Read-only task modified files: ${result.changedFiles.join(', ')}`;
  }
  const scopeErrors = validateChangedFiles(task.contract, result.changedFiles);
  return scopeErrors.length > 0 ? scopeErrors.join(' ') : undefined;
}

export class OrchestrationScheduler {
  private readonly pollMs: number;
  private readonly cancelGraceMs: number;
  private readonly waitForMore: boolean;
  private readonly review: (run: OrchestrationRun) => Promise<RunReview>;
  private readonly leases = new WorkspaceLeaseManager();
  /** 在跑的 Worker：taskId → 完成 promise。并发调度的全部状态都在这里。 */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** taskId → 上一次记录的等待原因；同一个原因只落一次事件，避免每 250ms 刷屏。 */
  private readonly deferred = new Map<string, string>();
  /** 已落盘的 conflict.serialized 组合（task\0blockedBy\0overlap），同组合只记一次。 */
  private readonly serialized = new Set<string>();
  /** 预算超限的人话说明；进 awaiting_user 时作为 reason 落账。 */
  private budgetNote: string | undefined;
  private cancellationSent = false;

  constructor(
    private readonly store: OrchestrationStore,
    private readonly worker: WorkerExecutor,
    private readonly hooks: SchedulerHooks = {},
    options: SchedulerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 250;
    this.cancelGraceMs = options.cancelGraceMs ?? 15_000;
    this.waitForMore = options.waitForMore === true;
    this.review = options.review ?? ((run) => reviewRun(run));
  }

  async run(): Promise<OrchestrationRun> {
    this.recoverInFlightTasks();
    while (!TERMINAL_RUNS.has(this.store.current.status)) {
      this.observeCancellation();
      if (this.store.current.cancellationRequested) {
        await this.cancelRun();
        break;
      }
      // idle / awaiting_user 都是「没活可干但有救」的状态：可以继续等新任务，也可以直接返回给调用方。
      // awaiting_user 必须由人显式 dispatch 唤醒，不在原地自己转圈。
      if (this.store.current.status === 'awaiting_user') break;
      if (this.store.current.status === 'idle' && !this.hasRunnableWork()) {
        if (!this.waitForMore) break;
        await sleep(this.pollMs);
        continue;
      }
      // 预算闸：超限时不再派发新任务，已在跑的让它跑完，然后进 awaiting_user 等人决定。
      if (!this.enforceBudget()) {
        if (this.inFlight.size > 0) {
          await Promise.race([...this.inFlight.values(), sleep(this.pollMs)]);
          continue;
        }
        this.append({ type: 'run.awaiting_user', data: { reason: this.budgetNote ?? 'Run budget exhausted.' } });
        break;
      }
      this.promoteReadyTasks();
      this.dispatchReady();
      if (this.inFlight.size > 0) {
        // 任一 Worker 结束或一个轮询窗口过去就回来补槽位。
        await Promise.race([...this.inFlight.values(), sleep(this.pollMs)]);
        continue;
      }
      const run = this.store.current;
      if (Object.values(run.tasks).every((task) => task.status === 'completed')) {
        await this.finishCompleted();
        break;
      }
      const irrecoverable = Object.values(run.tasks).some(
        (task) => task.status === 'failed' || (task.status === 'interrupted' && task.attempts >= task.maxAttempts),
      );
      const blocked = Object.values(run.tasks).some(
        (task) => task.status === 'pending' && task.dependsOn.some((id) => run.tasks[id]?.status !== 'completed'),
      );
      if (irrecoverable || blocked) {
        // 重试耗尽不等于「必须终止」：现场与会话都还在，交给人决定是补任务还是收工。
        this.append({
          type: 'run.awaiting_user',
          data: {
            reason: irrecoverable
              ? 'A task exhausted its attempts; add a follow-up task or close the run.'
              : 'A task cannot run because its dependency did not complete.',
          },
        });
        break;
      }
      await sleep(this.pollMs);
    }
    return this.store.current;
  }

  /**
   * 预算判定：返回 false 表示「不该再派新活」。
   * 只记录一次超限事件（run.budget_exhausted 不允许重复落到同一状态上），
   * 真正的状态转移留给 run() 在 in-flight 清空后做。
   */
  private enforceBudget(): boolean {
    const run = this.store.current;
    const budget = run.policy?.budget;
    if (!budget) return true;
    if (budget.maxTokensPerRun !== undefined) {
      const used = run.usage?.tokens ?? 0;
      if (used >= budget.maxTokensPerRun) return this.markBudgetExhausted('tokens', used, budget.maxTokensPerRun);
    }
    if (budget.maxWallClockMs !== undefined) {
      const used = Date.now() - Date.parse(run.budgetWindowStart ?? run.createdAt);
      if (used >= budget.maxWallClockMs) return this.markBudgetExhausted('wall_clock', used, budget.maxWallClockMs);
    }
    return true;
  }

  private markBudgetExhausted(limit: 'tokens' | 'wall_clock', used: number, cap: number): boolean {
    if (!this.budgetNote) {
      this.append({ type: 'run.budget_exhausted', data: { limit, used } });
      this.budgetNote = `Run budget exhausted (${limit}: ${used} / ${cap}). Add a task to continue or close the run.`;
    }
    return false;
  }

  /**
   * 把 ready 任务填进空槽位。
   *
   * 三道门：全局槽位、lane 独占（同一现场/会话不能同时跑两个任务）、工作区租约。
   * 另：同一执行根（只有 `inplace` 会共享根）上的写任务先按契约 scope 判一下交集，
   * 好把「为什么在等」说得更具体（`scope_overlap` vs `workspace_lease`）；
   * 真正的互斥保证来自租约本身：inplace 对同一目录恒为独占。
   */
  private dispatchReady(): void {
    const run = this.store.current;
    const limit = run.policy?.maxConcurrentWorkers ?? 6;
    const perWorkspace = run.policy?.maxConcurrentPerWorkspace ?? 6;
    for (const task of Object.values(run.tasks)) {
      if (this.inFlight.size >= limit) break;
      if (task.status !== 'ready' || this.inFlight.has(task.id)) continue;

      const busyLane = [...this.inFlight.keys()].find((id) => run.tasks[id]?.lane === task.lane);
      if (busyLane) {
        this.deferTask(task.id, 'lane_busy', busyLane);
        continue;
      }
      const conflict = this.conflictWith(task.id, run);
      if (conflict) {
        this.deferTask(task.id, 'scope_overlap', conflict);
        this.serializeConflict(task.id, conflict, 'scope');
        continue;
      }
      const lane = run.lanes[task.lane];
      const mode: LaneMode = lane?.mode ?? 'worktree';
      const lease = this.leases.tryAcquire(
        lane?.workspaceRoot ?? run.workspaceRoot,
        mode === 'inplace' ? 'inplace' : 'isolated',
        perWorkspace,
      );
      if (!lease) {
        this.deferTask(task.id, 'workspace_lease', lane?.workspaceRoot);
        this.serializeConflict(task.id, lane?.workspaceRoot ?? run.workspaceRoot, 'workspace');
        continue;
      }
      this.deferred.delete(task.id);
      const pending = this.execute(task)
        .catch((error: unknown) => {
          // execute 自己吞掉 Worker 异常；能到这里只剩账本写入之类的硬故障。
          this.hooks.onEvent?.(
            { type: 'task.progress', data: { taskId: task.id, message: `scheduler error: ${String(error)}` } },
            this.store.current,
          );
        })
        .finally(() => {
          this.inFlight.delete(task.id);
          try {
            lease.release();
          } catch {
            // 释放失败最多留下一个过期锁文件；下次 tryAcquire 会按 PID 判活接管。
          }
        });
      this.inFlight.set(task.id, pending);
    }
  }

  /** 两个**写**任务是否可能撞在同一个执行根上；返回先占者的 taskId。 */
  private conflictWith(taskId: string, run: OrchestrationRun): string | undefined {
    const task = run.tasks[taskId];
    if (task.contract.changePolicy !== 'isolated_write') return undefined;
    const root = executionRoot(task, run);
    for (const otherId of this.inFlight.keys()) {
      const other = run.tasks[otherId];
      if (!other || other.contract.changePolicy !== 'isolated_write') continue;
      if (executionRoot(other, run) !== root) continue;
      if (scopeOverlaps(task.contract, other.contract)) return otherId;
    }
    return undefined;
  }

  private deferTask(
    taskId: string,
    reason: 'lane_busy' | 'workspace_lease' | 'scope_overlap',
    blockedBy?: string,
  ): void {
    const key = `${reason}:${blockedBy ?? ''}`;
    if (this.deferred.get(taskId) === key) return;
    this.deferred.set(taskId, key);
    this.append({ type: 'task.deferred', data: { taskId, reason, blockedBy } });
  }

  /**
   * 写冲突的显式审计事件：`task.deferred` 说的是「这个任务为什么没发出去」，
   * 这条说的是「哪些写操作被串行化了、被谁挡住」——事后能直接回答「谁先占了这批文件」。
   * 同一对 (task, blockedBy) 只记一次，避免每个轮询窗口刷屏。
   */
  private serializeConflict(taskId: string, blockedBy: string, overlap: 'scope' | 'workspace'): void {
    const dedupe = `${taskId}\u0000${blockedBy}\u0000${overlap}`;
    if (this.serialized.has(dedupe)) return;
    this.serialized.add(dedupe);
    this.append({ type: 'conflict.serialized', data: { taskId, blockedBy, overlap } });
  }

  /** 把一次收工判定写进账本（CLI `review` 用）。只是建议，不改变 Run 状态。 */
  recordReview(review: RunReview): void {
    if (TERMINAL_RUNS.has(this.store.current.status)) {
      throw new Error(
        `Run ${this.store.current.id} is ${this.store.current.status}; reviews can no longer be recorded.`,
      );
    }
    this.append({ type: 'run.reviewed', data: { review } });
  }

  /** 还有可执行或被重试的任务（即使 Run 处于 idle，也能被唤醒回到 running）。 */
  private hasRunnableWork(): boolean {
    const run = this.store.current;
    if (Object.values(run.tasks).some((task) => ACTIVE.has(task.status))) return true;
    return readyCandidates(run).length > 0;
  }

  /**
   * 所有任务完成时的收尾：autoClose 直接结束 Run；否则进入 idle，等下一轮 dispatch。
   * lane 与 session 都保留 —— 这是「跑完不关门、随时接着派」的核心。
   */
  private async finishCompleted(): Promise<void> {
    if (this.store.current.autoClose !== false) {
      await this.closeLanes('run completed');
      this.append({ type: 'run.completed', data: {} });
      return;
    }
    await this.reviewIfNeeded();
    this.append({ type: 'run.idle', data: { reason: 'queue_drained' } });
  }

  /**
   * idle 前的收工判定：只是建议，不改变 Run 状态。
   * 判定失败或关闭都不阻塞进 idle —— 调度不能被一个模型调用卡住。
   */
  private async reviewIfNeeded(): Promise<void> {
    const run = this.store.current;
    if (run.policy?.reviewOnIdle === false) return;
    if (!needsReview(run)) return;
    let review: RunReview;
    try {
      review = await this.review(run);
    } catch (error) {
      review = {
        verdict: 'unknown',
        rationale: '',
        remaining: [],
        createdAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.append({ type: 'run.reviewed', data: { review } });
  }

  /**
   * 显式关闭一条 lane（CLI `close`）：导出累计 diff、归档会话，并按 keepWorktree 决定是否删现场。
   * 若此时所有任务已完成、所有 lane 已关闭，Run 随之收尾。
   */
  async closeLaneById(laneId: string, reason: string): Promise<OrchestrationRun> {
    const lane = this.store.current.lanes[laneId];
    if (!lane) throw new Error(`Unknown lane: ${laneId}`);
    if (!lane.closed) await this.closeLane(lane, reason);
    await this.finalizeIfDone();
    return this.store.current;
  }

  /** idle / awaiting_user 状态下把新增任务唤醒：append task.added + run.resumed 后交给 run()。 */
  appendTask(task: TaskInput, options: { reopenLane?: boolean } = {}): void {
    const run = this.store.current;
    if (run.status !== 'idle' && run.status !== 'awaiting_user') {
      throw new Error(`Run ${run.id} is ${run.status}; tasks can only be added while idle or awaiting the user.`);
    }
    const lane = run.lanes[task.lane?.trim() || task.id];
    if (lane?.closed) {
      if (!options.reopenLane) {
        throw new Error(
          `Lane ${lane.id} is closed; pass --reuse to reopen it (only the conversation history survives).`,
        );
      }
      this.append({ type: 'lane.reopened', data: { laneId: lane.id } });
    }
    this.append({ type: 'task.added', data: { task } });
    this.append({ type: 'run.resumed', data: { reason: 'task_added' } });
  }

  /**
   * 把「人按下了继续」写进账本：idle / awaiting_user 都回到 running。
   * 幂等：running 或终态直接忽略，CLI 可以无条件调。
   */
  resume(reason = 'Operator resumed the run.'): void {
    const run = this.store.current;
    if (run.status === 'running' || TERMINAL_RUNS.has(run.status)) return;
    this.append({ type: 'run.resumed', data: { reason } });
  }

  private async finalizeIfDone(): Promise<void> {
    const run = this.store.current;
    if (TERMINAL_RUNS.has(run.status)) return;
    const allTasksDone = Object.values(run.tasks).every((task) => task.status === 'completed');
    const allLanesClosed = Object.values(run.lanes).every((lane) => lane.closed || !lane.worktreePath);
    if (!allTasksDone || !allLanesClosed) return;
    if (run.status === 'running') return;
    this.append({ type: 'run.completed', data: { reason: 'All lanes closed by the operator.' } });
  }

  private recoverInFlightTasks(): void {
    for (const task of Object.values(this.store.current.tasks)) {
      if (!ACTIVE.has(task.status)) continue;
      this.append({
        type: 'task.interrupted',
        data: {
          taskId: task.id,
          error: 'Controller restarted while the worker was in flight.',
          sessionId: task.sessionId,
        },
      });
    }
  }

  private promoteReadyTasks(): void {
    for (const task of readyCandidates(this.store.current)) {
      this.append({
        type: 'task.ready',
        data: {
          taskId: task.id,
          reason:
            task.status === 'interrupted' ? 'recovery' : task.status === 'failed' ? 'retry' : 'dependencies_satisfied',
        },
      });
    }
  }

  private async execute(taskSnapshot: OrchestrationTask): Promise<void> {
    const attempt = taskSnapshot.attempts + 1;
    const workerId = `worker-${randomUUID().slice(0, 8)}`;
    this.append({ type: 'task.dispatching', data: { taskId: taskSnapshot.id, attempt, workerId } });

    let result: WorkerTaskResult;
    const pending = this.worker.run(
      {
        run: this.store.current,
        task: this.store.current.tasks[taskSnapshot.id],
        attempt,
        workerId,
        lane: this.laneRequest(taskSnapshot.lane),
      },
      (progress) => this.recordProgress(taskSnapshot.id, progress),
    );
    try {
      result = await this.waitForWorkerOrCancellation(pending);
    } catch (error) {
      result = {
        outcome: 'interrupted',
        summary: '',
        changedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.appendLaneCheckpoint(result);
    const current = this.store.current.tasks[taskSnapshot.id];
    if (result.outcome === 'completed') {
      const violation = completionViolation(current, result);
      if (violation) result = { ...result, outcome: 'failed', error: violation };
    }
    if (result.outcome === 'cancelled') {
      this.append({ type: 'task.cancelled', data: { taskId: taskSnapshot.id, reason: result.error ?? 'Cancelled.' } });
      return;
    }

    const taskHandoff = handoff({ ...current, attempts: attempt }, result);
    const handoffPath = this.store.artifactPath(taskSnapshot.id, `attempt-${attempt}-handoff.json`);
    taskHandoff.artifacts.unshift(handoffPath);
    fs.writeFileSync(handoffPath, `${JSON.stringify(taskHandoff, null, 2)}\n`, 'utf8');
    if (result.outcome === 'completed') {
      this.append({
        type: 'task.completed',
        data: {
          taskId: taskSnapshot.id,
          handoff: taskHandoff,
          sessionId: result.sessionId,
          workspacePath: result.workspacePath,
          patchPath: result.patchPath,
          sessionArchivePath: result.sessionArchivePath,
        },
      });
    } else {
      const type = result.outcome === 'interrupted' ? 'task.interrupted' : 'task.failed';
      this.append({
        type,
        data: {
          taskId: taskSnapshot.id,
          error: result.error ?? (result.summary || 'Worker failed.'),
          handoff: taskHandoff,
          sessionId: result.sessionId,
          workspacePath: result.workspacePath,
          patchPath: result.patchPath,
          sessionArchivePath: result.sessionArchivePath,
        },
      });
    }
  }

  /** lane 现场快照：有 worktree/session 时 Worker 会复用，否则新建。 */
  private laneRequest(laneId: string): LaneRequest | undefined {
    const lane = this.store.current.lanes[laneId];
    if (!lane) return undefined;
    return {
      id: lane.id,
      workspaceRoot: lane.workspaceRoot,
      mode: lane.mode ?? 'worktree',
      worktreePath: lane.worktreePath,
      baseTree: lane.baseTree,
      baselineTree: lane.baselineTree,
      baselineIndex: lane.baselineIndex,
      sessionId: lane.sessionId,
      keepWorktree: lane.keepWorktree,
      allowInplace: lane.allowInplace,
    };
  }

  private recordProgress(taskId: string, progress: WorkerProgress): void {
    const task = this.store.current.tasks[taskId];
    if (!task) return;
    const lane = this.store.current.lanes[task.lane];
    if (progress.approval?.state === 'requested') {
      // 先把「它在问什么」落账，再记 progress：控制面读状态时能看到完整的审批对象。
      this.append({
        type: 'task.approval_requested',
        data: {
          taskId,
          approval: {
            id: progress.approval.id,
            taskId,
            kind: progress.approval.kind,
            title: progress.approval.title,
            detail: progress.approval.detail,
            options: progress.approval.options,
            requestedAt: new Date().toISOString(),
          },
        },
      });
    } else if (progress.approval?.state === 'resolved') {
      const pending = this.store.current.tasks[taskId]?.approvals?.[progress.approval.id];
      // 超时兜底与正常回答都会走到这里；只有账本里确实还挂着这条时才落 resolved，
      // 否则（例如新 attempt 已清空审批表）重复落账会被 reducer 拒绝。
      if (pending && !pending.resolved) {
        this.append({
          type: 'task.approval_resolved',
          data: { taskId, approvalId: progress.approval.id, resolution: progress.approval.resolution },
        });
      }
    }
    if (lane && progress.lane?.opened && progress.workspacePath && !lane.worktreePath) {
      this.append({
        type: 'lane.opened',
        data: {
          laneId: lane.id,
          worktreePath: progress.workspacePath,
          baseTree: progress.lane.baseTree,
          baseIndex: progress.lane.baseIndex,
        },
      });
    }
    if (lane && progress.sessionId && lane.sessionId !== progress.sessionId) {
      this.append({ type: 'lane.session', data: { laneId: lane.id, sessionId: progress.sessionId } });
    }
    if (task.status === 'dispatching' && progress.started) {
      this.append({
        type: 'task.started',
        data: {
          taskId: task.id,
          sessionId: progress.sessionId,
          workspacePath: progress.workspacePath ?? task.workspacePath,
        },
      });
    }
    if (['dispatching', 'running'].includes(this.store.current.tasks[taskId].status)) {
      this.append({
        type: 'task.progress',
        data: { taskId, message: progress.message, sessionId: progress.sessionId },
      });
    }
  }

  /** 账本里还挂着等待回答的人工介入（跨任务平铺）。 */
  pendingApprovals(): Array<{ taskId: string; approval: OrchestrationApproval }> {
    const result: Array<{ taskId: string; approval: OrchestrationApproval }> = [];
    for (const task of Object.values(this.store.current.tasks)) {
      for (const approval of Object.values(task.approvals ?? {})) {
        if (!approval.resolved) result.push({ taskId: task.id, approval });
      }
    }
    return result;
  }

  /**
   * 把操作者的回答转给正在等它的 Worker。
   *
   * 返回 false 的三种情形都意味着「这条请求已经不可能得到回答」：账本里没有、
   * 已经 resolved、或者执行器手里已经没有这个 id（超时/进程已退）。调用方必须如实报告，
   * 不能假装成功——用户会以为按钮生效了。
   */
  respondApproval(approvalId: string, resolution: ApprovalResolution): boolean {
    const owner = this.pendingApprovals().find((item) => item.approval.id === approvalId);
    if (!owner) return false;
    if (!this.worker.respondApproval) return false;
    return this.worker.respondApproval(approvalId, resolution);
  }

  /**
   * Run 结束前收尾所有打开过的 lane：导出整条 lane 的累计 patch、归档最终会话、按需删除 worktree。
   * 已关闭或从未打开过的 lane 跳过；收尾失败不阻塞 Run 终态，只降级为一条风险事件。
   */
  private async closeLanes(reason: string): Promise<void> {
    // P1 之前创建的 Run 没有 lanes 字段，恢复时按「无 lane」处理。
    for (const lane of Object.values(this.store.current.lanes ?? {})) {
      if (!lane.worktreePath || lane.closed) continue;
      await this.closeLane(lane, reason);
    }
  }

  private async closeLane(lane: OrchestrationLane, reason: string): Promise<void> {
    let closed: LaneCloseResult = { kept: lane.keepWorktree };
    if (this.worker.closeLane) {
      try {
        closed = await this.worker.closeLane({ run: this.store.current, lane, reason });
      } catch (failure) {
        closed = {
          kept: true,
          error: `Lane cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        };
      }
    }
    // 收尾错误只能落在 lane.closed 里：此刻任务都已终态，task.progress 会被状态机拒绝。
    this.append({
      type: 'lane.closed',
      data: {
        laneId: lane.id,
        reason,
        patchPath: closed.patchPath,
        sessionArchivePath: closed.sessionArchivePath,
        kept: closed.kept,
        error: closed.error,
      },
    });
  }

  private appendLaneCheckpoint(result: WorkerTaskResult): void {
    const laneId = result.laneId;
    if (!laneId) return;
    if (!result.baselineTree && !result.baselineIndex) return;
    const lane = this.store.current.lanes[laneId];
    if (!lane?.worktreePath || lane.closed) return;
    if (lane.baselineTree === result.baselineTree && lane.baselineIndex === result.baselineIndex) return;
    this.append({
      type: 'lane.checkpoint',
      data: { laneId, baselineTree: result.baselineTree, baselineIndex: result.baselineIndex },
    });
  }

  private async waitForWorkerOrCancellation(pending: Promise<WorkerTaskResult>): Promise<WorkerTaskResult> {
    // A rejected worker promise is observed by the race below; this guard only prevents an
    // unhandled rejection when the scheduler gives up earlier (cancel grace timeout).
    void pending.catch(() => undefined);
    let cancelledAt: number | undefined;
    while (true) {
      const winner = await Promise.race([
        pending.then((value) => ({ kind: 'result' as const, value })),
        new Promise<{ kind: 'tick' }>((resolve) => setTimeout(() => resolve({ kind: 'tick' }), this.pollMs)),
      ]);
      if (winner.kind === 'result') return winner.value;
      this.observeCancellation();
      if (!this.store.current.cancellationRequested) continue;
      if (!this.cancellationSent) {
        this.cancellationSent = true;
        cancelledAt = Date.now();
        await this.worker.cancel('Orchestration cancellation requested.');
      } else if (cancelledAt !== undefined && Date.now() - cancelledAt >= this.cancelGraceMs) {
        return {
          outcome: 'cancelled',
          summary: '',
          changedFiles: [],
          error: 'Worker did not stop within the cancellation grace period.',
        };
      }
    }
  }

  private observeCancellation(): void {
    if (this.store.cancellationMarkerExists() && !this.store.current.cancellationRequested) {
      this.append({ type: 'run.cancel_requested', data: { reason: 'Cancellation marker observed.' } });
    }
  }

  private async cancelRun(): Promise<void> {
    if (!this.cancellationSent) {
      this.cancellationSent = true;
      await this.worker.cancel('Orchestration cancelled.');
    }
    for (const task of Object.values(this.store.current.tasks)) {
      if (!TERMINAL.has(task.status)) {
        this.append({ type: 'task.cancelled', data: { taskId: task.id, reason: 'Orchestration cancelled.' } });
      }
    }
    await this.closeLanes('run cancelled');
    this.append({ type: 'run.cancelled', data: { reason: 'Cancellation requested.' } });
  }

  private append(event: NewOrchestrationEvent): void {
    this.store.append(event);
    this.hooks.onEvent?.(event, this.store.current);
  }
}
