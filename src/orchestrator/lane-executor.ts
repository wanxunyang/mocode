// 可视执行器：把「派活」变成「在那个窗口里说一句话」。
//
// 与 `HostWorkerExecutor` 的分工，一句话说清：
//   - headless：spawn 一个 agent host 进程，stdout 走 NDJSON 控制通道，没人看得见它；
//   - 本执行器：spawn 一个**真的 mocode REPL 窗口**，控制面通过 lane.commands 说话、
//     通过 lane.events 收结论。画面就是这个终端本身，人随时能接管打字。
//
// 三条由此产生的差异（不是遗漏，是有意的）：
//   1. **不镜像输出**。要复制一份流式正文出来，就得在 REPL 里再插一层画屏钩子，
//      那正好破坏「跟手敲 mocode 一模一样」这个目标。
//   2. **审批在那个窗口里回答**。它是真 TTY、真权限面板，人在屏幕前按一下即可；
//      控制面的 `/approve` 只对 headless worker 有意义。
//   3. **进程死了就是死了**。窗口被关掉时这一轮不可能有结论，按 failed 上报并让下一次
//      attempt 重开窗口，而不是假装还在跑。

import fs from 'node:fs';
import path from 'node:path';
import { LaneSite, type ExecSite, type LaneSiteOptions } from './lane-site.js';
import {
  appendLaneCommand,
  clearLaneStop,
  laneChannelPaths,
  readChannel,
  requestLaneStop,
  type LaneChannelPaths,
  type LaneEvent,
} from './lane-channel.js';
import { handoffViolation, parseHandoff, taskPrompt } from './task-prompt.js';
import { openTerminalWindow, type TerminalLaunchResult } from './terminal.js';
import type {
  ApprovalResolution,
  LaneCloseRequest,
  LaneCloseResult,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from './types.js';

export interface LaneReplExecutorOptions extends LaneSiteOptions {
  /** 注入开窗（测试用）：默认走 `openTerminalWindow`。 */
  openTerminal?: (options: { title: string; args: string[]; cwd?: string }) => TerminalLaunchResult;
  /** 窗口起来到 ready 的等待上限；默认 30s（REPL 要加载配置、MCP、记忆）。 */
  readyTimeoutMs?: number;
  /** 轮询通道的间隔；默认 300ms，与调度器同量级。 */
  pollMs?: number;
  /**
   * 请求关窗后等它自己退的宽限；默认 5s。
   *
   * 这不是礼貌，是必须的：Windows 上 `process.kill` 走 TerminateProcess，目标进程的
   * exit / SIGTERM 处理器一个都不跑，`exitAltScreen()` 就永远执行不到——终端留在
   * alt screen 里，画面还在、滚轮翻不动、点哪都没反应。所以先请它自己走正常退出路径。
   */
  stopGraceMs?: number;
}

interface LaneProcess {
  key: string;
  runId: string;
  laneId: string;
  workspaceRoot: string;
  /** 窗口进程 pid（ready 事件带的）；没有它就只能靠 exit 事件判定。 */
  pid?: number;
  /** 窗口里那个 REPL 的会话 id：必须回传账本，否则后续任务接不上同一段对话、收尾也归档不到。 */
  sessionId?: string;
  /** 本次窗口的标记：只认带同一标记的 ready，旧进程的 ready 已经过期。 */
  launch: string;
  consumed: number;
  /** 已开窗但还没收到 ready。 */
  ready: boolean;
  /** 这个窗口已经关掉了（exit 事件或 pid 消失）。 */
  dead: boolean;
  /** 在等结论的那条指令。 */
  waiting?: {
    id: string;
    resolve: (event: Extract<LaneEvent, { kind: 'turn.finished' }> | null) => void;
  };
}

/** pid 还活着吗。用于「窗口被关掉但没有 exit 事件」（比如被外部 taskkill）。 */
function processAlive(pid: number | undefined): boolean {
  if (!pid) return true; // 不知道 pid 就别乱判死
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LaneReplExecutor implements WorkerExecutor {
  private readonly site: LaneSite;
  private readonly openTerminal: NonNullable<LaneReplExecutorOptions['openTerminal']>;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly stopGraceMs: number;
  /** `runId:laneId` → 那个 lane 的窗口进程。一个 lane 同时只跑一个任务（调度器保证）。 */
  private readonly lanes = new Map<string, LaneProcess>();
  /** 被取消的 lane key：正在跑的那一轮要在下一次轮询时收手。 */
  private readonly cancelled = new Set<string>();

  constructor(options: LaneReplExecutorOptions = {}) {
    this.site = new LaneSite(options);
    this.openTerminal = options.openTerminal ?? openTerminalWindow;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 300;
    this.stopGraceMs = options.stopGraceMs ?? 15_000;
  }

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    const lane = request.lane;
    const laneId = lane?.id ?? request.task.id;
    let site: ExecSite;
    try {
      site = this.site.openExecution(lane, request);
    } catch (error) {
      return {
        outcome: 'failed',
        summary: 'Worker isolation could not be created.',
        changedFiles: [],
        error: error instanceof Error ? error.message : String(error),
        laneId: lane?.id,
      };
    }
    if (site.created) {
      try {
        const base = this.site.baseFor(site, request, lane);
        onProgress({
          message: site.mode === 'worktree' ? 'lane opened' : `lane opened (${site.mode})`,
          workspacePath: site.path,
          lane: { opened: true, baseTree: base.baseTree, baseIndex: base.baseIndex },
        });
      } catch (error) {
        return {
          outcome: 'failed',
          summary: 'Lane baseline could not be captured.',
          changedFiles: [],
          error: error instanceof Error ? error.message : String(error),
          laneId: lane?.id,
          worktreePath: site.path,
          keepWorktree: true,
        };
      }
    }

    const paths = laneChannelPaths(request.run.workspaceRoot, request.run.id, laneId);
    const ready = await this.ensureWindow(request, site, laneId, paths, onProgress);
    if (!ready.ok) {
      return { outcome: 'failed', summary: '', changedFiles: [], error: ready.error, laneId, worktreePath: site.path };
    }
    const process_ = ready.process;
    const commandId = `${request.task.id}#${request.attempt}`;
    appendLaneCommand(paths, {
      t: Date.now(),
      id: commandId,
      taskId: request.task.id,
      kind: 'task',
      text: taskPrompt(request, { interactive: true }),
    });
    // sessionId 必须上报：账本据此落 `lane.session`，后续任务才能续同一段对话，
    // 收尾时也才有会话可归档。窗口的 ready 里带的就是它。
    onProgress({
      message: 'worker started',
      workspacePath: site.path,
      started: true,
      ...(process_.sessionId ? { sessionId: process_.sessionId } : {}),
    });

    const finished = await this.waitForTurn(process_, commandId);
    // 这一轮不管是正常结束、被取消、还是窗口没了，都先把现场差分收上来：
    // 半途失败恰恰最需要看到「已经改了什么」。
    const collected = this.collect(request, site, lane, onProgress);
    if (!finished) {
      // 先取出再判：`delete` 之后 `has` 恒为 false，问「是不是被取消」必须用返回值。
      const cancelled = this.cancelled.delete(process_.key);
      return {
        ...collected,
        outcome: cancelled ? 'cancelled' : 'failed',
        summary: '',
        error: cancelled
          ? 'The lane window was stopped by the operator.'
          : 'The lane window closed before this task finished.',
        laneId,
        worktreePath: site.path,
      };
    }
    const parsed = parseHandoff(finished.summary ?? '');
    const violation = handoffViolation(request, parsed);
    const outcome = finished.outcome === 'completed' && !violation ? 'completed' : 'failed';
    return {
      ...collected,
      outcome,
      summary: parsed.summary,
      validation: parsed.validation,
      risks: parsed.risks,
      ...(outcome === 'completed'
        ? {}
        : { error: violation ?? finished.error ?? `Worker stopped: ${finished.outcome}` }),
      laneId,
      worktreePath: site.path,
    };
  }

  /** 开窗一次，等到 `ready`。同一个 lane 的后续任务复用这个窗口（会话就在里面）。 */
  private async ensureWindow(
    request: WorkerTaskRequest,
    site: ExecSite,
    laneId: string,
    paths: LaneChannelPaths,
    onProgress: (progress: WorkerProgress) => void,
  ): Promise<{ ok: true; process: LaneProcess } | { ok: false; error: string }> {
    const key = `${request.run.id}:${laneId}`;
    const existing = this.lanes.get(key);
    if (existing && !existing.dead) {
      if (!existing.ready) await this.waitReady(existing);
      if (existing.ready) return { ok: true, process: existing };
    }
    this.lanes.delete(key);
    this.cancelled.delete(key);

    const launch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const opened = this.openTerminal({
      title: `mocode · ${laneId} · ${request.run.id}`,
      cwd: site.path,
      args: [
        'supervise',
        'lane',
        request.run.id,
        '--lane',
        laneId,
        '--launch',
        launch,
        // 必须显式给账本根：窗口 cwd 是 lane 执行现场（worktree / 副本），
        // 那里的 `.mocode/orchestrations` 根本不存在（worktree 基于 HEAD，副本还排除了 .mocode），
        // 不给这个参数 `supervise lane` 会立刻报「run 不存在」，窗口一闪就退。
        '--sandbox-root',
        request.run.workspaceRoot,
      ],
    });
    if (!opened.opened) {
      // 开不出窗口不是「任务失败」的合理理由，但这里确实没法继续：没有 TTY 就没有 REPL。
      // 调用方（supervisor）在无终端环境应改用 headless 执行器。
      return {
        ok: false,
        error: 'could not open a terminal window for this lane; fall back to a headless worker (--no-terminal).',
      };
    }
    const process_: LaneProcess = {
      key,
      runId: request.run.id,
      laneId,
      workspaceRoot: request.run.workspaceRoot,
      launch,
      consumed: 0,
      ready: false,
      dead: false,
    };
    this.lanes.set(key, process_);
    onProgress({ message: 'lane window opened', workspacePath: site.path });
    const ready = await this.waitReady(process_);
    if (!ready) {
      return {
        ok: false,
        error: `the lane window did not become ready within ${Math.round(this.readyTimeoutMs / 1000)}s.`,
      };
    }
    return { ok: true, process: process_ };
  }

  /** 轮询到 ready（带本次 launch 标记）。同时把 `turn.finished` 分发给等待方。 */
  private async waitReady(process_: LaneProcess): Promise<boolean> {
    const paths = laneChannelPaths(process_.workspaceRoot, process_.runId, process_.laneId);
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      this.pump(process_, paths);
      if (process_.ready) return true;
      if (process_.dead) return false;
      await sleep(this.pollMs);
    }
    return false;
  }

  private async waitForTurn(
    process_: LaneProcess,
    commandId: string,
  ): Promise<Extract<LaneEvent, { kind: 'turn.finished' }> | null> {
    const paths = laneChannelPaths(process_.workspaceRoot, process_.runId, process_.laneId);
    // 注意顺序：先建 promise、再起轮询、最后才 await。写成 `await new Promise(...)` 会让
    // 轮询根本没机会启动（await 卡在原地），表现是「任务永远不结束」。
    let resolve!: (event: Extract<LaneEvent, { kind: 'turn.finished' }> | null) => void;
    const result = new Promise<Extract<LaneEvent, { kind: 'turn.finished' }> | null>((done) => {
      resolve = done;
      process_.waiting = { id: commandId, resolve: done };
    });
    const timer = setInterval(() => {
      this.pump(process_, paths);
      // 取消 / 窗口消失时 pump 未必能 settle（它只在「有等待方」时发结论），这里补一刀。
      if (this.cancelled.has(process_.key) || process_.dead) this.settle(process_, null);
    }, this.pollMs);
    timer.unref?.();
    try {
      return await result;
    } finally {
      clearInterval(timer);
      process_.waiting = undefined;
      void resolve;
    }
  }

  private settle(process_: LaneProcess, event: Extract<LaneEvent, { kind: 'turn.finished' }> | null): void {
    const waiting = process_.waiting;
    if (!waiting) return;
    process_.waiting = undefined;
    waiting.resolve(event);
  }

  /** 读一次通道：更新 ready / dead，并把匹配的 turn.finished 交给等待方。 */
  private pump(process_: LaneProcess, paths: LaneChannelPaths): void {
    const read = readChannel<LaneEvent>(paths.events, process_.consumed);
    process_.consumed = read.consumed;
    for (const event of read.items) {
      if (!event || typeof event !== 'object') continue;
      if (event.kind === 'ready') {
        // 只认本次窗口：旧进程残留的 ready 会让控制面往一个已经不存在的窗口里投任务。
        if (event.launch && event.launch !== process_.launch) continue;
        process_.ready = true;
        process_.pid = event.pid ?? process_.pid;
        process_.sessionId = event.sessionId ?? process_.sessionId;
      } else if (event.kind === 'exit') {
        process_.dead = true;
        this.settle(process_, null);
      } else if (event.kind === 'turn.finished') {
        // id 必须对上：人自己在这个窗口里敲的那一轮也会发 turn.finished，那不是派活的结论。
        if (process_.waiting?.id === event.id) this.settle(process_, event);
      }
    }
    if (!process_.dead && process_.pid && !processAlive(process_.pid)) {
      process_.dead = true;
      this.settle(process_, null);
    }
  }

  /** 收现场差分：哪些文件改了、attempt patch 落在哪、是否违反契约。 */
  private collect(
    request: WorkerTaskRequest,
    site: ExecSite,
    lane: WorkerTaskRequest['lane'],
    onProgress: (progress: WorkerProgress) => void,
  ): WorkerTaskResult {
    const laneId = lane?.id ?? request.task.id;
    const risks: string[] = [];
    let patchPath: string | undefined;
    let baselineTree: string | undefined;
    let baselineIndex: string | undefined;
    let changedFiles: string[] = [];
    try {
      const changes = this.site.collect(site, {
        run: request.run,
        laneId,
        attempt: request.attempt,
        baselineTree: lane?.baselineTree,
        baselineIndex: lane?.baselineIndex,
      });
      baselineTree = changes.tree;
      baselineIndex = changes.index;
      changedFiles = changes.changedFiles;
      patchPath = this.site.writeAttemptPatch(request.run, request.task.id, request.attempt, changes, site.mode);
      if (!changes.patch && site.mode !== 'worktree' && changes.changedFiles.length > 0) {
        risks.push(`${site.mode} lane cannot produce a content diff for this attempt.`);
      }
      const violations = this.site.violations(request.task.contract, changedFiles);
      if (violations.length > 0) risks.push(...violations);
    } catch (error) {
      // 收不上差分也不能丢现场：保留 worktree 供人工打捞。
      risks.push(`Artifact collection failed: ${error instanceof Error ? error.message : String(error)}`);
      onProgress({ message: 'artifact collection failed', workspacePath: site.path });
      return {
        outcome: 'failed',
        summary: '',
        changedFiles: [],
        error: `Artifact collection failed; the execution site was preserved at ${site.path}.`,
        laneId,
        worktreePath: site.path,
        keepWorktree: true,
        risks,
      };
    }
    return {
      outcome: 'completed',
      summary: '',
      changedFiles,
      laneId,
      worktreePath: site.path,
      baselineTree,
      baselineIndex,
      patchPath,
      risks,
    };
  }

  /**
   * 请 window 自己退，等它退；真卡住才硬杀。
   *
   * 顺序不能反：`process.kill` 在 Windows 上是 TerminateProcess，目标进程的
   * `exit` / `SIGTERM` 处理器一个都不跑，`exitAltScreen()` 永远执行不到，于是终端留在
   * alt screen 里——画面还在、鼠标追踪还开着，滚轮翻不动、点哪都没反应。所以先写 stop
   * 信号让它走 REPL 自己的退出路径（会复原终端），宽限期到了才退到硬杀。
   */
  private async stopWindow(process_: LaneProcess, reason: string): Promise<void> {
    const paths = laneChannelPaths(process_.workspaceRoot, process_.runId, process_.laneId);
    // 先 settle：让正在等结论的那一轮立刻收手，不必等窗口真的退干净。
    this.settle(process_, null);
    if (process_.dead) {
      clearLaneStop(paths);
      return;
    }
    if (!process_.ready) {
      // 还没 ready 的窗口：既没有 pid 可杀，stop 信号也会被它的启动清理（resetLaneEvents）
      // 抹掉——等下去只会白等一个宽限期。直接放弃，那个窗口起来后是个没人管的空 REPL，
      // 人按 Ctrl+D 就能关（它从未接过任务）。
      process_.dead = true;
      clearLaneStop(paths);
      return;
    }
    requestLaneStop(paths, reason);
    const deadline = Date.now() + this.stopGraceMs;
    while (Date.now() < deadline) {
      // 必须边等边读通道：窗口退出的证据就是它自己写的 exit 事件，
      // 只 sleep 不 pump 会一直等到宽限期结束，然后误判「没理我们」而硬杀。
      this.pump(process_, paths);
      if (process_.dead) break;
      if (process_.pid && !processAlive(process_.pid)) {
        process_.dead = true;
        break;
      }
      await sleep(Math.min(this.pollMs, 200));
    }
    if (!process_.dead && process_.pid) {
      // 超时：它没理我们。硬杀是最后手段——终端会烂在 alt screen 里，但至少进程不残留。
      try {
        process.kill(process_.pid);
      } catch {
        // 已经退了
      }
    }
    process_.dead = true;
    clearLaneStop(paths);
  }

  async cancel(reason?: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const process_ of this.lanes.values()) {
      this.cancelled.add(process_.key);
      pending.push(this.stopWindow(process_, reason ?? 'orchestration cancelled'));
    }
    // 并行等：5 个 lane 串行各等一个宽限期会像卡住。
    await Promise.all(pending);
  }

  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    const key = `${request.run.id}:${request.lane.id}`;
    const process_ = this.lanes.get(key);
    if (process_) await this.stopWindow(process_, request.reason);
    this.lanes.delete(key);
    this.cancelled.delete(key);
    // 窗口退干净之后 `.mocode/sessions` 才稳定，才能安全归档会话。
    await sleep(Math.min(this.pollMs, 300));
    return this.site.closeLane(request);
  }

  /**
   * 不实现 `respondApproval`：lane 窗口本身就是一个真 TTY，权限面板与 `ask_human`
   * 都在那个窗口里直接回答。控制面替它作答会绕过人在屏幕前看到的那一次确认。
   */
  respondApproval?(approvalId: string, resolution: ApprovalResolution): boolean {
    void approvalId;
    void resolution;
    return false;
  }

  /** 供诊断/测试：某个 lane 的窗口是否还开着。 */
  laneWindowAlive(runId: string, laneId: string): boolean {
    const process_ = this.lanes.get(`${runId}:${laneId}`);
    return process_ !== undefined && !process_.dead;
  }
}

/** 让 `fs` 的导入不被 lint 判为未使用（本模块只在 `collect` 的失败路径里间接依赖现场）。 */
void fs;
void path;
