/**
 * 用量聚合的**两份实现**必须同口径：core（src/session/global-usage.ts）负责写账本 + 终端 /usage，
 * work-app（packages/work-app/src/usage.ts）负责 GUI 面板在主进程就地算完 —— 后者是为了
 * 「没开工作区也能看总量」，代价是聚合逻辑复制了一份。
 *
 * 这份测试就是那份代价的护栏：任何一边改了聚合口径（字段、补零天、排序、phase 拆分）都会在这里红。
 * 只比纯函数，不碰真实 ~/.mocode/usage-daily.jsonl。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localDay as coreLocalDay,
  summarizeGlobalUsage as coreSummarize,
  type GlobalUsageRecord as CoreRecord,
} from '../../src/session/global-usage.js';
import {
  localDay as workLocalDay,
  summarizeGlobalUsage as workSummarize,
  type GlobalUsageRecord as WorkRecord,
} from '../../packages/work-app/src/usage.js';

/** 相对今天第 offset 天（负 = 过去）。两位实现都按本地日期归集，所以这里也用本地时间算。 */
function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return coreLocalDay(d);
}

function records(): CoreRecord[] {
  const rows: Array<Partial<CoreRecord> & { day: string }> = [
    {
      day: dayOffset(0),
      workspace: 'F:/a',
      model: 'm1',
      sessionId: 's1',
      input: 100,
      output: 10,
      cached: 40,
      reasoning: 5,
    },
    { day: dayOffset(0), workspace: 'F:/a', model: 'm2', sessionId: 's1', input: 200, output: 20, phase: 'compact' },
    {
      day: dayOffset(-1),
      workspace: 'F:/b',
      model: 'm1',
      sessionId: 's2',
      input: 50,
      output: 5,
      cached: 10,
      cacheCreation: 7,
    },
    // 窗口外：7 天视图不该算进来
    { day: dayOffset(-30), workspace: 'F:/c', model: 'm9', sessionId: 's3', input: 999, output: 99 },
  ];
  return rows.map((row) => ({
    ts: `${row.day}T00:00:00.000Z`,
    day: row.day,
    workspace: row.workspace ?? 'F:/a',
    model: row.model ?? 'm1',
    phase: row.phase ?? 'main',
    sessionId: row.sessionId ?? 's1',
    input: row.input ?? 0,
    output: row.output ?? 0,
    cached: row.cached ?? 0,
    reasoning: row.reasoning ?? 0,
    cacheCreation: row.cacheCreation ?? 0,
  }));
}

test('work-app 的用量聚合与 core 逐字段一致（7 / 30 天两个窗口）', () => {
  assert.equal(workLocalDay(new Date(2026, 10, 3, 12)), coreLocalDay(new Date(2026, 10, 3, 12)));
  const core = records();
  const work = core as unknown as WorkRecord[];
  for (const days of [7, 30]) {
    assert.deepEqual(workSummarize(work, days), coreSummarize(core, days), `days=${days}`);
  }
});

test('窗口外记录不计入，窗口内缺天数补零', () => {
  const summary = workSummarize(records() as unknown as WorkRecord[], 7);
  assert.equal(summary.total.calls, 3);
  assert.equal(summary.total.input, 350);
  assert.equal(summary.byDay.length, 7);
  // 只有今天 / 昨天两天有量，其余 5 天是零行
  assert.equal(summary.byDay.filter((row) => row.calls === 0).length, 5);
  assert.equal(summary.workspaceCount, 2);
  // main / compact 拆分
  assert.equal(summary.compact.calls, 1);
  assert.equal(summary.main.calls, 2);
});

test('旧账本缺 cached/reasoning 字段不产生 NaN', () => {
  const legacy = [
    { ts: '', day: dayOffset(0), workspace: 'F:/x', model: 'm', phase: 'main', input: 10, output: 2 },
  ] as unknown as WorkRecord[];
  const summary = workSummarize(legacy, 1);
  assert.equal(summary.total.cached, 0);
  assert.equal(summary.total.reasoning, 0);
  assert.equal(summary.total.input, 10);
});
