export const ORCHESTRATION_SCHEMA_VERSION = 1;

/**
 * - `running`：在跑；
 * - `idle`：队列跑空但 Run 未关闭，可继续追加任务（v2 长驻 lane）；
 * - `awaiting_user`：卡在需要人决定的事上（预算耗尽 / 重试耗尽 / 收工判定建议继续），
 *   现场与 lane 全部保留，`dispatch` 或 `resume` 可以把它唤醒回 `running`；
 * - `completed` / `failed` / `cancelled` 为终态，账本冻结。
 */
export type OrchestrationRunStatus = 'running' | 'idle' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled';

/**
 * 执行现场档位：
 * - `worktree`：git 仓库，`git worktree` 隔离（P1 行为）；
 * - `copy`：非 git 目录，复制一份副本执行，原目录零改动；
 * - `inplace`：直接改原目录，必须用户显式同意（`--allow-inplace`）。
 */
export type LaneMode = 'worktree' | 'copy' | 'inplace';
export type OrchestrationTaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type TaskChangePolicy = 'read_only' | 'isolated_write';

export interface TaskContract {
  objective: string;
  scope: { allow: string[]; deny: string[] };
  acceptanceCriteria: string[];
  requiredChecks: string[];
  changePolicy: TaskChangePolicy;
}

export interface TaskInput {
  id: string;
  title: string;
  objective: string;
  dependsOn?: string[];
  scope?: { allow?: string[]; deny?: string[] };
  acceptanceCriteria?: string[];
  requiredChecks?: string[];
  changePolicy?: TaskChangePolicy;
  maxAttempts?: number;
  /** 共享执行通道；同 lane 的任务复用同一个 worktree 与 mocode 会话。缺省为任务 id。 */
  lane?: string;
}

/**
 * Lane = 工作区 + worktree + mocode 会话 组成的可复用执行通道。
 * 同 lane 的后续任务接着上一次的现场干活，而不是从 HEAD 重新开一份。
 */
export interface LaneInput {
  id: string;
  /** 工作区（worktree 宿主仓库根 / 副本源目录 / 原地目录）；缺省为 Run 的 workspaceRoot。 */
  workspaceRoot?: string;
  /** 执行现场档位；缺省按工作区是否 git 仓库自动选。 */
  mode?: LaneMode;
  /** 允许原地写（对应 CLI `--allow-inplace`）；只有 mode=inplace 时生效。 */
  allowInplace?: boolean;
  /** Run 结束后保留执行现场供人工检查（默认删除；inplace 无现场可删）。 */
  keepWorktree?: boolean;
}

export interface OrchestrationDefinition {
  objective: string;
  tasks: TaskInput[];
  lanes?: LaneInput[];
  /**
   * 队列跑空后是否直接收尾。默认 false：Run 进入 `idle` 等待继续派活（长驻 lane），
   * 只有显式 close / 全部完成后自动收尾才落终态。
   */
  autoClose?: boolean;
  /** 并发与收工判定策略；缺省值见 `DEFAULT_RUN_POLICY`。 */
  policy?: Partial<RunPolicy>;
}

/**
 * 一次 Run 的调度策略。
 *
 * 并行只对**隔离现场**（worktree / copy）有意义：每条 lane 各有自己的目录，互不干扰；
 * `inplace` 档直接写用户目录，必须独占（见 `src/orchestrator/lease.ts`）。
 */
export interface RunPolicy {
  /** 同时在跑的 Worker 上限（默认 6）。 */
  maxConcurrentWorkers: number;
  /** 同一个工作区同时在跑的 Worker 上限（隔离现场默认 6；inplace 恒为 1）。 */
  maxConcurrentPerWorkspace: number;
  /** 队列跑空时是否唤醒 Supervisor 做收工判定（默认 true：进 idle 前先给一次建议）。 */
  reviewOnIdle: boolean;
  /** 整趟 Run 的限额；超限后停止派发并进 `awaiting_user`，不杀已在跑的任务。 */
  budget?: RunBudget;
}

/**
 * 一趟 Run 的硬限额。两个字段都可省略（省略=不限）。它只做「别把账户跑穿」的兜底，
 * 不是精确计费：token 来自各 Worker 上报的 usage，缺报按 0 计；壁钟从 Run 创建时刻起算。
 */
export interface RunBudget {
  /** 整趟 Run 累计 token 上限（输入+输出）。 */
  maxTokensPerRun?: number;
  /** 整趟 Run 壁钟上限（毫秒）。 */
  maxWallClockMs?: number;
}

/** Run 已消耗量；由 reducer 从各任务 usage 累加，不以 Worker 自报整趟为准。 */
export interface RunUsage {
  tokens: number;
  /** 最近一次刷新时的壁钟毫秒数。 */
  wallClockMs: number;
}

/** Supervisor 在 idle 时对「是否收工」给出的结论；只是建议，收工仍由用户 close 决定。 */
export interface RunReview {
  verdict: 'done' | 'continue' | 'unknown';
  rationale: string;
  remaining: string[];
  createdAt: string;
  /** 判定失败时记录原因；run 不受影响，只是这一轮没有建议。 */
  error?: string;
}

export interface TaskValidation {
  command: string;
  status: 'passed' | 'failed' | 'not_reported';
  detail?: string;
}

export interface TaskHandoff {
  taskId: string;
  attempt: number;
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  summary: string;
  changedFiles: string[];
  validation: TaskValidation[];
  artifacts: string[];
  risks: string[];
  /** 本次 attempt 消耗的 token（Host 上报 usage 时才有）。 */
  tokens?: number;
}

export interface OrchestrationLane {
  id: string;
  workspaceRoot: string;
  /** 执行现场档位；P1 创建的 lane 没有该字段，按 `worktree` 处理。 */
  mode: LaneMode;
  /** 是否已获得原地写授权；未授权时 inplace 档位会被拒绝。 */
  allowInplace: boolean;
  keepWorktree: boolean;
  /** 实际执行目录：worktree 为 `wt-*`，copy 为副本路径，inplace 即 workspaceRoot。 */
  worktreePath?: string;
  /** 打开 lane 时的 tree，用于导出整条 lane 的累计 patch。 */
  baseTree?: string;
  /** 打开 lane 时（或副本创建时）的目录索引快照路径，非 git 档位的累计 diff 基线。 */
  baseIndex?: string;
  /** 上一次 attempt 结束时的 tree；本次 attempt 的 patch 相对它计算。 */
  baselineTree?: string;
  /** 非 git 档位：上一次 attempt 结束时的目录索引快照路径（与 baselineTree 同义）。 */
  baselineIndex?: string;
  sessionId?: string;
  closed?: {
    reason: string;
    patchPath?: string;
    sessionArchivePath?: string;
    kept: boolean;
    error?: string;
  };
}

export interface OrchestrationTask {
  id: string;
  /** 本任务所属 lane。 */
  lane: string;
  title: string;
  contract: TaskContract;
  dependsOn: string[];
  status: OrchestrationTaskStatus;
  attempts: number;
  maxAttempts: number;
  workerId?: string;
  sessionId?: string;
  workspacePath?: string;
  patchPath?: string;
  sessionArchivePath?: string;
  lastEvent?: string;
  error?: string;
  output?: TaskHandoff;
  /**
   * 这条任务的「人工介入」请求（工具审批 / ask_human），按 approvalId 索引。
   * 存在的意义是在 Worker 卡住等人时，控制面（status / 工作台 / 对话）能看见「它在问什么」，
   * 并把人的回答送回同一个 Host 进程。`resolved` 一旦落定就只读留档，供事后审计。
   */
  approvals?: Record<string, OrchestrationApproval>;
  startedAt?: string;
  finishedAt?: string;
}

/** 人的回答：映射到 Host 的 `approval` 命令（selected / submitted / cancelled）。 */
export interface ApprovalResolution {
  action: 'selected' | 'submitted' | 'cancelled';
  value?: string;
  /**
   * 谁做的决定：`operator` 操作者经控制面回答；`policy` 无人值守策略直接拒绝（CLI 单发）；
   * `timeout` 等到超时也没人回答，按拒绝兜底。
   */
  by: 'operator' | 'policy' | 'timeout';
  at: string;
}

/**
 * 一次人工介入请求。
 *
 * `kind`：`permission` 是 mocode 的工具权限面板（写文件、跑命令…），`ask_human` 是 Worker 主动提问。
 * 两者走同一条通道，因为对控制面来说它们是同一件事——「有个 Host 进程停在这里等一个答案」。
 */
export interface OrchestrationApproval {
  id: string;
  taskId: string;
  kind: 'permission' | 'ask_human';
  title: string;
  detail?: string;
  /** 可选项标签（原样来自 InterventionRequest）；空数组表示需要自由文本。 */
  options: string[];
  requestedAt: string;
  resolved?: ApprovalResolution;
}

export interface OrchestrationRun {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  id: string;
  objective: string;
  workspaceRoot: string;
  status: OrchestrationRunStatus;
  sequence: number;
  tasks: Record<string, OrchestrationTask>;
  lanes: Record<string, OrchestrationLane>;
  /** 队列跑空后直接收尾（true）还是进入 idle 等待继续派活（false，默认）。 */
  autoClose: boolean;
  /** 并发与收工判定策略。 */
  policy: RunPolicy;
  /** 最近一次 Supervisor 收工判定（idle / awaiting_user 时产生）。 */
  lastReview?: RunReview;
  /** 已完成任务的 token 累计（预算判定的依据）。 */
  usage?: RunUsage;
  /**
   * 预算计时段起点：缺省为 `createdAt`；每次 `run.resumed` 把它推到当前时刻并清零 usage。
   * 语义是「一段连续自主工作」的花费上限，人一旦介入（resume / dispatch）就重新计时。
   */
  budgetWindowStart?: string;
  /** 进入 `awaiting_user` 的原因；唤醒后清空。 */
  awaitingReason?: string;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EventBase<T extends string, D> {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  sequence: number;
  timestamp: string;
  type: T;
  data: D;
}

export type OrchestrationEvent =
  | EventBase<'run.created', { run: OrchestrationRun }>
  | EventBase<'task.ready', { taskId: string; reason: 'dependencies_satisfied' | 'retry' | 'recovery' }>
  | EventBase<'task.dispatching', { taskId: string; attempt: number; workerId: string; workspacePath?: string }>
  | EventBase<'task.started', { taskId: string; sessionId?: string; workspacePath?: string }>
  | EventBase<'task.progress', { taskId: string; message: string; sessionId?: string }>
  | EventBase<
      'task.completed',
      {
        taskId: string;
        handoff: TaskHandoff;
        sessionId?: string;
        workspacePath?: string;
        patchPath?: string;
        sessionArchivePath?: string;
      }
    >
  | EventBase<
      'task.failed' | 'task.interrupted',
      {
        taskId: string;
        error: string;
        handoff?: TaskHandoff;
        sessionId?: string;
        workspacePath?: string;
        patchPath?: string;
        sessionArchivePath?: string;
      }
    >
  | EventBase<'task.cancelled', { taskId: string; reason: string }>
  | EventBase<'lane.opened', { laneId: string; worktreePath: string; baseTree?: string; baseIndex?: string }>
  | EventBase<'lane.session', { laneId: string; sessionId: string }>
  | EventBase<'lane.checkpoint', { laneId: string; baselineTree?: string; baselineIndex?: string }>
  | EventBase<
      'lane.closed',
      {
        laneId: string;
        reason: string;
        patchPath?: string;
        sessionArchivePath?: string;
        kept: boolean;
        error?: string;
      }
    >
  | EventBase<'task.approval_requested', { taskId: string; approval: OrchestrationApproval }>
  | EventBase<'task.approval_resolved', { taskId: string; approvalId: string; resolution: ApprovalResolution }>
  | EventBase<'task.added', { task: TaskInput }>
  | EventBase<
      'task.deferred',
      { taskId: string; reason: 'lane_busy' | 'workspace_lease' | 'scope_overlap'; blockedBy?: string }
    >
  | EventBase<'conflict.serialized', { taskId: string; blockedBy: string; overlap: 'scope' | 'workspace' }>
  | EventBase<'run.reviewed', { review: RunReview }>
  | EventBase<'run.budget_exhausted', { limit: 'tokens' | 'wall_clock'; used: number }>
  | EventBase<'run.awaiting_user', { reason: string }>
  | EventBase<'lane.reopened', { laneId: string }>
  | EventBase<'run.idle', { reason: 'queue_drained' }>
  | EventBase<'run.resumed', { reason: string }>
  | EventBase<'run.cancel_requested', { reason: string }>
  | EventBase<'run.completed' | 'run.failed' | 'run.cancelled', { reason?: string }>;

export type NewOrchestrationEvent = OrchestrationEvent extends infer E
  ? E extends OrchestrationEvent
    ? Omit<E, 'schemaVersion' | 'sequence' | 'timestamp'>
    : never
  : never;

export interface WorkerProgress {
  message: string;
  sessionId?: string;
  workspacePath?: string;
  started?: boolean;
  /** 首次上报 lane 的执行现场时置 opened=true，并带打开时的基线（git=baseTree，非 git=baseIndex）。 */
  lane?: { opened: boolean; baseTree?: string; baseIndex?: string };
  /**
   * 人工介入：`requested` 表示 Worker 停下来等人，`resolved` 表示答案已落定（含超时兜底）。
   * 控制面据此落 `task.approval_*` 事件；同一条 progress 仍带 message，旧消费方不会失明。
   */
  approval?:
    | {
        state: 'requested';
        id: string;
        kind: OrchestrationApproval['kind'];
        title: string;
        detail?: string;
        options: string[];
      }
    | { state: 'resolved'; id: string; resolution: ApprovalResolution };
}

export interface WorkerTaskResult {
  outcome: TaskHandoff['outcome'];
  summary: string;
  changedFiles: string[];
  sessionId?: string;
  workspacePath?: string;
  patchPath?: string;
  sessionArchivePath?: string;
  validation?: TaskValidation[];
  risks?: string[];
  error?: string;
  laneId?: string;
  /** 本次 attempt 使用的执行现场（worktree / 副本 / 原地目录）。 */
  worktreePath?: string;
  /** 本次 attempt 结束后的 tree，作为同 lane 下一个 attempt 的 diff 基线。 */
  baselineTree?: string;
  /** 非 git 档位：本次 attempt 结束后的目录索引快照路径。 */
  baselineIndex?: string;
  /** 成果无法安全归档时置 true，要求调用方保留 worktree。 */
  keepWorktree?: boolean;
  /** 本次 attempt 消耗的 token（来自 Host 的 run_completed.usage）；用于 Run 预算累计。 */
  tokens?: number;
}

/** 派发给 Worker 的 lane 现场；worktreePath/sessionId 存在即可续接。 */
export interface LaneRequest {
  id: string;
  workspaceRoot: string;
  mode: LaneMode;
  worktreePath?: string;
  baseTree?: string;
  baselineTree?: string;
  baselineIndex?: string;
  sessionId?: string;
  keepWorktree: boolean;
  /** 用户已确认原地写（`--allow-inplace`）；未确认时 inplace 档位必须被拒绝。 */
  allowInplace?: boolean;
}

export interface WorkerTaskRequest {
  run: OrchestrationRun;
  task: OrchestrationTask;
  attempt: number;
  workerId: string;
  lane?: LaneRequest;
}

export interface LaneCloseRequest {
  run: OrchestrationRun;
  lane: OrchestrationLane;
  reason: string;
}

export interface LaneCloseResult {
  /** git 档位写 lane.patch，非 git 档位写 lane.diff。 */
  patchPath?: string;
  sessionArchivePath?: string;
  /** worktree 是否被保留（成果未能归档，或 lane 显式要求保留）。 */
  kept: boolean;
  error?: string;
}

export interface WorkerExecutor {
  run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult>;
  cancel(reason?: string): Promise<void>;
  /** 收尾一条 lane：导出累计 patch、归档会话，再决定是否删除 worktree。 */
  closeLane?(request: LaneCloseRequest): Promise<LaneCloseResult>;
  /**
   * 回答一个挂起中的人工介入请求。返回 false 表示这个 approvalId 不在本执行器手里
   * （已超时/已被回答/不是它派的）——控制面据此报错，而不是假装成功。
   * 不实现该方法的执行器（例如只做脚本回放的测试替身）视为「不支持人工介入」。
   */
  respondApproval?(approvalId: string, resolution: ApprovalResolution): boolean;
}
