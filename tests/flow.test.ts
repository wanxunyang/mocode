/**
 * flow 文件单测(design-notes/computer-use-rpa.md §5.2):解析校验、模板、参数、敏感审查、
 * 从 trace 导出、存取。纯逻辑 + 临时目录,不碰屏幕/UIA。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import {
  describeStep,
  escapeTemplate,
  exportFlowFromTrace,
  flowReviewReasons,
  flowsDir,
  listFlows,
  loadFlow,
  parseFlow,
  renderStep,
  renderTemplate,
  resolveParams,
  saveFlow,
  summarizeFlow,
  templateRefs,
  type Flow,
} from '../src/flows/flow.js';
import type { TraceEntry } from '../src/flows/trace.js';

const SEL = { window: { processName: 'notepad' }, path: [{ role: 'Document' }] };

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'demo',
    params: {},
    steps: [{ action: 'key', text: 'ctrl+s' }],
    ...over,
  };
}

function mustParse(raw: unknown): Flow {
  const r = parseFlow(raw);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.flow;
}

function parseError(raw: unknown): string {
  const r = parseFlow(raw);
  assert.equal(r.ok, false);
  return r.ok ? '' : r.error;
}

test('parseFlow: 最小合法 flow 通过,params 缺省为 {}', () => {
  const flow = mustParse({ version: 1, name: 'a-b_1', steps: [{ action: 'wait', duration_ms: 100 }] });
  assert.deepEqual(flow.params, {});
  assert.equal(flow.steps.length, 1);
});

test('parseFlow: 版本 / 名称 / 步骤数边界', () => {
  assert.match(parseError(base({ version: 2 })), /version/);
  assert.match(parseError(base({ name: '../evil' })), /name/);
  assert.match(parseError(base({ name: '' })), /name/);
  assert.match(parseError(base({ steps: [] })), /non-empty/);
  const many = Array.from({ length: 201 }, () => ({ action: 'key', text: 'a' }));
  assert.match(parseError(base({ steps: many })), /limit/);
});

test('parseFlow: 拒绝未知 action 与未知字段(防手改塞入 ref 等)', () => {
  assert.match(parseError(base({ steps: [{ action: 'screenshot' }] })), /action must be one of/);
  assert.match(parseError(base({ steps: [{ action: 'key', text: 'a', ref: 'e1' }] })), /unknown field "ref"/);
  assert.match(
    parseError(base({ steps: [{ action: 'key', text: 'a', coordinate: [1, 1] }] })),
    /unknown field "coordinate"/,
  );
});

test('parseFlow: 元素动作需 selector 或 fallback;focus_window 需窗口信息', () => {
  assert.match(parseError(base({ steps: [{ action: 'click_element' }] })), /needs a selector/);
  assert.ok(parseFlow(base({ steps: [{ action: 'click_element', selector: SEL }] })).ok);
  assert.ok(parseFlow(base({ steps: [{ action: 'click_element', fallback: { coordinate: [10, 20] } }] })).ok);
  assert.match(parseError(base({ steps: [{ action: 'focus_window' }] })), /needs window/);
  assert.ok(parseFlow(base({ steps: [{ action: 'focus_window', window: { processName: 'notepad' } }] })).ok);
});

test('parseFlow: selector / fallback / window / onError 结构校验', () => {
  assert.match(parseError(base({ steps: [{ action: 'click_element', selector: { path: [] } }] })), /selector/);
  assert.match(
    parseError(base({ steps: [{ action: 'click_element', selector: { window: { processName: 'n' }, path: [] } }] })),
    /non-empty/,
  );
  assert.match(
    parseError(base({ steps: [{ action: 'click_element', fallback: { coordinate: [1001, 5] } }] })),
    /fallback/,
  );
  assert.match(
    parseError(base({ steps: [{ action: 'focus_window', window: { titleRegex: '([' } }] })),
    /valid regular expression/,
  );
  assert.match(parseError(base({ steps: [{ action: 'key', text: 'a', onError: { retry: 9 } }] })), /retry/);
  assert.match(
    parseError(base({ steps: [{ action: 'key', text: 'a', onError: { then: 'explode' } }] })),
    /abort\|skip\|handoff/,
  );
  assert.ok(
    parseFlow(base({ steps: [{ action: 'key', text: 'a', onError: { retry: 2, retryDelayMs: 300, then: 'skip' } }] }))
      .ok,
  );
});

test('parseFlow: 引用未声明参数报错;secret 参数不得带 default', () => {
  assert.match(
    parseError(base({ steps: [{ action: 'type', text: 'hi {{who}}' }] })),
    /undefined parameter "\{\{who\}\}"/,
  );
  assert.ok(parseFlow(base({ params: { who: {} }, steps: [{ action: 'type', text: 'hi {{who}}' }] })).ok);
  assert.match(
    parseError(base({ params: { pw: { secret: true, default: 'x' } }, steps: [{ action: 'key', text: 'a' }] })),
    /must not have a default/,
  );
  assert.match(parseError(base({ params: { '1bad': {} } })), /param name/);
});

test('模板: escapeTemplate / templateRefs / renderTemplate', () => {
  assert.equal(escapeTemplate('a {{b}} c'), 'a \\{{b}} c');
  assert.deepEqual(templateRefs('x {{a}} y {{ b_2 }} \\{{c}}'), ['a', 'b_2']);
  assert.equal(renderTemplate('hi {{who}}!', { who: '万' }), 'hi 万!');
  assert.equal(renderTemplate('literal \\{{who}}', {}), 'literal {{who}}');
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing value/);
});

test('renderStep: 只代入 computer 参数,保留键(selector 等)原样', () => {
  const step = {
    action: 'set_value',
    text: '{{body}}',
    selector: { window: { processName: 'notepad' }, path: [{ role: 'Document', name: '{{body}}' }] },
  };
  const out = renderStep(step, { body: 'hello' });
  assert.equal(out.text, 'hello');
  assert.equal((out.selector as typeof step.selector).path[0].name, '{{body}}');
});

test('resolveParams: default / 缺失 / 未知参数名', () => {
  const flow = mustParse(
    base({
      params: { a: { default: 'A' }, b: {} },
      steps: [{ action: 'type', text: '{{a}}{{b}}' }],
    }),
  );
  const ok = resolveParams(flow, { b: 'B' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.values, { a: 'A', b: 'B' });

  const missing = resolveParams(flow, {});
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error, /missing required parameter\(s\): b/);

  const unknown = resolveParams(flow, { b: 'B', typo: '1' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? '' : unknown.error, /unknown parameter "typo"/);

  const num = resolveParams(flow, { b: 5 });
  assert.ok(num.ok && num.values.b === '5');
  const bad = resolveParams(flow, { b: { x: 1 } });
  assert.equal(bad.ok, false);
});

test('flowReviewReasons: secret 参数 / 代入后的敏感文本 / 敏感目标元素', () => {
  const secret = mustParse(base({ params: { pw: { secret: true } }, steps: [{ action: 'type', text: '{{pw}}' }] }));
  assert.match(flowReviewReasons(secret, { pw: 'abc' }).join('\n'), /secret parameter pw/);

  const sensitiveText = mustParse(base({ params: { pw: {} }, steps: [{ action: 'type', text: 'password: {{pw}}' }] }));
  assert.match(flowReviewReasons(sensitiveText, { pw: 'x' }).join('\n'), /sensitive text/);

  const target = mustParse(
    base({
      steps: [
        { action: 'click_element', selector: SEL, target: { role: 'Button', name: '删除' } },
        { action: 'click_element', selector: { ...SEL, path: [{ role: 'Button', name: 'Send' }] } },
      ],
    }),
  );
  const reasons = flowReviewReasons(target, {});
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /step 1 targets a sensitive element/);
  assert.match(reasons[1], /step 2/);

  const benign = mustParse(
    base({
      steps: [
        { action: 'type', text: 'hello' },
        { action: 'key', text: 'ctrl+s' },
      ],
    }),
  );
  assert.deepEqual(flowReviewReasons(benign, {}), []);
});

test('describeStep / summarizeFlow: 摘要不含 secret 取值,标出坐标依赖与失败策略', () => {
  const flow = mustParse(
    base({
      description: 'demo flow',
      params: { pw: { secret: true }, who: { default: 'x' } },
      steps: [
        { action: 'type', text: '{{pw}}' },
        { action: 'left_click', coordinate: [100, 200], fragile: true, onError: { then: 'abort' } },
        { action: 'wait_until', condition: { kind: 'element_present', selector_text: 'Button:"OK"' } },
      ],
    }),
  );
  const text = summarizeFlow(flow);
  assert.match(text, /3 steps/);
  assert.match(text, /pw \(secret\)/);
  assert.match(text, /who \(default "x"\)/);
  assert.match(text, /\{\{pw\}\}/);
  assert.match(text, /coordinate-based/);
  assert.match(text, /on error: abort/);
  assert.match(describeStep(flow.steps[2], 3), /element_present Button:"OK"/);
});

// ── 导出 ────────────────────────────────────────────────────────────────

function entry(seq: number, over: Partial<TraceEntry> & Pick<TraceEntry, 'action' | 'args'>): TraceEntry {
  return { seq, ts: '2026-01-01T00:00:00.000Z', ...over };
}

const TRACE: TraceEntry[] = [
  entry(1, { action: 'focus_window', args: {}, window: { processName: 'notepad' }, changed: true }),
  entry(2, {
    action: 'set_value',
    args: { text: 'hello {{x}}' },
    selector: SEL,
    target: { role: 'Document', name: '文本编辑器' },
    changed: true,
  }),
  entry(3, { action: 'type', args: { text: { $param: 'text_3' } }, changed: false }),
  entry(4, { action: 'key', args: { text: 'ctrl+s' }, changed: true }),
];

test('exportFlowFromTrace: 敏感文本 → secret 参数;字面量 {{ 转义;界面变化后插入 stable 等待', () => {
  const r = exportFlowFromTrace(TRACE, { name: 'notepad-save', description: 'save it' });
  assert.ok(r.ok, r.ok ? '' : r.error);
  const flow = r.flow;
  assert.deepEqual(
    flow.steps.map((s) => s.action),
    ['focus_window', 'wait_until', 'set_value', 'wait_until', 'type', 'key'],
  );
  assert.equal(flow.params.text_3?.secret, true);
  assert.equal(flow.params.text_3?.default, undefined);
  assert.equal(flow.steps[4].text, '{{text_3}}');
  // 字面量 {{x}} 已转义,渲染后还原,且不会被当成参数引用。
  assert.equal(flow.steps[2].text, 'hello \\{{x}}');
  assert.equal(renderStep(flow.steps[2], {}).text, 'hello {{x}}');
  assert.equal(flow.params.x, undefined);
  // 自动等待:超时只跳过。
  assert.equal(flow.steps[1].onError?.then, 'skip');
  assert.equal(flow.description, 'save it');
  // 导出的磁盘文本里没有任何敏感明文,且能重新通过校验。
  assert.ok(parseFlow(JSON.parse(JSON.stringify(flow))).ok);
});

test('exportFlowFromTrace: 最后一步与相邻等待之前不插入自动等待', () => {
  const entries: TraceEntry[] = [
    entry(1, { action: 'key', args: { text: 'a' }, changed: true }),
    entry(2, { action: 'wait', args: { duration_ms: 100 } }),
    entry(3, { action: 'key', args: { text: 'b' }, changed: true }),
  ];
  const r = exportFlowFromTrace(entries, { name: 'x' });
  assert.ok(r.ok);
  assert.deepEqual(
    r.flow.steps.map((s) => s.action),
    ['key', 'wait', 'key'],
  );
});

test('exportFlowFromTrace: --from/--to 范围、乱序输入、空范围与非法名称', () => {
  const shuffled = [TRACE[3], TRACE[1], TRACE[0], TRACE[2]];
  const ranged = exportFlowFromTrace(shuffled, { name: 'r', from: 2, to: 3 });
  assert.ok(ranged.ok);
  assert.deepEqual(
    ranged.flow.steps.map((s) => s.action),
    ['set_value', 'wait_until', 'type'],
  );
  const empty = exportFlowFromTrace(TRACE, { name: 'r', from: 99 });
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? '' : empty.error, /no recorded steps/);
  const badName = exportFlowFromTrace(TRACE, { name: '../x' });
  assert.equal(badName.ok, false);
});

// ── 存取 ────────────────────────────────────────────────────────────────

function withTmpRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-flow-'));
  const prev = setSandboxRoot(root);
  try {
    fn(root);
  } finally {
    setSandboxRoot(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('saveFlow / loadFlow / listFlows: 往返、拒绝覆盖、hash 随内容变化、无 tmp 残留', () => {
  withTmpRoot((root) => {
    assert.equal(flowsDir(), path.join(root, '.mocode', 'flows'));
    assert.deepEqual(listFlows(), []);

    const flow = mustParse(base({ name: 'one', description: 'first' }));
    const saved = saveFlow(flow);
    assert.ok(saved.ok);
    assert.deepEqual(fs.readdirSync(flowsDir()), ['one.json']);

    const dup = saveFlow(flow);
    assert.equal(dup.ok, false);
    assert.match(dup.ok ? '' : dup.error, /already exists/);

    const loaded = loadFlow('one');
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.flow, flow);
    assert.match(loaded.hash, /^[0-9a-f]{64}$/);

    const changed = mustParse(base({ name: 'one', steps: [{ action: 'key', text: 'ctrl+o' }] }));
    assert.ok(saveFlow(changed, { overwrite: true }).ok);
    const reloaded = loadFlow('one');
    assert.ok(reloaded.ok);
    assert.notEqual(reloaded.hash, loaded.hash);

    assert.ok(saveFlow(mustParse(base({ name: 'alpha' }))).ok);
    assert.deepEqual(
      listFlows().map((f) => [f.name, f.steps]),
      [
        ['alpha', 1],
        ['one', 1],
      ],
    );
  });
});

test('loadFlow: 路径穿越 / 不存在 / 坏 JSON / 校验失败 / 文件名与 name 不一致', () => {
  withTmpRoot(() => {
    const traversal = loadFlow('../secrets');
    assert.equal(traversal.ok, false);
    assert.match(traversal.ok ? '' : traversal.error, /invalid flow name/);
    assert.equal(saveFlow({ ...mustParse(base()), name: '../x' }).ok, false);

    const missing = loadFlow('nope');
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? '' : missing.error, /not found/);

    fs.mkdirSync(flowsDir(), { recursive: true });
    fs.writeFileSync(path.join(flowsDir(), 'broken.json'), '{ not json', 'utf8');
    const broken = loadFlow('broken');
    assert.equal(broken.ok, false);
    assert.match(broken.ok ? '' : broken.error, /not valid JSON/);

    fs.writeFileSync(path.join(flowsDir(), 'bad.json'), JSON.stringify({ version: 1, name: 'bad', steps: [] }), 'utf8');
    const invalid = loadFlow('bad');
    assert.equal(invalid.ok, false);
    assert.match(invalid.ok ? '' : invalid.error, /invalid/);

    fs.writeFileSync(path.join(flowsDir(), 'other.json'), JSON.stringify(base({ name: 'demo' })), 'utf8');
    const mismatch = loadFlow('other');
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.ok ? '' : mismatch.error, /must match/);

    // 坏文件不影响 list。
    assert.deepEqual(listFlows(), []);
  });
});
