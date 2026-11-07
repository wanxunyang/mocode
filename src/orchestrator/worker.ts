import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LaneSite, type ExecSite, type LaneSiteOptions } from './lane-site.js';
import { handoffViolation, parseHandoff, taskPrompt } from './task-prompt.js';
import type {
  ApprovalResolution,
  LaneCloseRequest,
  LaneCloseResult,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from './types.js';

// 现场逻辑（worktree / copy / inplace 的打开、基线、差分、收尾）已抽到 ./lane-site.ts，
// 因为可视执行器 `LaneReplExecutor` 要用同一套口径。这两个函数是历史导出点，测试仍在用。
export { isWithin, resolveCopyTarget } from './lane-site.js';

interface HostEnvelope {
  type: 'event' | 'error';
  requestId?: string;
  event?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

function defaultHostPath(): string {
  return fileURLToPath(new URL('../../bin/mocode-agent-host.js', import.meta.url));
}

async function killWorkerTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // Windows: taskkill /T 覆盖 Host 自己派生的子进程（run_command 等），单 kill 会留孤儿。
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', finish);
      child.off('close', finish);
      child.off('error', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      void killWorkerTree(child).finally(finish);
    }, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    try {
      child.stdin.end();
    } catch {
      void killWorkerTree(child).finally(finish);
    }
  });
}

function messageFor(event: string, payload: Record<string, unknown>): string | null {
  if (event === 'status') return typeof payload.value === 'string' ? payload.value : null;
  if (event === 'tool_started') return typeof payload.name === 'string' ? `tool: ${payload.name}` : null;
  if (event === 'tool_completed') return typeof payload.name === 'string' ? `tool done: ${payload.name}` : null;
  return null;
}

export interface HostWorkerExecutorOptions extends LaneSiteOptions {
  hostPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** 多久没收到 Worker 心跳就判「卡死」（毫秒；<=0 关闭判定）；默认 60000。 */
  heartbeatTimeoutMs?: number;
  /**
   * 人工介入等多久算放弃（毫秒；<=0 表示无限等）。默认 10 分钟。
   * 超时按「拒绝」回给 Host（reason 写进 resolved），而不是把 Worker 杀掉——
   * 任务仍能带着「敏感动作被拒」这条风险正常收尾，比留一个挂死的进程好。
   */
  approvalTimeoutMs?: number;
}

export class HostWorkerExecutor implements WorkerExecutor {
  /** 在跑的 Host 进程，按 requestId 记录：并发调度下同一时刻可以有多个 Worker。 */
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly hostEntry: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  /** 现场管理（worktree / copy / inplace 与产物归档），与可视执行器共用同一份实现。 */
  private readonly site: LaneSite;
  private readonly heartbeatTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  /** workerId → 最近一次收到心跳的时刻；UI/控制面用 isAlive 区分「卡死」与「已退出」。 */
  private readonly heartbeats = new Map<string, number>();
  /**
   * 挂起中的人工介入：approvalId → 投递通道。
   * 控制面通过 `respondApproval()` 直接回写 Host 的 `approval` 命令，不需要重启进程或重放会话。
   */
  private readonly pendingApprovals = new Map<
    string,
    {
      requestId: string;
      /** 由产生该请求的那次 run 提供的闭合：写回 Host + 上报 resolved + 清定时器。 */
      answer: (resolution: ApprovalResolution) => boolean;
      timer?: NodeJS.Timeout;
    }
  >();

  constructor(options: HostWorkerExecutorOptions = {}) {
    this.hostEntry = options.hostPath ?? defaultHostPath();
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    this.site = new LaneSite(options);
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 600_000;
  }

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    const lane = request.lane;
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
    const requestId = randomUUID();
    // 这里不镜像执行画面：stdout 是**独占的控制通道**（审批回传 / 取消 / 心跳都在上面）。
    // 人想看画面的场景走 `LaneReplExecutor`——它直接开一个真 mocode，画面就是那个终端本身。
    const child = spawn(process.execPath, [this.hostEntry], {
      cwd: site.path,
      env: { ...process.env, MOCODE_SUPERVISED_WORKER: '1', MOCODE_WORKER_ID: request.workerId },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.active.set(requestId, child);
    this.heartbeats.set(request.workerId, Date.now());

    let buffer = '';
    let text = '';
    let sessionId: string | undefined;
    let stderr = '';
    let settled = false;
    let ready = false;
    /** 最近一次收到任何 Host envelope 的时刻；心跳事件会刷新它。 */
    let lastSeen = Date.now();
    let resolveResult!: (result: WorkerTaskResult) => void;
    const resultPromise = new Promise<WorkerTaskResult>((resolve) => {
      resolveResult = resolve;
    });

    const finish = (result: WorkerTaskResult): void => {
      if (settled) return;
      settled = true;
      if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);
      this.heartbeats.delete(request.workerId);
      // 这条 Worker 一旦收尾，它名下不可能再有能得到回答的审批：全部按超时口径清干净，
      // 否则控制面会一直显示「在等你回答」。
      for (const [approvalId, entry] of this.pendingApprovals) {
        if (entry.requestId !== requestId) continue;
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingApprovals.delete(approvalId);
      }
      resolveResult({ ...result, sessionId, workspacePath: site.path });
    };
    const send = (command: object): void => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
    };
    /**
     * 回答一个挂起中的审批：把决定写回 Host 的 `approval` 命令，并把 resolved 上报给控制面。
     * 只有 pendingApprovals 里确实有这条才算成功——超时/已答/不属于本 Worker 都返回 false。
     */
    const settleApproval = (approvalId: string, resolution: ApprovalResolution): boolean => {
      const entry = this.pendingApprovals.get(approvalId);
      if (!entry || entry.requestId !== requestId) return false;
      this.pendingApprovals.delete(approvalId);
      if (entry.timer) clearTimeout(entry.timer);
      send({ id: randomUUID(), type: 'approval', approvalId, action: resolution.action, value: resolution.value });
      onProgress({
        message:
          resolution.by === 'timeout'
            ? `approval ${approvalId} timed out — denied`
            : `approval ${approvalId} answered: ${resolution.action}${resolution.value ? ` (${resolution.value})` : ''}`,
        sessionId,
        approval: { state: 'resolved', id: approvalId, resolution },
      });
      return true;
    };
    const handle = (envelope: HostEnvelope): void => {
      lastSeen = Date.now();
      if (request.workerId) this.heartbeats.set(request.workerId, lastSeen);
      if (envelope.type === 'error') {
        if (envelope.requestId === requestId || !envelope.requestId) {
          finish({ outcome: 'failed', summary: text.trim(), changedFiles: [], error: envelope.error ?? 'Host error.' });
        }
        return;
      }
      const event = envelope.event ?? '';
      const payload = envelope.payload ?? {};
      if (event === 'runtime_ready') {
        ready = true;
        send({
          id: requestId,
          type: 'run',
          prompt: taskPrompt(request),
          // lane 已有会话时续接，Worker 能继承此前的上下文继续干活。
          ...(lane?.sessionId ? { sessionId: lane.sessionId } : {}),
        });
        onProgress({ message: 'host ready', workspacePath: site.path });
      } else if (envelope.requestId === requestId) {
        if (event === 'run_started') {
          sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
          onProgress({ message: 'worker started', sessionId, workspacePath: site.path, started: true });
        } else if (event === 'text_delta' && typeof payload.text === 'string') {
          text += payload.text;
        } else if (event === 'approval_requested') {
          const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
          const title = typeof payload.title === 'string' ? payload.title : 'Approval requested';
          const detail = typeof payload.detail === 'string' ? payload.detail : undefined;
          const options = Array.isArray(payload.options)
            ? payload.options.filter((item): item is string => typeof item === 'string')
            : [];
          // `ask_human` 走同一条事件，用 payload.kind 区分；缺省按权限面板处理（旧 Host 不发 kind）。
          const kind = payload.kind === 'ask_human' ? 'ask_human' : 'permission';
          if (!approvalId) {
            onProgress({ message: `${title} — ignored (host sent no approval id)`, sessionId });
          } else {
            this.pendingApprovals.set(approvalId, {
              requestId,
              answer: (resolution) => settleApproval(approvalId, resolution),
              ...(this.approvalTimeoutMs > 0
                ? {
                    timer: setTimeout(() => {
                      settleApproval(approvalId, {
                        action: 'cancelled',
                        by: 'timeout',
                        at: new Date().toISOString(),
                      });
                    }, this.approvalTimeoutMs),
                  }
                : {}),
            });
            this.pendingApprovals.get(approvalId)!.timer?.unref?.();
            onProgress({
              message: `${kind === 'ask_human' ? 'question' : 'approval'}: ${title}`,
              sessionId,
              approval: { state: 'requested', id: approvalId, kind, title, ...(detail ? { detail } : {}), options },
            });
          }
        } else if (event === 'run_completed') {
          const changedFiles = Array.isArray(payload.changedFiles)
            ? payload.changedFiles.filter((item): item is string => typeof item === 'string')
            : [];
          const completed = payload.completed === true;
          const parsed = parseHandoff(text);
          const handoffError = !parsed.found
            ? 'Worker completed without the required machine-readable handoff.'
            : handoffViolation(request, parsed);
          const error = completed
            ? handoffError
            : `Worker stopped: ${String(payload.terminationReason ?? 'incomplete')}`;
          const reportedTokens =
            payload.usage && typeof payload.usage === 'object'
              ? Number((payload.usage as { totalTokens?: unknown }).totalTokens)
              : Number.NaN;
          finish({
            outcome: completed && !error ? 'completed' : 'failed',
            summary: parsed.summary,
            changedFiles,
            validation: parsed.validation,
            risks: parsed.risks,
            error,
            tokens: Number.isFinite(reportedTokens) ? reportedTokens : undefined,
          });
        } else if (event === 'run_failed') {
          finish({
            outcome: 'failed',
            summary: text.trim(),
            changedFiles: [],
            error: typeof payload.message === 'string' ? payload.message : 'Worker failed.',
          });
        } else if (event === 'run_aborted') {
          finish({ outcome: 'cancelled', summary: text.trim(), changedFiles: [], error: 'Worker aborted.' });
        } else {
          const message = messageFor(event, payload);
          if (message) onProgress({ message, sessionId });
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            handle(JSON.parse(line) as HostEnvelope);
          } catch {
            stderr += `Invalid host NDJSON: ${line}\n`;
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once('error', (error) =>
      finish({ outcome: 'interrupted', summary: text.trim(), changedFiles: [], error: error.message }),
    );
    child.once('exit', (code) => {
      if (!settled) {
        finish({
          outcome: 'interrupted',
          summary: text.trim(),
          changedFiles: [],
          error: `Worker host exited with code ${code ?? 'unknown'}.${stderr ? ` ${stderr.trim()}` : ''}`,
        });
      }
    });

    const timeout = setTimeout(() => {
      if (ready) return;
      finish({
        outcome: 'interrupted',
        summary: text.trim(),
        changedFiles: [],
        error: 'Worker host startup timed out.',
      });
      void killWorkerTree(child);
    }, this.startupTimeoutMs);
    // 心跳看门狗：只在 Worker 已 ready 后生效（启动慢由 startupTimeout 管）。
    // 判死时保留执行现场，成果仍按 lane.patch / lane.diff 归档，不丢现场。
    const heartbeatWatchdog =
      this.heartbeatTimeoutMs > 0
        ? setInterval(
            () => {
              if (settled || !ready) return;
              if (Date.now() - lastSeen <= this.heartbeatTimeoutMs) return;
              finish({
                outcome: 'interrupted',
                summary: text.trim(),
                changedFiles: [],
                error: `Worker stopped reporting heartbeats for ${Math.round(this.heartbeatTimeoutMs / 1000)}s.`,
              });
              void killWorkerTree(child);
            },
            Math.min(this.heartbeatTimeoutMs, 5_000),
          )
        : undefined;
    heartbeatWatchdog?.unref?.();
    onProgress({ message: 'creating isolated worker', workspacePath: site.path });
    let result = await resultPromise;
    clearTimeout(timeout);
    await stopChild(child, this.stopTimeoutMs);

    let patchPath: string | undefined;
    const artifactRisks = [...(result.risks ?? [])];
    let keepWorktree = false;
    let baselineTree: string | undefined;
    let baselineIndex: string | undefined;
    try {
      const changes = this.site.collect(site, {
        run: request.run,
        laneId: lane?.id ?? request.task.id,
        attempt: request.attempt,
        baselineTree: lane?.baselineTree,
        baselineIndex: lane?.baselineIndex,
      });
      baselineTree = changes.tree;
      baselineIndex = changes.index;
      const changedFiles = changes.changedFiles.length > 0 ? changes.changedFiles : result.changedFiles;
      patchPath = this.site.writeAttemptPatch(request.run, request.task.id, request.attempt, changes, site.mode);
      if (!changes.patch && site.mode !== 'worktree' && changes.changedFiles.length > 0) {
        artifactRisks.push(
          `${site.mode} lane cannot produce a content diff for this attempt; changed files are listed in the handoff.`,
        );
      }
      result = { ...result, changedFiles };
      if (result.outcome === 'completed') {
        const violations = this.site.violations(request.task.contract, changedFiles);
        if (violations.length > 0) result = { ...result, outcome: 'failed', error: violations.join(' ') };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      artifactRisks.push(`Artifact collection failed: ${message}`);
      if (request.task.contract.changePolicy === 'isolated_write') {
        // 无法证明没有改动时，绝不销毁唯一副本：任务判失败，现场留在原地供人工打捞。
        keepWorktree = true;
        result = {
          ...result,
          outcome: 'failed',
          error: `Artifact collection failed; the execution site was preserved at ${site.path}. ${message}`,
        };
      }
    }
    this.active.delete(requestId);
    // 会话归档推迟到 closeLane：lane 内后续任务还要续接同一个会话目录。
    return {
      ...result,
      laneId: lane?.id,
      worktreePath: site.path,
      baselineTree,
      baselineIndex,
      keepWorktree,
      patchPath,
      risks: artifactRisks,
    };
  }

  /** 收尾 lane（口径与可视执行器共用 `LaneSite`，避免两套 patch 语义）。 */
  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    return this.site.closeLane(request);
  }

  /** Worker 是否还在活着（最近一次心跳在阈值内）。未启动过 / 已退出返回 false。 */
  isAlive(workerId: string): boolean {
    const at = this.heartbeats.get(workerId);
    if (at === undefined) return false;
    return Date.now() - at <= this.heartbeatTimeoutMs;
  }

  /** 挂起中的人工介入 id 清单（控制面在重启后据此对账）。 */
  pendingApprovalIds(): string[] {
    return [...this.pendingApprovals.keys()];
  }

  /**
   * 把人的决定送进那个正在等着的 Host 进程。
   * 返回 false = 这个 id 已经不在我等的人里（超时 / 已答 / 进程已退），调用方应当报错而不是装作成功。
   */
  respondApproval(approvalId: string, resolution: ApprovalResolution): boolean {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return false;
    return entry.answer(resolution);
  }

  async cancel(): Promise<void> {
    const children = [...this.active.values()];
    if (children.length === 0) return;
    for (const child of children) {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: 'cancel' })}\n`);
    }
    setTimeout(() => {
      for (const child of children) if (child.exitCode === null) void killWorkerTree(child);
    }, 1_000).unref();
  }
}
