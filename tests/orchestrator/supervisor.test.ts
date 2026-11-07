import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorRuntime } from '../../src/orchestrator/supervisor.js';
import { buildSupervisorPrompt } from '../../src/orchestrator/supervisor-prompt.js';
import { createSupervisorTools, SUPERVISOR_TOOL_NAMES } from '../../src/orchestrator/tools.js';
import { handleLocalCommand, supervisorCommands } from '../../src/orchestrator/repl.js';
import { __setWorkspaceRegistryPath, getWorkspaceRegistryPath } from '../../src/workspace/registry.js';
import type { ToolOutcome } from '../../src/tools/types.js';
import type {
  LaneCloseRequest,
  LaneCloseResult,
  RunReview,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-supervisor-'));
  const finish = (): void => fs.rmSync(root, { recursive: true, force: true });
  try {
    const result = fn(root);
    if (result instanceof Promise) return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

/** 注册表是全局文件：指到临时路径，否则会读写真实的 ~/.mocode。 */
async function withRegistryPath<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = getWorkspaceRegistryPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-supervisor-registry-'));
  __setWorkspaceRegistryPath(path.join(dir, 'workspaces.jsonl'));
  try {
    return await fn();
  } finally {
    __setWorkspaceRegistryPath(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 记录每次 run 的 lane/session，必要时用 gate 把第一批任务挂住，测「边跑边派」的排队。 */
class RecordingWorker implements WorkerExecutor {
  readonly calls: Array<{ taskId: string; laneId?: string; sessionId?: string; mode?: string }> = [];
  readonly closed: string[] = [];
  /** 置位后，第一次 run 会等这个 promise resolve 再返回。 */
  gate: Promise<void> | null = null;

  constructor(private readonly summaries: string[] = []) {}

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    const lane = request.lane;
    this.calls.push({
      taskId: request.task.id,
      laneId: lane?.id,
      sessionId: lane?.sessionId,
      mode: lane?.mode,
    });
    const execPath = lane?.worktreePath ?? `/fake/${lane?.mode ?? 'worktree'}/${lane?.id ?? request.task.id}`;
    if (lane && !lane.worktreePath) {
      onProgress({
        message: 'lane opened',
        workspacePath: execPath,
        lane:
          lane.mode === 'worktree'
            ? { opened: true, baseTree: 'base-0' }
            : { opened: true, baseIndex: `/fake/index/${lane.id}-base.json` },
      });
    }
    const sessionId = lane?.sessionId ?? `session-${request.task.id}`;
    onProgress({ message: 'started by fake worker', sessionId, workspacePath: execPath, started: true });
    if (this.calls.length === 1 && this.gate) await this.gate;
    const summary = this.summaries.shift() ?? `${request.task.id} done`;
    return {
      outcome: 'completed',
      summary,
      changedFiles: [],
      laneId: lane?.id,
      worktreePath: execPath,
      ...(lane?.mode === 'worktree'
        ? { baselineTree: `tree-${request.task.id}` }
        : { baselineIndex: `/fake/index/${request.task.id}.json` }),
    };
  }

  async cancel(): Promise<void> {
    // 测试里不触发取消
  }

  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    this.closed.push(request.lane.id);
    return { patchPath: `patch-${request.lane.id}`, kept: false };
  }
}

/** 等某个 Run 不再处于 running（测试用轮询，避免依赖事件时序）。 */
async function waitForSettled(supervisor: SupervisorRuntime, runId: string, timeoutMs = 8000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const text = supervisor.status(runId);
    if (/· (idle|completed|failed|cancelled)\b/.test(text)) return text;
    if (Date.now() - started > timeoutMs) throw new Error(`run ${runId} did not settle:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ── 本地斜杠命令 ─────────────────────────────────────────────────────────────

test('local commands: /exit ends the loop, unknown text goes to the model', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        assert.deepEqual(handleLocalCommand('/exit', supervisor), { kind: 'exit' });
        assert.deepEqual(handleLocalCommand('/quit', supervisor), { kind: 'exit' });
        assert.equal(handleLocalCommand('在 mocode 里修个 typo', supervisor).kind, 'none');
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('local commands: /help, /runs and /workspaces answer without a model call', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        const help = handleLocalCommand('/help', supervisor);
        assert.equal(help.kind, 'handled');
        assert.match(help.kind === 'handled' ? help.output : '', /supervise_|隔离|派/);

        const runs = handleLocalCommand('/runs', supervisor);
        assert.equal(runs.kind, 'handled');
        assert.match(runs.kind === 'handled' ? runs.output : '', /还没有任何编排 Run|run/);

        const workspaces = handleLocalCommand('/workspaces', supervisor);
        assert.equal(workspaces.kind, 'handled');
        assert.ok((workspaces.kind === 'handled' ? workspaces.output : '').includes(root));

        const status = handleLocalCommand('/status', supervisor);
        assert.equal(status.kind, 'handled');
        assert.match(status.kind === 'handled' ? status.output : '', /No live orchestration runs/);
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('local commands: /approvals and /approve answer without a model call', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        const approvals = handleLocalCommand('/approvals', supervisor);
        assert.equal(approvals.kind, 'handled');
        assert.equal(approvals.kind === 'handled' ? approvals.output : '', '没有待决的人工介入。');

        // 缺参数只给用法，不去动 Worker。
        const noArgs = handleLocalCommand('/approve', supervisor);
        assert.match(noArgs.kind === 'handled' ? noArgs.output : '', /用法：\/approve/);
        const noValue = handleLocalCommand('/approve 1', supervisor);
        assert.match(noValue.kind === 'handled' ? noValue.output : '', /用法：\/approve/);

        // 没有待决审批时如实说「已经不在了」，不假装成功。
        const stale = handleLocalCommand('/approve 1 cancel', supervisor);
        assert.equal(stale.kind, 'handled');
        assert.match(stale.kind === 'handled' ? stale.output : '', /no longer pending/);
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('slash menu: every local command is discoverable, /approve prefills instead of submitting', async () => {
  const commands = supervisorCommands();
  assert.deepEqual(
    commands.map((command) => command.name),
    ['/status', '/approvals', '/approve', '/runs', '/workspaces', '/help', '/exit'],
  );
  // 需要参数的命令必须 submit:false，否则选中菜单就把半截命令发出去。
  const approve = commands.find((command) => command.name === '/approve')!;
  assert.equal(approve.submit, false);
  assert.equal(approve.value, '/approve ');

  // 菜单里列出的每条命令都必须真的能被 handleLocalCommand 认出来（不列不存在的命令）。
  await withRegistryPath(() =>
    withRoot((root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        for (const command of commands) {
          const result = handleLocalCommand(command.name, supervisor);
          if (command.name === '/exit') assert.equal(result.kind, 'exit');
          else assert.equal(result.kind, 'handled', `${command.name} is listed in the menu but not handled`);
        }
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

// ── 快照 / 提示词 ────────────────────────────────────────────────────────────

test('snapshot lists the known workspaces and says there are no live runs', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        const snapshot = supervisor.snapshot();
        assert.match(snapshot, /## Orchestration snapshot/);
        assert.ok(snapshot.includes(root), 'snapshot must name the supervisor cwd');
        assert.match(snapshot, /Live runs: none\./);
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('supervisor prompt forbids self-editing and encodes the queued-is-not-started rule', () => {
  const prompt = buildSupervisorPrompt({ root: 'C:/work', workspaceCount: 3 });
  assert.match(prompt, /Never claim work you did not dispatch/);
  assert.match(prompt, /"Queued" is not "started"/);
  assert.match(prompt, /C:\/work/);
});

// ── 派活 / 复用 / 排队 ───────────────────────────────────────────────────────

/**
 * 测试用收工判定：真实 `review.ts` 要发一次最长 90s 的模型请求，单测里会让「等 Run 落定」
 * 变成跟后端延迟赛跑（实测偶发超时）。这里给固定判决，只验证调度语义。
 */
const stubReview = async (): Promise<RunReview> => ({
  verdict: 'done',
  rationale: 'stub review (tests never call the model)',
  remaining: [],
  createdAt: new Date().toISOString(),
});

test('dispatch: creates a run, runs the worker in a copy lane, and keeps the lane open', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const worker = new RecordingWorker(['read the README']);
      const notices: string[] = [];
      const supervisor = new SupervisorRuntime({
        root,
        worker: () => worker,
        onNotice: (notice) => notices.push(notice.text),
        review: stubReview,
      });
      try {
        const created = await supervisor.dispatch({ workspace: root, objective: 'summarize the README' });
        assert.match(created, /Started run /);

        const live = supervisor.liveRuns();
        assert.equal(live.length, 1);
        const runId = live[0].run.id;
        const settled = await waitForSettled(supervisor, runId);
        assert.match(settled, /1\/1 task\(s\) completed/);

        const run = supervisor.findRun(runId)!.store.current;
        assert.equal(run.status, 'idle', 'autoClose stays false so the lane survives the batch');
        const lane = Object.values(run.lanes)[0];
        assert.equal(lane.closed, undefined);
        assert.equal(lane.mode, 'copy', 'a plain directory must not get a worktree');
        assert.ok(lane.sessionId, 'the lane remembers the worker session');
        assert.ok(
          notices.some((text) => /task-1 .*done/.test(text)),
          `expected a completion notice, got ${JSON.stringify(notices)}`,
        );
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('wake: a drained batch wakes the supervisor once with a self-contained prompt', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const wakes: string[] = [];
      const supervisor = new SupervisorRuntime({
        root,
        worker: () => new RecordingWorker(['read the README']),
        review: stubReview,
        onWake: (wake) => wakes.push(`${wake.reason}|${wake.prompt}`),
      });
      try {
        await supervisor.dispatch({ workspace: root, objective: 'summarize the README' });
        const runId = supervisor.liveRuns()[0].run.id;
        await waitForSettled(supervisor, runId);
        // 落定后再等一小会儿：验证「同一份状态不会重复唤醒」（idle 之后还有终态类事件时尤其）。
        await new Promise((resolve) => setTimeout(resolve, 150));

        assert.equal(wakes.length, 1, `expected exactly one wake, got ${JSON.stringify(wakes)}`);
        assert.match(wakes[0], /^idle\|/);
        // 唤醒原文必须自带上下文：上屏的通知不进模型历史，光说「干完了」它只能去猜。
        assert.match(wakes[0], new RegExp(runId));
        assert.match(wakes[0], /1\/1 个任务完成/);
        assert.match(wakes[0], /stub review/, 'the收工 verdict must be inlined into the wake prompt');
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('wake: a second batch on the same run wakes again (the dedupe key carries the state)', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const wakes: string[] = [];
      const supervisor = new SupervisorRuntime({
        root,
        worker: () => new RecordingWorker(['first', 'second']),
        review: stubReview,
        onWake: (wake) => wakes.push(wake.key),
      });
      try {
        await supervisor.dispatch({ workspace: root, objective: 'first task' });
        const runId = supervisor.liveRuns()[0].run.id;
        await waitForSettled(supervisor, runId);
        assert.equal(wakes.length, 1);

        await supervisor.dispatch({ workspace: root, objective: 'second task', lane: 'task-1' });
        await waitForSettled(supervisor, runId);
        assert.equal(wakes.length, 2, 'a new state must wake again, otherwise the second batch is silent');
        assert.notEqual(wakes[0], wakes[1]);
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test("dispatch: the workspace's live run is reused and the follow-up continues the same session", async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const worker = new RecordingWorker();
      const supervisor = new SupervisorRuntime({ root, worker: () => worker, review: stubReview });
      try {
        await supervisor.dispatch({ workspace: root, objective: 'first task' });
        const runId = supervisor.liveRuns()[0].run.id;
        await waitForSettled(supervisor, runId);

        const second = await supervisor.dispatch({ workspace: root, objective: 'second task', lane: 'task-1' });
        assert.match(second, /Reused the live run/);
        const settled = await waitForSettled(supervisor, runId);
        assert.match(settled, /2\/2 task\(s\) completed/);

        assert.equal(supervisor.liveRuns()[0].run.id, runId, 'no new run was created');
        assert.equal(worker.calls.length, 2);
        // 第一次开 lane 时现场与会话都还不存在，Worker 新建后经 lane.session 回报；
        // 第二次必须带着那个 sessionId 进来（这才是「同一个会话接着派活」）。
        assert.equal(worker.calls[0].sessionId, undefined);
        assert.equal(worker.calls[1].laneId, worker.calls[0].laneId);
        assert.equal(worker.calls[1].sessionId, 'session-task-1', 'the follow-up must resume the same worker session');
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('dispatch: a second task while the run is working is queued and runs after the first batch', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      let release!: () => void;
      const worker = new RecordingWorker();
      worker.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const supervisor = new SupervisorRuntime({ root, worker: () => worker, review: stubReview });
      try {
        await supervisor.dispatch({ workspace: root, objective: 'slow task' });
        const runId = supervisor.liveRuns()[0].run.id;

        const queued = await supervisor.dispatch({ workspace: root, objective: 'follow-up task', lane: 'lane-2' });
        assert.match(queued, /Queued task task-2/);
        assert.match(queued, /still working/);

        release();
        const settled = await waitForSettled(supervisor, runId);
        assert.match(settled, /2\/2 task\(s\) completed/);
        assert.deepEqual(
          worker.calls.map((call) => call.taskId),
          ['task-1', 'task-2'],
        );
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('dispatch: an unknown workspace is rejected before anything is written', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        await assert.rejects(
          () => supervisor.dispatch({ workspace: path.join(root, 'nope'), objective: 'x' }),
          /workspace does not exist/,
        );
        await assert.rejects(() => supervisor.dispatch({ objective: '   ' }), /objective must not be empty/);
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

// ── 工具集 ───────────────────────────────────────────────────────────────────

test('tools: the control plane exposes exactly the declared names, apply/cancel/approve need confirmation', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        const tools = createSupervisorTools(supervisor);
        assert.deepEqual(
          tools.map((tool) => tool.name),
          [...SUPERVISOR_TOOL_NAMES],
        );
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        // 三个会改变外部世界或替人拍板的工具都要过确认面板：合并、取消、回答审批。
        const confirming = new Set(['supervise_apply', 'supervise_cancel', 'supervise_approve']);
        for (const name of confirming) assert.equal(byName.get(name)?.risk, 'confirm', `${name} must confirm`);
        for (const tool of tools) {
          if (!confirming.has(tool.name)) {
            assert.equal(tool.risk, 'safe', `${tool.name} must not prompt`);
          }
          assert.ok(tool.capabilities, `${tool.name} must declare capabilities`);
          assert.equal(tool.parameters.type, 'object');
        }
        const dispatch = byName.get('supervise_dispatch')!;
        assert.deepEqual(dispatch.parameters.required, ['objective']);
        for (const tool of tools) {
          // 控制面工具都不接受路径类必填参数之外的隐式写入：schema 里不能出现 shell/路径写入键。
          const props = (tool.parameters.properties ?? {}) as Record<string, unknown>;
          assert.equal(props.command, undefined, `${tool.name} must not shell out`);
        }
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});

test('tools: supervise_workspaces and supervise_status answer from the supervisor state', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      const supervisor = new SupervisorRuntime({ root, worker: () => new RecordingWorker() });
      try {
        const tools = createSupervisorTools(supervisor);
        const workspaces = tools.find((tool) => tool.name === 'supervise_workspaces')!;
        const listed = (await workspaces.execute({})) as ToolOutcome;
        assert.equal(listed.status, 'success');
        assert.ok(listed.output.includes(root));

        const status = tools.find((tool) => tool.name === 'supervise_status')!;
        const live = (await status.execute({})) as ToolOutcome;
        assert.equal(live.status, 'success');
        assert.match(live.output, /No live orchestration runs/);

        const dispatch = tools.find((tool) => tool.name === 'supervise_dispatch')!;
        const failed = (await dispatch.execute({})) as ToolOutcome;
        assert.equal(failed.status, 'error', 'missing objective must be an error outcome, not a throw');
        assert.match(failed.output, /objective/);
      } finally {
        supervisor.shutdown();
      }
    }),
  );
});
