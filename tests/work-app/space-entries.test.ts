import test from 'node:test';
import assert from 'node:assert/strict';
import { SPACE_INLINE_LIMIT, splitSpaceEntries } from '../../packages/work-app/src/renderer/space-entries.js';

/**
 * 侧栏「空间」内联区的唯一规则源。这些用例钉的是三件事：
 *   1. 任务与会话按时间混排，不按「任务优先」硬分组（用户的直觉是「我最近聊过什么」）；
 *   2. 已接管的会话不能再以会话身份重复出现；
 *   3. 没进内联的行要能明确归到「还有 N 个任务」或「历史会话」两处之一，不漏不重。
 */

const task = (id: string, at: string, sessionId?: string) => ({ id, updatedAt: at, sessionId });
const session = (id: string, at: string) => ({ id, createdAt: at });

test('splitSpaceEntries：任务与会话按时间倒序混排', () => {
  const split = splitSpaceEntries(
    [task('t1', '2026-11-10T10:00:00.000Z'), task('t2', '2026-11-12T10:00:00.000Z')],
    [session('s1', '2026-11-11T10:00:00.000Z'), session('s2', '2026-11-13T10:00:00.000Z')],
  );
  assert.deepEqual(
    split.inline.map((entry) => entry.id),
    ['s2', 't2', 's1', 't1'],
  );
  assert.deepEqual(
    split.inline.map((entry) => entry.kind),
    ['session', 'task', 'session', 'task'],
  );
});

test('splitSpaceEntries：同一时刻任务排在会话前面', () => {
  const at = '2026-11-10T10:00:00.000Z';
  const split = splitSpaceEntries([task('t1', at)], [session('s1', at)]);
  assert.deepEqual(
    split.inline.map((entry) => `${entry.kind}:${entry.id}`),
    ['task:t1', 'session:s1'],
  );
});

test('splitSpaceEntries：只有任务时保持原有「前 6 条 + 折叠」行为', () => {
  const tasks = Array.from({ length: 8 }, (_, index) =>
    task(`t${index}`, `2026-11-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`),
  );
  const split = splitSpaceEntries(tasks, [], 6);
  assert.equal(SPACE_INLINE_LIMIT, 6);
  assert.equal(split.inline.length, 6);
  assert.deepEqual(split.hiddenTaskIds, ['t6', 't7']);
  assert.deepEqual(split.hiddenSessionIds, []);
});

test('splitSpaceEntries：已接管的会话不再以会话身份出现', () => {
  const split = splitSpaceEntries(
    [task('t1', '2026-11-10T10:00:00.000Z', 's-adopted')],
    [session('s-adopted', '2026-11-12T10:00:00.000Z'), session('s-free', '2026-11-11T10:00:00.000Z')],
  );
  assert.deepEqual(
    split.inline.map((entry) => `${entry.kind}:${entry.id}`),
    ['session:s-free', 'task:t1'],
  );
  // 被接管的会话既不进内联，也不进「历史会话」剩余 —— 它以任务身份存在。
  assert.deepEqual(split.hiddenSessionIds, []);
});

test('splitSpaceEntries：溢出的会话进 hiddenSessionIds，溢出的任务进 hiddenTaskIds', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => task(`t${index}`, `2026-11-0${index + 1}T00:00:00.000Z`));
  const sessions = Array.from({ length: 4 }, (_, index) => session(`s${index}`, `2026-11-1${index}T00:00:00.000Z`));
  const split = splitSpaceEntries(tasks, sessions, 6);
  assert.equal(split.inline.length, 6);
  // 会话都在 11-10..11-13，比任务（11-01..11-04）新：4 条会话 + 最新的 2 个任务进内联。
  assert.deepEqual(
    split.inline.map((entry) => entry.id),
    ['s3', 's2', 's1', 's0', 't3', 't2'],
  );
  // 「还有 N 个任务」沿用任务自己的传入顺序（侧栏传的是时间倒序），不按合并序重排。
  assert.deepEqual(split.hiddenTaskIds, ['t0', 't1']);
  assert.deepEqual(split.hiddenSessionIds, []);
});

test('splitSpaceEntries：内联被任务占满时，会话全进 hiddenSessionIds', () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(`t${index}`, `2026-11-2${index}T00:00:00.000Z`));
  const split = splitSpaceEntries(tasks, [session('s1', '2026-11-01T00:00:00.000Z')], 6);
  assert.deepEqual(
    split.inline.map((entry) => entry.id),
    ['t5', 't4', 't3', 't2', 't1', 't0'],
  );
  assert.deepEqual(split.hiddenSessionIds, ['s1']);
});

test('splitSpaceEntries：空空间返回空结果而不是 undefined', () => {
  const split = splitSpaceEntries([], []);
  assert.deepEqual(split, { inline: [], hiddenTaskIds: [], hiddenSessionIds: [] });
});
