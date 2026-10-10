/**
 * flow trace 单测(design-notes/computer-use-rpa.md §5.1):buildTraceEntry 纯函数 + JSONL 存取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSandboxRoot } from '../src/sandbox/root.js';
import { setCurrentSessionId } from '../src/session/state.js';
import { parseRawTree, type UiaRawTree } from '../src/runtime/uia-selector.js';
import {
  TRACE_FILENAME,
  appendTrace,
  buildTraceEntry,
  getTraceFilePath,
  isRecordedAction,
  isTraceSuspended,
  nextTraceSeq,
  outputIndicatesChange,
  readTrace,
  TRACE_KEEP_ENTRIES,
  trimTraceFile,
  withTraceSuspended,
} from '../src/flows/trace.js';

const GEO = { physW: 1000, physH: 1000, originX: 0, originY: 0 };

function node(
  id: number,
  parent: number,
  path: string,
  role: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    parent,
    path,
    depth: path === '' ? 0 : path.split('.').length,
    role,
    name,
    automationId: '',
    className: '',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    enabled: true,
    offscreen: false,
    isPassword: false,
    patterns: [],
    ...extra,
  };
}

/** Window → Document(value)+ Button 保存(invoke)。 */
function tree(): UiaRawTree {
  return parseRawTree({
    window: {
      hwnd: 7,
      title: '无标题 - 记事本',
      processName: 'notepad',
      pid: 1,
      rect: { x: 0, y: 0, w: 1000, h: 1000 },
    },
    nodes: [
      node(0, -1, '', 'Window', '无标题 - 记事本'),
      node(1, 0, '0', 'Document', '文本编辑器', { patterns: ['value'] }),
      node(2, 0, '1', 'Button', '保存', { patterns: ['invoke'], rect: { x: 100, y: 200, w: 40, h: 20 } }),
    ],
    truncated: false,
    elapsedMs: 1,
  });
}

test('isRecordedAction: 输入类入 trace,观察类不入', () => {
  for (const a of ['left_click', 'type', 'key', 'click_element', 'set_value', 'focus_window', 'wait_until']) {
    assert.equal(isRecordedAction(a), true, a);
  }
  for (const a of ['screenshot', 'zoom', 'inspect', 'list_windows', 'cursor_position']) {
    assert.equal(isRecordedAction(a), false, a);
  }
  assert.equal(buildTraceEntry({ action: 'screenshot' }, { seq: 1 }), null);
});

test('buildTraceEntry: 纯坐标动作标 fragile 并只保留白名单参数', () => {
  const e = buildTraceEntry({ action: 'left_click', coordinate: [500, 300], junk: 1 }, { seq: 3, ts: 'T' })!;
  assert.equal(e.seq, 3);
  assert.equal(e.ts, 'T');
  assert.equal(e.fragile, true);
  assert.deepEqual(e.args, { coordinate: [500, 300] });
});

test('buildTraceEntry: 敏感文本不落明文,普通文本原样保留', () => {
  const secret = buildTraceEntry({ action: 'type', text: 'password: hunter2' }, { seq: 7 })!;
  assert.deepEqual(secret.args.text, { $param: 'text_7' });
  assert.ok(!JSON.stringify(secret).includes('hunter2'));
  const plain = buildTraceEntry({ action: 'type', text: 'hello', method: 'paste' }, { seq: 8 })!;
  assert.deepEqual(plain.args, { text: 'hello', method: 'paste' });
  assert.equal(plain.fragile, undefined);
});

test('buildTraceEntry: click_element 记 selector / target / norm 中心 fallback,不记 ref', () => {
  const t = tree();
  const e = buildTraceEntry(
    { action: 'click_element', ref: 'e2' },
    { seq: 1, element: { tree: t, nodeId: 2 }, geometry: GEO },
  )!;
  assert.ok(e.selector);
  assert.equal(e.selector!.window.processName, 'notepad');
  assert.deepEqual(e.target, { role: 'Button', name: '保存' });
  assert.deepEqual(e.fallback, { coordinate: [120, 210] });
  assert.equal('ref' in e.args, false);
});

test('buildTraceEntry: 元素动作缺快照 → null(不录不可回放的步骤)', () => {
  assert.equal(buildTraceEntry({ action: 'click_element', ref: 'e2' }, { seq: 1, geometry: GEO }), null);
});

test('buildTraceEntry: focus_window 需要进程名或 title_regex', () => {
  assert.equal(buildTraceEntry({ action: 'focus_window', window: 'w3' }, { seq: 1 }), null);
  const byRef = buildTraceEntry({ action: 'focus_window', window: 'w3' }, { seq: 1, windowProcess: 'notepad' })!;
  assert.deepEqual(byRef.window, { processName: 'notepad' });
  const byRe = buildTraceEntry({ action: 'focus_window', title_regex: '记事本$' }, { seq: 2 })!;
  assert.deepEqual(byRe.window, { titleRegex: '记事本$' });
});

test('buildTraceEntry: wait_until 的 ref 条件转成 selector_text;未知 ref → null', () => {
  const lookupRef = (r: string) => (r === 'e5' ? { role: 'Button', name: '确定' } : undefined);
  const e = buildTraceEntry(
    { action: 'wait_until', condition: { kind: 'element_present', ref: 'e5' }, timeout_ms: 5000 },
    { seq: 1, lookupRef },
  )!;
  assert.deepEqual(e.args.condition, { kind: 'element_present', selector_text: 'Button:"确定"' });
  assert.equal(e.args.timeout_ms, 5000);
  assert.equal(
    buildTraceEntry({ action: 'wait_until', condition: { kind: 'element_present', ref: 'e9' } }, { seq: 1, lookupRef }),
    null,
  );
  const stable = buildTraceEntry({ action: 'wait_until', condition: { kind: 'stable' } }, { seq: 2 })!;
  assert.deepEqual(stable.args.condition, { kind: 'stable' });
});

test('outputIndicatesChange: 重截屏回灌算变化;wait/wait_until 与差分命中不算', () => {
  assert.equal(outputIndicatesChange('left_click', 'clicked. Screen re-captured (primary screen'), true);
  assert.equal(outputIndicatesChange('left_click', 'clicked. No visible change on screen (frame diff'), false);
  assert.equal(outputIndicatesChange('wait', 'waited 100ms. Screen re-captured ('), false);
  assert.equal(outputIndicatesChange('wait_until', 'waited until stable: met. Screen re-captured ('), false);
});

test('trace 存取:追加 / 读取 / 序号递增 / 坏行跳过 / 无会话不写', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-trace-'));
  const prev = setSandboxRoot(root);
  try {
    setCurrentSessionId(undefined, root);
    assert.equal(getTraceFilePath(), null);
    assert.equal(appendTrace({ seq: 1, ts: 'T', action: 'key', args: { text: 'a' } }), false);

    setCurrentSessionId('trace-test', root);
    const file = getTraceFilePath()!;
    assert.ok(file.endsWith(path.join('trace-test', TRACE_FILENAME)));
    assert.equal(nextTraceSeq(), 1);
    assert.equal(appendTrace({ seq: 1, ts: 'T', action: 'key', args: { text: 'ctrl+s' } }), true);
    fs.appendFileSync(file, 'not json\n', 'utf8');
    assert.equal(appendTrace({ seq: nextTraceSeq(), ts: 'T', action: 'type', args: { text: 'x' } }), true);
    const all = readTrace();
    assert.deepEqual(
      all.map((e) => e.seq),
      [1, 2],
    );
    assert.equal(nextTraceSeq(), 3);
  } finally {
    setCurrentSessionId(undefined, root);
    setSandboxRoot(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('withTraceSuspended: 嵌套计数,异常后也恢复', async () => {
  assert.equal(isTraceSuspended(), false);
  await withTraceSuspended(async () => {
    assert.equal(isTraceSuspended(), true);
    await withTraceSuspended(async () => assert.equal(isTraceSuspended(), true));
    assert.equal(isTraceSuspended(), true);
  });
  assert.equal(isTraceSuspended(), false);
  await assert.rejects(withTraceSuspended(async () => Promise.reject(new Error('x'))));
  assert.equal(isTraceSuspended(), false);
});

test('trimTraceFile: 未超大小不动;超限只留最近 keep 条且不留 tmp,seq 不重编号', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-trace-trim-'));
  try {
    const file = path.join(root, TRACE_FILENAME);
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ seq: i + 1, ts: 'T', action: 'key', args: { text: 'x' } }),
    );
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    assert.equal(trimTraceFile(file, 1_000_000, 3), false, '未超大小不裁');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 10);

    assert.equal(trimTraceFile(file, 10, 20), false, '条数不足 keep 不裁');
    assert.equal(trimTraceFile(file, 10, 3), true);
    const kept = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    assert.deepEqual(kept, [8, 9, 10]);
    assert.equal(fs.existsSync(`${file}.tmp`), false);

    assert.equal(trimTraceFile(path.join(root, 'missing.jsonl'), 1, 1), false, '文件缺失不抛');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appendTrace: 持续追加超过大小上限后自动裁剪,最新条目保留且 seq 单调', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-trace-cap-'));
  const prev = setSandboxRoot(root);
  try {
    setCurrentSessionId('trace-cap', root);
    // 单条略大于 1.3KB:256KB 上限在约 200 条时被越过,才同时满足「超大小」与「条数 > keep」两个裁剪条件。
    const big = 'a'.repeat(1400);
    const total = 215;
    // seq 用循环计数而不是每次 nextTraceSeq():后者整文件解析,会让用例 O(n²) 变慢。
    for (let i = 1; i <= total; i++) {
      assert.equal(appendTrace({ seq: i, ts: 'T', action: 'type', args: { text: big } }), true);
    }
    const all = readTrace();
    assert.ok(all.length >= TRACE_KEEP_ENTRIES, `kept ${all.length}`);
    assert.ok(all.length < total, `expected trimming, kept ${all.length}`);
    assert.equal(all[all.length - 1].seq, total);
    assert.equal(nextTraceSeq(), total + 1);
    for (let i = 1; i < all.length; i++) assert.ok(all[i].seq > all[i - 1].seq);
  } finally {
    setCurrentSessionId(undefined, root);
    setSandboxRoot(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
