/**
 * SessionStore 目录存在性缓存(2026-10-05)的护栏。
 *
 * 优化动机:`appendTrace` 每 step 调 14 次(每工具 2 个 + step/model 各 2),
 * 每次都`mkdirSync(recursive)` —— 实测 0.20ms/次,比 statSync 贵 20 倍,
 * 一轮 20 step ≈ 280 次全花在「确认目录已存在」上。
 *
 * 缓存代价:「外部删掉目录后不自愈」。故三个写盘方法都加了
 * 「失败 → 清缓存 → 重试一次」。本测试锁住这几条契约:
 *  1. 正常路径:缓存生效,内容逐行完整(无交错/丢失)
 *  2. 目录被外部删除 → 能自愈(这是缓存引入的新风险,必须有护栏)
 *  3. usage.jsonl 同样自愈
 *  4. save 在目录被删后仍能落盘,且失败会抛给调用方(用户数据不能静默丢)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import type { ChatMessage } from '../src/llm/index.js';

const setup = (): { store: SessionStore; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'mocode-store-dircache-'));
  return { store: new SessionStore({ sessionsRoot: root }), root };
};

test('目录缓存: 连续 appendTrace 每次都完整落盘(缓存不丢内容)', () => {
  const { store, root } = setup();
  try {
    const id = '20260906-010000';
    const N = 20;
    for (let i = 0; i < N; i++) {
      store.appendTrace(id, { type: 'tool_call_start', data: { tool: 'read_file', i } });
    }
    const lines = readFileSync(join(root, id, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    assert.equal(lines.length, N, '行数应与写入次数一致');
    for (let i = 0; i < N; i++) {
      const parsed = JSON.parse(lines[i]) as { data: { i: number } };
      assert.equal(parsed.data.i, i, `第 ${i} 行内容应保序无交错`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录缓存: 外部删除会话目录后 appendTrace 能自愈', () => {
  const { store, root } = setup();
  try {
    const id = '20260906-020000';
    store.appendTrace(id, { type: 'step_start', data: { ordinal: 0 } });
    assert.ok(existsSync(join(root, id, 'trace.jsonl')));

    // 模拟 retention 归档 / 用户手工清理:缓存还认为目录存在
    rmSync(join(root, id), { recursive: true, force: true });
    assert.equal(existsSync(join(root, id)), false);

    store.appendTrace(id, { type: 'step_start', data: { ordinal: 1 } });

    const trace = join(root, id, 'trace.jsonl');
    assert.ok(existsSync(trace), '目录被删后应重建,而不是静默丢事件');
    const lines = readFileSync(trace, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, '旧内容已随目录删除,应只有新写的这1 条');
    assert.equal((JSON.parse(lines[0]) as { data: { ordinal: number } }).data.ordinal, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录缓存: 外部删除会话目录后 appendUsage 能自愈', () => {
  const { store, root } = setup();
  try {
    const id = '20260906-030000';
    store.appendUsage(id, { step: 0, promptTokens: 100 });
    rmSync(join(root, id), { recursive: true, force: true });

    store.appendUsage(id, { step: 1, promptTokens: 200 });

    const usage = join(root, id, 'usage.jsonl');
    assert.ok(existsSync(usage), '目录被删后 usage.jsonl 应重建');
    const recs = store.readUsage(id) as Array<{ step: number }>;
    assert.equal(recs.length, 1);
    assert.equal(recs[0].step, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录缓存: 外部删除会话目录后 save 能落盘', () => {
  const { store, root } = setup();
  try {
    const id = '20260906-040000';
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    store.save(history, id);
    assert.ok(existsSync(join(root, id, 'session.json')));

    rmSync(join(root, id), { recursive: true, force: true });

    store.save(history, id);
    const raw = readFileSync(join(root, id, 'session.json'), 'utf8');
    assert.equal((JSON.parse(raw) as { history: unknown[] }).history.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录缓存: 轮转阈值仍生效(缓存不干扰 statSync 实时值)', () => {
  const { store, root } = setup();
  const prev = process.env.MOCODE_MAX_TRACE_BYTES;
  process.env.MOCODE_MAX_TRACE_BYTES = '200'; // 小阈值:立刻触发轮转
  try {
    const id = '20260906-050000';
    for (let i = 0; i < 10; i++) {
      store.appendTrace(id, { type: 'step_start', data: { ordinal: i, pad: 'x'.repeat(60) } });
    }
    // 每条 line 约 100 字节 → 第 3 条就该超过 200 → 至少发生一次轮转
    assert.ok(
      existsSync(join(root, id, 'trace.1.jsonl.gz')),
      '超过阈值应轮转出 trace.1.jsonl.gz(说明用的是实时 size 而非缓存值)',
    );
    const lines = readFileSync(join(root, id, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    for (const l of lines) JSON.parse(l); // 轮转边界不能切出半行
  } finally {
    if (prev === undefined) delete process.env.MOCODE_MAX_TRACE_BYTES;
    else process.env.MOCODE_MAX_TRACE_BYTES = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
