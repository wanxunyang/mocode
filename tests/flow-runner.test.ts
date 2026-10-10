/**
 * flow 回放器单测(design-notes/computer-use-rpa.md §5.3):用假 deps 覆盖
 * 成功 / 重试 / handoff / skip / abort / TIMEOUT 不重试 / 坐标回退闸 / 缺参 / secret 打码 / 中断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, type Flow } from '../src/flows/flow.js';
import { formatFlowRunResult, runFlow, type RunnerDeps, type StepOutcome } from '../src/flows/runner.js';
import { pickWindowForReplay, type RawWindow } from '../src/runtime/window-list.js';

const SEL = { window: { processName: 'notepad' }, path: [{ role: 'Document' }] };
const OK: StepOutcome = { status: 'success', code: 'OK', output: 'done' };

function mk(steps: unknown[], params: Record<string, unknown> = {}): Flow {
  const r = parseFlow({ version: 1, name: 'demo', params, steps });
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.flow;
}

interface Harness {
  deps: RunnerDeps;
  calls: Record<string, unknown>[];
  sleeps: number[];
  resolved: unknown[];
}

function harness(
  over: Partial<RunnerDeps> & { script?: (args: Record<string, unknown>, n: number) => StepOutcome } = {},
): Harness {
  const h: Harness = { calls: [], sleeps: [], resolved: [], deps: undefined as unknown as RunnerDeps };
  h.deps = {
    async execute(args) {
      h.calls.push(args);
      return over.script ? over.script(args, h.calls.length) : OK;
    },
    async resolveRef(selector) {
      h.resolved.push(selector);
      return { ok: true, ref: 'e7' };
    },
    async resolveWindow(win) {
      return { ok: true, args: { window: 'w2', ...(win.processName ? {} : {}) } };
    },
    async sleep(ms) {
      h.sleeps.push(ms);
    },
    ...(over.signal ? { signal: over.signal } : {}),
    ...(over.resolveRef ? { resolveRef: over.resolveRef } : {}),
    ...(over.resolveWindow ? { resolveWindow: over.resolveWindow } : {}),
    ...(over.execute ? { execute: over.execute } : {}),
  };
  return h;
}

const fail = (output: string, code = 'EXECUTION_ERROR'): StepOutcome => ({ status: 'error', code, output });

test('runFlow: 全部成功;保留键不进 computer 参数,元素步骤带上现场解析的 ref', async () => {
  const flow = mk([
    { action: 'key', text: 'ctrl+n', note: 'new doc' },
    {
      action: 'set_value',
      selector: SEL,
      target: { role: 'Document', name: '' },
      text: 'hi',
      fallback: { coordinate: [500, 500] },
    },
  ]);
  const h = harness();
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'completed');
  assert.equal(r.completed, 2);
  assert.deepEqual(h.calls[0], { action: 'key', text: 'ctrl+n' });
  assert.deepEqual(h.calls[1], { action: 'set_value', text: 'hi', ref: 'e7' });
  assert.deepEqual(h.resolved, [SEL]);
});

test('runFlow: 失败后按 retry 重试并等待 retryDelayMs,第二次成功', async () => {
  const flow = mk([{ action: 'key', text: 'ctrl+s', onError: { retry: 2, retryDelayMs: 123 } }]);
  const h = harness({ script: (_a, n) => (n < 3 ? fail('boom') : OK) });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'completed');
  assert.equal(r.steps[0].attempts, 3);
  assert.deepEqual(h.sleeps, [123, 123]);
});

test('runFlow: 默认策略 retry:1 + handoff,返回失败步 / 已完成数 / 最近截图', async () => {
  const flow = mk([
    { action: 'key', text: 'ctrl+n' },
    { action: 'key', text: 'ctrl+s' },
    { action: 'key', text: 'enter' },
  ]);
  const att = [
    { type: 'image' as const, name: 'x.png', mime: 'image/png' as const, dataUrl: 'data:image/png;base64,AA==' },
  ];
  const h = harness({
    script: (a) => (a.text === 'ctrl+s' ? { ...fail('save dialog missing'), modelAttachments: att } : OK),
  });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'handoff');
  assert.equal(r.completed, 1);
  assert.equal(r.failedStep?.index, 2);
  assert.match(r.failedStep?.error ?? '', /save dialog missing/);
  assert.equal(r.steps[1].attempts, 2);
  assert.equal(h.calls.length, 3, '第 3 步不应执行');
  assert.deepEqual(r.attachments, att);
  const text = formatFlowRunResult(flow, r);
  assert.match(text, /handed back to you/);
  assert.match(text, /step 2\/3/);
});

test('runFlow: onError.then=skip 跳过失败步并继续', async () => {
  const flow = mk([
    { action: 'key', text: 'a', onError: { retry: 0, then: 'skip' } },
    { action: 'key', text: 'b' },
  ]);
  const h = harness({ script: (a) => (a.text === 'a' ? fail('nope') : OK) });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'completed');
  assert.equal(r.completed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.steps[0].status, 'skipped');
  assert.match(formatFlowRunResult(flow, r), /step 1 \(key\) skipped/);
});

test('runFlow: onError.then=abort → failed,后续步骤不执行', async () => {
  const flow = mk([
    { action: 'key', text: 'a', onError: { retry: 0, then: 'abort' } },
    { action: 'key', text: 'b' },
  ]);
  const h = harness({ script: () => fail('x') });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.length, 1);
  assert.match(formatFlowRunResult(flow, r), /onError: abort/);
});

test('runFlow: TIMEOUT 与 denied 不重试', async () => {
  const flow = mk([{ action: 'wait_until', condition: { kind: 'stable' }, onError: { retry: 3, then: 'abort' } }]);
  const h = harness({ script: () => fail('timed out', 'TIMEOUT') });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);

  const h2 = harness({ script: () => ({ status: 'denied', code: 'PERMISSION_DENIED', output: 'no' }) });
  const r2 = await runFlow(flow, undefined, h2.deps);
  assert.equal(r2.status, 'failed');
  assert.equal(h2.calls.length, 1);
});

test('runFlow: selector 解析失败默认不退回坐标(即便录了 fallback)', async () => {
  const flow = mk([
    {
      action: 'click_element',
      selector: SEL,
      fallback: { coordinate: [100, 200] },
      onError: { retry: 0, then: 'abort' },
    },
  ]);
  const h = harness({ resolveRef: async () => ({ ok: false, error: 'no unique element' }) });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.length, 0, '不得盲点过期坐标');
  assert.match(r.failedStep?.error ?? '', /no unique element/);
  assert.match(r.failedStep?.error ?? '', /allowCoordinateFallback is not enabled/);
});

test('runFlow: allowCoordinateFallback:true 时 selector 失败退回录制坐标,并在结果里注明', async () => {
  const flow = mk([
    {
      action: 'click_element',
      selector: SEL,
      fallback: { coordinate: [100, 200] },
      allowCoordinateFallback: true,
      click_count: 2,
    },
    {
      action: 'set_value',
      selector: SEL,
      fallback: { coordinate: [300, 400] },
      allowCoordinateFallback: true,
      text: 'v',
    },
  ]);
  const h = harness({ resolveRef: async () => ({ ok: false, error: 'gone' }) });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'completed');
  assert.deepEqual(h.calls, [
    { action: 'double_click', coordinate: [100, 200] },
    { action: 'left_click', coordinate: [300, 400] },
    { action: 'key', text: 'ctrl+a' },
    { action: 'type', text: 'v' },
  ]);
  assert.match(r.steps[0].detail ?? '', /used the recorded coordinates/);
  assert.match(formatFlowRunResult(flow, r), /used the recorded coordinates/);
});

test('runFlow: 缺必填参数 / 未知参数 → rejected,一步都不执行', async () => {
  const flow = mk([{ action: 'type', text: '{{who}}' }], { who: { description: 'name' } });
  const h = harness();
  const r1 = await runFlow(flow, undefined, h.deps);
  assert.equal(r1.status, 'rejected');
  assert.match(r1.error ?? '', /missing required parameter/);
  const r2 = await runFlow(flow, { who: 'x', oops: 'y' }, h.deps);
  assert.equal(r2.status, 'rejected');
  assert.match(r2.error ?? '', /unknown parameter "oops"/);
  assert.equal(h.calls.length, 0);
  assert.match(formatFlowRunResult(flow, r1), /was not run/);
});

test('runFlow: 参数代入进 computer 参数;default 生效', async () => {
  const flow = mk([{ action: 'type', text: 'Hi {{who}}, {{greet}}' }], {
    who: {},
    greet: { default: 'welcome' },
  });
  const h = harness();
  const r = await runFlow(flow, { who: 'Ann' }, h.deps);
  assert.equal(r.status, 'completed');
  assert.equal(h.calls[0].text, 'Hi Ann, welcome');
});

test('runFlow: 失败文本里回显的 secret 取值被打码', async () => {
  const flow = mk([{ action: 'type', text: '{{text_1}}', onError: { retry: 0 } }], {
    text_1: { secret: true },
  });
  const h = harness({ script: () => fail('typing failed for hunter2-secret value') });
  const r = await runFlow(flow, { text_1: 'hunter2-secret' }, h.deps);
  assert.equal(r.status, 'handoff');
  const text = formatFlowRunResult(flow, r);
  assert.ok(!text.includes('hunter2-secret'));
  assert.ok(!JSON.stringify(r).includes('hunter2-secret'));
  assert.match(text, /\*\*\*/);
});

test('runFlow: focus_window 经 resolveWindow 解析;titleRegex-only 直接传 title_regex', async () => {
  const flow = mk([
    { action: 'focus_window', window: { processName: 'notepad' } },
    { action: 'focus_window', window: { titleRegex: 'Untitled' } },
  ]);
  const h = harness();
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'completed');
  assert.deepEqual(h.calls[0], { action: 'focus_window', window: 'w2' });
  assert.deepEqual(h.calls[1], { action: 'focus_window', title_regex: 'Untitled' });
});

test('runFlow: resolveWindow 失败 → 按策略处理', async () => {
  const flow = mk([{ action: 'focus_window', window: { processName: 'notepad' }, onError: { retry: 0 } }]);
  const h = harness({ resolveWindow: async () => ({ ok: false, error: 'no open window matches notepad.exe' }) });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'handoff');
  assert.match(r.failedStep?.error ?? '', /no open window/);
  assert.equal(h.calls.length, 0);
});

test('runFlow: 已中断的 signal 在第一步之前就返回 aborted', async () => {
  const ac = new AbortController();
  ac.abort();
  const flow = mk([{ action: 'key', text: 'a' }]);
  const h = harness({ signal: ac.signal });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'aborted');
  assert.equal(h.calls.length, 0);
});

test('runFlow: 执行中被中断(execute 返回 aborted)→ aborted,不重试', async () => {
  const flow = mk([
    { action: 'key', text: 'a' },
    { action: 'key', text: 'b' },
  ]);
  const h = harness({ script: () => ({ status: 'aborted', code: 'ABORTED', output: 'aborted' }) });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'aborted');
  assert.equal(h.calls.length, 1);
  assert.match(formatFlowRunResult(flow, r), /interrupted after 0 of 2/);
});

test('runFlow: execute 抛异常按失败处理(可重试)', async () => {
  const flow = mk([{ action: 'key', text: 'a', onError: { retry: 1 } }]);
  let n = 0;
  const h = harness({
    execute: async () => {
      n += 1;
      if (n === 1) throw new Error('spawn failed');
      return OK;
    },
  });
  const r = await runFlow(flow, undefined, h.deps);
  assert.equal(r.status, 'completed');
  assert.equal(r.steps[0].attempts, 2);
});

// ── pickWindowForReplay ──────────────────────────────────────────────────

function win(over: Partial<RawWindow>): RawWindow {
  return {
    hwnd: 1,
    title: 'Untitled - Notepad',
    processName: 'notepad',
    pid: 10,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    minimized: false,
    foreground: false,
    toolWindow: false,
    cloaked: false,
    ...over,
  };
}

test('pickWindowForReplay: 唯一匹配 / 无匹配 / 过滤工具窗与 cloaked', () => {
  const raw = [
    win({ hwnd: 1 }),
    win({ hwnd: 2, processName: 'calc', title: 'Calculator' }),
    win({ hwnd: 3, toolWindow: true }),
    win({ hwnd: 4, cloaked: true }),
  ];
  const hit = pickWindowForReplay(raw, { processName: 'NOTEPAD' });
  assert.ok(hit.ok && hit.window.hwnd === 1);
  const none = pickWindowForReplay(raw, { processName: 'mspaint' });
  assert.ok(!none.ok && /no open window matches mspaint\.exe/.test(none.error));
});

test('pickWindowForReplay: 同进程多窗口 → 恰一个前台则取前台,否则歧义报错', () => {
  const two = [win({ hwnd: 1, title: 'a - Notepad' }), win({ hwnd: 2, title: 'b - Notepad', foreground: true })];
  const fg = pickWindowForReplay(two, { processName: 'notepad' });
  assert.ok(fg.ok && fg.window.hwnd === 2);
  const none = [win({ hwnd: 1, title: 'a - Notepad' }), win({ hwnd: 2, title: 'b - Notepad' })];
  const amb = pickWindowForReplay(none, { processName: 'notepad' });
  assert.ok(!amb.ok && /none is uniquely in front/.test(amb.error));
  const byTitle = pickWindowForReplay(none, { processName: 'notepad', titleRegex: '^b' });
  assert.ok(byTitle.ok && byTitle.window.hwnd === 2);
});

test('pickWindowForReplay: 非法 titleRegex 报错而不抛', () => {
  const r = pickWindowForReplay([win({})], { titleRegex: '(' });
  assert.ok(!r.ok && /not a valid regular expression/.test(r.error));
});

// ── windowTitleRegex 运行时覆盖 ──────────────────────────────────────────

test('runFlow: windowTitleRegex 覆盖元素步骤 selector.window.titleRegex,进程名与 path 不变,原 flow 不被改写', async () => {
  const flow = mk([{ action: 'set_value', selector: SEL, text: 'hi' }]);
  const h = harness();
  const r = await runFlow(flow, undefined, h.deps, { windowTitleRegex: '^flow' });
  assert.equal(r.status, 'completed');
  assert.deepEqual(h.resolved, [{ window: { processName: 'notepad', titleRegex: '^flow' }, path: SEL.path }]);
  assert.equal((flow.steps[0].selector as { window: { titleRegex?: string } }).window.titleRegex, undefined);
});

test('runFlow: windowTitleRegex 覆盖 focus_window(带进程名时经 resolveWindow,仅标题时走 title_regex 参数)', async () => {
  const seen: Array<{ processName?: string; titleRegex?: string }> = [];
  const flow = mk([
    { action: 'focus_window', window: { processName: 'notepad', titleRegex: 'old' } },
    { action: 'focus_window', window: { titleRegex: 'older' } },
  ]);
  const h = harness({
    async resolveWindow(win) {
      seen.push(win);
      return { ok: true, args: { window: 'w2' } };
    },
  });
  const r = await runFlow(flow, undefined, h.deps, { windowTitleRegex: 'new' });
  assert.equal(r.status, 'completed');
  assert.deepEqual(seen, [{ processName: 'notepad', titleRegex: 'new' }]);
  assert.deepEqual(h.calls[0], { action: 'focus_window', window: 'w2' });
  assert.deepEqual(h.calls[1], { action: 'focus_window', title_regex: 'new' });
});

test('runFlow: 不传 windowTitleRegex 时行为不变(selector 原样传给 resolveRef)', async () => {
  const flow = mk([{ action: 'click_element', selector: SEL }]);
  const h = harness();
  await runFlow(flow, undefined, h.deps);
  assert.deepEqual(h.resolved, [SEL]);
});
