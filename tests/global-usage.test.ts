import test from 'node:test';
import assert from 'node:assert/strict';
import { localDay, summarizeGlobalUsage, windowStart, type GlobalUsageRecord } from '../src/session/global-usage.js';

function rec(partial: Partial<GlobalUsageRecord> & { day: string }): GlobalUsageRecord {
  return {
    ts: `${partial.day}T00:00:00.000Z`,
    workspace: partial.workspace ?? 'F:/proj-a',
    model: partial.model ?? 'model-x',
    phase: partial.phase ?? 'main',
    sessionId: partial.sessionId ?? 's1',
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    cached: partial.cached ?? 0,
    reasoning: partial.reasoning ?? 0,
    cacheCreation: partial.cacheCreation ?? 0,
    day: partial.day,
  };
}

test('global-usage: localDay 输出本地 YYYY-MM-DD', () => {
  assert.match(localDay(new Date(2026, 10, 3, 12)), /^2026-11-03$/);
});

test('global-usage: windowStart 含今天在内往前 N 天', () => {
  const today = new Date(2026, 10, 10); // 本地 2026-11-10
  assert.equal(windowStart(7, today), '2026-11-04');
  assert.equal(windowStart(1, today), '2026-11-10');
});

test('global-usage: 按天/工作区/模型/phase 聚合并补零天', () => {
  const today = localDay();
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return localDay(d);
  })();
  const threeDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    return localDay(d);
  })();
  const records: GlobalUsageRecord[] = [
    rec({
      day: today,
      input: 100,
      output: 20,
      cached: 80,
      reasoning: 5,
      workspace: 'F:/a',
      model: 'm1',
      sessionId: 'a1',
    }),
    rec({ day: today, input: 50, output: 10, cached: 0, workspace: 'F:/a', model: 'm2', sessionId: 'a2' }),
    rec({
      day: today,
      input: 200,
      output: 30,
      cached: 100,
      workspace: 'F:/b',
      model: 'm1',
      sessionId: 'b1',
      phase: 'compact',
    }),
    rec({ day: threeDaysAgo, input: 999, output: 999, workspace: 'F:/old', model: 'm1' }),
  ];

  const s = summarizeGlobalUsage(records, 2);
  assert.equal(s.days, 2);
  assert.equal(s.total.input, 350, '窗口外(3 天前)记录不计入');
  assert.equal(s.total.output, 60);
  assert.equal(s.total.calls, 3);
  assert.equal(s.total.cached, 180);
  assert.equal(s.workspaceCount, 2);
  assert.equal(s.sessionCount, 3);

  // byDay 补齐两天,顺序为昨天→今天
  assert.equal(s.byDay.length, 2);
  assert.equal(s.byDay[0].day, yesterday);
  assert.equal(s.byDay[0].input, 0, '零用量日补 0');
  assert.equal(s.byDay[1].day, today);
  assert.equal(s.byDay[1].input, 350);
  assert.equal(s.byDay[1].sessions, 3);

  // 工作区按 input+output 降序
  assert.deepEqual(
    s.byWorkspace.map((r) => r.key),
    ['F:/b', 'F:/a'],
  );
  assert.equal(s.byWorkspace[0].calls, 1);
  assert.equal(s.byWorkspace[0].sessions, 1);

  // 模型分组
  const m1 = s.byModel.find((r) => r.key === 'm1')!;
  assert.equal(m1.input, 300);
  assert.equal(m1.sessions, 2, 'm1 跨 a1/b1 两个会话');

  // phase 拆分:compact 那条单列
  assert.equal(s.compact.input, 200);
  assert.equal(s.main.input, 150);
});

test('global-usage: 7 天默认窗口补齐 7 行且空数据不报错', () => {
  const s = summarizeGlobalUsage([], 7);
  assert.equal(s.byDay.length, 7);
  assert.equal(s.total.calls, 0);
  assert.equal(s.workspaceCount, 0);
});
