import test from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEY_DRIFT_MS, planSortKeyRepair } from '../../packages/work-app/src/task-order.js';

/**
 * 侧栏排序键对账规则。
 *
 * 钉的是用户报过的那个 bug：接管历史会话时把任务 `updatedAt` 写成 now，只是看一眼
 * 就把几周前的旧会话顶到正在跑的任务上面。规则必须只改「明显写坏」的终态任务，
 * 且绝不碰运行中 / 等人 / 排队的任务（它们的 updatedAt 是刚刚发生的真实事件）。
 */

const task = (id: string, status: string, updatedAt: string, sessionId: string | undefined = `s-${id}`) => ({
  id,
  status,
  updatedAt,
  sessionId,
});

/** 把「磁盘证据」做成查表：不在表里的返回 null（没有证据）。 */
const evidence = (table: Record<string, string>) => (item: { id: string }) => table[item.id] ?? null;

test('planSortKeyRepair：updatedAt 明显晚于会话最后活动时间时回退成 mtime', () => {
  const repairs = planSortKeyRepair(
    [task('t1', 'completed', '2026-11-17T06:35:22.879Z')],
    evidence({ t1: '2026-11-05T02:54:24.605Z' }),
  );
  assert.deepEqual(repairs, [{ taskId: 't1', from: '2026-11-17T06:35:22.879Z', to: '2026-11-05T02:54:24.605Z' }]);
});

test('planSortKeyRepair：正常漂移（写盘比发言晚 / 只差几分钟）不改', () => {
  // host 写盘通常晚于用户发消息，updatedAt 早于 mtime —— 绝不能把这当成"写坏"往回拨。
  const later = planSortKeyRepair(
    [task('t1', 'completed', '2026-11-16T08:19:11.266Z')],
    evidence({ t1: '2026-11-16T08:41:48.099Z' }),
  );
  assert.deepEqual(later, []);
  // 一小时内的小幅漂移也容忍：消息排队 + host 冷启动会让两者差出几分钟。
  const small = planSortKeyRepair(
    [task('t2', 'completed', '2026-11-16T10:00:00.000Z')],
    evidence({ t2: '2026-11-16T09:30:00.000Z' }),
  );
  assert.deepEqual(small, []);
  assert.equal(SORT_KEY_DRIFT_MS, 60 * 60 * 1000);
});

test('planSortKeyRepair：运行中 / 等人 / 排队的任务一律不动', () => {
  const stale = '2026-11-01T00:00:00.000Z';
  const repairs = planSortKeyRepair(
    [
      task('running', 'running', '2026-11-17T06:35:22.879Z'),
      task('waiting', 'waiting', '2026-11-17T06:35:22.879Z'),
      task('queued', 'queued', '2026-11-17T06:35:22.879Z'),
    ],
    evidence({ running: stale, waiting: stale, queued: stale }),
  );
  assert.deepEqual(repairs, []);
});

test('planSortKeyRepair：没有会话、没有磁盘证据、时间串坏掉的一律跳过（无证据不动数据）', () => {
  const repairs = planSortKeyRepair(
    [
      task('no-session', 'completed', '2026-11-17T06:35:22.879Z', undefined),
      task('no-evidence', 'completed', '2026-11-17T06:35:22.879Z'),
      task('broken', 'completed', 'not-a-date'),
    ],
    evidence({ broken: '2026-11-01T00:00:00.000Z' }),
  );
  assert.deepEqual(repairs, []);
});

test('planSortKeyRepair：成批写坏的同一亚秒窗口被逐条纠正', () => {
  // 真机数据：四条 11 月初的老任务 updatedAt 全落在同一秒内。
  const repairs = planSortKeyRepair(
    [
      task('a', 'completed', '2026-11-17T06:35:22.879Z'),
      task('b', 'completed', '2026-11-17T06:35:22.146Z'),
      task('c', 'completed', '2026-11-17T06:35:21.559Z'),
      task('d', 'completed', '2026-11-17T06:35:20.538Z'),
    ],
    evidence({
      a: '2026-11-05T02:54:24.605Z',
      b: '2026-11-09T10:51:47.552Z',
      c: '2026-11-11T10:15:23.284Z',
      d: '2026-11-16T03:01:25.779Z',
    }),
  );
  assert.equal(repairs.length, 4);
  assert.deepEqual(
    repairs.map((item) => item.to),
    ['2026-11-05T02:54:24.605Z', '2026-11-09T10:51:47.552Z', '2026-11-11T10:15:23.284Z', '2026-11-16T03:01:25.779Z'],
  );
});
