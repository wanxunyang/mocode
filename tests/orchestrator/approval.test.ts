import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchestrationScheduler } from '../../src/orchestrator/scheduler.js';
import { createInitialRun } from '../../src/orchestrator/state.js';
import { OrchestrationStore } from '../../src/orchestrator/store.js';
import { HostWorkerExecutor } from '../../src/orchestrator/worker.js';
import { askHumanTool, setAskHumanHandler, type AskHumanRequest } from '../../src/tools/builtins/ask-human.js';
import type {
  ApprovalResolution,
  OrchestrationRun,
  RunReview,
  WorkerExecutor,
  WorkerProgress,
  WorkerTaskRequest,
  WorkerTaskResult,
} from '../../src/orchestrator/types.js';

function withRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> | T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-approval-'));
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

async function waitFor(check: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** 取出「已上报的请求」那一支，避免每处都写一遍联合类型收窄。 */
function requestedOf(
  progress: readonly WorkerProgress[],
): Extract<NonNullable<WorkerProgress['approval']>, { state: 'requested' }> {
  const hit = progress.find((item) => item.approval?.state === 'requested')?.approval;
  assert.ok(hit && hit.state === 'requested', 'expected an approval request in the progress stream');
  return hit;
}

function resolvedOf(progress: readonly WorkerProgress[]): ApprovalResolution {
  const hit = progress.find((item) => item.approval?.state === 'resolved')?.approval;
  assert.ok(hit && hit.state === 'resolved', 'expected a resolved approval in the progress stream');
  return hit.resolution;
}

/** 假 Host：发一次 approval_requested，收到 approval 命令后才收尾（并回显它收到的决定）。 */
function writeApprovalHost(root: string): { workerRoot: string; hostPath: string } {
  const workerRoot = path.join(root, 'worker');
  fs.mkdirSync(path.join(workerRoot, '.git'), { recursive: true });
  const hostPath = path.join(root, 'approval-host.mjs');
  fs.writeFileSync(
    hostPath,
    `import readline from 'node:readline';
const emit = (event, payload = {}, requestId) => process.stdout.write(JSON.stringify({ type: 'event', event, payload, requestId }) + '\\n');
emit('runtime_ready', { projectRoot: process.cwd(), pid: process.pid });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let runId = '';
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.type === 'run') {
    runId = command.id;
    emit('run_started', { sessionId: 'session-1' }, runId);
    emit('approval_requested', {
      approvalId: 'ap-1',
      kind: 'permission',
      title: 'Allow writing src/x.ts?',
      detail: 'write_file src/x.ts',
      options: ['Allow', 'Deny'],
    }, runId);
    continue;
  }
  if (command.type === 'approval') {
    // 记住收到了什么，测试据此断言决定真的送到了 Host 进程里。
    emit('approval_recorded', { approvalId: command.approvalId, action: command.action, value: command.value ?? '' }, runId);
    emit('text_delta', { text: '<mocode_handoff>{"summary":"answered ' + command.action + '","risks":["x.ts was not written"]}</mocode_handoff>' }, runId);
    emit('run_completed', { completed: true }, runId);
  }
}
`,
    'utf8',
  );
  return { workerRoot, hostPath };
}

/** 收工判定注入空实现：这几条用例只关心审批通道，不该真调一次模型（又慢又会因为没配 key 变味）。 */
function noReview(): Promise<RunReview> {
  return Promise.resolve({
    verdict: 'continue',
    rationale: 'test',
    remaining: [],
    createdAt: new Date().toISOString(),
  });
}

function runFor(root: string): OrchestrationRun {
  return createInitialRun('approval-run', root, {
    objective: 'write something',
    autoClose: false,
    tasks: [{ id: 'task', title: 'task', objective: 'task' }],
  });
}

// ── Worker 层：审批真的往返一次 ─────────────────────────────────────────────

test('worker: a pending approval is reported, answered, and delivered to the host', async () => {
  await withRoot(async (root) => {
    const fixture = writeApprovalHost(root);
    const worker = new HostWorkerExecutor({
      hostPath: fixture.hostPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 300,
      createWorktree: () => ({ path: fixture.workerRoot, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
    });
    const progress: WorkerProgress[] = [];
    const run = runFor(root);

    const pending = worker.run({ run, task: run.tasks.task, attempt: 1, workerId: 'w-approval' }, (item) =>
      progress.push(item),
    );
    await waitFor(() => progress.some((item) => item.approval?.state === 'requested'), 4_000, 'approval request');

    const requested = requestedOf(progress);
    assert.equal(requested.id, 'ap-1');
    assert.equal(requested.kind, 'permission');
    assert.deepEqual(requested.options, ['Allow', 'Deny']);
    assert.deepEqual(worker.pendingApprovalIds(), ['ap-1']);

    const resolution: ApprovalResolution = {
      action: 'selected',
      value: 'Allow',
      by: 'operator',
      at: new Date().toISOString(),
    };
    assert.equal(worker.respondApproval('ap-1', resolution), true);
    // 同一个 id 不可能回答两次。
    assert.equal(worker.respondApproval('ap-1', resolution), false);

    const result = await pending;
    assert.equal(result.outcome, 'completed');
    assert.equal(worker.pendingApprovalIds().length, 0);
    const resolved = resolvedOf(progress);
    assert.equal(resolved.value, 'Allow');
    assert.match(progress.map((item) => item.message).join('\n'), /answered: selected \(Allow\)/);
  });
});

test('worker: an unanswered approval is denied on timeout instead of hanging forever', async () => {
  await withRoot(async (root) => {
    const fixture = writeApprovalHost(root);
    const worker = new HostWorkerExecutor({
      hostPath: fixture.hostPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 300,
      approvalTimeoutMs: 60,
      createWorktree: () => ({ path: fixture.workerRoot, repoRoot: root }),
      collectChanges: () => ({ changedFiles: [], patch: null, tree: 'tree-1' }),
      removeWorktree: () => undefined,
    });
    const progress: WorkerProgress[] = [];
    const run = runFor(root);

    const result = await worker.run({ run, task: run.tasks.task, attempt: 1, workerId: 'w-timeout' }, (item) =>
      progress.push(item),
    );

    assert.equal(result.outcome, 'completed', 'a denied approval must not kill the attempt');
    const resolution = resolvedOf(progress);
    assert.equal(resolution.by, 'timeout');
    assert.equal(resolution.action, 'cancelled');
    assert.ok(progress.some((item) => /timed out/.test(item.message)));
  });
});

// ── Scheduler 层：落账 + 跨实例转发 ─────────────────────────────────────────

/** 挂住等审批的最小 Worker：respondApproval 解锁后才收尾。 */
class ApprovalWorker implements WorkerExecutor {
  readonly answered: Array<{ approvalId: string; resolution: ApprovalResolution }> = [];
  private unlock: ((resolution: ApprovalResolution) => void) | null = null;

  async run(request: WorkerTaskRequest, onProgress: (progress: WorkerProgress) => void): Promise<WorkerTaskResult> {
    onProgress({ message: 'started', started: true, sessionId: 'session-1' });
    onProgress({
      message: 'approval: Allow writing src/x.ts?',
      sessionId: 'session-1',
      approval: {
        state: 'requested',
        id: 'ap-1',
        kind: 'permission',
        title: 'Allow writing src/x.ts?',
        options: ['Allow', 'Deny'],
      },
    });
    const resolution = await new Promise<ApprovalResolution>((resolve) => {
      this.unlock = resolve;
    });
    onProgress({
      message: 'approval answered',
      sessionId: 'session-1',
      approval: { state: 'resolved', id: 'ap-1', resolution },
    });
    return { outcome: 'completed', summary: 'wrote x.ts', changedFiles: [], laneId: request.lane?.id };
  }

  respondApproval(approvalId: string, resolution: ApprovalResolution): boolean {
    if (approvalId !== 'ap-1' || !this.unlock) return false;
    const unlock = this.unlock;
    this.unlock = null;
    this.answered.push({ approvalId, resolution });
    unlock(resolution);
    return true;
  }

  async cancel(): Promise<void> {}
}

// ── ask_human：受监管时改走通道，而不是直接说不可用 ─────────────────────────

test('ask_human: a supervised worker routes the question through the injected handler', async () => {
  const previous = process.env.MOCODE_SUPERVISED_WORKER;
  process.env.MOCODE_SUPERVISED_WORKER = '1';
  try {
    // 没注入通道（CLI 单发）：明确说不可用，逼 Worker 把问题写进 risks，而不是让非 TTY 面板替人选首项。
    setAskHumanHandler(null);
    const unavailable = await askHumanTool.execute({ question: 'Which one?', options: [] });
    assert.match(String(unavailable), /unavailable in this supervised worker/);

    // 注入了通道（对话/工作台在跑）：问题原样交上去，回答原样回给模型。
    const seen: AskHumanRequest[] = [];
    setAskHumanHandler((request) => {
      seen.push(request);
      return Promise.resolve({ action: 'selected', value: 'Postgres' });
    });
    const answered = await askHumanTool.execute({
      question: 'Which database?',
      options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'simpler' }],
      context: 'both work',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].question, 'Which database?');
    assert.deepEqual(
      seen[0].options.map((option) => option.label),
      ['Postgres', 'SQLite'],
    );
    assert.equal(seen[0].context, 'both work');
    assert.match(String(answered), /Postgres/);
  } finally {
    setAskHumanHandler(null);
    if (previous === undefined) delete process.env.MOCODE_SUPERVISED_WORKER;
    else process.env.MOCODE_SUPERVISED_WORKER = previous;
  }
});

test('scheduler: the pending approval lands in the ledger and can be answered from a fresh scheduler', async () => {
  await withRoot(async (root) => {
    const store = OrchestrationStore.create(root, {
      objective: 'needs permission',
      autoClose: false,
      tasks: [{ id: 'task', title: 'task', objective: 'task' }],
    });
    const worker = new ApprovalWorker();
    const scheduler = new OrchestrationScheduler(store, worker, {}, { pollMs: 5, review: noReview });
    const running = scheduler.run();

    await waitFor(() => store.current.tasks.task.approvals?.['ap-1'] !== undefined, 3_000, 'ledger approval');
    const recorded = store.current.tasks.task.approvals!['ap-1'];
    assert.equal(recorded.kind, 'permission');
    assert.equal(recorded.resolved, undefined);
    assert.deepEqual(
      scheduler.pendingApprovals().map((item) => item.approval.id),
      ['ap-1'],
    );

    // 关键：控制面每次调工具都会新建 scheduler 实例，必须能靠共享的 store + worker 把回答转过去。
    const fresh = new OrchestrationScheduler(store, worker, {}, { pollMs: 5, review: noReview });
    const resolution: ApprovalResolution = {
      action: 'selected',
      value: 'Allow',
      by: 'operator',
      at: new Date().toISOString(),
    };
    assert.equal(fresh.respondApproval('ap-1', resolution), true);
    // 已答过的不能再答。
    assert.equal(fresh.respondApproval('ap-1', resolution), false);

    const final = await running;
    assert.equal(final.status, 'idle');
    assert.equal(final.tasks.task.status, 'completed');
    assert.equal(worker.answered.length, 1);
    assert.equal(final.tasks.task.approvals!['ap-1'].resolved?.by, 'operator');

    const events = fs.readFileSync(path.join(store.directory, 'events.jsonl'), 'utf8');
    assert.match(events, /"type":"task\.approval_requested"/);
    assert.match(events, /"type":"task\.approval_resolved"/);
  });
});
