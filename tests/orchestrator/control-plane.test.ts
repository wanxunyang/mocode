import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuperviseCli, type SuperviseCliDeps } from '../../src/orchestrator/cli.js';
import { OrchestrationScheduler } from '../../src/orchestrator/scheduler.js';
import { createInitialRun } from '../../src/orchestrator/state.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import { HostWorkerExecutor } from '../../src/orchestrator/worker.js';
import type {
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-control-plane-'));
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

function completed(summary: string, tokens?: number): WorkerTaskResult {
  return { outcome: 'completed', summary, changedFiles: [], ...(tokens === undefined ? {} : { tokens }) };
}

/** 记录调用顺序的最小 Worker；每个任务的结果按数组 shift 取。 */
class QueueWorker implements WorkerExecutor {
  readonly order: string[] = [];
  constructor(private readonly results: Record<string, WorkerTaskResult[]>) {}

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    this.order.push(request.task.id);
    onProgress({ message: 'started', started: true, sessionId: `session-${request.task.id}` });
    const result = this.results[request.task.id]?.shift();
    if (!result) throw new Error(`No scripted result for ${request.task.id}`);
    return result;
  }

  async cancel(): Promise<void> {}
}

function eventsOf(store: OrchestrationStore): string {
  return fs.readFileSync(path.join(store.directory, 'events.jsonl'), 'utf8');
}

// ── 预算 ─────────────────────────────────────────────────────────────────────

test('budget: a run that exceeds its token cap stops dispatching and asks the user', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'spend tokens',
        policy: { budget: { maxTokensPerRun: 10 } },
        tasks: [{ id: 'a', title: 'a', objective: 'a' }],
      },
      'budget-run',
    );
    const worker = new QueueWorker({ a: [completed('done', 100)] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();

    // 任务本身成功了，但整趟 Run 的预算已穿：不进 idle / completed，停下来问人。
    assert.equal(final.tasks.a.status, 'completed');
    assert.equal(final.status, 'awaiting_user');
    assert.match(final.awaitingReason ?? '', /tokens: 100 \/ 10/);
    assert.equal(final.usage?.tokens, 100);
    assert.match(eventsOf(store), /"type":"run.budget_exhausted","data":\{"limit":"tokens","used":100\}/);
    assert.match(eventsOf(store), /"type":"run.awaiting_user"/);
  });
});

test('budget: resuming starts a fresh budget window instead of failing again immediately', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'resume after budget',
        autoClose: true,
        policy: { reviewOnIdle: false, budget: { maxTokensPerRun: 10 } },
        tasks: [{ id: 'a', title: 'a', objective: 'a' }],
      },
      'budget-resume',
    );
    const worker = new QueueWorker({ a: [completed('done', 100)] });
    const scheduler = new OrchestrationScheduler(store, worker, {}, { pollMs: 1 });
    const waiting = await scheduler.run();
    assert.equal(waiting.status, 'awaiting_user');

    scheduler.resume('operator top-up');
    const final = await scheduler.run();
    // 人一旦介入就重新计时：同一批成果不会再被判超限，Run 正常收尾。
    assert.equal(final.status, 'completed');
    assert.equal(final.usage?.tokens, 0);
    assert.equal(final.budgetWindowStart !== undefined, true);
  });
});

test('budget: wall-clock cap also stops the run', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'slow run',
        policy: { budget: { maxWallClockMs: 1 } },
        tasks: [{ id: 'a', title: 'a', objective: 'a' }],
      },
      'budget-clock',
    );
    const worker = new QueueWorker({ a: [completed('done')] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'awaiting_user');
    assert.match(final.awaitingReason ?? '', /wall_clock/);
  });
});

// ── 冲突串行 ─────────────────────────────────────────────────────────────────

test('conflict.serialized records which writer blocked which on a shared root', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'same files',
        autoClose: true,
        lanes: [
          { id: 'one', mode: 'inplace', allowInplace: true, workspaceRoot: root },
          { id: 'two', mode: 'inplace', allowInplace: true, workspaceRoot: root },
        ],
        tasks: [
          { id: 'a', title: 'a', objective: 'a', lane: 'one', scope: { allow: ['src/**'] } },
          { id: 'b', title: 'b', objective: 'b', lane: 'two', scope: { allow: ['src/api/**'] } },
        ],
      },
      'conflict-run',
    );
    const worker = new QueueWorker({ a: [completed('a')], b: [completed('b')] });

    await new OrchestrationScheduler(store, worker, {}, { pollMs: 5 }).run();

    const events = eventsOf(store);
    assert.match(events, /"type":"conflict.serialized","data":\{"taskId":"b","blockedBy":"a","overlap":"scope"\}/);
    // 旧的 task.deferred 仍然保留：一个说「为什么没发」，一个说「谁挡了谁」。
    assert.match(events, /"type":"task.deferred"/);
  });
});

test('conflict.serialized dedupes the same pair instead of logging every poll', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'dedupe conflicts',
        autoClose: true,
        lanes: [
          { id: 'one', mode: 'inplace', allowInplace: true, workspaceRoot: root },
          { id: 'two', mode: 'inplace', allowInplace: true, workspaceRoot: root },
        ],
        tasks: [
          { id: 'a', title: 'a', objective: 'a', lane: 'one', scope: { allow: ['src/**'] } },
          { id: 'b', title: 'b', objective: 'b', lane: 'two', scope: { allow: ['src/**'] } },
        ],
      },
      'conflict-dedupe',
    );
    const worker = new QueueWorker({ a: [completed('a')], b: [completed('b')] });
    await new OrchestrationScheduler(store, worker, {}, { pollMs: 5 }).run();
    const matches = eventsOf(store).match(/"type":"conflict\.serialized"/g) ?? [];
    assert.equal(matches.length, 1);
  });
});

// ── awaiting_user 唤醒 ──────────────────────────────────────────────────────

test('awaiting_user: dispatching a new task wakes the run up and it finishes normally', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'two halves',
        autoClose: true,
        policy: { reviewOnIdle: false, budget: { maxTokensPerRun: 10 } },
        tasks: [{ id: 'a', title: 'a', objective: 'a' }],
      },
      'await-dispatch',
    );
    const worker = new QueueWorker({ a: [completed('first half', 50)], b: [completed('second half', 0)] });
    const scheduler = new OrchestrationScheduler(store, worker, {}, { pollMs: 1 });
    const waiting = await scheduler.run();
    assert.equal(waiting.status, 'awaiting_user');
    assert.match(waiting.awaitingReason ?? '', /budget exhausted/);

    // 人补一个后继任务：任务账本允许在 awaiting_user 上追加，并自动 resume。
    scheduler.appendTask({ id: 'b', title: 'b', objective: 'finish it', lane: 'a' });
    const final = await scheduler.run();
    assert.equal(final.status, 'completed');
    assert.equal(final.tasks.b.status, 'completed');
    assert.equal(final.awaitingReason, undefined);
    assert.deepEqual(worker.order, ['a', 'b']);
    assert.match(eventsOf(store), /"type":"run\.resumed"/);
  });
});

test('awaiting_user: watch reports the reason instead of silently waiting', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'needs a decision', tasks: [{ id: 'a', title: 'a', objective: 'a', maxAttempts: 1 }] },
      'await-watch',
    );
    const worker = new QueueWorker({
      a: [{ outcome: 'failed', summary: 'nope', changedFiles: [], error: 'boom' }],
    });
    await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();

    const out: string[] = [];
    const err: string[] = [];
    const deps: SuperviseCliDeps = {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      worker: () => new QueueWorker({}),
      modelConfigured: async () => true,
    };
    assert.equal(await runSuperviseCli(['watch', 'await-watch', '--sandbox-root', root], deps), 0);
    assert.match(out.join(''), /awaiting_user/);
    assert.match(out.join(''), /Waiting for you:/);
    assert.match(err.join(''), /mocode supervise resume await-watch/);
  });
});

test('CLI: --max-tokens lands in the policy and resume clears the waiting state', async () => {
  await withRoot(async (root) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: SuperviseCliDeps = {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      worker: () => new QueueWorker({ 'task-1': [completed('spent', 50)] }),
      modelConfigured: async () => true,
    };
    assert.equal(
      await runSuperviseCli(['start', 'tokens', '--sandbox-root', root, '--max-tokens', '10', '--no-review'], deps),
      0,
      err.join(''),
    );
    const runId = /Orchestration started: ([^\s]+)/.exec(out.join(''))?.[1];
    assert.ok(runId);
    assert.match(out.join(''), /budget tokens 50\/10/);
    assert.match(out.join(''), /awaiting_user/);

    out.length = 0;
    assert.equal(await runSuperviseCli(['resume', runId, '--sandbox-root', root], deps), 0, err.join(''));
    assert.match(out.join(''), /run\.resumed/);
  });
});

// ── Host 心跳 ────────────────────────────────────────────────────────────────

interface HeartbeatFixture {
  root: string;
  workerRoot: string;
  hostPath: string;
}

/** 写一个只做最少事情的假 host：runtime_ready → run_started，然后按 mode 决定是否发心跳。 */
function writeFakeHost(root: string, mode: 'silent' | 'beating'): HeartbeatFixture {
  const workerRoot = path.join(root, `worker-${mode}`);
  fs.mkdirSync(path.join(workerRoot, '.git'), { recursive: true });
  const hostPath = path.join(root, `fake-host-${mode}.mjs`);
  fs.writeFileSync(
    hostPath,
    `import readline from 'node:readline';
const emit = (event, payload = {}, requestId) => process.stdout.write(JSON.stringify({ type: 'event', event, payload, requestId }) + '\\n');
emit('runtime_ready', { projectRoot: process.cwd(), pid: process.pid });
const beat = ${mode === 'beating' ? 'setInterval(() => emit("heartbeat", { pid: process.pid, at: Date.now() }), 20)' : 'null'};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.type !== 'run') continue;
  emit('run_started', { sessionId: 'session-1' }, command.id);
  const finish = () => {
    if (beat) clearInterval(beat);
    emit('text_delta', { text: '<mocode_handoff>{"summary":"beat done","risks":[]}</mocode_handoff>' }, command.id);
    emit('run_completed', { completed: true }, command.id);
  };
  setTimeout(finish, ${mode === 'beating' ? 200 : 3_000});
}
`,
    'utf8',
  );
  return { root, workerRoot, hostPath };
}

test('heartbeat: a worker that stops reporting is judged interrupted', async () => {
  await withRoot(async (root) => {
    const fixture = writeFakeHost(root, 'silent');
    const run = createInitialRun('heartbeat-timeout', root, {
      objective: 'hang',
      autoClose: true,
      tasks: [{ id: 'task', title: 'task', objective: 'task' }],
    });
    const worker = new HostWorkerExecutor({
      hostPath: fixture.hostPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 300,
      heartbeatTimeoutMs: 80,
      createWorktree: () => ({ path: fixture.workerRoot, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
    });

    const result = await worker.run(
      { run, task: run.tasks.task, attempt: 1, workerId: 'worker-hang' },
      () => undefined,
    );
    assert.equal(result.outcome, 'interrupted');
    assert.match(result.error ?? '', /heartbeats/);
    // 看门狗只结束 attempt，不动目录：成果仍可被 lane 归档。
    assert.ok(!result.keepWorktree);
    assert.equal(worker.isAlive('worker-hang'), false);
  });
});

test('heartbeat: regular heartbeats keep a long worker alive', async () => {
  await withRoot(async (root) => {
    const fixture = writeFakeHost(root, 'beating');
    const run = createInitialRun('heartbeat-alive', root, {
      objective: 'stay alive',
      autoClose: true,
      tasks: [{ id: 'task', title: 'task', objective: 'task' }],
    });
    const worker = new HostWorkerExecutor({
      hostPath: fixture.hostPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 300,
      heartbeatTimeoutMs: 80,
      createWorktree: () => ({ path: fixture.workerRoot, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
    });

    const result = await worker.run(
      { run, task: run.tasks.task, attempt: 1, workerId: 'worker-alive' },
      () => undefined,
    );
    assert.equal(result.outcome, 'completed');
    assert.equal(result.error, undefined);
    assert.equal(worker.isAlive('worker-alive'), false);
  });
});
