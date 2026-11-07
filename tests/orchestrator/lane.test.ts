import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchestrationScheduler } from '../../src/orchestrator/scheduler.js';
import { createInitialRun } from '../../src/orchestrator/state.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import type {
  LaneCloseRequest,
  LaneCloseResult,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-'));
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

interface LaneCall {
  laneId?: string;
  worktreePath?: string;
  sessionId?: string;
  baselineTree?: string;
}

/** 记录每次派发看到的 lane 现场，并模拟控制面/Worker 的握手（opened → session → checkpoint）。 */
class RecordingWorker implements WorkerExecutor {
  readonly calls: LaneCall[] = [];
  readonly closed: string[] = [];
  cancelled = 0;

  constructor(private readonly results: Record<string, WorkerTaskResult[]>) {}

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    const lane = request.lane;
    this.calls.push({
      laneId: lane?.id,
      worktreePath: lane?.worktreePath,
      sessionId: lane?.sessionId,
      baselineTree: lane?.baselineTree,
    });
    const worktreePath = lane?.worktreePath ?? `/fake/worktrees/${lane?.id ?? request.task.id}`;
    if (lane && !lane.worktreePath) {
      onProgress({ message: 'lane opened', workspacePath: worktreePath, lane: { opened: true, baseTree: 'base-0' } });
    }
    const sessionId = lane?.sessionId ?? `session-${request.task.id}`;
    onProgress({ message: 'started by fake worker', sessionId, workspacePath: worktreePath, started: true });
    const result = this.results[request.task.id]?.shift();
    if (!result) throw new Error(`No scripted result for ${request.task.id}`);
    return {
      ...result,
      laneId: lane?.id,
      worktreePath,
      baselineTree: result.baselineTree ?? `tree-${request.task.id}-${request.attempt}`,
    };
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
  }

  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    this.closed.push(request.lane.id);
    return { patchPath: `lane-patch-${request.lane.id}`, kept: request.lane.keepWorktree };
  }
}

test('lane: tasks sharing a lane reuse one worktree and continue one session', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'two tasks in one lane',
        autoClose: true,
        lanes: [{ id: 'main' }],
        tasks: [
          { id: 'first', title: 'first', objective: 'first', lane: 'main' },
          { id: 'second', title: 'second', objective: 'second', lane: 'main', dependsOn: ['first'] },
        ],
      },
      'lane-reuse',
    );
    const worker = new RecordingWorker({ first: [completed('first done')], second: [completed('second done')] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');

    // 第一条任务新建 worktree 与新会话；第二条复用同一个 worktree 与同一个会话。
    assert.equal(worker.calls[0]?.worktreePath, undefined);
    assert.equal(worker.calls[0]?.sessionId, undefined);
    assert.equal(worker.calls[1]?.worktreePath, '/fake/worktrees/main');
    assert.equal(worker.calls[1]?.sessionId, 'session-first');
    // 第二条任务的 diff 基线是第一条任务结束时的 tree。
    assert.equal(worker.calls[1]?.baselineTree, 'tree-first-1');

    const lane = final.lanes.main;
    assert.equal(lane.worktreePath, '/fake/worktrees/main');
    assert.equal(lane.baseTree, 'base-0');
    assert.equal(lane.baselineTree, 'tree-second-1');
    assert.equal(lane.sessionId, 'session-first');
    assert.ok(lane.closed, 'run completion must close the lane');
    assert.equal(lane.closed?.kept, false);
    assert.deepEqual(worker.closed, ['main']);
  });
});

test('lane: keepWorktree preserves the workspace after the run ends', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'keep',
        autoClose: true,
        lanes: [{ id: 'main', keepWorktree: true }],
        tasks: [{ id: 'a', title: 'a', objective: 'a', lane: 'main' }],
      },
      'lane-keep',
    );
    const worker = new RecordingWorker({ a: [completed('done')] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(final.lanes.main.closed?.kept, true);
  });
});

test('lane: a lane may target another repository root', async () => {
  await withRoot(async (root) => {
    const other = path.join(root, 'other-repo');
    fs.mkdirSync(other, { recursive: true });
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'cross-repo',
        autoClose: true,
        lanes: [{ id: 'elsewhere', workspaceRoot: 'other-repo' }],
        tasks: [{ id: 'a', title: 'a', objective: 'a', lane: 'elsewhere' }],
      },
      'lane-cross-repo',
    );
    assert.equal(path.resolve(store.current.lanes.elsewhere.workspaceRoot), path.resolve(other));

    const worker = new RecordingWorker({ a: [completed('done')] });
    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(path.resolve(final.lanes.elsewhere.workspaceRoot), path.resolve(other));
  });
});

test('lane: retry keeps the previous attempt worktree instead of restarting from HEAD', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'retry in place',
        autoClose: true,
        lanes: [{ id: 'main' }],
        tasks: [{ id: 'a', title: 'a', objective: 'a', lane: 'main', maxAttempts: 2 }],
      },
      'lane-retry',
    );
    const worker = new RecordingWorker({
      a: [
        { outcome: 'failed', summary: 'first attempt failed', changedFiles: ['src/a.ts'], error: 'boom' },
        completed('second attempt done'),
      ],
    });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(worker.calls.length, 2);
    // 重试复用同一个 worktree，并以第一次 attempt 结束时的 tree 为基线。
    assert.equal(worker.calls[1]?.worktreePath, '/fake/worktrees/main');
    assert.equal(worker.calls[1]?.baselineTree, 'tree-a-1');
    assert.equal(final.lanes.main.baselineTree, 'tree-a-2');
    // lane 只关一次。
    assert.deepEqual(worker.closed, ['main']);
  });
});

test('lane: a cancelled run still closes opened lanes', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'cancel', lanes: [{ id: 'main' }], tasks: [{ id: 'a', title: 'a', objective: 'a', lane: 'main' }] },
      'lane-cancel',
    );
    let release!: (result: WorkerTaskResult) => void;
    const worker: WorkerExecutor & { closed: string[] } = {
      closed: [],
      async run(_request, onProgress) {
        onProgress({ message: 'lane opened', workspacePath: '/fake/wt', lane: { opened: true, baseTree: 'base-0' } });
        onProgress({ message: 'running', sessionId: 'session-a', started: true });
        return new Promise<WorkerTaskResult>((resolve) => {
          release = resolve;
        });
      },
      async cancel() {
        release({ outcome: 'cancelled', summary: '', changedFiles: [], error: 'cancelled' });
      },
      async closeLane() {
        this.closed.push('main');
        return { kept: false };
      },
    };

    const running = new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.requestCancellation();
    const final = await running;
    assert.equal(final.status, 'cancelled');
    assert.deepEqual(worker.closed, ['main']);
    assert.equal(final.lanes.main.closed?.reason, 'run cancelled');
  });
});

test('lane: unknown lane reference and duplicate lane ids are rejected', () =>
  withRoot((root) => {
    assert.throws(
      () =>
        createInitialRun('bad-lane', root, {
          objective: 'x',
          lanes: [{ id: 'a' }],
          tasks: [{ id: 't', title: 't', objective: 't', lane: 'missing' }],
        }),
      /unknown lane/,
    );
    assert.throws(
      () =>
        createInitialRun('dup-lane', root, {
          objective: 'x',
          lanes: [{ id: 'a' }, { id: 'a' }],
          tasks: [{ id: 't', title: 't', objective: 't', lane: 'a' }],
        }),
      /Duplicate lane id/,
    );
  }));
