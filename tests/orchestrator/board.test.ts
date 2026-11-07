import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuperviseCli, type SuperviseCliDeps } from '../../src/orchestrator/cli.js';
import {
  boardRows,
  collectBoard,
  formatBoardSnapshot,
  renderBoard,
  type BoardSnapshot,
} from '../../src/orchestrator/board.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import { listWorkspaces } from '../../src/orchestrator/workspaces.js';
import { ansiDisplayWidth } from '../../src/ui/render.js';
import { __setWorkspaceRegistryPath, getWorkspaceRegistryPath } from '../../src/workspace/registry.js';
import type { OrchestrationDefinition } from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-board-'));
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

/** 注册表是全局文件：测试必须指到临时路径，否则会读到/写进真实 ~/.mocode。 */
async function withRegistryPath<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = getWorkspaceRegistryPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-board-registry-'));
  __setWorkspaceRegistryPath(path.join(dir, 'workspaces.jsonl'));
  try {
    return await fn();
  } finally {
    __setWorkspaceRegistryPath(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DEFINITION: OrchestrationDefinition = {
  objective: 'board demo',
  tasks: [{ id: 'task-1', title: 'demo', objective: 'demo' }],
};

/** 建一个 Run，并让它的 task-1 处于 running（lane 也随之打开）。 */
function runningRun(root: string, objective: string): OrchestrationStore {
  const store = OrchestrationStore.create(root, { ...DEFINITION, objective });
  store.append({ type: 'task.ready', data: { taskId: 'task-1', reason: 'dependencies_satisfied' } });
  store.append({
    type: 'task.dispatching',
    data: { taskId: 'task-1', attempt: 1, workerId: 'worker-1' },
  });
  store.append({ type: 'task.started', data: { taskId: 'task-1', sessionId: 'session-1' } });
  store.append({ type: 'task.progress', data: { taskId: 'task-1', message: 'tool: read_file' } });
  return store;
}

function workspacesOf(root: string) {
  return listWorkspaces({ roots: [root] });
}

// ── 采集 ─────────────────────────────────────────────────────────────────────

test('collect: a workspace with no orchestration runs yields an empty board', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const board = collectBoard({ workspaces: workspacesOf(root) });
      assert.equal(board.workspaces.length, 1);
      assert.deepEqual(board.workspaces[0]?.runs, []);
      assert.equal(board.busy, 0);
      assert.equal(board.live, 0);
      assert.deepEqual(boardRows(board).length, 1); // 只有工作区标题行
    }),
  );
});

test('collect: a running lane shows its task, progress and session', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      runningRun(root, 'watch me');
      const board = collectBoard({ workspaces: workspacesOf(root) });
      const lane = board.workspaces[0]?.runs[0]?.lanes[0];
      assert.equal(lane?.laneId, 'task-1');
      assert.equal(lane?.state, 'open');
      assert.equal(lane?.taskStatus, 'running');
      assert.equal(lane?.lastEvent, 'tool: read_file');
      assert.equal(lane?.sessionId, 'session-1');
      assert.equal(lane?.done, 0);
      assert.equal(lane?.total, 1);
      assert.equal(board.busy, 1);
      assert.equal(board.live, 1);
    }),
  );
});

test('collect: terminal runs are hidden unless asked for', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const store = OrchestrationStore.create(root, DEFINITION);
      store.append({ type: 'task.ready', data: { taskId: 'task-1', reason: 'dependencies_satisfied' } });
      store.append({ type: 'task.dispatching', data: { taskId: 'task-1', attempt: 1, workerId: 'w' } });
      store.append({ type: 'task.started', data: { taskId: 'task-1', sessionId: 'session-1' } });
      store.append({
        type: 'task.completed',
        data: {
          taskId: 'task-1',
          handoff: {
            taskId: 'task-1',
            attempt: 1,
            outcome: 'completed',
            summary: 'done',
            changedFiles: [],
            validation: [],
            artifacts: [],
            risks: [],
          },
        },
      });
      store.append({ type: 'run.completed', data: {} });

      assert.equal(collectBoard({ workspaces: workspacesOf(root) }).workspaces[0]?.runs.length, 0);
      const all = collectBoard({ workspaces: workspacesOf(root), includeTerminal: true });
      assert.equal(all.workspaces[0]?.runs.length, 1);
      assert.equal(all.workspaces[0]?.runs[0]?.status, 'completed');
      // 终态 Run 的 lane 不再算「开着」
      assert.equal(all.live, 0);
    }),
  );
});

test('collect: awaiting_user surfaces the reason instead of looking idle', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const store = OrchestrationStore.create(root, DEFINITION);
      store.append({ type: 'run.awaiting_user', data: { reason: 'token budget exhausted' } });
      const lane = collectBoard({ workspaces: workspacesOf(root) }).workspaces[0]?.runs[0]?.lanes[0];
      assert.equal(lane?.awaitingReason, 'token budget exhausted');
    }),
  );
});

test('collect: a broken run directory is counted, not fatal', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      // 有 events 但没有可读 snapshot：面板应跳过并记账，而不是抛错。
      const dir = path.join(root, '.mocode', 'orchestrations', '20260101-000000-broken');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '{}\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'snapshot.json'), 'not json', 'utf8');

      const board = collectBoard({ workspaces: workspacesOf(root) });
      assert.equal(board.broken, 1);
      assert.deepEqual(board.workspaces[0]?.runs, []);
    }),
  );
});

test('collect: workspaces with running lanes sort before idle ones', async () => {
  await withRegistryPath(() =>
    withRoot((root) => {
      const busy = path.join(root, 'busy');
      const quiet = path.join(root, 'quiet');
      fs.mkdirSync(busy, { recursive: true });
      fs.mkdirSync(quiet, { recursive: true });
      runningRun(busy, 'busy work');
      OrchestrationStore.create(quiet, DEFINITION);

      // 两个子目录都要显式列出（roots 只加 cwd）。
      const board = collectBoard({ workspaces: listWorkspaces({ roots: [busy, quiet] }) });
      assert.deepEqual(
        board.workspaces.map((item) => item.name),
        ['busy', 'quiet'],
      );
    }),
  );
});

// ── 渲染 ─────────────────────────────────────────────────────────────────────

function fixture(): BoardSnapshot {
  return {
    collectedAt: '2026-11-06T12:34:56.000Z',
    workspaces: [
      {
        root: 'F:\\mocode',
        name: 'mocode',
        exists: true,
        git: true,
        branch: 'main',
        dirty: true,
        sessionCount: 3,
        latestSession: '20261106-120000-000-abcdef12',
        runs: [
          {
            id: '20261106-111111-aaaa',
            status: 'running',
            objective: 'refactor the parser',
            createdAt: '2026-11-06T11:11:11.000Z',
            updatedAt: '2026-11-06T11:12:00.000Z',
            lanes: [
              {
                runId: '20261106-111111-aaaa',
                laneId: 'core',
                mode: 'worktree',
                state: 'open',
                taskId: 'task-2',
                taskStatus: 'running',
                lastEvent: 'tool: read_file',
                sessionId: 'session-core',
                done: 1,
                total: 3,
                pendingApprovals: [],
                risks: [],
              },
            ],
          },
        ],
      },
      {
        root: 'E:\\notes',
        name: 'notes',
        exists: true,
        git: false,
        sessionCount: 0,
        runs: [],
      },
    ],
    busy: 1,
    live: 1,
    broken: 0,
  };
}

test('render: rows are workspace headers plus one row per lane', () => {
  const rows = boardRows(fixture());
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['workspace', 'lane', 'workspace'],
  );
  assert.equal(rows[1]?.laneId, 'core');
  assert.equal(rows[1]?.runId, '20261106-111111-aaaa');
});

test('render: the selected row is marked and never exceeds the terminal width', () => {
  const board = fixture();
  for (const cols of [60, 100, 140]) {
    const rendered = renderBoard(board, { cols, rows: 20, selected: 1 });
    // selectedLine 指向的必须是那一行 lane，而不是工作区标题。
    assert.match(rendered.lines[rendered.selectedLine] ?? '', /▸/);
    assert.match(rendered.lines[rendered.selectedLine] ?? '', /core/);
    for (const line of rendered.lines) {
      assert.ok(ansiDisplayWidth(line) <= cols, `line wider than ${cols}: ${line}`);
    }
  }
});

test('render: the detail pane answers why a lane is waiting', () => {
  const board = fixture();
  board.workspaces[0]!.runs[0]!.lanes[0]!.awaitingReason = 'retry budget exhausted';
  const rendered = renderBoard(board, { cols: 120, rows: 20, selected: 1 });
  const text = rendered.lines.join('\n');
  assert.match(text, /retry budget exhausted/);
  assert.match(text, /refactor the parser/);
  // 详情必须给出下一步该谁做什么，而不是只摆状态。
  assert.match(text, /dispatch/);
});

test('render: an empty board explains how to dispatch the first task', () => {
  const board: BoardSnapshot = {
    collectedAt: '2026-11-06T12:34:56.000Z',
    workspaces: [],
    busy: 0,
    live: 0,
    broken: 0,
  };
  const rendered = renderBoard(board, { cols: 100, rows: 20, selected: 0 });
  assert.match(rendered.lines.join('\n'), /supervise dispatch/);
  assert.equal(rendered.rows.length, 0);
});

test('snapshot output: json round-trips, human text has no ANSI', () => {
  const board = fixture();
  const json = JSON.parse(formatBoardSnapshot(board, { json: true })) as BoardSnapshot;
  assert.equal(json.workspaces.length, 2);

  const text = formatBoardSnapshot(board, { cols: 100 });
  assert.ok(!text.includes('\x1b['), 'snapshot text must be colour-free when stdout is not a TTY');
  assert.match(text, /mocode/);
});

// ── CLI ─────────────────────────────────────────────────────────────────────

test('CLI: watch without a run id prints a one-shot board on a non-TTY', async () => {
  await withRegistryPath(() =>
    withRoot(async (root) => {
      runningRun(root, 'cli board');
      const out: string[] = [];
      const err: string[] = [];
      const deps: SuperviseCliDeps = {
        out: (text) => void out.push(text),
        err: (text) => void err.push(text),
        worker: () => {
          throw new Error('watch must not start a worker');
        },
        modelConfigured: async () => true,
      };

      assert.equal(await runSuperviseCli(['watch', '--sandbox-root', root], deps), 0, err.join(''));
      assert.match(out.join(''), /cli board|task-1/);

      out.length = 0;
      assert.equal(await runSuperviseCli(['watch', '--sandbox-root', root, '--json'], deps), 0, err.join(''));
      const parsed = JSON.parse(out.join('')) as BoardSnapshot;
      assert.equal(parsed.busy, 1);
      assert.equal(parsed.workspaces[0]?.runs[0]?.lanes[0]?.laneId, 'task-1');
    }),
  );
});
