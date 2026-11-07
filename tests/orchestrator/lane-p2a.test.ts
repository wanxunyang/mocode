import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDirCopy,
  diffRoots,
  diffSnapshots,
  isMocodeRuntimeState,
  LaneCopyTooLargeError,
  snapshotDirectory,
} from '../../src/jobs/dir-snapshot.js';
import { runSuperviseCli, type SuperviseCliDeps } from '../../src/orchestrator/cli.js';
import { OrchestrationScheduler } from '../../src/orchestrator/scheduler.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import { HostWorkerExecutor, isWithin, resolveCopyTarget } from '../../src/orchestrator/worker.js';
import { listWorkspaces } from '../../src/orchestrator/workspaces.js';
import { getWorkspaceRegistryPath, __setWorkspaceRegistryPath } from '../../src/workspace/registry.js';
import type {
  LaneCloseRequest,
  LaneCloseResult,
  LaneMode,
  OrchestrationDefinition,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-p2a-'));
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

/**
 * 把工作区注册表临时指向测试文件，结束后**恢复原值**而不是清空。
 * 同一进程里可能有别的测试在模块顶层设好了自己的注册表路径（如 usage-backfill），
 * 这里清成 undefined 会让它们回落到真实的 ~/.mocode，读到几百个工作区后超时。
 */
async function withRegistryPath<T>(fn: (file: string) => Promise<T> | T): Promise<T> {
  const previous = getWorkspaceRegistryPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-registry-'));
  const file = path.join(dir, 'workspaces.jsonl');
  __setWorkspaceRegistryPath(file);
  try {
    return await fn(file);
  } finally {
    __setWorkspaceRegistryPath(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function completed(summary: string): WorkerTaskResult {
  return { outcome: 'completed', summary, changedFiles: [] };
}

interface LaneCall {
  mode?: LaneMode;
  worktreePath?: string;
  sessionId?: string;
  baselineTree?: string;
  baselineIndex?: string;
}

/** 模拟 Worker：按档位上报 tree / 目录索引基线，并像真 Worker 一样复用现场与会话。 */
class LaneWorker implements WorkerExecutor {
  readonly calls: LaneCall[] = [];
  readonly closed: string[] = [];
  cancelled = 0;

  constructor(private readonly results: Record<string, WorkerTaskResult[]>) {}

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    const lane = request.lane;
    const mode = lane?.mode ?? 'worktree';
    this.calls.push({
      mode,
      worktreePath: lane?.worktreePath,
      sessionId: lane?.sessionId,
      baselineTree: lane?.baselineTree,
      baselineIndex: lane?.baselineIndex,
    });
    const execPath = lane?.worktreePath ?? `/fake/${mode}/${lane?.id ?? request.task.id}`;
    if (lane && !lane.worktreePath) {
      onProgress({
        message: `lane opened (${mode})`,
        workspacePath: execPath,
        lane:
          mode === 'worktree'
            ? { opened: true, baseTree: 'base-0' }
            : { opened: true, baseIndex: `/fake/index/${lane.id}/base-index.json` },
      });
    }
    const sessionId = lane?.sessionId ?? `session-${request.task.id}`;
    onProgress({ message: 'started by fake worker', sessionId, workspacePath: execPath, started: true });
    const result = this.results[request.task.id]?.shift();
    if (!result) throw new Error(`No scripted result for ${request.task.id}`);
    const suffix = `${request.task.id}-${request.attempt}`;
    return {
      ...result,
      laneId: lane?.id,
      worktreePath: execPath,
      ...(mode === 'worktree'
        ? { baselineTree: result.baselineTree ?? `tree-${suffix}` }
        : { baselineIndex: result.baselineIndex ?? `/fake/index/${lane?.id}/${suffix}.json` }),
    };
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
  }

  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    this.closed.push(request.lane.id);
    return { patchPath: `lane-diff-${request.lane.id}`, kept: request.lane.keepWorktree };
  }
}

// ── 目录快照与副本 ───────────────────────────────────────────────────────────

test('dir-snapshot: copies a workspace, ignores runtime dirs, and diffs changes', () =>
  withRoot((root) => {
    const source = path.join(root, 'project');
    fs.mkdirSync(path.join(source, '.mocode', 'sessions', 's1'), { recursive: true });
    fs.writeFileSync(path.join(source, '.mocode', 'sessions', 's1', 'session.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(source, 'a.txt'), 'one\ntwo\n', 'utf8');
    const excludes = ['.mocode/sessions'];
    const before = snapshotDirectory(source, { excludes });
    assert.deepEqual(Object.keys(before.entries), ['a.txt']);

    const copy = createDirCopy(source, path.join(root, 'copy'), { excludes });
    assert.ok(fs.existsSync(path.join(copy, 'a.txt')));
    assert.equal(fs.existsSync(path.join(copy, '.mocode', 'sessions')), false);

    fs.writeFileSync(path.join(copy, 'a.txt'), 'one\nTWO\n', 'utf8');
    fs.writeFileSync(path.join(copy, 'b.txt'), 'new\n', 'utf8');
    const after = snapshotDirectory(copy, { excludes });
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, ['b.txt']);
    assert.deepEqual(diff.modified, ['a.txt']);
    assert.deepEqual(diff.changed, ['a.txt', 'b.txt']);

    const patch = diffRoots(source, copy, diff.changed);
    assert.match(patch, /--- a\/a\.txt/);
    assert.match(patch, /-two/);
    assert.match(patch, /\+TWO/);
    assert.match(patch, /\+new/);
  }));

test('dir-snapshot: mocode runtime state is not counted as the worker changing files', () =>
  withRoot((root) => {
    const source = path.join(root, 'project');
    fs.mkdirSync(path.join(source, '.mocode'), { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(source, '.mocode', 'config'), 'MODEL=x\n', 'utf8');
    const before = snapshotDirectory(source, { ignore: isMocodeRuntimeState });

    // Worker 只读文件，但 mocode 自己写了记忆/统计——这些不是任务改动。
    fs.writeFileSync(path.join(source, '.mocode', 'memory-adoption.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(source, '.mocode', 'memory-recall-stats.json'), '{}\n', 'utf8');
    const after = snapshotDirectory(source, { ignore: isMocodeRuntimeState });
    assert.deepEqual(diffSnapshots(before, after).changed, []);

    // 用户自己的改动照常被发现。
    fs.writeFileSync(path.join(source, 'a.txt'), 'one\ntwo\n', 'utf8');
    const edited = snapshotDirectory(source, { ignore: isMocodeRuntimeState });
    assert.deepEqual(diffSnapshots(before, edited).changed, ['a.txt']);

    // 项目级配置与技能属于用户资产，不能被当成运行时状态吞掉。
    assert.equal(isMocodeRuntimeState('.mocode/config'), false);
    assert.equal(isMocodeRuntimeState('.mocode/skills/x.md'), false);
    assert.equal(isMocodeRuntimeState('.mocode/memory.jsonl'), true);
    assert.equal(isMocodeRuntimeState('src/index.ts'), false);
  }));

test('copy target never lands inside the source directory it copies', () => {
  const source = path.resolve('/tmp/workspace-src');
  // 首选根落在源目录内部（例如被误配成 <workspace>/.mocode/lanes）时必须换落点，
  // 否则 fs.cpSync 会以「复制到自身子目录」失败，而且副本会被下一轮再复制一遍。
  const target = resolveCopyTarget(source, path.join(source, '.mocode', 'lanes'), 'run-1', 'lane-1');
  assert.equal(isWithin(source, target), false);
  assert.match(target, /run-1[\\/]lane-1[\\/]copy$/);

  // 首选根在外面时直接用首选根。
  const outside = path.resolve('/tmp/lane-root');
  assert.equal(resolveCopyTarget(source, outside, 'run-1', 'lane-1'), path.join(outside, 'run-1', 'lane-1', 'copy'));
  assert.equal(isWithin(source, path.join(source, 'nested')), true);
});

test('dir-snapshot: a copy over the byte budget refuses instead of falling back to in-place', () =>
  withRoot((root) => {
    const source = path.join(root, 'big');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'blob.txt'), 'x'.repeat(2048), 'utf8');
    assert.throws(
      () => createDirCopy(source, path.join(root, 'copy'), { maxBytes: 1024 }),
      (error: unknown) => error instanceof LaneCopyTooLargeError && /--allow-inplace/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(root, 'copy')), false);
  }));

// ── copy 档位的 lane ─────────────────────────────────────────────────────────

test('lane: copy mode carries a directory baseline across tasks in one lane', async () => {
  await withRoot(async (root) => {
    const workspace = path.join(root, 'notes-repo');
    fs.mkdirSync(workspace);
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'copy lane',
        lanes: [{ id: 'main', workspaceRoot: workspace, mode: 'copy' }],
        tasks: [
          { id: 'first', title: 'first', objective: 'first', lane: 'main' },
          { id: 'second', title: 'second', objective: 'second', lane: 'main', dependsOn: ['first'] },
        ],
      },
      'copy-lane',
    );
    const worker = new LaneWorker({ first: [completed('first')], second: [completed('second')] });

    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'idle');
    assert.equal(worker.calls[0]?.mode, 'copy');
    assert.equal(worker.calls[0]?.baselineIndex, undefined);
    // 第二条任务复用同一现场，并以第一条任务结束后的索引为基线。
    assert.equal(worker.calls[1]?.worktreePath, '/fake/copy/main');
    assert.equal(worker.calls[1]?.baselineIndex, '/fake/index/main/first-1.json');

    const lane = final.lanes.main;
    assert.equal(lane.mode, 'copy');
    assert.ok(lane.baseIndex?.endsWith('base-index.json'));
    // lane 的基线随任务推进：跑完两个任务后它停在后一个任务结束时的索引。
    assert.ok(lane.baselineIndex?.endsWith('second-1.json'));
  });
});

test('lane: a non-git definition defaults to copy and in-place stays an explicit decision', async () => {
  await withRoot(async (root) => {
    const created = OrchestrationStore.create(
      root,
      { objective: 'default mode', tasks: [{ id: 'a', title: 'a', objective: 'a' }] },
      'default-mode',
    );
    assert.equal(created.current.lanes.a.mode, 'worktree');

    const flagged = OrchestrationStore.create(
      root,
      {
        objective: 'inplace',
        lanes: [{ id: 'main', mode: 'inplace', allowInplace: true }],
        tasks: [{ id: 'a', title: 'a', objective: 'a', lane: 'main' }],
      },
      'inplace-run',
    );
    assert.equal(flagged.current.lanes.main.mode, 'inplace');
    assert.equal(flagged.current.lanes.main.allowInplace, true);
  });
});

// ── idle 与续派 ─────────────────────────────────────────────────────────────

test('idle: a drained run stays open and accepts more work in the same session', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'long lived lane',
        lanes: [{ id: 'main' }],
        tasks: [{ id: 'first', title: 'first', objective: 'first', lane: 'main' }],
      },
      'idle-run',
    );
    const worker = new LaneWorker({ first: [completed('first')], ask: [completed('still working')] });
    const scheduler = new OrchestrationScheduler(store, worker, {}, { pollMs: 1 });

    const idle = await scheduler.run();
    assert.equal(idle.status, 'idle');
    assert.equal(idle.lanes.main.closed, undefined);
    assert.deepEqual(worker.closed, []);

    // 追加任务：Run 从 idle 回到 running，lane 复用同一个现场与会话。
    scheduler.appendTask({ id: 'ask', title: 'progress?', objective: 'progress?', lane: 'main' });
    const resumed = await scheduler.run();
    assert.equal(resumed.status, 'idle');
    assert.equal(resumed.tasks.ask.status, 'completed');
    assert.equal(worker.calls[1]?.worktreePath, '/fake/worktree/main');
    assert.equal(worker.calls[1]?.sessionId, 'session-first');

    // 显式 close：导出 lane diff、归档会话，随后 Run 收尾。
    const closed = await scheduler.closeLaneById('main', 'operator closed');
    assert.equal(closed.status, 'completed');
    assert.deepEqual(worker.closed, ['main']);
    assert.equal(closed.lanes.main.closed?.patchPath, 'lane-diff-main');
  });
});

test('idle: autoClose=true finishes the run as soon as the queue drains', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      {
        objective: 'one shot',
        autoClose: true,
        tasks: [{ id: 'a', title: 'a', objective: 'a' }],
      },
      'auto-close',
    );
    const worker = new LaneWorker({ a: [completed('done')] });
    const final = await new OrchestrationScheduler(store, worker, {}, { pollMs: 1 }).run();
    assert.equal(final.status, 'completed');
    assert.ok(final.lanes.a.closed);
  });
});

test('idle: tasks cannot be added while the run is still running', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(
      root,
      { objective: 'busy', tasks: [{ id: 'a', title: 'a', objective: 'a' }] },
      'busy-run',
    );
    const scheduler = new OrchestrationScheduler(store, new LaneWorker({}), {}, { pollMs: 1 });
    assert.throws(() => scheduler.appendTask({ id: 'b', title: 'b', objective: 'b' }), /can only be added while idle/);
  });
});

// ── 真 Worker：非 git 副本 + lane.diff ───────────────────────────────────────

const FAKE_HOST = `import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const emit = (event, payload = {}, requestId) => process.stdout.write(JSON.stringify({ type: 'event', event, payload, requestId }) + '\\n');
emit('runtime_ready', { projectRoot: process.cwd() });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.type !== 'run') continue;
  fs.mkdirSync(path.join(process.cwd(), '.mocode', 'sessions', 'session-9'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.mocode', 'sessions', 'session-9', 'session.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(process.cwd(), 'notes.md'), '# notes\\nadded by the worker\\n', 'utf8');
  emit('run_started', { sessionId: 'session-9' }, command.id);
  emit('text_delta', { text: 'done\\n<mocode_handoff>{"summary":"wrote notes","validation":[],"risks":[]}</mocode_handoff>' }, command.id);
  emit('run_completed', { completed: true, changedFiles: ['notes.md'] }, command.id);
}
`;

test('HostWorkerExecutor: a non-git workspace runs in an isolated copy and exits with lane.diff', async () => {
  await withRoot(async (root) => {
    const workspace = path.join(root, 'plain-dir');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), 'original\n', 'utf8');
    const hostPath = path.join(root, 'fake-host.mjs');
    fs.writeFileSync(hostPath, FAKE_HOST, 'utf8');

    const run = OrchestrationStore.create(
      root,
      {
        objective: 'summarize',
        lanes: [{ id: 'main', workspaceRoot: workspace, mode: 'copy' }],
        tasks: [{ id: 'task-1', title: 'summarize', objective: 'summarize', lane: 'main' }],
      },
      'copy-host-run',
    ).current;
    const worker = new HostWorkerExecutor({
      hostPath,
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 500,
      // 副本落点显式指向临时目录：默认 `~/.mocode/lanes` 会把测试产物写到真实家目录。
      copyRoot: path.join(root, 'lane-copies'),
    });
    const progress: WorkerProgress[] = [];

    const result = await worker.run(
      { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
      (item) => progress.push(item),
    );

    assert.equal(result.outcome, 'completed', result.error);
    assert.deepEqual(result.changedFiles, ['notes.md']);
    assert.ok(result.worktreePath && fs.existsSync(result.worktreePath));
    assert.notEqual(path.resolve(result.worktreePath!), path.resolve(workspace));
    // 原目录保持不变：写只落在副本里。
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), 'original\n');
    assert.equal(fs.existsSync(path.join(workspace, 'notes.md')), false);
    assert.ok(result.baselineIndex && fs.existsSync(result.baselineIndex));
    assert.ok(progress.some((item) => item.lane?.opened && item.lane.baseIndex));

    const closed = await worker.closeLane({
      run,
      lane: {
        ...run.lanes.main,
        worktreePath: result.worktreePath,
        sessionId: result.sessionId,
        baseIndex: run.lanes.main.baseIndex,
        baselineIndex: result.baselineIndex,
      },
      reason: 'run completed',
    });
    assert.equal(closed.kept, false);
    assert.ok(closed.patchPath && closed.patchPath.endsWith('lane.diff'));
    assert.match(fs.readFileSync(closed.patchPath!, 'utf8'), /\+added by the worker/);
    assert.ok(closed.sessionArchivePath && fs.existsSync(path.join(closed.sessionArchivePath, 'session.json')));
    assert.equal(fs.existsSync(result.worktreePath!), false);
  });
});

test('HostWorkerExecutor: in-place execution is refused without explicit authorization', async () => {
  await withRoot(async (root) => {
    const workspace = path.join(root, 'plain-dir');
    fs.mkdirSync(workspace);
    const run = OrchestrationStore.create(
      root,
      {
        objective: 'in place',
        lanes: [{ id: 'main', workspaceRoot: workspace, mode: 'inplace' }],
        tasks: [{ id: 'task-1', title: 't', objective: 't', lane: 'main' }],
      },
      'inplace-refused',
    ).current;
    const worker = new HostWorkerExecutor({ hostPath: path.join(root, 'never-started.mjs') });
    const result = await worker.run(
      { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
      () => undefined,
    );
    assert.equal(result.outcome, 'failed');
    assert.match(result.error ?? '', /allow-inplace/);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

function cliDeps(out: string[], results: Record<string, WorkerTaskResult[]>, err: string[]): SuperviseCliDeps {
  return {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    worker: () => new LaneWorker(results),
    modelConfigured: async () => true,
  };
}

test('supervise CLI: a non-git workspace is dispatched in copy mode', async () => {
  await withRoot(async (root) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = cliDeps(out, { 'task-1': [completed('summarized')] }, err);
    const code = await runSuperviseCli(['start', 'summarize', '--sandbox-root', root], deps);
    assert.equal(code, 0, err.join(''));
    assert.match(out.join(''), /Orchestration started: /);
    assert.match(out.join(''), /lane task-1 {2}copy/);
    assert.match(out.join(''), /✓ task-1 {2}completed/);
    assert.equal(err.join(''), '');
  });
});

test('supervise CLI: in-place needs --allow-inplace and is never silent', async () => {
  await withRoot(async (root) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = cliDeps(out, { 'task-1': [completed('done')] }, err);
    const dag: OrchestrationDefinition = {
      objective: 'edit here',
      lanes: [{ id: 'main', mode: 'inplace' }],
      tasks: [{ id: 'task-1', title: 'edit', objective: 'edit', lane: 'main' }],
    };
    const file = path.join(root, 'dag.json');
    fs.writeFileSync(file, JSON.stringify(dag), 'utf8');

    assert.equal(await runSuperviseCli(['start', '--file', file, '--sandbox-root', root], deps), 1);
    assert.match(err.join(''), /--allow-inplace/);

    out.length = 0;
    err.length = 0;
    assert.equal(
      await runSuperviseCli(['start', '--file', file, '--allow-inplace', '--sandbox-root', root], deps),
      0,
      err.join(''),
    );
    assert.match(out.join(''), /lane main {2}inplace/);
  });
});

test('supervise CLI: workspaces lists the registry, the cwd, and scanned roots', async () => {
  await withRegistryPath(async (file) => {
    await withRoot(async (root) => {
      const registered = path.join(root, 'registered');
      fs.mkdirSync(path.join(registered, '.mocode', 'sessions', '20260101-000000-000-aaaaaaa'), { recursive: true });
      fs.writeFileSync(
        path.join(registered, '.mocode', 'sessions', '20260101-000000-000-aaaaaaa', 'session.json'),
        JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', history: [] }),
        'utf8',
      );
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          root: registered,
          name: 'registered',
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-01-02T00:00:00.000Z',
          sessions: 1,
          sessionsBytes: 10,
        })}\n`,
        'utf8',
      );
      const scanRoot = path.join(root, 'scan');
      const discovered = path.join(scanRoot, 'nested', 'project');
      fs.mkdirSync(path.join(discovered, '.mocode', 'sessions'), { recursive: true });

      const out: string[] = [];
      const err: string[] = [];
      const deps = cliDeps(out, {}, err);
      assert.equal(
        await runSuperviseCli(['workspaces', '--json', '--sandbox-root', root, '--scan-roots', scanRoot], deps),
        0,
        err.join(''),
      );
      const listed = JSON.parse(out.join('')) as Array<{ root: string; git: boolean; exists: boolean }>;
      const roots = listed.map((item) => path.resolve(item.root).toLowerCase());
      assert.ok(roots.includes(path.resolve(registered).toLowerCase()));
      assert.ok(roots.includes(path.resolve(discovered).toLowerCase()));
      assert.ok(roots.includes(path.resolve(root).toLowerCase()));
      assert.ok(listed.every((item) => item.git === false && item.exists));
      // 会话摘要来自 .mocode/sessions，用来判断「这个工作区之前在干什么」。
      const entry = listed.find(
        (item) => path.resolve(item.root).toLowerCase() === path.resolve(registered).toLowerCase(),
      );
      assert.ok(entry);
    });
  });
});

test('workspaces: the listing reports git state and open lanes', async () => {
  await withRegistryPath(async () => {
    await withRoot(async (root) => {
      const store = OrchestrationStore.create(
        root,
        {
          objective: 'open lane',
          lanes: [{ id: 'main' }],
          tasks: [{ id: 'a', title: 'a', objective: 'a', lane: 'main' }],
        },
        'live-lane',
      );
      const worker = new LaneWorker({ a: [completed('done')] });
      const scheduler = new OrchestrationScheduler(store, worker, {}, { pollMs: 1 });
      await scheduler.run();

      const list = listWorkspaces({ roots: [root], includeSessions: false });
      const entry = list.find((item) => item.root === path.resolve(root));
      assert.ok(entry);
      assert.equal(entry.git, false);
      assert.equal(entry.lanes.length, 1);
      assert.equal(entry.lanes[0]?.laneId, 'main');
      assert.equal(entry.lanes[0]?.mode, 'worktree');
      assert.equal(entry.lanes[0]?.status, 'open');
    });
  });
});
