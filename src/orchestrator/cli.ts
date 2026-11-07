import fs from 'node:fs';
import path from 'node:path';
import { gitRepositoryDirty } from '../jobs/worktree.js';
import { OrchestrationScheduler } from './scheduler.js';
import { isRunLive } from './state.js';
import { appendIntegrationLog, formatIntegration, integrateRun } from './integrate.js';
import { collectBoard, formatBoardSnapshot } from './board.js';
import { prepareDefinition } from './lanes.js';
import { listOrchestrations, OrchestrationStore } from './store.js';
import { reviewRun } from './review.js';
import { HostWorkerExecutor } from './worker.js';
import { formatWorkspaces, listWorkspaces } from './workspaces.js';
import type {
  NewOrchestrationEvent,
  OrchestrationDefinition,
  OrchestrationRun,
  RunPolicy,
  RunReview,
  RunBudget,
  TaskInput,
  WorkerExecutor,
} from './types.js';

export const SUPERVISE_USAGE = [
  'Usage: mocode supervise [<command>] [--sandbox-root <path>]',
  '  (no command)                                  进 Supervisor 对话：自然语言派活 / 查进度 / 收工',
  '  workspaces [--scan-roots <dir>] [--json]   列出这台机器上跑过 mocode 的工作区',
  '  start <objective> | start --file <dag.json> [--allow-inplace] [--auto-close] [--concurrency N]',
  '  dispatch <workspace> --lane <id> <objective>  向工作区派活（无 live run 时新建）',
  '  ask <lane> <question> --run <id>              在同一会话里问进度（真回合）',
  '  tell <lane> <message> --run <id>              插话纠偏，约束后续任务',
  '  close <lane> --run <id>                       关闭 lane：导出累计 diff + 归档会话',
  '  watch [<run-id>] [--json]                      无 id 打开监管工作台；有 id 观察那个 Run 的事件流',
  '  lane <run-id> --lane <id>                     在 lane 现场跑一个真 mocode（supervisor 可派活，人也能直接打字）',
  '  resume <run-id>                               继续一个 idle / awaiting_user 的 Run',
  '  integrate <run-id> [--lane <id>] [--apply]    把已 close 的 lane patch 合回工作区（默认 dry-run）',
  '  budget: --max-tokens <n> / --max-minutes <n>  整趟 Run 限额，超限进 awaiting_user',
  '  review <run-id> [--dry-run]                   跑一次收工判定，看还差什么',
  '  list | status <run-id> | cancel <run-id>',
].join('\n');

export interface SuperviseCliDeps {
  out(text: string): void;
  err(text: string): void;
  worker(): WorkerExecutor;
  modelConfigured(): Promise<boolean>;
  /** Replace the process-wide immediate-exit SIGINT with cancellation; returns an uninstaller. */
  installSigint?(handler: () => void): () => void;
}

function defaultDeps(): SuperviseCliDeps {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    worker: () => new HostWorkerExecutor(),
    async modelConfigured() {
      const { isModelConfigured } = await import('../config/index.js');
      return isModelConfigured();
    },
    installSigint(handler) {
      // src/index.ts 的全局 SIGINT 会直接 exit(130)，来不及落取消标记、收 Worker、清现场。
      const globalListeners = process.listeners('SIGINT');
      process.removeAllListeners('SIGINT');
      process.once('SIGINT', handler);
      return () => {
        process.removeListener('SIGINT', handler);
        for (const listener of globalListeners) process.on('SIGINT', listener);
      };
    },
  };
}

// ── 参数解析 ─────────────────────────────────────────────────────────────────

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  '--sandbox-root',
  '--file',
  '--run',
  '--lane',
  '--task',
  // lane 窗口的「本次拉起」标记。执行器开窗时会带上它，不注册就会被参数解析拒成
  // Unknown flag，窗口一闪就退（表现为「没看到弹窗」，实际是立刻崩了）。
  '--launch',
  '--scan-roots',
  '--concurrency',
  '--max-tokens',
  '--max-minutes',
]);
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--allow-inplace',
  '--auto-close',
  '--reuse',
  '--dry-run',
  '--no-review',
  '--apply',
  '--all',
  '--no-terminal',
]);

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      flags.set(arg, value);
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }
  return { positionals, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function requireString(parsed: ParsedArgs, name: string, label: string): string {
  const value = stringFlag(parsed, name);
  if (!value) throw new Error(`${label} requires ${name}.`);
  return value;
}

/** `--concurrency N` / `--max-tokens` / `--max-minutes` → policy 局部；非法值在 state 归一化处也会被拦一次。 */
function policyFlags(parsed: ParsedArgs): Partial<RunPolicy> | undefined {
  const policy: Partial<RunPolicy> = {};
  const raw = stringFlag(parsed, '--concurrency');
  if (raw !== undefined) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error('--concurrency must be a positive integer.');
    policy.maxConcurrentWorkers = value;
    policy.maxConcurrentPerWorkspace = value;
  }
  if (boolFlag(parsed, '--no-review')) policy.reviewOnIdle = false;
  const budget: RunBudget = {};
  const tokens = stringFlag(parsed, '--max-tokens');
  if (tokens !== undefined) {
    const value = Number(tokens);
    if (!Number.isFinite(value) || value <= 0) throw new Error('--max-tokens must be a positive number.');
    budget.maxTokensPerRun = Math.floor(value);
  }
  const minutes = stringFlag(parsed, '--max-minutes');
  if (minutes !== undefined) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) throw new Error('--max-minutes must be a positive number.');
    budget.maxWallClockMs = Math.floor(value * 60_000);
  }
  if (Object.keys(budget).length > 0) policy.budget = budget;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** `budget: tokens 12k/50k, 3.2/30 min`；没配就是 `unlimited`。 */
function formatBudget(run: OrchestrationRun): string {
  const budget = run.policy?.budget;
  if (!budget) return 'budget unlimited';
  const parts: string[] = [];
  if (budget.maxTokensPerRun !== undefined) {
    parts.push(`tokens ${run.usage?.tokens ?? 0}/${budget.maxTokensPerRun}`);
  }
  if (budget.maxWallClockMs !== undefined) {
    const usedMin = ((run.usage?.wallClockMs ?? Date.now() - Date.parse(run.createdAt)) / 60_000).toFixed(1);
    parts.push(`${usedMin}/${(budget.maxWallClockMs / 60_000).toFixed(0)} min`);
  }
  return `budget ${parts.join(', ')}`;
}

/** 剩余位置参数拼成一句话（objective / question）。 */
function message(parsed: ParsedArgs, from = 0): string {
  const text = parsed.positionals.slice(from).join(' ').trim();
  if (!text) throw new Error('A non-empty message is required.');
  return text;
}

// ── 工作区与 lane 档位（判定逻辑在 ./lanes.ts，与 Supervisor 工具共用一份）──

function warnDirtyWorkspaces(definition: OrchestrationDefinition, deps: SuperviseCliDeps): void {
  for (const lane of definition.lanes ?? []) {
    if (lane.mode !== 'worktree' || !lane.workspaceRoot) continue;
    if (!gitRepositoryDirty(lane.workspaceRoot)) continue;
    deps.err(
      `mocode supervise: warning — ${lane.workspaceRoot} has uncommitted changes; worktree workers run against HEAD and will not see them.\n`,
    );
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

function taskGlyph(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'running' || status === 'dispatching') return '▶';
  if (status === 'failed' || status === 'interrupted') return '!';
  if (status === 'cancelled') return '×';
  return '○';
}

export function formatOrchestration(run: OrchestrationRun): string {
  const tasks = Object.values(run.tasks);
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const policy = run.policy;
  const lines = [
    `${run.id}  ${run.status}  ${completed}/${tasks.length}`,
    `Objective: ${run.objective}`,
    `Policy: concurrency ${policy?.maxConcurrentWorkers ?? 6}, per-workspace ${policy?.maxConcurrentPerWorkspace ?? 6}, review ${policy?.reviewOnIdle === false ? 'off' : 'on'}, ${formatBudget(run)}`,
  ];
  if (run.awaitingReason) lines.push(`Waiting for you: ${run.awaitingReason}`);
  for (const lane of Object.values(run.lanes ?? {})) {
    lines.push(
      `lane ${lane.id}  ${lane.mode ?? 'worktree'}  ${lane.workspaceRoot}` +
        `\n    status: ${lane.closed ? `closed (${lane.closed.reason})` : lane.worktreePath ? 'open' : 'idle'}` +
        `${lane.worktreePath ? `\n    workspace: ${lane.worktreePath}` : ''}` +
        `${lane.sessionId ? `\n    session: ${lane.sessionId}` : ''}` +
        `${lane.closed?.patchPath ? `\n    lane diff: ${lane.closed.patchPath}` : ''}` +
        `${lane.closed?.sessionArchivePath ? `\n    session archive: ${lane.closed.sessionArchivePath}` : ''}` +
        `${lane.closed?.kept ? '\n    kept: execution site preserved' : ''}` +
        `${lane.closed?.error ? `\n    error: ${lane.closed.error}` : ''}`,
    );
  }
  for (const task of tasks) {
    lines.push(
      `${taskGlyph(task.status)} ${task.id}  ${task.status}  ${task.title}${task.lane ? `  [lane ${task.lane}]` : ''}` +
        `${task.sessionId ? `\n    session: ${task.sessionId}` : ''}` +
        `${task.workspacePath ? `\n    workspace: ${task.workspacePath}` : ''}` +
        `${task.patchPath ? `\n    patch: ${task.patchPath}` : ''}` +
        `${task.sessionArchivePath ? `\n    session archive: ${task.sessionArchivePath}` : ''}` +
        `${task.lastEvent ? `\n    event: ${task.lastEvent}` : ''}` +
        `${task.error ? `\n    error: ${task.error}` : ''}`,
    );
  }
  const review = run.lastReview;
  if (review) {
    lines.push(
      `review: ${review.verdict}${review.error ? ` (error: ${review.error})` : ''}` +
        `${review.rationale ? `\n    ${review.rationale}` : ''}` +
        `${review.remaining.length > 0 ? `\n    remaining: ${review.remaining.join(' | ')}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatReview(review: RunReview): string {
  const lines = [`review: ${review.verdict}  ${review.createdAt}`, `${review.rationale || '(no rationale)'}`];
  if (review.remaining.length > 0)
    lines.push(`remaining:\n${review.remaining.map((item) => `  - ${item}`).join('\n')}`);
  if (review.error) lines.push(`error: ${review.error}`);
  return `${lines.join('\n')}\n`;
}

// ── 执行 ─────────────────────────────────────────────────────────────────────

interface ExecuteOptions {
  waitForMore?: boolean;
  json?: boolean;
  /** `resume` 显式唤醒 awaiting_user 的 Run；`watch` 不自动唤醒，只报原因。 */
  resumeAwaiting?: boolean;
}

async function execute(
  store: OrchestrationStore,
  deps: SuperviseCliDeps,
  options: ExecuteOptions = {},
): Promise<number> {
  const lease = store.acquireControllerLease();
  const worker = deps.worker();
  const scheduler = new OrchestrationScheduler(
    store,
    worker,
    {
      onEvent(event: NewOrchestrationEvent, run) {
        if (options.json) {
          deps.out(`${JSON.stringify({ type: event.type, data: event.data, status: run.status, task: event.data })}\n`);
          return;
        }
        if (event.type === 'task.progress') deps.out(`[${event.data.taskId}] ${event.data.message}\n`);
        else if (event.type !== 'run.created') deps.out(`[supervise] ${event.type} · ${run.status}\n`);
      },
    },
    { waitForMore: options.waitForMore },
  );
  const removeSigint = deps.installSigint?.(() => {
    deps.out('\n[supervise] cancellation requested; stopping workers…\n');
    store.requestCancellation();
  });
  try {
    if (options.resumeAwaiting && store.current.status === 'awaiting_user') {
      scheduler.resume('Operator resumed the run.');
    }
    const final = await scheduler.run();
    if (!options.json) deps.out(formatOrchestration(final));
    // awaiting_user 不是错误：Run 情愿停下等人，退出码 0 让脚本能区分「正常等人」与「跑挂」
    return final.status === 'completed' || final.status === 'idle' || final.status === 'awaiting_user'
      ? 0
      : final.status === 'cancelled'
        ? 130
        : 1;
  } finally {
    removeSigint?.();
    lease.release();
  }
}

/** 找该工作区最近一个还能接活的 Run（running / idle / awaiting_user）。 */
function latestLiveRun(root: string): OrchestrationRun | undefined {
  return listOrchestrations(root).find((run) => isRunLive(run));
}

function nextTaskId(run: OrchestrationRun, prefix: 'task' | 'ask' | 'steer'): string {
  let index = 1;
  while (run.tasks[`${prefix}-${index}`]) index++;
  return `${prefix}-${index}`;
}

/** ask / tell 都是往同一 lane 的同一会话发一个回合；区别只在契约（只读 vs 可写）与意图。 */
async function askOrTell(parsed: ParsedArgs, deps: SuperviseCliDeps, kind: 'ask' | 'tell'): Promise<number> {
  const runId = requireString(parsed, '--run', kind);
  const laneId = parsed.positionals[0];
  if (!laneId) throw new Error(`${kind} requires a lane id.`);
  const text = message(parsed, 1);
  const root = path.resolve(stringFlag(parsed, '--sandbox-root') ?? process.cwd());
  if (!(await deps.modelConfigured())) throw new Error('model not configured; run `mocode config` first.');

  const store = OrchestrationStore.load(root, runId);
  const run = store.current;
  const lane = run.lanes[laneId];
  if (!lane) throw new Error(`run ${runId} has no lane ${laneId}.`);
  if (lane.closed) throw new Error(`lane ${laneId} is closed; dispatch --reuse first.`);
  if (run.status === 'running') throw new Error(`run ${runId} is running; wait for it to idle before asking.`);

  const task: TaskInput =
    kind === 'ask'
      ? {
          id: nextTaskId(run, 'ask'),
          title: text.slice(0, 80),
          objective:
            `${text}\n\nThis is a status question from the operator, delivered into this lane's existing session. ` +
            'Answer from the work you already did in this session (files you read, commands you ran). ' +
            'Do not modify any file; report what is done, what is verified, and what remains.',
          lane: laneId,
          changePolicy: 'read_only',
        }
      : {
          id: nextTaskId(run, 'steer'),
          title: text.slice(0, 80),
          objective:
            `${text}\n\nThis is an operator steering message. Treat it as a binding constraint for this lane ` +
            'and act accordingly in the same session. Do not redo work that is already on disk.',
          lane: laneId,
          changePolicy: 'isolated_write',
        };

  const lease = store.acquireControllerLease();
  const scheduler = new OrchestrationScheduler(store, deps.worker(), {
    onEvent(event: NewOrchestrationEvent, current) {
      if (event.type === 'task.progress') deps.out(`[${event.data.taskId}] ${event.data.message}\n`);
      else if (event.type !== 'run.created') deps.out(`[supervise] ${event.type} · ${current.status}\n`);
    },
  });
  try {
    scheduler.appendTask(task);
    const final = await scheduler.run();
    deps.out(formatOrchestration(final));
    return final.status === 'failed' ? 1 : 0;
  } finally {
    lease.release();
  }
}

/** 在一个已有 Run 上追加任务并跑起来（dispatch --run 的共用路径）。 */
async function dispatchToRun(
  store: OrchestrationStore,
  deps: SuperviseCliDeps,
  task: TaskInput,
  options: { reopenLane: boolean },
): Promise<number> {
  const lease = store.acquireControllerLease();
  try {
    const scheduler = new OrchestrationScheduler(store, deps.worker(), {
      onEvent(event: NewOrchestrationEvent, current) {
        if (event.type === 'task.progress') deps.out(`[${event.data.taskId}] ${event.data.message}\n`);
        else if (event.type !== 'run.created') deps.out(`[supervise] ${event.type} · ${current.status}\n`);
      },
    });
    scheduler.appendTask(task, { reopenLane: options.reopenLane });
    const final = await scheduler.run();
    deps.out(formatOrchestration(final));
    return final.status === 'failed' ? 1 : 0;
  } finally {
    lease.release();
  }
}

export async function runSuperviseCli(
  rawArgs: readonly string[],
  deps: SuperviseCliDeps = defaultDeps(),
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(rawArgs);
  } catch (error) {
    deps.err(`mocode supervise: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const root = path.resolve(stringFlag(parsed, '--sandbox-root') ?? process.cwd());
  const command = (parsed.positionals.shift() ?? '').toLowerCase();
  try {
    // 无子命令 = Supervisor 对话（本机所有工作区的编排入口）。非 TTY 由 repl 自己拒绝并给 CLI 提示。
    if (command === '') {
      const scanRoots = stringFlag(parsed, '--scan-roots');
      if (!(await deps.modelConfigured())) throw new Error('model not configured; run `mocode config` first.');
      const { runSupervisorChat } = await import('./repl.js');
      return runSupervisorChat({
        root,
        scanRoots: scanRoots ? [path.resolve(scanRoots)] : [],
        // **不要**把 deps.worker 传进来。deps.worker 的默认值就是 headless 的
        // `HostWorkerExecutor`，而 SupervisorRuntime 的规则是「显式注入优先于 watchTerminals」，
        // 传进来就等于把可视化 lane 永久关掉了——派活永远不会弹 mocode 窗口（真踩过）。
        // 让 SupervisorRuntime 自己按 watchTerminals 选执行器：默认可视化 lane，
        // --no-terminal / CI 走 headless。
        ...(boolFlag(parsed, '--no-terminal') ? { watchTerminals: false } : {}),
      });
    }
    if (command === 'workspaces') {
      const scanRoots = stringFlag(parsed, '--scan-roots');
      const list = listWorkspaces({
        roots: [root],
        scanRoots: scanRoots ? [path.resolve(scanRoots)] : [],
      });
      deps.out(boolFlag(parsed, '--json') ? `${JSON.stringify(list, null, 2)}\n` : formatWorkspaces(list));
      return 0;
    }
    if (command === 'list') {
      const runs = listOrchestrations(root);
      if (runs.length === 0) deps.out('No orchestration runs.\n');
      else for (const run of runs) deps.out(`${run.id}  ${run.status}  ${run.objective}\n`);
      return 0;
    }
    if (command === 'status') {
      const id = parsed.positionals[0];
      if (!id) throw new Error('status requires a run id.');
      deps.out(formatOrchestration(OrchestrationStore.load(root, id).current));
      return 0;
    }
    if (command === 'cancel') {
      const id = parsed.positionals[0];
      if (!id) throw new Error('cancel requires a run id.');
      const store = OrchestrationStore.load(root, id);
      if (!isRunLive(store.current)) throw new Error(`run ${id} is already ${store.current.status}.`);
      store.requestCancellation();
      deps.out(`Cancellation requested for ${id}.\n`);
      return 0;
    }
    if (command === 'close') {
      const runId = requireString(parsed, '--run', 'close');
      const laneId = parsed.positionals[0];
      if (!laneId) throw new Error('close requires a lane id.');
      const store = OrchestrationStore.load(root, runId);
      if (!store.current.lanes[laneId]) throw new Error(`run ${runId} has no lane ${laneId}.`);
      const lease = store.acquireControllerLease();
      try {
        const scheduler = new OrchestrationScheduler(store, deps.worker(), {
          onEvent(event: NewOrchestrationEvent, current) {
            if (event.type !== 'task.progress' && event.type !== 'run.created') {
              deps.out(`[supervise] ${event.type} · ${current.status}\n`);
            }
          },
        });
        const final = await scheduler.closeLaneById(laneId, 'Closed by the operator.');
        deps.out(formatOrchestration(final));
        return 0;
      } finally {
        lease.release();
      }
    }
    if (command === 'integrate') {
      const id = parsed.positionals[0] ?? stringFlag(parsed, '--run');
      if (!id) throw new Error('integrate requires a run id.');
      const store = OrchestrationStore.load(root, id);
      const laneFlag = stringFlag(parsed, '--lane');
      const result = integrateRun(store.current, {
        lanes: laneFlag ? [laneFlag] : undefined,
        apply: boolFlag(parsed, '--apply'),
      });
      // 只落审计文件，不动事件账本：integrate 通常在 Run 终态后跑，而终态账本是冻结的。
      appendIntegrationLog(store.artifactPath('integration.jsonl'), result);
      deps.out(formatIntegration(result));
      return result.results.some((item) => item.status === 'failed') ? 1 : 0;
    }
    if (command === 'ask' || command === 'tell') return askOrTell(parsed, deps, command);
    if (command === 'dispatch') {
      const workspaceArg = parsed.positionals[0];
      if (!workspaceArg) throw new Error('dispatch requires a workspace path.');
      const workspace = path.resolve(root, workspaceArg);
      parsed.positionals.shift();
      const laneId = requireString(parsed, '--lane', 'dispatch');
      const objective = message(parsed);
      if (!(await deps.modelConfigured())) throw new Error('model not configured; run `mocode config` first.');
      const existingId = stringFlag(parsed, '--run');
      if (existingId) {
        const store = OrchestrationStore.load(workspace, existingId);
        const task: TaskInput = {
          id: nextTaskId(store.current, 'task'),
          title: objective.slice(0, 80),
          objective,
          lane: laneId,
        };
        return dispatchToRun(store, deps, task, { reopenLane: boolFlag(parsed, '--reuse') });
      }
      const definition = prepareDefinition(
        {
          objective,
          autoClose: boolFlag(parsed, '--auto-close'),
          lanes: [{ id: laneId, workspaceRoot: workspace }],
          tasks: [{ id: 'task-1', title: objective.slice(0, 80), objective, lane: laneId }],
          policy: policyFlags(parsed),
        },
        workspace,
        boolFlag(parsed, '--allow-inplace'),
      );
      const live = latestLiveRun(workspace);
      if (live) {
        deps.err(
          `mocode supervise: note — run ${live.id} is still open; pass '--run ${live.id}' to add this task to it.\n`,
        );
      }
      warnDirtyWorkspaces(definition, deps);
      const store = OrchestrationStore.create(workspace, definition);
      deps.out(`Orchestration started: ${store.current.id}\n`);
      return execute(store, deps);
    }
    if (command === 'start') {
      if (!(await deps.modelConfigured())) throw new Error('model not configured; run `mocode config` first.');
      const loaded = loadDefinition(parsed, root);
      const definition = prepareDefinition(
        { ...loaded, policy: { ...loaded.policy, ...policyFlags(parsed) } },
        root,
        boolFlag(parsed, '--allow-inplace'),
      );
      warnDirtyWorkspaces(definition, deps);
      const store = OrchestrationStore.create(root, definition);
      deps.out(`Orchestration started: ${store.current.id}\n`);
      return execute(store, deps);
    }
    if (command === 'review') {
      const id = parsed.positionals[0] ?? stringFlag(parsed, '--run');
      if (!id) throw new Error('review requires a run id.');
      const store = OrchestrationStore.load(root, id);
      const dryRun = boolFlag(parsed, '--dry-run');
      if (!dryRun && !(await deps.modelConfigured())) {
        throw new Error('model not configured; run `mocode config` first, or pass --dry-run.');
      }
      const run = store.current;
      const review = await reviewRun(run, { dryRun });
      if (dryRun) {
        deps.out(review.rationale);
        return 0;
      }
      // 判定只是建议：只有 Run 未终态时才入账（终态账本冻结，reducer 会拒绝追加）。
      if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
        const lease = store.acquireControllerLease();
        try {
          const scheduler = new OrchestrationScheduler(store, deps.worker(), {});
          scheduler.recordReview(review);
        } finally {
          lease.release();
        }
      }
      deps.out(formatReview(review));
      return review.verdict === 'unknown' ? 1 : 0;
    }
    if (command === 'lane') {
      // 在 lane 的执行现场跑一个**真的 mocode REPL**：同款 TUI、同款输入框。
      // 人可以直接在这个窗口里说话，supervisor 也能经 lane.commands 派活——两个输入源，一个输入框。
      const runId = parsed.positionals[0] ?? stringFlag(parsed, '--run');
      if (!runId) throw new Error('lane requires a run id.');
      const laneId = requireString(parsed, '--lane', 'lane');
      const store = OrchestrationStore.load(root, runId);
      const run = store.current;
      if (!run.lanes[laneId]) throw new Error(`run ${run.id} has no lane ${laneId}.`);
      const { runLaneRepl } = await import('./lane-repl.js');
      const launch = stringFlag(parsed, '--launch');
      return runLaneRepl({
        workspaceRoot: run.workspaceRoot,
        runId: run.id,
        laneId,
        ...(launch ? { launch } : {}),
      });
    }
    if (command === 'watch' && !parsed.positionals[0] && !stringFlag(parsed, '--run')) {
      // 无 run id = 监管工作台：看这台机器上所有还在动的工作区 / lane。
      const scanRoots = stringFlag(parsed, '--scan-roots');
      const workspaces = listWorkspaces({
        roots: [root],
        scanRoots: scanRoots ? [path.resolve(scanRoots)] : [],
      });
      const json = boolFlag(parsed, '--json');
      const includeTerminal = boolFlag(parsed, '--all');
      if (json || !process.stdout.isTTY) {
        const board = collectBoard({ workspaces, includeTerminal });
        deps.out(formatBoardSnapshot(board, { json }));
        return 0;
      }
      const { runBoardPanel } = await import('./watch-panel.js');
      return runBoardPanel({ workspaces, collect: (known) => collectBoard({ workspaces: known, includeTerminal }) });
    }
    if (command === 'resume' || command === 'watch') {
      const id = parsed.positionals[0] ?? stringFlag(parsed, '--run');
      if (!id) throw new Error(`${command} requires a run id.`);
      const store = OrchestrationStore.load(root, id);
      if (store.current.status === 'completed' || store.current.status === 'cancelled') {
        throw new Error(`run ${id} is already ${store.current.status}.`);
      }
      // watch 是只读观察：不替人做「继续」的决定，先把原因摆出来。
      if (command === 'watch' && store.current.status === 'awaiting_user') {
        deps.out(`${formatOrchestration(store.current)}\n`);
        deps.err(
          `mocode supervise: run ${id} is waiting for you — ${store.current.awaitingReason ?? 'needs a decision'}\n` +
            `  continue:  mocode supervise resume ${id}\n` +
            `  add work:  mocode supervise dispatch <workspace> --lane <id> --run ${id} <objective>\n`,
        );
        return 0;
      }
      if (!(await deps.modelConfigured())) throw new Error('model not configured; run `mocode config` first.');
      return execute(store, deps, {
        waitForMore: command === 'watch',
        json: boolFlag(parsed, '--json'),
        resumeAwaiting: command === 'resume',
      });
    }
    deps.err(`${SUPERVISE_USAGE}\n`);
    return 2;
  } catch (error) {
    deps.err(`mocode supervise: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// ── dag.json ─────────────────────────────────────────────────────────────────

function loadDefinition(parsed: ParsedArgs, root: string): OrchestrationDefinition {
  const file = stringFlag(parsed, '--file');
  if (file) {
    const definition = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8')) as OrchestrationDefinition;
    return { ...definition, autoClose: definition.autoClose === true || boolFlag(parsed, '--auto-close') };
  }
  const objective = parsed.positionals.join(' ').trim();
  if (!objective) throw new Error('start requires an objective or --file <dag.json>.');
  return {
    objective,
    autoClose: boolFlag(parsed, '--auto-close'),
    tasks: [{ id: 'task-1', title: objective.slice(0, 80), objective, changePolicy: 'isolated_write' }],
  };
}
