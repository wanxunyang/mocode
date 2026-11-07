import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSuperviseCli, type SuperviseCliDeps } from '../../src/orchestrator/cli.js';
import { OrchestrationScheduler } from '../../src/orchestrator/scheduler.js';
import { createInitialRun } from '../../src/orchestrator/state.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import { HostWorkerExecutor } from '../../src/orchestrator/worker.js';
import type {
  LaneCloseRequest,
  LaneCloseResult,
  OrchestrationDefinition,
  TaskHandoff,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-orchestrator-'));
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

function definition(tasks: OrchestrationDefinition['tasks']): OrchestrationDefinition {
  // 这些用例验证的是重试 / 恢复 / 取消，不涉及长驻语义：用 autoClose 保持 P1 的「跑完即终态」。
  return { objective: 'deliver the feature', tasks, autoClose: true };
}

/** CLI start 现在要求 sandbox root 就是 git 仓库根；测试用空仓库 + 一次提交。 */
function initGitRepo(root: string): void {
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'init']);
}

function completed(summary: string): WorkerTaskResult {
  return { outcome: 'completed', summary, changedFiles: [] };
}

class ScriptedWorker implements WorkerExecutor {
  readonly requests: Array<{ taskId: string; attempt: number }> = [];
  readonly laneRequests: Array<{
    laneId?: string;
    worktreePath?: string;
    sessionId?: string;
    baselineTree?: string;
  }> = [];
  readonly closedLanes: string[] = [];
  cancelled = 0;

  constructor(private readonly results: Record<string, WorkerTaskResult[]>) {}

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    const lane = request.lane;
    this.requests.push({ taskId: request.task.id, attempt: request.attempt });
    this.laneRequests.push({
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
    this.closedLanes.push(request.lane.id);
    return { patchPath: `patch-${request.lane.id}`, kept: request.lane.keepWorktree };
  }
}

function handoff(taskId: string, attempt: number): TaskHandoff {
  return {
    taskId,
    attempt,
    outcome: 'completed',
    summary: `${taskId} done`,
    changedFiles: [],
    validation: [],
    artifacts: [],
    risks: [],
  };
}

test('definition validation rejects duplicate, unknown, and cyclic task graphs', () => {
  assert.throws(
    () =>
      createInitialRun(
        'run',
        '.',
        definition([
          { id: 'same', title: 'one', objective: 'one' },
          { id: 'same', title: 'two', objective: 'two' },
        ]),
      ),
    /Duplicate task id/,
  );
  assert.throws(
    () => createInitialRun('run', '.', definition([{ id: 'a', title: 'a', objective: 'a', dependsOn: ['missing'] }])),
    /unknown task/,
  );
  assert.throws(
    () =>
      createInitialRun(
        'run',
        '.',
        definition([
          { id: 'a', title: 'a', objective: 'a', dependsOn: ['b'] },
          { id: 'b', title: 'b', objective: 'b', dependsOn: ['a'] },
        ]),
      ),
    /cycle/,
  );
});

test('store rebuilds a damaged snapshot, repairs an incomplete JSONL tail, and rejects stale future snapshots', () =>
  withRoot((root) => {
    const store = OrchestrationStore.create(root, definition([{ id: 'a', title: 'a', objective: 'a' }]), 'repair-run');
    store.append({ type: 'task.ready', data: { taskId: 'a', reason: 'dependencies_satisfied' } });
    const eventsPath = path.join(store.directory, 'events.jsonl');
    const snapshotPath = path.join(store.directory, 'snapshot.json');
    fs.appendFileSync(eventsPath, '{"schemaVersion":1', 'utf8');
    fs.writeFileSync(snapshotPath, '{not-json', 'utf8');

    const repaired = OrchestrationStore.load(root, 'repair-run');
    assert.equal(repaired.current.sequence, 2);
    assert.equal(repaired.current.tasks.a.status, 'ready');
    assert.ok(fs.readFileSync(eventsPath, 'utf8').endsWith('\n'));
    assert.doesNotThrow(() =>
      fs
        .readFileSync(eventsPath, 'utf8')
        .trim()
        .split('\n')
        .forEach((line) => JSON.parse(line)),
    );

    const future = { ...repaired.current, sequence: 999 };
    fs.writeFileSync(snapshotPath, `${JSON.stringify(future)}\n`, 'utf8');
    const rebuilt = OrchestrationStore.load(root, 'repair-run');
    assert.equal(rebuilt.current.sequence, 2);
  }));

test('scheduler retries a failed task, writes every handoff, then unlocks its dependent task', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      definition([
        { id: 'research', title: 'research', objective: 'research', maxAttempts: 2 },
        { id: 'implement', title: 'implement', objective: 'implement', dependsOn: ['research'] },
      ]),
      'retry-run',
    );
    const worker = new ScriptedWorker({
      research: [
        { outcome: 'failed', summary: 'transient failure', changedFiles: [], error: 'temporary' },
        completed('research complete'),
      ],
      implement: [completed('implementation complete')],
    });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.deepEqual(worker.requests, [
      { taskId: 'research', attempt: 1 },
      { taskId: 'research', attempt: 2 },
      { taskId: 'implement', attempt: 1 },
    ]);
    assert.equal(final.tasks.research.output?.summary, 'research complete');
    for (const file of [
      'artifacts/research/attempt-1-handoff.json',
      'artifacts/research/attempt-2-handoff.json',
      'artifacts/implement/attempt-1-handoff.json',
    ]) {
      assert.ok(fs.existsSync(path.join(store.directory, file)), `${file} should exist`);
    }
  });
});

test('recovery marks an in-flight attempt interrupted without redispatching when attempts are exhausted', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      definition([{ id: 'a', title: 'a', objective: 'a', maxAttempts: 1 }]),
      'recovery-run',
    );
    store.append({ type: 'task.ready', data: { taskId: 'a', reason: 'dependencies_satisfied' } });
    store.append({ type: 'task.dispatching', data: { taskId: 'a', attempt: 1, workerId: 'lost-worker' } });
    store.append({ type: 'task.started', data: { taskId: 'a', sessionId: 'lost-session' } });
    const worker = new ScriptedWorker({ a: [] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    // 重试耗尽不再是终态：现场与会话都还在，Run 停在 awaiting_user 等人决定补任务还是收工。
    assert.equal(final.status, 'awaiting_user');
    assert.match(final.awaitingReason ?? '', /exhausted its attempts/);
    assert.equal(final.tasks.a.status, 'interrupted');
    assert.equal(final.tasks.a.attempts, 1);
    assert.deepEqual(worker.requests, []);
  });
});

test('rerunning a terminal run does not dispatch its completed task again', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(root, definition([{ id: 'a', title: 'a', objective: 'a' }]), 'done-run');
    store.append({ type: 'task.ready', data: { taskId: 'a', reason: 'dependencies_satisfied' } });
    store.append({ type: 'task.dispatching', data: { taskId: 'a', attempt: 1, workerId: 'worker' } });
    store.append({ type: 'task.completed', data: { taskId: 'a', handoff: handoff('a', 1) } });
    store.append({ type: 'run.completed', data: {} });
    const worker = new ScriptedWorker({ a: [completed('should not run')] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.deepEqual(worker.requests, []);
  });
});

test('cancellation marker cancels the active worker and all remaining tasks', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      definition([
        { id: 'a', title: 'a', objective: 'a' },
        { id: 'b', title: 'b', objective: 'b', dependsOn: ['a'] },
      ]),
      'cancel-run',
    );
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveResult!: (result: WorkerTaskResult) => void;
    const result = new Promise<WorkerTaskResult>((resolve) => {
      resolveResult = resolve;
    });
    const worker: WorkerExecutor & { cancelCount: number } = {
      cancelCount: 0,
      async run(_request, onProgress) {
        onProgress({ message: 'running', started: true });
        resolveStarted();
        return result;
      },
      async cancel() {
        this.cancelCount += 1;
        resolveResult({ outcome: 'cancelled', summary: 'cancelled', changedFiles: [], error: 'cancelled by test' });
      },
    };

    const running = new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    await started;
    store.requestCancellation();
    const final = await running;
    assert.equal(final.status, 'cancelled');
    assert.equal(worker.cancelCount, 1);
    assert.equal(final.tasks.a.status, 'cancelled');
    assert.equal(final.tasks.b.status, 'cancelled');
  });
});

test('supervise CLI starts a fake-worker run and exposes it through status and list', async () => {
  await withRoot(async (root) => {
    initGitRepo(root);
    const out: string[] = [];
    const err: string[] = [];
    const worker = new ScriptedWorker({ 'task-1': [completed('CLI task complete')] });
    const deps: SuperviseCliDeps = {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      worker: () => worker,
      modelConfigured: async () => true,
    };

    assert.equal(await runSuperviseCli(['start', 'ship', 'feature', '--sandbox-root', root, '--auto-close'], deps), 0);
    const runId = /Orchestration started: ([^\s]+)/.exec(out.join(''))?.[1];
    assert.ok(runId);
    assert.equal(err.join(''), '');

    out.length = 0;
    assert.equal(await runSuperviseCli(['status', runId, '--sandbox-root', root], deps), 0);
    assert.match(out.join(''), /completed {2}1\/1/);
    assert.match(out.join(''), /task-1 {2}completed/);

    out.length = 0;
    assert.equal(await runSuperviseCli(['list', '--sandbox-root', root], deps), 0);
    assert.match(out.join(''), new RegExp(`${runId}  completed  ship feature`));
  });
});

test('HostWorkerExecutor maps host NDJSON, validates handoff, and archives artifacts', async () => {
  await withRoot(async (root) => {
    const workerRoot = path.join(root, 'worker');
    fs.mkdirSync(path.join(workerRoot, '.git'), { recursive: true });
    const hostPath = path.join(root, 'fake-host.mjs');
    fs.writeFileSync(
      hostPath,
      `import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const emit = (event, payload = {}, requestId) => process.stdout.write(JSON.stringify({ type: 'event', event, payload, requestId }) + '\\n');
emit('runtime_ready', { projectRoot: process.cwd() });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.type !== 'run') continue;
  fs.writeFileSync(path.join(process.cwd(), 'prompt.txt'), command.prompt, 'utf8');
  fs.mkdirSync(path.join(process.cwd(), '.mocode', 'sessions', 'session-1'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.mocode', 'sessions', 'session-1', 'session.json'), '{}', 'utf8');
  emit('run_started', { sessionId: 'session-1' }, command.id);
  emit('tool_started', { name: 'read_file' }, command.id);
  emit('text_delta', { text: 'done\\n<mocode_handoff>{"summary":"host task done","validation":[{"command":"npm test","status":"passed"}],"risks":[]}</mocode_handoff>' }, command.id);
  emit('run_completed', { completed: true, changedFiles: ['src/demo.ts'] }, command.id);
}
`,
      'utf8',
    );
    const run = createInitialRun(
      'host-run',
      root,
      definition([
        {
          id: 'host-task',
          title: 'host task',
          objective: 'exercise host',
          requiredChecks: ['npm test'],
        },
      ]),
    );
    let removed = 0;
    const worker = new HostWorkerExecutor({
      hostPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 500,
      createWorktree: () => ({ path: workerRoot, repoRoot: root }),
      collectChanges: () => ({
        changedFiles: ['src/demo.ts'],
        patch: 'diff --git a/src/demo.ts b/src/demo.ts\n',
        tree: 'tree-1',
      }),
      removeWorktree: () => {
        removed += 1;
      },
    });
    const progress: WorkerProgress[] = [];

    const result = await worker.run({ run, task: run.tasks['host-task'], attempt: 1, workerId: 'worker-1' }, (item) =>
      progress.push(item),
    );
    assert.equal(result.outcome, 'completed');
    assert.equal(result.summary, 'host task done');
    assert.deepEqual(result.changedFiles, ['src/demo.ts']);
    assert.equal(result.validation?.[0]?.status, 'passed');
    assert.ok(result.patchPath && fs.existsSync(result.patchPath));
    assert.equal(result.baselineTree, 'tree-1');
    // worktree 与 session 归 lane 所有：closeLane 之前既不能删除，也不能提前归档。
    assert.equal(result.sessionArchivePath, undefined);
    assert.equal(removed, 0);
    assert.match(fs.readFileSync(path.join(workerRoot, 'prompt.txt'), 'utf8'), /Super Agent worker task/);
    assert.ok(progress.some((item) => item.started && item.sessionId === 'session-1'));
    assert.ok(progress.some((item) => item.lane?.opened && item.lane.baseTree === 'tree-1'));

    const closed = await worker.closeLane({
      run,
      lane: {
        id: 'host-task',
        workspaceRoot: root,
        mode: 'worktree',
        allowInplace: false,
        keepWorktree: false,
        worktreePath: result.worktreePath,
        baseTree: 'tree-0',
        sessionId: 'session-1',
      },
      reason: 'run completed',
    });
    assert.equal(closed.kept, false);
    assert.ok(closed.patchPath && fs.existsSync(closed.patchPath));
    assert.ok(closed.sessionArchivePath && fs.existsSync(path.join(closed.sessionArchivePath, 'session.json')));
    assert.equal(removed, 1);
  });
});
test('controller lease blocks a second controller and is released on demand', () =>
  withRoot((root) => {
    const store = OrchestrationStore.create(root, definition([{ id: 'a', title: 'a', objective: 'a' }]), 'lease-run');
    const lease = store.acquireControllerLease();
    assert.throws(() => store.acquireControllerLease(), /active controller/);
    lease.release();
    store.acquireControllerLease().release();
  }));

test('scheduler rejects a self-declared completion that violates the task contract', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      definition([
        {
          id: 'guarded',
          title: 'guarded',
          objective: 'guarded',
          requiredChecks: ['npm test'],
          scope: { allow: ['src/**'] },
          maxAttempts: 3,
        },
      ]),
      'contract-run',
    );
    const worker = new ScriptedWorker({
      guarded: [
        { outcome: 'completed', summary: 'skipped checks', changedFiles: ['src/a.ts'] },
        { outcome: 'completed', summary: 'touched docs', changedFiles: ['docs/a.md'] },
        {
          outcome: 'completed',
          summary: 'checked',
          changedFiles: ['src/a.ts'],
          validation: [{ command: 'npm test', status: 'passed' }],
        },
      ],
    });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.equal(final.tasks.guarded.attempts, 3);
    assert.deepEqual(
      worker.requests.map((item) => item.attempt),
      [1, 2, 3],
    );
  });
});

test('scope validation handles wildcards, deny lists, and path escapes', async () => {
  const { validateChangedFiles } = await import('../../src/orchestrator/scope.js');
  const contract = {
    objective: 'x',
    scope: { allow: ['src/**'], deny: ['src/secrets/**'] },
    acceptanceCriteria: [],
    requiredChecks: [],
    changePolicy: 'isolated_write' as const,
  };
  assert.deepEqual(validateChangedFiles(contract, ['src/a.ts', 'src/deep/b.ts']), []);
  assert.match(validateChangedFiles(contract, ['docs/a.md']).join(' '), /outside the allowed/);
  assert.match(validateChangedFiles(contract, ['src/secrets/key.ts']).join(' '), /denied/);
  assert.match(validateChangedFiles(contract, ['../escape.ts']).join(' '), /Invalid changed-file path/);
  assert.match(validateChangedFiles(contract, ['C:/abs.ts']).join(' '), /Invalid changed-file path/);
});

test('cancel grace period ends a worker that ignores cancellation', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      definition([{ id: 'stuck', title: 'stuck', objective: 'stuck' }]),
      'stuck-run',
    );
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const worker: WorkerExecutor & { cancelCount: number } = {
      cancelCount: 0,
      async run(_request, onProgress) {
        onProgress({ message: 'running', started: true });
        resolveStarted();
        return new Promise<WorkerTaskResult>(() => undefined);
      },
      async cancel() {
        this.cancelCount += 1;
      },
    };

    const running = new OrchestrationScheduler(store, worker, {}, { pollMs: 1, cancelGraceMs: 10 }).run();
    await started;
    store.requestCancellation();
    const final = await running;
    assert.equal(final.status, 'cancelled');
    assert.equal(worker.cancelCount, 1);
  });
});
test('supervise CLI accepts a non-git workspace as a copy lane but refuses a git subdirectory', async () => {
  await withRoot(async (root) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: SuperviseCliDeps = {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      worker: () => new ScriptedWorker({ 'task-1': [completed('copied')] }),
      modelConfigured: async () => true,
    };
    // 非 git 目录不再是错误：默认落到 copy 副本，原目录零改动。
    assert.equal(await runSuperviseCli(['start', 'x', '--sandbox-root', root], deps), 0, err.join(''));
    assert.match(out.join(''), /copy/);
    assert.equal(err.join(''), '');

    initGitRepo(root);
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    err.length = 0;
    assert.equal(await runSuperviseCli(['start', 'x', '--sandbox-root', sub], deps), 1);
    assert.match(err.join(''), /inside the git repository/);
  });
});
