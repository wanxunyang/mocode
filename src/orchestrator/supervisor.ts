// Supervisor 的控制面：把「这台机器上有哪些工作区 / 哪些 Run / 怎么派活」收成一个可被
// 工具调用的对象。对话 REPL（./repl.ts）与工具集（./tools.ts）都只跟它说话。
//
// 三条不变量：
//   1. 派活绝不阻塞前台对话：scheduler.run() 挂在后台 promise 上，工具立即返回 run id。
//   2. 一个 Run 同时只有一个控制器：本对象持有 controller.lock，直到 Run 终态或进程退出。
//   3. 账本只在 Run 处于 idle / awaiting_user 时接受新任务（reducer 的硬约束）。所以「边跑边派」
//      走内存队列：任务排队，后台 Run 一进 idle 立刻落账并继续跑。这与 CLI 的「等 idle 再 dispatch」
//      是同一语义，只是把等待从人身上挪到了队列里。

import fs from 'node:fs';
import path from 'node:path';
import { OrchestrationScheduler } from './scheduler.js';
import { OrchestrationStore, listOrchestrations, orchestrationRoot, type ControllerLease } from './store.js';
import { isRunLive, isRunTerminal } from './state.js';
import { prepareDefinition } from './lanes.js';
import { HostWorkerExecutor } from './worker.js';
import { LaneReplExecutor } from './lane-executor.js';
import { formatWorkspaces, listWorkspaces, type WorkspaceInfo } from './workspaces.js';
import { appendIntegrationLog, formatIntegration, integrateRun } from './integrate.js';
import type { TerminalLaunchResult } from './terminal.js';
import type {
  ApprovalResolution,
  NewOrchestrationEvent,
  OrchestrationApproval,
  OrchestrationRun,
  RunReview,
  TaskChangePolicy,
  TaskInput,
  WorkerExecutor,
} from './types.js';

/** 后台事件的最小投影：REPL 只按这个渲染，不直接摸 Run 对象。 */
export interface SupervisorNotice {
  runId: string;
  workspaceRoot: string;
  /**
   * 两个通道，渲染位置完全不同：
   *   - `event`：状态真的变了（开始/完成/失败/审批/收尾），进对话正文，人需要读；
   *   - `activity`：Worker 在动（thinking / tool: read_file …），只进底栏一行，不进正文。
   * 混在一起就是「执行画面刷屏」——那正是这套改动要解决的问题。
   */
  channel: 'event' | 'activity';
  /** 人话一行（已含 emoji 之外的全部信息；颜色由调用方加）。 */
  text: string;
  level: 'info' | 'error';
  /** activity 通道的归属任务（底栏按它去重，同一个任务只保留最新一条）。 */
  taskId?: string;
}

/**
 * 一次「该你接手了」的唤醒请求。
 *
 * `prompt` 会作为一条**真实用户消息**交给 supervisor 的模型（不是伪造的 assistant 文本），
 * 所以它必须读起来像人说的话，且自带全部上下文——模型看不到触发它的那条事件的原文。
 */
export interface SupervisorWake {
  /** 去重键：同一 Run 的同一份状态只唤醒一次。 */
  key: string;
  runId: string;
  workspaceRoot: string;
  /** 为什么叫醒它（`idle` / `terminal` / `approval`），仅用于日志与去重。 */
  reason: 'idle' | 'terminal' | 'approval';
  /** 交给模型的原文。 */
  prompt: string;
}

export interface SupervisorOptions {
  /** Supervisor 自己的 cwd：`supervise` 的默认工作区，也是工具省略 workspace 时的落点。 */
  root: string;
  /** 额外扫描根（找带 `.mocode/sessions` 的目录）；缺省只认全局注册表 + root。 */
  scanRoots?: readonly string[];
  /** 后台事件出口（REPL 接到内容区）。 */
  onNotice?: (notice: SupervisorNotice) => void;
  /**
   * 后台「该你接手了」信号（静默唤醒）。
   *
   * 只在一波工作**落定**时触发：队列跑空、Run 终态、有人在等审批。逐条 `task.completed`
   * 不触发——五个任务并行时那是五次无效唤醒，模型只会重复念同一份状态。
   *
   * 为什么需要它：模型的回合只由人说话驱动，于是「活干完了」这件事在界面上就是一行通知，
   * 没人接手 → 用户看到的是「跑完了，然后停在那儿」。唤醒把这条断链接上，语义仍是
   * 「一次真实回合」：模型读快照、汇报、决定下一步，而不是让控制面替它做决定。
   *
   * 去重由调用方按 `key` 做：同一个 Run 的同一份状态（status + 完成数 + 待决审批数）
   * 只唤醒一次，重复事件不会连环转。
   */
  onWake?: (wake: SupervisorWake) => void;
  /** 注入 Worker 执行器（测试用）。 */
  worker?: () => WorkerExecutor;
  /**
   * 注入收工判定（测试用）。缺省走 `review.ts` 的真模型回合——那是一次最长 90s 的网络调用，
   * 放在单测里会让「等 Run 落定」变成跟后端延迟赛跑。
   */
  review?: (run: OrchestrationRun) => Promise<RunReview>;
  /**
   * 是否让 worker 跑在**可见的 mocode 窗口**里（而不是 headless host）。
   *
   * true（默认，`supervise` 对话入口）= 每个 lane 开一个真 mocode REPL：人能在那个窗口里
   * 直接打字，supervisor 也能经 lane.commands 派活。false（`--no-terminal` / CI / 测试）
   * = 退回 headless host，没有画面但控制通道最直接。
   */
  watchTerminals?: boolean;
  /** 注入开窗（测试用）：默认走 `openTerminalWindow`。 */
  openTerminal?: (options: { title: string; args: string[]; cwd?: string }) => TerminalLaunchResult;
}

export interface DispatchInput {
  workspace?: string;
  objective: string;
  title?: string;
  lane?: string;
  runId?: string;
  taskId?: string;
  dependsOn?: string[];
  requiredChecks?: string[];
  acceptanceCriteria?: string[];
  changePolicy?: TaskChangePolicy;
  allow?: string[];
  deny?: string[];
}

interface ManagedRun {
  store: OrchestrationStore;
  workspaceRoot: string;
  lease: ControllerLease;
  running: boolean;
  /** drive() 还在收尾时又来了一次「该再跑一波」：让它在 finally 里自己接上，避免丢唤醒。 */
  needsDrive: boolean;
  pending: TaskInput[];
}

/** 待落账的任务草稿：`buildTask` 把缺省值补齐成账本接受的 TaskInput。 */
interface TaskDraft {
  id?: string;
  title: string;
  objective: string;
  lane?: string;
  dependsOn?: string[];
  requiredChecks?: string[];
  acceptanceCriteria?: string[];
  changePolicy?: TaskChangePolicy;
  allow?: string[];
  deny?: string[];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** 同一任务同一条进度消息的最小间隔：调度器 250ms 一轮，不节流会把对话刷没。 */
const PROGRESS_THROTTLE_MS = 700;

/** 一行 lane 摘要：档位 + 执行现场 + 会话是否已接上。 */
function laneLine(run: OrchestrationRun, laneId: string): string {
  const lane = run.lanes[laneId];
  if (!lane) return `lane ${laneId} (unknown)`;
  const state = lane.closed ? `closed: ${lane.closed.reason}` : lane.worktreePath ? 'open' : 'idle';
  const extras = [
    lane.mode,
    state,
    lane.sessionId ? `session ${lane.sessionId}` : 'no session yet',
    lane.closed?.patchPath ? `patch ${lane.closed.patchPath}` : '',
  ].filter(Boolean);
  return `lane ${lane.id} → ${lane.workspaceRoot} [${extras.join(' · ')}]`;
}

/** 给模型看的 Run 摘要：任务、lane、收工判定、awaiting 原因。不含路径噪音以外的东西。 */
export function formatRunForModel(run: OrchestrationRun): string {
  const tasks = Object.values(run.tasks);
  const done = tasks.filter((task) => task.status === 'completed').length;
  const lines = [
    `run ${run.id} · ${run.status} · ${done}/${tasks.length} task(s) completed`,
    `objective: ${run.objective}`,
  ];
  if (run.awaitingReason) lines.push(`waiting for the user: ${run.awaitingReason}`);
  for (const lane of Object.values(run.lanes ?? {})) lines.push(laneLine(run, lane.id));
  for (const task of tasks) {
    const bits = [
      `${taskGlyph(task.status)} ${task.id} ${task.status} [lane ${task.lane}] ${task.title}`,
      task.sessionId ? `    session ${task.sessionId}` : '',
      task.error ? `    error ${task.error}` : '',
      task.output?.summary ? `    handoff ${firstLine(task.output.summary)}` : '',
      // 风险必须出现在这里：Worker 把「我没做成的那部分」写进 risks，控制面不展示就等于被吞了。
      ...(task.output?.risks ?? []).map((risk) => `    risk ${firstLine(risk)}`),
      task.lastEvent ? `    last ${task.lastEvent}` : '',
    ].filter(Boolean);
    lines.push(bits.join('\n'));
    for (const approval of Object.values(task.approvals ?? {})) {
      lines.push(`    ${approvalLine(approval)}`);
    }
  }
  if (run.lastReview) {
    lines.push(
      `review: ${run.lastReview.verdict}` +
        `${run.lastReview.rationale ? ` — ${firstLine(run.lastReview.rationale)}` : ''}` +
        `${run.lastReview.remaining.length > 0 ? `\n  remaining: ${run.lastReview.remaining.join(' | ')}` : ''}`,
    );
  }
  return lines.join('\n');
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line ? (line.length > 160 ? `${line.slice(0, 157)}…` : line) : '';
}

/** 一行审批摘要：待决时带 id（回答要用它），已定时带结论。 */
export function approvalLine(approval: OrchestrationApproval): string {
  const what = `${approval.kind === 'ask_human' ? 'question' : 'approval'} ${approval.id}: ${approval.title}`;
  if (!approval.resolved) {
    const options = approval.options.length > 0 ? ` [${approval.options.join(' / ')}]` : ' [free text]';
    return `? ${what}${options} — waiting for you`;
  }
  const resolution = approval.resolved;
  const verdict =
    resolution.action === 'cancelled'
      ? 'cancelled'
      : `${resolution.action}${resolution.value ? ` ${resolution.value}` : ''}`;
  return `· ${what} — ${verdict} (${resolution.by})`;
}

function taskGlyph(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'running' || status === 'dispatching') return '▶';
  if (status === 'failed' || status === 'interrupted') return '!';
  if (status === 'cancelled') return '×';
  return '○';
}

export class SupervisorRuntime {
  readonly root: string;
  private readonly scanRoots: readonly string[];
  private readonly onNotice: (notice: SupervisorNotice) => void;
  private readonly onWake: (wake: SupervisorWake) => void;
  private readonly workerFactory: () => WorkerExecutor;
  private readonly reviewFn?: (run: OrchestrationRun) => Promise<RunReview>;
  private workerInstance: WorkerExecutor | null = null;
  private readonly managed = new Map<string, ManagedRun>();
  /** runId → 最近一次进度消息时刻（节流用）。 */
  private readonly lastProgress = new Map<string, number>();
  /**
   * 已唤醒过的状态键。
   *
   * 唤醒的语义是「这一份状态我刚交给模型看过」，所以去重键必须含状态本身
   * （run 状态 + 完成数 + 待决审批数），而不是只含 runId——否则第二波任务跑完
   * 就再也叫不醒了。反过来，同一份状态重复上报（idle 之后又来一条终态、审批
   * 事件重放）必须只唤醒一次，否则模型会连环自言自语。
   */
  private readonly woken = new Set<string>();
  /** runId → 最近一次收工判定（唤醒原文要自带它：上屏的通知不在模型历史里）。 */
  private readonly lastReview = new Map<string, RunReview>();

  constructor(options: SupervisorOptions) {
    this.root = path.resolve(options.root);
    this.scanRoots = options.scanRoots ?? [];
    this.onNotice = options.onNotice ?? (() => undefined);
    this.onWake = options.onWake ?? (() => undefined);
    /**
     * 默认用哪种 Worker 执行器，由 `watchTerminals` 决定：
     *   - true：`LaneReplExecutor`——每个 lane 开一个**真 mocode REPL 窗口**，人也能在那儿打字；
     *   - false：`HostWorkerExecutor`——headless host 进程，没有画面，但控制通道最直接
     *     （CI / SSH / 测试都走这条）。
     * 显式传 `worker` 时一律以注入为准（测试替身必须完全可控）。
     *
     * 默认**不**开窗：`SupervisorRuntime` 是给工具/测试用的库对象，弹窗口是副作用，
     * 该由入口（supervise 对话 REPL）显式打开。默认值设成「跟随环境变量」会让单测
     * 在开发者机器上真的弹出窗口（踩过一次：跑测试时冒出一排 node 进程占住 cwd，
     * 临时目录 rm 报 EPERM）。
     */
    const watchTerminals = options.watchTerminals ?? false;
    this.workerFactory =
      options.worker ??
      (() =>
        watchTerminals
          ? new LaneReplExecutor(options.openTerminal ? { openTerminal: options.openTerminal } : {})
          : new HostWorkerExecutor());
    this.reviewFn = options.review;
  }

  private worker(): WorkerExecutor {
    if (!this.workerInstance) this.workerInstance = this.workerFactory();
    return this.workerInstance;
  }

  // ── 盘点 ──────────────────────────────────────────────────────────────────

  workspaces(options: { includeSessions?: boolean } = {}): WorkspaceInfo[] {
    return listWorkspaces({
      roots: [this.root],
      scanRoots: this.scanRoots,
      includeSessions: options.includeSessions ?? true,
    });
  }

  formatWorkspaces(): string {
    return formatWorkspaces(this.workspaces({ includeSessions: true }));
  }

  /** 跨工作区找 Run：先按 id 命中的目录判定，不做全盘遍历。 */
  findRun(runId: string): { store: OrchestrationStore; workspaceRoot: string } | undefined {
    for (const info of this.workspaces({ includeSessions: false })) {
      if (!info.exists) continue;
      if (!fs.existsSync(path.join(orchestrationRoot(info.root), path.basename(runId)))) continue;
      try {
        return { store: OrchestrationStore.load(info.root, runId), workspaceRoot: info.root };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * 取某个 Run 的权威账本：内存里已托管就直接用那份，否则从盘上 load。
   *
   * 关键约束（踩过一次）：同一 Run 绝不能同时存在两份 OrchestrationStore 实例。
   * `appendTask` 只把事件写进自己那份 store 的内存状态，另一份看不见——驱动方会以为
   * 「所有任务都已完成」，任务就永远停在 pending，Run 卡在 running。
   */
  private storeFor(workspaceRoot: string, runId: string): OrchestrationStore {
    const managed = this.managed.get(runId);
    if (managed) return managed.store;
    return OrchestrationStore.load(workspaceRoot, runId);
  }

  private requireRun(runId: string): { store: OrchestrationStore; workspaceRoot: string } {
    // 同一 Run 在内存里只能有一份账本。managed 里那份是权威实例（drive 循环持有它），
    // 另 load 一份会让两边的 current 互相看不见对方刚 append 的事件——表现为「任务已落账为
    // pending，但驱动方以为所有任务都跑完了」，run 卡在 running 再也不动。
    const managed = this.managed.get(runId);
    if (managed) return { store: managed.store, workspaceRoot: managed.workspaceRoot };
    const found = this.findRun(runId);
    if (!found) throw new Error(`no orchestration run ${runId} in any known workspace.`);
    return found;
  }

  /** 这台机器上还能接活的 Run（running / idle / awaiting_user）。 */
  liveRuns(): Array<{ run: OrchestrationRun; workspaceRoot: string }> {
    const result: Array<{ run: OrchestrationRun; workspaceRoot: string }> = [];
    for (const info of this.workspaces({ includeSessions: false })) {
      if (!info.exists) continue;
      for (const run of listOrchestrations(info.root)) {
        if (isRunLive(run)) result.push({ run, workspaceRoot: info.root });
      }
    }
    return result.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  }

  /** 每个工作区最近若干 Run（含终态，供「上次那单怎么样了」）。 */
  recentRuns(limitPerWorkspace = 3): Array<{ run: OrchestrationRun; workspaceRoot: string }> {
    const result: Array<{ run: OrchestrationRun; workspaceRoot: string }> = [];
    for (const info of this.workspaces({ includeSessions: false })) {
      if (!info.exists) continue;
      for (const run of listOrchestrations(info.root).slice(0, limitPerWorkspace)) {
        result.push({ run, workspaceRoot: info.root });
      }
    }
    return result;
  }

  status(runId?: string): string {
    if (runId) return formatRunForModel(this.requireRun(runId).store.current);
    const live = this.liveRuns();
    if (live.length === 0) return 'No live orchestration runs.';
    return live.map(({ run }) => `${run.id} · ${run.status} · ${run.objective}`).join('\n');
  }

  // ── 人工介入 ──────────────────────────────────────────────────────────────

  /**
   * 全机待决的人工介入（工具审批 / Worker 提问）。
   *
   * 只读账本，不碰 Worker 进程：因此即使控制器在别的进程里（CLI 单发的 Run），
   * 这里也能如实列出「谁在等」，只是回答不了——`respondApproval` 会返回 false。
   */
  pendingApprovals(): Array<{ run: OrchestrationRun; taskId: string; approval: OrchestrationApproval }> {
    const result: Array<{ run: OrchestrationRun; taskId: string; approval: OrchestrationApproval }> = [];
    for (const { run } of this.recentRuns(3)) {
      if (isRunTerminal(run)) continue;
      for (const task of Object.values(run.tasks)) {
        for (const approval of Object.values(task.approvals ?? {})) {
          if (!approval.resolved) result.push({ run, taskId: task.id, approval });
        }
      }
    }
    return result;
  }

  /** 一行一条待决审批，含回答时要用的 approvalId。 */
  formatApprovals(): string {
    const pending = this.pendingApprovals();
    if (pending.length === 0) return '没有待决的人工介入。';
    return pending
      .map(
        ({ run, approval }) =>
          `${approval.id}  run ${run.id}  ${approval.taskId}  ${approval.kind}\n` +
          `  ${approval.title}${approval.detail ? `\n  ${firstLine(approval.detail)}` : ''}\n` +
          `  ${approval.options.length > 0 ? approval.options.map((item, index) => `[${index + 1}] ${item}`).join('  ') : '(自由文本)'}`,
      )
      .join('\n');
  }

  /**
   * 把一个决定转给正在等它的 Worker。
   *
   * 只有「本进程托管的 Run + 该 approvalId 仍在执行器手里」才会成功。返回 false 时
   * 调用方必须如实说「这条已经不可能回答了」，不能假装成功——用户会以为按钮生效了。
   */
  respondApproval(approvalId: string, resolution: ApprovalResolution): boolean {
    const owner = this.pendingApprovals().find((item) => item.approval.id === approvalId);
    if (!owner) return false;
    const managed = this.managed.get(owner.run.id);
    if (!managed) return false;
    return this.schedulerFor(managed.store, managed.workspaceRoot).respondApproval(approvalId, resolution);
  }

  /** 便捷入口：按序号（1-based，对齐 formatApprovals）或完整 id 回答。 */
  answerApproval(target: string, action: ApprovalResolution['action'], value?: string): string {
    const pending = this.pendingApprovals();
    const index = Number.parseInt(target, 10);
    const hit = Number.isInteger(index) && String(index) === target ? pending[index - 1] : undefined;
    const picked = hit?.approval.id ?? target;
    const resolution: ApprovalResolution = {
      action,
      ...(value ? { value } : {}),
      by: 'operator',
      at: new Date().toISOString(),
    };
    if (!this.respondApproval(picked, resolution)) {
      return `approval ${picked} is no longer pending (already answered, timed out, or owned by another process).`;
    }
    return `approval ${picked} answered: ${action}${value ? ` ${value}` : ''}.`;
  }

  /**
   * 每轮对话前注入的编排快照：工作区清单（压缩）+ 在跑的 Run。
   * 只给「够判断往哪派、现在能不能派」的信息，不给完整任务表（那要 status 工具按需取）。
   */
  snapshot(): string {
    const workspaces = this.workspaces({ includeSessions: true });
    const lines: string[] = ['## Orchestration snapshot'];
    lines.push(`Supervisor cwd: ${this.root}`);
    if (workspaces.length === 0) {
      lines.push('Known workspaces: none yet (no mocode session has been started on this machine).');
    } else {
      lines.push(`Known workspaces (${workspaces.length}):`);
      for (const info of workspaces.slice(0, 12)) {
        const flags = [
          info.exists ? '' : 'missing',
          info.git ? `git:${info.branch ?? '?'}${info.dirty ? '*' : ''}` : 'no-git',
          `${info.sessions.length} session(s)`,
        ].filter(Boolean);
        const lanes =
          info.lanes.length > 0
            ? ` · open lane(s): ${info.lanes.map((l) => `${l.laneId}(${l.status})`).join(', ')}`
            : '';
        lines.push(`- ${info.root}  [${flags.join(' ')}]${lanes}`);
      }
      if (workspaces.length > 12) lines.push(`- … ${workspaces.length - 12} more (use supervise_workspaces)`);
    }
    const live = this.liveRuns();
    if (live.length === 0) {
      lines.push('Live runs: none.');
    } else {
      lines.push(`Live runs (${live.length}):`);
      for (const { run } of live.slice(0, 8)) {
        const tasks = Object.values(run.tasks);
        const active = tasks.filter((task) => task.status === 'running' || task.status === 'dispatching').length;
        const pending = this.managed.get(run.id)?.pending.length ?? 0;
        lines.push(
          `- ${run.id} · ${run.status} · ${run.workspaceRoot} · ${tasks.filter((t) => t.status === 'completed').length}/${tasks.length} done` +
            `${active > 0 ? ` · ${active} running` : ''}${pending > 0 ? ` · ${pending} queued` : ''}` +
            `${run.awaitingReason ? ` · waiting: ${firstLine(run.awaitingReason)}` : ''}`,
        );
      }
      if (live.length > 8) lines.push(`- … ${live.length - 8} more (use supervise_status)`);
    }
    // 待决的人工介入必须在快照里：它是唯一「模型不主动查就会被漏掉」的状态，
    // 而漏掉它意味着 Worker 一直停在那里等人。
    const approvals = this.pendingApprovals();
    if (approvals.length > 0) {
      lines.push(`
## Waiting for a human (${approvals.length})`);
      for (const { run, approval } of approvals.slice(0, 8)) {
        const options = approval.options.length > 0 ? ` options: ${approval.options.join(' / ')}` : ' free text';
        lines.push(
          `- run ${run.id} · ${approval.taskId} · ${approval.kind} ${approval.id}: ${approval.title}${options}`,
          `  ${approval.detail ? `detail: ${firstLine(approval.detail)}` : `requested ${approval.requestedAt}`}`,
        );
      }
      lines.push(
        'Answer with supervise_approve (or tell the operator these are waiting). The worker stays paused until answered ' +
          'and the request is denied on timeout.',
      );
    }
    return lines.join('\n');
  }

  // ── 派活 ──────────────────────────────────────────────────────────────────

  /**
   * 往某个工作区派活。
   *
   * 三种落点，按顺序判定：
   *   1. 给了 runId → 追加到那个 Run（running 时排队）；
   *   2. 该工作区有还活着的 Run → 追加到它（`接着在那个会话派活`）；
   *   3. 都没有 → 新建一个 Run（autoClose=false，跑完进 idle，lane 保持可再用）。
   */
  async dispatch(input: DispatchInput): Promise<string> {
    const workspace = path.resolve(input.workspace ?? this.root);
    if (!fs.existsSync(workspace)) throw new Error(`workspace does not exist: ${workspace}`);
    const objective = input.objective.trim();
    if (!objective) throw new Error('objective must not be empty.');
    const title = (input.title ?? firstLine(objective)).slice(0, 80);
    const taskId = input.taskId?.trim() || undefined;
    const laneId = input.lane?.trim() || undefined;

    if (input.runId) {
      const { store, workspaceRoot } = this.requireRun(input.runId);
      if (path.resolve(workspaceRoot) !== workspace && input.workspace) {
        throw new Error(
          `run ${input.runId} belongs to ${workspaceRoot}, not ${workspace}; omit workspace or pass the matching one.`,
        );
      }
      const task = this.buildTask(store.current, {
        id: taskId,
        title,
        objective,
        lane: laneId,
        dependsOn: input.dependsOn,
        requiredChecks: input.requiredChecks,
        acceptanceCriteria: input.acceptanceCriteria,
        changePolicy: input.changePolicy,
        allow: input.allow,
        deny: input.deny,
      });
      return this.enqueue(store, workspaceRoot, task);
    }

    const live = listOrchestrations(workspace).find((run) => isRunLive(run));
    if (live) {
      const store = this.storeFor(workspace, live.id);
      const task = this.buildTask(store.current, {
        id: taskId,
        title,
        objective,
        lane: laneId,
        dependsOn: input.dependsOn,
        requiredChecks: input.requiredChecks,
        acceptanceCriteria: input.acceptanceCriteria,
        changePolicy: input.changePolicy,
        allow: input.allow,
        deny: input.deny,
      });
      const note = this.enqueue(store, workspace, task);
      return `Reused the live run in ${workspace} instead of starting a new one.\n${note}`;
    }

    // 新建 Run：lane 档位按工作区能力判定（git 根 → worktree，非 git → copy）。
    // 刻意不给 inplace 入口：对话里的一句话不该直接改写真实目录。
    const definition = prepareDefinition(
      {
        objective,
        autoClose: false,
        lanes: [{ id: laneId ?? taskId ?? 'task-1', workspaceRoot: workspace }],
        tasks: [{ id: taskId ?? 'task-1', title, objective, lane: laneId ?? taskId ?? 'task-1' }],
      },
      workspace,
      false,
    );
    const store = OrchestrationStore.create(workspace, definition);
    const runId = store.current.id;
    this.start(store, workspace);
    const lane = Object.values(store.current.lanes)[0];
    return (
      `Started run ${runId} in ${workspace}.\n` +
      `${laneLine(store.current, lane.id)}\n` +
      'The worker is running in the background; the conversation stays responsive.'
    );
  }

  private buildTask(run: OrchestrationRun, input: TaskDraft): TaskInput {
    const id = input.id ?? this.nextTaskId(run, 'task');
    const lane = input.lane ?? id;
    const task: TaskInput = {
      id,
      title: input.title,
      objective: input.objective,
      lane,
      ...(input.dependsOn && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
      ...(input.requiredChecks && input.requiredChecks.length > 0 ? { requiredChecks: input.requiredChecks } : {}),
      ...(input.acceptanceCriteria && input.acceptanceCriteria.length > 0
        ? { acceptanceCriteria: input.acceptanceCriteria }
        : {}),
      ...(input.changePolicy ? { changePolicy: input.changePolicy } : {}),
      ...(input.allow || input.deny
        ? { scope: { ...(input.allow ? { allow: input.allow } : {}), ...(input.deny ? { deny: input.deny } : {}) } }
        : {}),
    };
    return task;
  }

  private nextTaskId(run: OrchestrationRun, prefix: 'task' | 'ask' | 'steer'): string {
    let index = 1;
    while (run.tasks[`${prefix}-${index}`]) index++;
    return `${prefix}-${index}`;
  }

  /** 静默态直接落账并启动；running 时排队，等这一波收尾。 */
  private enqueue(store: OrchestrationStore, workspaceRoot: string, task: TaskInput): string {
    const run = store.current;
    const managed = this.managed.get(run.id);
    if (TERMINAL.has(run.status)) {
      throw new Error(`run ${run.id} is ${run.status}; dispatch to a live run or start a new one.`);
    }
    const busy = run.status === 'running' || (managed?.running ?? false);
    if (busy) {
      if (!managed) throw new Error(`run ${run.id} is running under another controller; use ask/tell once it idles.`);
      managed.pending.push(task);
      return (
        `Queued task ${task.id} (lane ${task.lane}) on run ${run.id}: the run is still working. ` +
        'It will be added and started automatically as soon as the current batch finishes.'
      );
    }
    const scheduler = this.schedulerFor(store, workspaceRoot);
    scheduler.appendTask(task, { reopenLane: true });
    this.start(store, workspaceRoot);
    return `Added task ${task.id} (lane ${task.lane}) to run ${run.id} and started it.`;
  }

  /** `ask` / `tell` 复用的同一入口：只读回合 vs 可写纠偏。 */
  async laneTurn(kind: 'ask' | 'tell', input: { runId: string; lane: string; text: string }): Promise<string> {
    const { store } = this.requireRun(input.runId);
    const run = store.current;
    const lane = run.lanes[input.lane];
    if (!lane) throw new Error(`run ${run.id} has no lane ${input.lane}.`);
    const text = input.text.trim();
    if (!text) throw new Error(`${kind} requires a non-empty message.`);
    const task =
      kind === 'ask'
        ? this.buildTask(run, {
            id: this.nextTaskId(run, 'ask'),
            title: text.slice(0, 80),
            objective:
              `${text}\n\nThis is a status question from the operator, delivered into this lane's existing session. ` +
              'Answer from the work you already did in this session (files you read, commands you ran). ' +
              'Do not modify any file; report what is done, what is verified, and what remains.',
            lane: input.lane,
            changePolicy: 'read_only',
          })
        : this.buildTask(run, {
            id: this.nextTaskId(run, 'steer'),
            title: text.slice(0, 80),
            objective:
              `${text}\n\nThis is an operator steering message. Treat it as a binding constraint for this lane ` +
              'and act accordingly in the same session. Do not redo work that is already on disk.',
            lane: input.lane,
            changePolicy: 'isolated_write',
          });
    const note = this.enqueue(store, run.workspaceRoot, task);
    return `${kind === 'ask' ? 'Status question' : 'Steering message'} sent on lane ${input.lane}.\n${note}`;
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────────

  async closeLane(runId: string, laneId: string): Promise<string> {
    const { store, workspaceRoot } = this.requireRun(runId);
    if (store.current.status === 'running') {
      throw new Error(`run ${runId} is running; close the lane after it idles (or cancel it first).`);
    }
    const managed = this.managed.get(runId);
    const lease = managed?.lease ?? store.acquireControllerLease();
    try {
      const scheduler = this.schedulerFor(store, workspaceRoot);
      const final = await scheduler.closeLaneById(laneId, 'Closed by the supervisor.');
      return formatRunForModel(final);
    } finally {
      if (!managed) lease.release();
    }
  }

  integrate(runId: string, options: { lane?: string; apply?: boolean } = {}): string {
    const { store, workspaceRoot } = this.requireRun(runId);
    const result = integrateRun(store.current, {
      lanes: options.lane ? [options.lane] : undefined,
      apply: options.apply === true,
    });
    appendIntegrationLog(store.artifactPath('integration.jsonl'), result);
    return `${formatIntegration(result)}workspace root: ${workspaceRoot}\n`;
  }

  async review(runId: string, options: { dryRun?: boolean } = {}): Promise<string> {
    const { store, workspaceRoot } = this.requireRun(runId);
    const { reviewRun } = await import('./review.js');
    const review = await reviewRun(store.current, { dryRun: options.dryRun === true });
    if (options.dryRun !== true && !isRunTerminal(store.current)) {
      const managed = this.managed.get(runId);
      const lease = managed?.lease ?? store.acquireControllerLease();
      try {
        this.schedulerFor(store, workspaceRoot).recordReview(review);
      } finally {
        if (!managed) lease.release();
      }
    }
    return (
      `review: ${review.verdict}${review.error ? ` (error: ${review.error})` : ''}\n` +
      `${review.rationale || '(no rationale)'}` +
      `${review.remaining.length > 0 ? `\nremaining:\n${review.remaining.map((item) => `- ${item}`).join('\n')}` : ''}`
    );
  }

  async cancel(runId: string): Promise<string> {
    const { store } = this.requireRun(runId);
    if (!isRunLive(store.current)) return `run ${runId} is already ${store.current.status}.`;
    store.requestCancellation();
    return `Cancellation requested for ${runId}; the scheduler will stop its workers.`;
  }

  /** 释放所有控制器租约（不取消在跑的 Run：状态留在盘上，`supervise resume` 可续）。 */
  shutdown(): void {
    for (const managed of this.managed.values()) {
      try {
        managed.lease.release();
      } catch {
        // 释放失败最多留一个按 PID 判活的过期锁，下次 acquire 会接管。
      }
    }
    this.managed.clear();
  }

  // ── 调度 ──────────────────────────────────────────────────────────────────

  private schedulerFor(store: OrchestrationStore, workspaceRoot: string): OrchestrationScheduler {
    return new OrchestrationScheduler(
      store,
      this.worker(),
      {
        onEvent: (event, run) => this.notify(event, run, workspaceRoot),
      },
      { pollMs: 300, ...(this.reviewFn ? { review: this.reviewFn } : {}) },
    );
  }

  /** 拿到（或复用）该 Run 的控制器租约，把 scheduler.run() 挂到后台。 */
  private start(store: OrchestrationStore, workspaceRoot: string): void {
    const runId = store.current.id;
    const existing = this.managed.get(runId);
    if (existing) {
      if (existing.running) existing.needsDrive = true;
      else void this.drive(existing);
      return;
    }
    const managed: ManagedRun = {
      store,
      workspaceRoot,
      lease: store.acquireControllerLease(),
      running: false,
      needsDrive: false,
      pending: [],
    };
    this.managed.set(runId, managed);
    void this.drive(managed);
  }

  /**
   * 后台驱动循环：跑一波；跑空后若队列里有排队的任务就落账再跑，否则把控制器还给盘面
   * （Run 停在 idle / awaiting_user，等下一次 dispatch）。
   */
  private async drive(managed: ManagedRun): Promise<void> {
    if (managed.running) return;
    managed.running = true;
    try {
      for (;;) {
        const scheduler = this.schedulerFor(managed.store, managed.workspaceRoot);
        let final: OrchestrationRun;
        try {
          final = await scheduler.run();
        } catch (error) {
          this.notice(managed, `scheduler stopped: ${error instanceof Error ? error.message : String(error)}`, 'error');
          break;
        }
        if (TERMINAL.has(final.status)) break;
        const next = managed.pending.shift();
        if (!next) break;
        try {
          scheduler.appendTask(next, { reopenLane: true });
        } catch (error) {
          this.notice(
            managed,
            `could not add queued task ${next.id}: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        }
      }
    } finally {
      managed.running = false;
      // 终态 Run 的账本已冻结：控制器任务完成，交还租约。
      if (TERMINAL.has(managed.store.current.status)) {
        try {
          managed.lease.release();
        } catch {
          // ignore
        }
        this.managed.delete(managed.store.current.id);
      } else if (managed.needsDrive) {
        // 收尾途中（run() 已返回、running 还没置回）又有新任务落账：这里补跑一波。
        // 没有这个转接，派活会撞上「对话以为已启动、后台已退出循环」的静默死锁。
        managed.needsDrive = false;
        void this.drive(managed);
      }
    }
  }

  private notice(managed: ManagedRun, text: string, level: 'info' | 'error' = 'info'): void {
    this.onNotice({
      runId: managed.store.current.id,
      workspaceRoot: managed.workspaceRoot,
      channel: 'event',
      text,
      level,
    });
  }

  /**
   * 「这一波落定了，该你接手了」——把一条真实用户消息交给 supervisor 的模型。
   *
   * 三条克制（不然就是自己给自己刷屏）：
   *   1. **只在一波落定时叫**：idle / 终态 / 等审批。逐条 `task.completed` 不叫——五个任务
   *      并行时那是五次无效唤醒，模型每次都只能念同一份状态。
   *   2. **同一份状态只叫一次**：去重键含状态本身（status + 完成数 + 待决审批数），
   *      所以第二波任务跑完照样叫得醒，而重复上报的事件不会连环转。
   *   3. **提示词自带上下文**：上屏的 `emit` 通知不进模型历史，光说「活干完了」它会去猜。
   */
  private wake(run: OrchestrationRun, workspaceRoot: string, reason: SupervisorWake['reason']): void {
    const tasks = Object.values(run.tasks);
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const approvals = this.pendingApprovals().length;
    const key = `${run.id}:${run.status}:${completed}/${tasks.length}:${approvals}`;
    if (this.woken.has(key)) return;
    this.woken.add(key);

    const head =
      reason === 'approval'
        ? `后台等你决定：run ${run.id}`
        : reason === 'terminal'
          ? `后台有 run 收尾了：run ${run.id}`
          : `后台这一波干完了：run ${run.id}`;
    const review = this.lastReview.get(run.id);
    const lines = [
      `${head}（${workspaceRoot}，${completed}/${tasks.length} 个任务完成，状态 ${run.status}）。`,
      '这段是系统通知，不是你自己的话：请现在查一下（supervise_status），',
      reason === 'approval'
        ? '把等你的审批念清楚并给出可选项，等我决定；在我回答之前不要自行放行。'
        : '如实汇报结果与风险，然后判断收工还是继续派活；需要验收的（close/integrate）先说明再问。',
    ];
    if (review) {
      lines.push(
        `上一轮的收工判定是 ${review.verdict}${review.rationale ? `（${firstLine(review.rationale)}）` : ''}` +
          `${review.remaining.length > 0 ? `，剩余：${review.remaining.map(firstLine).join(' | ')}` : ''}。`,
      );
    }
    this.onWake({ key, runId: run.id, workspaceRoot, reason, prompt: lines.join('\n') });
  }

  /** 把调度器事件压成一行人话：状态变化进正文，执行进度只进底栏。 */
  private notify(event: NewOrchestrationEvent, run: OrchestrationRun, workspaceRoot: string): void {
    const emit = (text: string, level: 'info' | 'error' = 'info'): void => {
      this.onNotice({ runId: run.id, workspaceRoot, channel: 'event', text, level });
    };
    /**
     * 只有「谁在动、动到哪一步」这一层走 activity 通道——它每几百毫秒就来一条，
     * 写进正文会把对话刷没（这正是独立终端窗口要解决的那件事）。
     */
    const activity = (taskId: string, text: string): void => {
      this.onNotice({ runId: run.id, workspaceRoot, channel: 'activity', text, level: 'info', taskId });
    };
    switch (event.type) {
      case 'run.created':
      case 'task.ready':
      case 'lane.checkpoint':
        return;
      case 'run.reviewed': {
        // 这次判定真花了一次模型回合（最长 90s），结论却只落盘不上屏，等于纯亏。
        // 把它当正式通知显出来：用户要知道「系统自己认为收没收工」。
        const review = event.data.review;
        this.lastReview.set(run.id, review);
        const remaining =
          review.remaining.length > 0 ? ` · remaining: ${review.remaining.map(firstLine).join(' | ')}` : '';
        emit(
          `review: ${review.verdict}${review.error ? ` (error: ${firstLine(review.error)})` : ''}` +
            `${review.rationale ? ` — ${firstLine(review.rationale)}` : ''}${remaining}`,
          review.verdict === 'continue' ? 'error' : 'info',
        );
        return;
      }
      case 'task.progress': {
        const key = `${run.id}:${event.data.taskId}`;
        const last = this.lastProgress.get(key) ?? 0;
        const now = Date.now();
        if (now - last < PROGRESS_THROTTLE_MS) return;
        this.lastProgress.set(key, now);
        activity(event.data.taskId, event.data.message);
        return;
      }
      case 'task.started':
        emit(`${event.data.taskId} started${event.data.sessionId ? ` · session ${event.data.sessionId}` : ''}`);
        return;
      case 'task.completed': {
        const summary = firstLine(event.data.handoff.summary);
        emit(`${event.data.taskId} ✓ done${summary ? ` — ${summary}` : ''}`);
        return;
      }
      case 'task.failed':
      case 'task.interrupted':
        emit(
          `${event.data.taskId} ${event.type === 'task.failed' ? 'failed' : 'interrupted'} — ${firstLine(event.data.error)}`,
          'error',
        );
        return;
      case 'task.approval_requested': {
        // 这一条必须显眼：Worker 已经停下来等人了，汇报里不能只当成一条普通进度。
        const approval = event.data.approval;
        const options = approval.options.length > 0 ? ` [${approval.options.join(' / ')}]` : ' [free text]';
        emit(
          `${event.data.taskId} needs a human · ${approval.kind} ${approval.id}: ${approval.title}${options} — /approvals or supervise_approve`,
          'error',
        );
        // 人也得被叫一声：Worker 就停在那里不动，不叫的话这个 Run 就是静默卡死。
        this.wake(run, workspaceRoot, 'approval');
        return;
      }
      case 'task.approval_resolved':
        emit(
          `approval ${event.data.approvalId} ${event.data.resolution.by === 'timeout' ? 'timed out — denied' : 'answered'}`,
        );
        return;
      case 'task.deferred':
      case 'conflict.serialized':
        return;
      case 'lane.opened':
        emit(`lane ${event.data.laneId} opened at ${event.data.worktreePath}`);
        return;
      case 'lane.closed':
        emit(
          `lane ${event.data.laneId} closed${event.data.patchPath ? ` · patch ${event.data.patchPath}` : ''}` +
            `${event.data.error ? ` · ${event.data.error}` : ''}`,
          event.data.error ? 'error' : 'info',
        );
        return;
      case 'run.idle':
        emit(
          `run idle — ${Object.values(run.tasks).filter((task) => task.status === 'completed').length} task(s) done, lanes kept open. Add more work or close the lane.`,
        );
        // 断链就在这里：活干完了只有一行通知，没人接手 → 用户看到「跑完了，然后停在那儿」。
        this.wake(run, workspaceRoot, 'idle');
        return;
      case 'run.awaiting_user':
        emit(`run is waiting for you — ${event.data.reason}`, 'error');
        this.wake(run, workspaceRoot, 'approval');
        return;
      case 'run.completed':
        emit('run completed.');
        this.wake(run, workspaceRoot, 'terminal');
        return;
      case 'run.failed':
        emit(`run failed${event.data.reason ? ` — ${event.data.reason}` : ''}`, 'error');
        this.wake(run, workspaceRoot, 'terminal');
        return;
      case 'run.cancelled':
        emit('run cancelled.', 'error');
        this.wake(run, workspaceRoot, 'terminal');
        return;
      default:
        return;
    }
  }
}
