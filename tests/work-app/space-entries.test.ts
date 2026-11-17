import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPACE_INLINE_LIMIT,
  entryTimeOf,
  mergeSpaceEntries,
  splitSpaceEntries,
} from '../../packages/work-app/src/renderer/space-entries.js';

/**
 * 侧栏「空间」列表的唯一规则源。这些用例钉的是四件事：
 *   1. 任务与会话按时间混排，不按「任务优先」硬分组（用户的直觉是「我最近聊过什么」）；
 *   2. 已接管的会话不能再以会话身份重复出现；
 *   3. 没进内联的行全部归到「更多 (N)」的 overflow 一处 —— 侧栏不再有第二个折叠入口；
 *   4. 只有 running / waiting 能压过时间顺序。
 */

const task = (id: string, at: string, sessionId?: string, status = 'completed') => ({
  id,
  updatedAt: at,
  sessionId,
  status,
});
const session = (id: string, at: string, lastActiveAt?: string) => ({ id, createdAt: at, lastActiveAt });

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

test('splitSpaceEntries：只有任务时保持「前 6 条 + 更多」行为', () => {
  const tasks = Array.from({ length: 8 }, (_, index) =>
    task(`t${index}`, `2026-11-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`),
  );
  const split = splitSpaceEntries(tasks, [], 6);
  assert.equal(SPACE_INLINE_LIMIT, 6);
  assert.equal(split.inline.length, 6);
  assert.deepEqual(
    split.overflow.map((entry) => entry.id),
    ['t6', 't7'],
  );
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
  // 被接管的会话既不进内联，也不进「更多」—— 它以任务身份存在。
  assert.deepEqual(split.overflow, []);
});

test('splitSpaceEntries：溢出的任务与会话都进同一个 overflow，且顺序与内联同源', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => task(`t${index}`, `2026-11-0${index + 1}T00:00:00.000Z`));
  const sessions = Array.from({ length: 4 }, (_, index) => session(`s${index}`, `2026-11-1${index}T00:00:00.000Z`));
  const split = splitSpaceEntries(tasks, sessions, 6);
  assert.equal(split.inline.length, 6);
  // 会话都在 11-10..11-13，比任务（11-01..11-04）新：4 条会话 + 最新的 2 个任务进内联。
  assert.deepEqual(
    split.inline.map((entry) => entry.id),
    ['s3', 's2', 's1', 's0', 't3', 't2'],
  );
  // 剩下的两条任务按时间倒序收进 overflow —— 不再分「还有 N 个任务 / 历史会话」两处。
  assert.deepEqual(
    split.overflow.map((entry) => entry.id),
    ['t1', 't0'],
  );
  assert.deepEqual(
    split.overflow.map((entry) => entry.kind),
    ['task', 'task'],
  );
});

test('splitSpaceEntries：内联被任务占满时，会话全进 overflow', () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task(`t${index}`, `2026-11-2${index}T00:00:00.000Z`));
  const split = splitSpaceEntries(tasks, [session('s1', '2026-11-01T00:00:00.000Z')], 6);
  assert.deepEqual(
    split.inline.map((entry) => entry.id),
    ['t5', 't4', 't3', 't2', 't1', 't0'],
  );
  assert.deepEqual(
    split.overflow.map((entry) => entry.id),
    ['s1'],
  );
});

test('splitSpaceEntries：空空间返回空结果而不是 undefined', () => {
  const split = splitSpaceEntries([], []);
  assert.deepEqual(split, { inline: [], overflow: [] });
});

test('splitSpaceEntries：只有运行中/等待中的任务能压过时间顺序站到最前', () => {
  // 用户报过的 bug：点开一条两周前的历史会话看一眼，它就以 now 建任务并顶到最上面，
  // 正在跑的那个反被挤下去。置顶权现在只给 running / waiting。
  const split = splitSpaceEntries(
    [
      task('old-running', '2026-11-01T10:00:00.000Z', undefined, 'running'),
      task('fresh-done', '2026-11-13T10:00:00.000Z', undefined, 'completed'),
      task('waiting', '2026-11-02T10:00:00.000Z', undefined, 'waiting'),
    ],
    [session('newest-session', '2026-11-14T10:00:00.000Z')],
  );
  assert.deepEqual(
    split.inline.map((entry) => entry.id),
    // 两个活动任务先（内部仍按时间倒序），再是"最新"的完成态任务与会话
    ['waiting', 'old-running', 'newest-session', 'fresh-done'],
  );
  assert.deepEqual(
    split.inline.map((entry) => entry.active),
    [true, true, false, false],
  );
});

test('splitSpaceEntries：溢出的永远是终态条目 —— 活动任务不会被折叠进「更多」', () => {
  const tasks = [
    ...Array.from({ length: 7 }, (_, index) =>
      task(`done${index}`, `2026-11-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`, undefined, 'completed'),
    ),
    task('running-old', '2026-10-01T00:00:00.000Z', undefined, 'running'),
  ];
  const split = splitSpaceEntries(tasks, [], 6);
  assert.ok(
    split.inline.some((entry) => entry.id === 'running-old'),
    '运行中的任务必须在可见的 6 条里',
  );
  assert.ok(!split.overflow.some((entry) => entry.id === 'running-old'));
});

test('entryTimeOf：会话排序优先用最后活动时间，缺失时退回创建时间', () => {
  assert.equal(
    entryTimeOf({ createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: '2026-11-16T00:00:00.000Z' }),
    '2026-11-16T00:00:00.000Z',
  );
  assert.equal(entryTimeOf({ createdAt: '2026-11-01T00:00:00.000Z' }), '2026-11-01T00:00:00.000Z');
});

test('mergeSpaceEntries：按 lastActiveAt 排序 —— 三个月前建、昨天聊过的会话不该沉底', () => {
  const merged = mergeSpaceEntries(
    [task('t1', '2026-11-10T00:00:00.000Z')],
    [
      session('stale', '2026-08-01T00:00:00.000Z'),
      session('recently-active', '2026-08-01T00:00:00.000Z', '2026-11-16T00:00:00.000Z'),
    ],
  );
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['recently-active', 't1', 'stale'],
  );
});
