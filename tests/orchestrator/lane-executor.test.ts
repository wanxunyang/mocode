import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  laneChannelPaths,
  appendLaneEvent,
  laneStopRequested,
  readChannel,
  type LaneCommand,
} from '../../src/orchestrator/lane-channel.js';
import { LaneReplExecutor } from '../../src/orchestrator/lane-executor.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import type { WorkerProgress } from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-lane-executor-'));
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

/** 造一个可直接跑的 Run：一条 worktree lane，任务已就绪（不走调度器）。 */
function makeRun(root: string, id = 'run-1') {
  const fakeWorktree = path.join(root, 'fake-worktree');
  fs.mkdirSync(path.join(fakeWorktree, '.git'), { recursive: true });
  const run = OrchestrationStore.create(
    root,
    {
      objective: 'ship it',
      lanes: [{ id: 'main', mode: 'worktree' }],
      tasks: [{ id: 'task-1', title: 'do the thing', objective: 'do the thing', lane: 'main' }],
    },
    id,
  ).current;
  return { run, fakeWorktree };
}

interface FakeWindow {
  /** 收到的开窗参数（断言命令行的形态）。 */
  readonly opened: Array<{ title: string; args: string[]; cwd?: string }>;
  /** 收到的派活指令正文（断言提示词真的被投进了通道）。 */
  readonly commands: LaneCommand[];
  stop(): void;
}

/**
 * 假「lane 窗口」：不真开终端，只按真 REPL 的时序往通道里写事件。
 *
 * 真 lane 的行为是：起来 → 写 ready → 等 lane.commands → 跑一轮 → 写 turn.finished。
 * 这里把「跑一轮」换成脚本，其余时序完全一致，这样被测的是执行器的等待/收账逻辑。
 */
function fakeWindow(
  root: string,
  runId: string,
  laneId: string,
  reply: (command: LaneCommand) => Array<Record<string, unknown>>,
): FakeWindow {
  const opened: FakeWindow['opened'] = [];
  const commands: LaneCommand[] = [];
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const paths = laneChannelPaths(root, runId, laneId);
  let consumed = 0;

  const start = (args: string[]): void => {
    const launch = args[args.indexOf('--launch') + 1];
    // ready 先到：控制面必须等它，才允许投任务。
    setTimeout(() => {
      if (stopped) return;
      appendLaneEvent(paths, {
        t: Date.now(),
        kind: 'ready',
        // 不报 pid：真 REPL 会报，但测试里报 process.pid 会让「硬杀兜底」打到自己，
        // 反而测不到「靠 exit 事件判定窗口已退」这条路径。
        workspacePath: root,
        sessionId: 'lane-session-1',
        launch,
      });
    }, 1);
    const timer = setInterval(() => {
      if (stopped) return;
      // 真 REPL 是协作式关窗：看到 stop 信号后走自己的退出路径，报 exit 再消失。
      if (laneStopRequested(paths)) {
        appendLaneEvent(paths, { t: Date.now(), kind: 'exit', reason: 'stop requested' });
        stopped = true;
        return;
      }
      const read = readChannel<LaneCommand>(paths.commands, consumed);
      consumed = read.consumed;
      for (const command of read.items) {
        commands.push(command);
        for (const event of reply(command)) appendLaneEvent(paths, { t: Date.now(), ...event } as never);
      }
    }, 3);
    timer.unref?.();
    timers.push(timer);
  };

  return {
    opened,
    commands,
    stop: () => {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
    },
    // 把 start 塞进 opened 记录里，调用方在 openTerminal 里触发
    ...({ start } as object),
  } as FakeWindow & { start: (args: string[]) => void };
}

/** 统一的执行器：假 worktree + 固定差分，只让「窗口」这一层可脚本化。 */
function makeExecutor(
  root: string,
  fakeWorktree: string,
  window_: FakeWindow & { start: (args: string[]) => void },
  overrides: { readyTimeoutMs?: number } = {},
): LaneReplExecutor {
  return new LaneReplExecutor({
    createWorktree: () => ({ path: fakeWorktree, repoRoot: root }),
    collectChanges: () => ({
      changedFiles: ['src/demo.ts'],
      patch: 'diff --git a/src/demo.ts b/src/demo.ts\n',
      tree: 'tree-1',
    }),
    removeWorktree: () => undefined,
    openTerminal: (options) => {
      window_.opened.push(options);
      window_.start(options.args);
      return { opened: true, via: 'test' };
    },
    pollMs: 3,
    readyTimeoutMs: overrides.readyTimeoutMs ?? 2000,
  });
}

test('LaneReplExecutor: a lane window is opened with `supervise lane` and the task reaches it as a turn', async () => {
  await withRoot(async (root) => {
    const { run, fakeWorktree } = makeRun(root);
    const window_ = fakeWindow(root, run.id, 'main', () => [
      {
        kind: 'turn.finished',
        id: 'task-1#1',
        outcome: 'completed',
        summary: [
          'Implemented the thing.',
          '<mocode_handoff>{"summary":"implemented","validation":[],"risks":[]}</mocode_handoff>',
        ].join('\n'),
      },
    ]) as FakeWindow & { start: (args: string[]) => void };
    const executor = makeExecutor(root, fakeWorktree, window_);
    const progress: WorkerProgress[] = [];
    try {
      const result = await executor.run(
        { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
        (item) => progress.push(item),
      );

      assert.equal(result.outcome, 'completed', result.error);
      assert.equal(result.summary, 'implemented');
      assert.deepEqual(result.changedFiles, ['src/demo.ts']);
      assert.ok(result.patchPath && fs.existsSync(result.patchPath), 'the attempt patch must land on disk');

      // 开窗参数就是「那个窗口跑 mocode 本体」这件事的契约。
      assert.equal(window_.opened.length, 1);
      const args = window_.opened[0].args;
      assert.deepEqual(args.slice(0, 2), ['supervise', 'lane']);
      assert.ok(args.includes(run.id));
      assert.ok(args.includes('--lane'));
      assert.ok(args.includes('--launch'), 'each launch needs a marker so a stale ready is ignored');
      // 账本根必须显式给出：窗口 cwd 是 lane 执行现场，那里没有 `.mocode/orchestrations/<run>`，
      // 少了这个参数 `supervise lane` 会立刻报「run not found」并退出窗口。
      assert.equal(args[args.indexOf('--sandbox-root') + 1], run.workspaceRoot);
      assert.equal(window_.opened[0].cwd, fakeWorktree);

      // 窗口的会话必须回传账本，否则后续任务接不上同一段对话、收尾也归档不到会话。
      const started = progress.find((item) => item.started);
      assert.equal(started?.sessionId, 'lane-session-1');

      // 派活正文必须落到通道里（那是窗口里真正"说的话"）。
      assert.equal(window_.commands.length, 1);
      assert.equal(window_.commands[0].kind, 'task');
      assert.equal(window_.commands[0].taskId, 'task-1');
      assert.match(window_.commands[0].text, /do the thing/);
      assert.match(window_.commands[0].text, /mocode_handoff/);

      assert.ok(
        progress.some((item) => item.lane?.opened && item.lane.baseTree),
        'the lane baseline must be reported so later attempts can diff from it',
      );
      assert.ok(progress.some((item) => item.started));
    } finally {
      window_.stop();
    }
  });
});

test('LaneReplExecutor: a handoff that violates required checks fails the task', async () => {
  await withRoot(async (root) => {
    const fakeWorktree = path.join(root, 'fake-worktree');
    fs.mkdirSync(path.join(fakeWorktree, '.git'), { recursive: true });
    const run = OrchestrationStore.create(
      root,
      {
        objective: 'ship it',
        lanes: [{ id: 'main', mode: 'worktree' }],
        tasks: [
          {
            id: 'task-1',
            title: 'do the thing',
            objective: 'do the thing',
            lane: 'main',
            requiredChecks: ['npm test'],
          },
        ],
      },
      'run-2',
    ).current;
    const window_ = fakeWindow(root, run.id, 'main', () => [
      {
        kind: 'turn.finished',
        id: 'task-1#1',
        outcome: 'completed',
        // 声称做完，但没报必需检查通过：控制面不能信这句话。
        summary: '<mocode_handoff>{"summary":"done","validation":[],"risks":[]}</mocode_handoff>',
      },
    ]) as FakeWindow & { start: (args: string[]) => void };
    const executor = makeExecutor(root, fakeWorktree, window_);
    try {
      const result = await executor.run(
        { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
        () => undefined,
      );
      assert.equal(result.outcome, 'failed');
      assert.match(result.error ?? '', /required checks/);
    } finally {
      window_.stop();
    }
  });
});

test('LaneReplExecutor: a window that never reports ready fails fast instead of hanging', async () => {
  await withRoot(async (root) => {
    const { run, fakeWorktree } = makeRun(root, 'run-3');
    const executor = new LaneReplExecutor({
      createWorktree: () => ({ path: fakeWorktree, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
      // 开得出窗口，但永远不写 ready（比如 REPL 卡在加载配置）。
      openTerminal: () => ({ opened: true, via: 'test' }),
      pollMs: 3,
      readyTimeoutMs: 60,
    });
    const result = await executor.run(
      { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
      () => undefined,
    );
    assert.equal(result.outcome, 'failed');
    assert.match(result.error ?? '', /did not become ready/);
  });
});

test('LaneReplExecutor: no terminal means a clear failure, not a silent hang', async () => {
  await withRoot(async (root) => {
    const { run, fakeWorktree } = makeRun(root, 'run-4');
    const executor = new LaneReplExecutor({
      createWorktree: () => ({ path: fakeWorktree, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
      openTerminal: () => ({ opened: false }),
      pollMs: 3,
      readyTimeoutMs: 60,
    });
    const result = await executor.run(
      { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
      () => undefined,
    );
    assert.equal(result.outcome, 'failed');
    assert.match(result.error ?? '', /--no-terminal/);
  });
});

test('LaneReplExecutor: a window that closes mid-turn is reported as failed, with the partial diff kept', async () => {
  await withRoot(async (root) => {
    const { run, fakeWorktree } = makeRun(root, 'run-5');
    const window_ = fakeWindow(root, run.id, 'main', () => [
      { kind: 'exit', reason: 'window closed' },
    ]) as FakeWindow & {
      start: (args: string[]) => void;
    };
    const executor = makeExecutor(root, fakeWorktree, window_);
    try {
      const result = await executor.run(
        { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
        () => undefined,
      );
      assert.equal(result.outcome, 'failed');
      assert.match(result.error ?? '', /closed before this task finished/);
      // 半途失败最需要看到「已经改了什么」，所以差分照样收。
      assert.deepEqual(result.changedFiles, ['src/demo.ts']);
    } finally {
      window_.stop();
    }
  });
});

test('LaneReplExecutor: cancel turns the in-flight turn into a cancelled result', async () => {
  await withRoot(async (root) => {
    const { run, fakeWorktree } = makeRun(root, 'run-6');
    // 只报 ready，永远不报 turn.finished：模拟一个跑不完的窗口。
    const window_ = fakeWindow(root, run.id, 'main', () => []) as FakeWindow & { start: (args: string[]) => void };
    const executor = makeExecutor(root, fakeWorktree, window_);
    try {
      const running = executor.run(
        { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(executor.laneWindowAlive(run.id, 'main'), true);
      await executor.cancel('stop');
      const result = await running;
      assert.equal(result.outcome, 'cancelled', `got ${result.outcome}: ${result.error}`);
      assert.equal(executor.laneWindowAlive(run.id, 'main'), false);
    } finally {
      window_.stop();
    }
  });
});

test('LaneReplExecutor: a turn finished by the human typing is ignored (only the dispatched id counts)', async () => {
  await withRoot(async (root) => {
    const { run, fakeWorktree } = makeRun(root, 'run-7');
    const window_ = fakeWindow(root, run.id, 'main', () => [
      // 人自己在这个窗口里敲的那一轮：id 不是派活 id，不能被当成任务结论。
      { kind: 'turn.finished', id: 'human-1', outcome: 'completed', summary: 'chit chat' },
      {
        kind: 'turn.finished',
        id: 'task-1#1',
        outcome: 'completed',
        summary: '<mocode_handoff>{"summary":"real work","validation":[],"risks":[]}</mocode_handoff>',
      },
    ]) as FakeWindow & { start: (args: string[]) => void };
    const executor = makeExecutor(root, fakeWorktree, window_);
    try {
      const result = await executor.run(
        { run, task: run.tasks['task-1'], attempt: 1, workerId: 'w', lane: { ...run.lanes.main } },
        () => undefined,
      );
      assert.equal(result.outcome, 'completed');
      assert.equal(result.summary, 'real work');
    } finally {
      window_.stop();
    }
  });
});
