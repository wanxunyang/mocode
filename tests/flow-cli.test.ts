/**
 * `mocode flow` CLI 单测(design-notes/computer-use-rpa.md §5.4):参数解析、list/show、
 * run 的 fail-closed 权限、总开关否决、退出码、--window 透传。回放本身用假 deps,不碰屏幕。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { parseFlow, saveFlow } from '../src/flows/flow.js';
import { FLOW_CLI_USAGE, parseRunArgs, runFlowCli, type FlowCliDeps } from '../src/flows/cli.js';
import type { FlowRunResult, RunFlowOptions } from '../src/flows/runner.js';

function saveDemo(name: string, steps: unknown[], params: Record<string, unknown> = {}): void {
  const r = parseFlow({ version: 1, name, params, steps });
  assert.ok(r.ok, r.ok ? '' : r.error);
  const s = saveFlow(r.flow, { overwrite: true });
  assert.ok(s.ok);
}

interface Rig {
  deps: FlowCliDeps;
  out: string[];
  err: string[];
  runs: Array<{ params: Record<string, unknown>; options: RunFlowOptions }>;
}

function rig(opts: { allowed?: boolean; result?: Partial<FlowRunResult> } = {}): Rig {
  const r: Rig = { out: [], err: [], runs: [], deps: undefined as unknown as FlowCliDeps };
  r.deps = {
    out: (s) => void r.out.push(s),
    err: (s) => void r.err.push(s),
    async computerAllowed() {
      return opts.allowed ?? true;
    },
    async run(_flow, params, _signal, options) {
      r.runs.push({ params, options });
      return { status: 'completed', steps: [], completed: 1, skipped: 0, ...opts.result };
    },
  };
  return r;
}

async function withRoot<T>(fn: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-flowcli-'));
  const prev = setSandboxRoot(root);
  try {
    return await fn();
  } finally {
    setSandboxRoot(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('parseRunArgs: 名称、参数、--window、--yes;非法输入给出错误', () => {
  const ok = parseRunArgs(['demo', 'who=Ann', 'k=a=b', '--window', '^flow', '-y']);
  assert.equal(ok.error, undefined);
  assert.equal(ok.name, 'demo');
  assert.deepEqual(ok.params, { who: 'Ann', k: 'a=b' });
  assert.equal(ok.windowTitleRegex, '^flow');
  assert.equal(ok.yes, true);

  assert.match(parseRunArgs(['demo', '--window']).error ?? '', /requires a regular expression/);
  assert.match(parseRunArgs(['demo', '--window', '(']).error ?? '', /not a valid regular expression/);
  assert.match(parseRunArgs(['demo', '--bogus']).error ?? '', /unknown option/);
  assert.match(parseRunArgs(['demo', 'oops']).error ?? '', /name=value/);
});

test('flow list / show: 空列表、列出、展示摘要;未知 flow 退出码 1', async () => {
  await withRoot(async () => {
    const a = rig();
    assert.equal(await runFlowCli(['list'], a.deps), 0);
    assert.match(a.out.join(''), /No saved flows/);

    saveDemo('demo', [{ action: 'key', text: 'ctrl+n' }]);
    const b = rig();
    assert.equal(await runFlowCli(['list'], b.deps), 0);
    assert.match(b.out.join(''), /demo {2}1 steps/);

    const c = rig();
    assert.equal(await runFlowCli(['show', 'demo'], c.deps), 0);
    assert.match(c.out.join(''), /Flow "demo"/);

    const d = rig();
    assert.equal(await runFlowCli(['show', 'nope'], d.deps), 1);
    assert.match(d.err.join(''), /mocode flow:/);
  });
});

test('用法错误 → 退出码 2', async () => {
  const a = rig();
  assert.equal(await runFlowCli([], a.deps), 2);
  assert.ok(a.err.join('').includes(FLOW_CLI_USAGE));
  const b = rig();
  assert.equal(await runFlowCli(['show'], b.deps), 2);
  const c = rig();
  assert.equal(await runFlowCli(['run'], c.deps), 2);
  const d = rig();
  assert.equal(await runFlowCli(['--sandbox-root'], d.deps), 2);
});

test('flow run: 无敏感内容直接运行,参数与 --window 透传,退出码 0', async () => {
  await withRoot(async () => {
    saveDemo('plain', [{ action: 'key', text: 'ctrl+n' }]);
    const r = rig();
    assert.equal(await runFlowCli(['run', 'plain', '--window', '^flow'], r.deps), 0);
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].options.windowTitleRegex, '^flow');
    assert.match(r.out.join(''), /completed/);
  });
});

test('flow run: 敏感 flow 无 --yes 拒绝且不执行(fail-closed);带 --yes 才执行', async () => {
  await withRoot(async () => {
    saveDemo('login', [{ action: 'type', text: 'password: {{pw}}' }], { pw: { secret: true } });
    const denied = rig();
    assert.equal(await runFlowCli(['run', 'login', 'pw=hunter2'], denied.deps), 1);
    assert.equal(denied.runs.length, 0);
    const msg = denied.err.join('');
    assert.match(msg, /--yes/);
    assert.ok(!msg.includes('hunter2'), '拒绝信息不得回显 secret 取值');

    const allowed = rig();
    assert.equal(await runFlowCli(['run', 'login', 'pw=hunter2', '--yes'], allowed.deps), 0);
    assert.equal(allowed.runs.length, 1);
  });
});

test('flow run: Computer Use 总开关关闭 → 拒绝,不执行', async () => {
  await withRoot(async () => {
    saveDemo('plain', [{ action: 'key', text: 'ctrl+n' }]);
    const r = rig({ allowed: false });
    assert.equal(await runFlowCli(['run', 'plain'], r.deps), 1);
    assert.equal(r.runs.length, 0);
    assert.match(r.err.join(''), /disabled/);
  });
});

test('flow run: handoff/failed → 1,aborted → 130,结果文本写 stderr', async () => {
  await withRoot(async () => {
    saveDemo('plain', [{ action: 'key', text: 'ctrl+n' }]);
    const h = rig({
      result: { status: 'handoff', completed: 0, failedStep: { index: 1, description: 'key ctrl+n', error: 'boom' } },
    });
    assert.equal(await runFlowCli(['run', 'plain'], h.deps), 1);
    assert.match(h.err.join(''), /handed back/);
    assert.equal(h.out.join(''), '');

    const a = rig({ result: { status: 'aborted', completed: 0 } });
    assert.equal(await runFlowCli(['run', 'plain'], a.deps), 130);
  });
});

test('--sandbox-root 只在调用期间生效,结束后恢复', async () => {
  await withRoot(async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-flowcli-other-'));
    try {
      const before = setSandboxRoot(other);
      setSandboxRoot(before);
      saveDemo('only-here', [{ action: 'key', text: 'ctrl+n' }]);
      const r = rig();
      assert.equal(await runFlowCli(['list', '--sandbox-root', other], r.deps), 0);
      assert.match(r.out.join(''), /No saved flows/, '应读取 --sandbox-root 指向的目录');
      const r2 = rig();
      await runFlowCli(['list'], r2.deps);
      assert.match(r2.out.join(''), /only-here/, '调用结束后沙箱根恢复');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
