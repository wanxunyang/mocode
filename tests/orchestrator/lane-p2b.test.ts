import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuperviseCli, type SuperviseCliDeps } from '../../src/orchestrator/cli.js';
import { WorkspaceLeaseManager } from '../../src/orchestrator/lease.js';
import { buildReviewPrompt, needsReview, reviewRun } from '../../src/orchestrator/review.js';
import { OrchestrationScheduler } from '../../src/orchestrator/scheduler.js';
import { scopeOverlaps } from '../../src/orchestrator/scope.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import { HostWorkerExecutor } from '../../src/orchestrator/worker.js';
import type {
  LaneCloseRequest,
  LaneCloseResult,
  OrchestrationDefinition,
  RunReview,
  TaskContract,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-p2b-'));
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

function completed(summary: string): WorkerTaskResult {
  return { outcome: 'completed', summary, changedFiles: [] };
}

/**
 * 并发探针 Worker：记录同时在跑的峰值，并让每次 run 至少存活 `holdMs`，
 * 这样调度器有机会在同一个轮次里把第二个任务也塞进槽位。
 */
class ProbeWorker implements WorkerExecutor {
  peak = 0;
  current = 0;
  readonly order: string[] = [];
  readonly closed: string[] = [];

  constructor(
    private readonly results: Record<string, WorkerTaskResult[]>,
    private readonly holdMs = 40,
  ) {}

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    this.current += 1;
    this.peak = Math.max(this.peak, this.current);
    this.order.push(request.task.id);
    const lane = request.lane;
    const worktreePath = lane?.worktreePath ?? `/fake/${lane?.mode ?? 'worktree'}/${lane?.id ?? request.task.id}`;
    if (lane && !lane.worktreePath) {
      onProgress({ message: 'lane opened', workspacePath: worktreePath, lane: { opened: true, baseTree: 'base-0' } });
    }
    onProgress({
      message: 'started',
      sessionId: `session-${request.task.id}`,
      workspacePath: worktreePath,
      started: true,
    });
    await new Promise((resolve) => setTimeout(resolve, this.holdMs));
    this.current -= 1;
    const result = this.results[request.task.id]?.shift();
    if (!result) throw new Error(`No scripted result for ${request.task.id}`);
    return { ...result, laneId: lane?.id, worktreePath, baselineTree: `tree-${request.task.id}` };
  }

  async cancel(): Promise<void> {
    this.current = 0;
  }

  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    this.closed.push(request.lane.id);
    return { patchPath: `patch-${request.lane.id}`, kept: request.lane.keepWorktree };
  }
}

function contract(allow: string[], changePolicy: TaskContract['changePolicy'] = 'isolated_write'): TaskContract {
  return {
    objective: 'x',
    scope: { allow, deny: ['.git/**'] },
    acceptanceCriteria: [],
    requiredChecks: [],
    changePolicy,
  };
}

// ── 并发槽位 ─────────────────────────────────────────────────────────────────

test('concurrency: two lanes run at the same time under the default policy', async () => {
  await withRoot(async (root) => {
    const definition: OrchestrationDefinition = {
      objective: 'parallel work',
      autoClose: true,
      lanes: [{ id: 'one' }, { id: 'two' }],
      tasks: [
        { id: 'a', title: 'a', objective: 'a', lane: 'one' },
        { id: 'b', title: 'b', objective: 'b', lane: 'two' },
      ],
    };
    const store = OrchestrationStore.create(root, definition, 'parallel-run');
    assert.equal(store.current.policy.maxConcurrentWorkers, 6);
    const worker = new ProbeWorker({ a: [completed('a done')], b: [completed('b done')] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 5 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(worker.peak, 2, 'both tasks should be in flight together');
  });
});

test('concurrency: --concurrency 1 forces strict serial execution', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'serial work',
        autoClose: true,
        policy: { maxConcurrentWorkers: 1, maxConcurrentPerWorkspace: 1 },
        lanes: [{ id: 'one' }, { id: 'two' }],
        tasks: [
          { id: 'a', title: 'a', objective: 'a', lane: 'one' },
          { id: 'b', title: 'b', objective: 'b', lane: 'two' },
        ],
      },
      'serial-run',
    );
    const worker = new ProbeWorker({ a: [completed('a done')], b: [completed('b done')] });
    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 5 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(worker.peak, 1);
    assert.deepEqual(worker.order, ['a', 'b']);
  });
});

test('concurrency: two tasks sharing one lane are serialized with a lane_busy deferral', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'lane exclusive',
        autoClose: true,
        lanes: [{ id: 'main' }],
        tasks: [
          { id: 'first', title: 'first', objective: 'first', lane: 'main' },
          { id: 'second', title: 'second', objective: 'second', lane: 'main' },
        ],
      },
      'lane-exclusive',
    );
    const worker = new ProbeWorker({ first: [completed('first')], second: [completed('second')] });
    const deferred: string[] = [];
    const final = await new OrchestrationScheduler(
      store,
      worker,
      {
        onEvent: (event) => {
          if (event.type === 'task.deferred') deferred.push(`${event.data.taskId}:${event.data.reason}`);
        },
      },
      { pollMs: 5 },
    ).run();
    assert.equal(final.status, 'completed');
    assert.equal(worker.peak, 1);
    assert.deepEqual(deferred, ['second:lane_busy']);
  });
});

// ── 工作区租约 ───────────────────────────────────────────────────────────────

test('lease: isolated workers share a workspace up to the per-workspace limit', () => {
  const leases = new WorkspaceLeaseManager();
  const a = leases.tryAcquire('C:/ws', 'isolated', 2);
  const b = leases.tryAcquire('C:/ws', 'isolated', 2);
  assert.ok(a && b);
  assert.equal(leases.tryAcquire('C:/ws', 'isolated', 2), undefined);
  a!.release();
  assert.ok(leases.tryAcquire('C:/ws', 'isolated', 2));
});

test('lease: in-place writing is exclusive and blocks both directions', () => {
  const leases = new WorkspaceLeaseManager();
  const isolated = leases.tryAcquire('C:/ws', 'isolated', 4);
  assert.ok(isolated);
  assert.equal(leases.tryAcquire('C:/ws', 'inplace', 4), undefined, 'in-place must wait for isolated workers');
  isolated!.release();

  const inplace = leases.tryAcquire('C:/ws', 'inplace', 4);
  assert.ok(inplace);
  assert.equal(leases.tryAcquire('C:/ws', 'inplace', 4), undefined);
  assert.equal(leases.tryAcquire('C:/ws', 'isolated', 4), undefined, 'isolated must wait for in-place');
  inplace!.release();
  assert.ok(leases.tryAcquire('C:/ws', 'isolated', 4));
});

test('lease: two in-place lanes on one workspace never run together', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'in place twice',
        autoClose: true,
        lanes: [
          { id: 'one', mode: 'inplace', allowInplace: true, workspaceRoot: root },
          { id: 'two', mode: 'inplace', allowInplace: true, workspaceRoot: root },
        ],
        tasks: [
          { id: 'a', title: 'a', objective: 'a', lane: 'one', scope: { allow: ['src/a/**'] } },
          { id: 'b', title: 'b', objective: 'b', lane: 'two', scope: { allow: ['docs/**'] } },
        ],
      },
      'inplace-lease',
    );
    const worker = new ProbeWorker({ a: [completed('a')], b: [completed('b')] });
    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 5 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(worker.peak, 1, 'one directory cannot be written by two workers');
    const deferrals = path.join(store.directory, 'events.jsonl');
    assert.match(fs.readFileSync(deferrals, 'utf8'), /workspace_lease/);
  });
});

test('lease: a stale in-place lock owned by a dead process is taken over', () =>
  withRoot((root) => {
    fs.mkdirSync(path.join(root, '.mocode'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.mocode', 'lane.lock'),
      `${JSON.stringify({ pid: 999999, token: 'stale' })}\n`,
      'utf8',
    );
    const leases = new WorkspaceLeaseManager();
    const lease = leases.tryAcquire(root, 'inplace', 1);
    assert.ok(lease, 'a dead owner must not block the workspace forever');
    lease!.release();
    assert.equal(fs.existsSync(path.join(root, '.mocode', 'lane.lock')), false);
  }));

// ── 冲突串行 ─────────────────────────────────────────────────────────────────

test('scope overlap: wildcard prefixes decide whether two writers may run together', () => {
  assert.equal(scopeOverlaps(contract(['src/**']), contract(['src/api/**'])), true);
  assert.equal(scopeOverlaps(contract(['src/**']), contract(['docs/**', 'src/a.ts'])), true);
  assert.equal(scopeOverlaps(contract(['src/a/**']), contract(['src/b/**'])), false);
  assert.equal(scopeOverlaps(contract(['docs/**']), contract(['tests/**'])), false);
  // 全局写与任何写都相交。
  assert.equal(scopeOverlaps(contract(['**/*']), contract(['docs/**'])), true);
});

test('conflict: overlapping writers on a shared in-place root are serialized as scope_overlap', async () => {
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
      'scope-conflict',
    );
    const worker = new ProbeWorker({ a: [completed('a')], b: [completed('b')] });
    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 5 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(worker.peak, 1);
    // lastEvent 会被后续 task.progress 覆盖，冲突证据只能从账本里读。
    assert.match(fs.readFileSync(path.join(store.directory, 'events.jsonl'), 'utf8'), /"reason":"scope_overlap"/);
  });
});

// ── 收工判定 ─────────────────────────────────────────────────────────────────

test('review: draining the queue records a supervisor verdict before going idle', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'ship the feature', tasks: [{ id: 'a', title: 'a', objective: 'a' }] },
      'review-run',
    );
    const worker = new ProbeWorker({ a: [completed('only the first half')] });
    let reviews = 0;
    const final = await new OrchestrationScheduler(
      store,
      worker,
      {},
      {
        pollMs: 5,
        review: async (run): Promise<RunReview> => {
          reviews += 1;
          assert.match(run.tasks.a.output?.summary ?? '', /first half/);
          return {
            verdict: 'continue',
            rationale: 'the objective mentions the whole feature',
            remaining: ['implement the second half'],
            createdAt: new Date().toISOString(),
          };
        },
      },
    ).run();

    assert.equal(final.status, 'idle');
    assert.equal(reviews, 1);
    assert.equal(final.lastReview?.verdict, 'continue');
    assert.deepEqual(final.lastReview?.remaining, ['implement the second half']);
    // lane 仍然开着：判定只是建议，收工由用户决定。
    assert.equal(final.lanes.a.closed, undefined);
  });
});

test('review: a failing reviewer never blocks the run from idling', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'resilient review', tasks: [{ id: 'a', title: 'a', objective: 'a' }] },
      'review-failure',
    );
    const worker = new ProbeWorker({ a: [completed('done')] });
    const final = await new OrchestrationScheduler(
      store,
      worker,
      {},
      {
        pollMs: 5,
        review: async () => {
          throw new Error('reviewer exploded');
        },
      },
    ).run();
    assert.equal(final.status, 'idle');
    assert.equal(final.lastReview?.verdict, 'unknown');
    assert.match(final.lastReview?.error ?? '', /reviewer exploded/);
  });
});

test('review: reviewOnIdle=false skips the extra model turn', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'no review',
        policy: { reviewOnIdle: false },
        tasks: [{ id: 'a', title: 'a', objective: 'a' }],
      },
      'review-off',
    );
    const worker = new ProbeWorker({ a: [completed('done')] });
    let reviews = 0;
    const final = await new OrchestrationScheduler(
      store,
      worker,
      {},
      {
        pollMs: 5,
        review: async () => {
          reviews += 1;
          return { verdict: 'done', rationale: '', remaining: [], createdAt: new Date().toISOString() };
        },
      },
    ).run();
    assert.equal(final.status, 'idle');
    assert.equal(reviews, 0);
    assert.equal(final.lastReview, undefined);
  });
});

test('review: dry-run prints the evidence bundle without calling the model', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'summarize the repo', tasks: [{ id: 'a', title: 'summarize', objective: 'read README' }] },
      'review-dry',
    );
    const review = await reviewRun(store.current, { dryRun: true });
    assert.equal(review.verdict, 'unknown');
    assert.match(review.rationale, /Run objective: summarize the repo/);
    assert.match(review.rationale, /read README/);
    assert.match(buildReviewPrompt(store.current), /Lanes:/);
  });
});

test('review: an unchanged run is not reviewed twice', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'dedupe', tasks: [{ id: 'a', title: 'a', objective: 'a' }] },
      'review-dedupe',
    );
    assert.equal(needsReview(store.current), true);
    const reviewed = {
      ...store.current,
      lastReview: {
        verdict: 'done' as const,
        rationale: 'done',
        remaining: [],
        createdAt: '2099-01-01T00:00:00.000Z',
      },
    };
    assert.equal(needsReview(reviewed), false);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

function cliDeps(out: string[], err: string[], results: Record<string, WorkerTaskResult[]>): SuperviseCliDeps {
  return {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    worker: () => new ProbeWorker(results, 1),
    modelConfigured: async () => true,
  };
}

test('supervise CLI: --concurrency and --no-review land in the run policy', async () => {
  await withRoot(async (root) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = cliDeps(out, err, { 'task-1': [completed('done')] });
    const code = await runSuperviseCli(
      ['start', 'tune', '--sandbox-root', root, '--auto-close', '--concurrency', '3', '--no-review'],
      deps,
    );
    assert.equal(code, 0, err.join(''));
    assert.match(out.join(''), /Policy: concurrency 3, per-workspace 3, review off/);
    const runId = /Orchestration started: (\S+)/.exec(out.join(''))?.[1];
    assert.ok(runId);
    const stored = OrchestrationStore.load(root, runId!).current;
    assert.equal(stored.policy.maxConcurrentWorkers, 3);
    assert.equal(stored.policy.reviewOnIdle, false);
  });
});

test('supervise CLI: an invalid --concurrency value is rejected', async () => {
  await withRoot(async (root) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = cliDeps(out, err, {});
    const code = await runSuperviseCli(['start', 'x', '--sandbox-root', root, '--concurrency', '0'], deps);
    assert.equal(code, 1);
    assert.match(err.join(''), /--concurrency must be a positive integer/);
  });
});

// ── Host 并发 ───────────────────────────────────────────────────────────────

test('HostWorkerExecutor: two workers run concurrently and both report a handoff', async () => {
  await withRoot(async (root) => {
    const workerRoot = path.join(root, 'worker');
    fs.mkdirSync(path.join(workerRoot, '.git'), { recursive: true });
    const hostPath = path.join(root, 'fake-host.mjs');
    fs.writeFileSync(
      hostPath,
      `import readline from 'node:readline';
const emit = (event, payload = {}, requestId) => process.stdout.write(JSON.stringify({ type: 'event', event, payload, requestId }) + '\\n');
emit('runtime_ready', {});
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.type !== 'run') continue;
  const tag = command.prompt.includes('SLOW') ? 'slow' : 'fast';
  emit('run_started', { sessionId: 'session-' + tag }, command.id);
  await new Promise((resolve) => setTimeout(resolve, tag === 'slow' ? 120 : 10));
  emit('text_delta', { text: '<mocode_handoff>{"summary":"' + tag + ' worker done","validation":[],"risks":[]}</mocode_handoff>' }, command.id);
  emit('run_completed', { completed: true, changedFiles: [] }, command.id);
}
`,
      'utf8',
    );
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'two hosts',
        autoClose: true,
        policy: { maxConcurrentWorkers: 2, maxConcurrentPerWorkspace: 2 },
        lanes: [{ id: 'slow' }, { id: 'fast' }],
        tasks: [
          { id: 'slow', title: 'slow', objective: 'SLOW job', lane: 'slow' },
          { id: 'fast', title: 'fast', objective: 'quick job', lane: 'fast' },
        ],
      },
      'host-parallel',
    );
    const worker = new HostWorkerExecutor({
      hostPath,
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 500,
      createWorktree: () => ({ path: workerRoot, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
    });
    const started: string[] = [];
    const final = await new OrchestrationScheduler(
      store,
      worker,
      {
        onEvent(event) {
          if ('taskId' in event.data && event.type.startsWith('task.')) {
            started.push(`${event.type}:${event.data.taskId}`);
          }
        },
      },
      { pollMs: 5 },
    ).run();
    assert.equal(final.status, 'completed');
    assert.equal(final.tasks.slow.output?.summary, 'slow worker done');
    assert.equal(final.tasks.fast.output?.summary, 'fast worker done');
    // 串行时 fast 只能等 slow 跑完（120ms）才开始；两个 host 都活着时 fast 会先启动。
    const slowStarted = started.indexOf('task.started:slow');
    const slowDone = started.indexOf('task.completed:slow');
    const fastStarted = started.indexOf('task.started:fast');
    assert.ok(slowStarted >= 0 && slowDone >= 0 && fastStarted >= 0, started.join(','));
    assert.ok(fastStarted < slowDone, `fast should start before slow finishes: ${started.join(',')}`);
  });
});
