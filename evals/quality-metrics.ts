// QUAL-01 fixture: 质量指标 reducer + BenchmarkReport 集成。
//
// 断言:
// 1. reduceTraceMetrics 返回的 TraceMetrics 含 3 个新维度,默认 0。
// 2. reflectionRounds 从 history 文本中 [retry reflection: 计数。
// 3. checklistTriggered 从 history 文本中 [checklist] 计数。
// 4. askHumanCount 从 events 的 tool_call_end (name === 'ask_human', status === 'success') 计数。
// 5. BenchmarkTaskResult 必填 3 个新字段 (types.ts 编译期保证,fixture 端用 mock 验证)。
// 6. createReport 算 3 个新均值 (per task),空 tasks 时 fallback 0。
// 7. renderSummary 包含 "Quality dimensions" 小节 + 3 个均值行 + 表格新增 3 列。
// 8. fallback: history 缺失时 reflectionRounds / checklistTriggered = 0(不抛错,不返回 NaN)。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { reduceTraceMetrics } = await import('../src/session/trace-metrics.js');
const { createReport, renderSummary } = await import('../evals/coding/report.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const textMessage = (role: 'user' | 'assistant', text: string) => ({
  role, content: text,
});

const fakeToolResult = (text: string) => ({
  role: 'tool' as const, content: text, tool_call_id: 'call_x',
});

const fakeEvent = (data: { name: string; status: string }) => ({
  schemaVersion: 1 as const, eventId: 'e', ts: '0', sessionId: 's', turnId: 0, type: 'tool_call_end' as const, data,
});

// 1. reduceTraceMetrics 返回结构含 3 个新字段。
{
  const metrics = reduceTraceMetrics([], undefined);
  assert(typeof metrics.reflectionRounds === 'number', 'reflectionRounds must be number');
  assert(typeof metrics.askHumanCount === 'number', 'askHumanCount must be number');
  assert(typeof metrics.checklistTriggered === 'number', 'checklistTriggered must be number');
  assert(metrics.reflectionRounds === 0, 'reflectionRounds default 0');
  assert(metrics.askHumanCount === 0, 'askHumanCount default 0');
  assert(metrics.checklistTriggered === 0, 'checklistTriggered default 0');
}

// 2. reflectionRounds 从 history 文本中 [retry reflection: 计数。
{
  const history = [
    textMessage('user', 'fix the bug'),
    textMessage('assistant', ''),
    fakeToolResult('[retry reflection: TRANSIENT_TIMEOUT]\nA hint'),
    textMessage('assistant', ''),
    fakeToolResult('[retry reflection: INVALID_ARGUMENTS]\nB hint'),
    fakeToolResult('[retry reflection: CONFLICT]\nC hint'),
    fakeToolResult('no marker here'),
  ];
  const metrics = reduceTraceMetrics([], history);
  assert(metrics.reflectionRounds === 3, `reflectionRounds must be 3, got ${metrics.reflectionRounds}`);
  assert(metrics.checklistTriggered === 0, 'no [checklist] in history, count 0');
  assert(metrics.askHumanCount === 0, 'no ask_human events, count 0');
}

// 3. checklistTriggered 从 history 文本中 [checklist] 计数。
{
  const history = [
    textMessage('user', '[checklist] pre-completion checklist'),
    textMessage('assistant', ''),
    textMessage('user', '[checklist] another one (after fix)'),
  ];
  const metrics = reduceTraceMetrics([], history);
  assert(metrics.checklistTriggered === 2, `checklistTriggered must be 2, got ${metrics.checklistTriggered}`);
  assert(metrics.reflectionRounds === 0, 'no [retry reflection:] in history, count 0');
}

// 4. askHumanCount 从 events 推断(只算 success 状态的 ask_human 工具调用)。
{
  const events = [
    fakeEvent({ name: 'ask_human', status: 'success' }),
    fakeEvent({ name: 'ask_human', status: 'success' }),
    fakeEvent({ name: 'edit_file', status: 'success' }),
    fakeEvent({ name: 'ask_human', status: 'error' }), // 失败不计入
    fakeEvent({ name: 'ask_human', status: 'denied' }), // denied 不计入
  ];
  const metrics = reduceTraceMetrics(events, []);
  assert(metrics.askHumanCount === 2, `askHumanCount must be 2 (only successes), got ${metrics.askHumanCount}`);
  assert(metrics.reflectionRounds === 0, 'no history, count 0');
  assert(metrics.checklistTriggered === 0, 'no history, count 0');
}

// 5. 综合: history + events 同时注入,三者正交累加。
{
  const history = [
    textMessage('user', '[checklist] gate 1'),
    fakeToolResult('[retry reflection: CONFLICT]\nA'),
    fakeToolResult('[retry reflection: CONFLICT]\nB'),
  ];
  const events = [
    fakeEvent({ name: 'ask_human', status: 'success' }),
    fakeEvent({ name: 'read_file', status: 'success' }),
  ];
  const metrics = reduceTraceMetrics(events, history);
  assert(metrics.reflectionRounds === 2, `reflect 2, got ${metrics.reflectionRounds}`);
  assert(metrics.checklistTriggered === 1, `checklist 1, got ${metrics.checklistTriggered}`);
  assert(metrics.askHumanCount === 1, `ask 1, got ${metrics.askHumanCount}`);
}

// 6. fallback: history 缺失 / undefined / null 都不抛错,全部 fallback 0。
{
  const m1 = reduceTraceMetrics([], undefined);
  const m2 = reduceTraceMetrics([], []);
  assert(m1.reflectionRounds === 0 && m1.checklistTriggered === 0 && m1.askHumanCount === 0,
    'undefined history must fallback 0');
  assert(m2.reflectionRounds === 0 && m2.checklistTriggered === 0 && m2.askHumanCount === 0,
    'empty history must fallback 0');
}

// 7. createReport 算 3 个新均值,空 tasks 时 fallback 0。
{
  const empty = createReport({ schemaVersion: 2, runId: 'r', generatedAt: 'now', model: 'm', promptHash: 'h', selection: 'all' }, []);
  assert(empty.summary.reflectionRounds === 0, 'empty tasks → 0 mean');
  assert(empty.summary.askHumanCount === 0, 'empty tasks → 0 mean');
  assert(empty.summary.checklistTriggered === 0, 'empty tasks → 0 mean');
  // 含 2 个 task:reflectionRounds = (1 + 3)/2 = 2,askHumanCount = (2 + 0)/2 = 1,checklist = (0 + 1)/2 = 0.5
  const tasks = [
    {
      id: 'a', title: 'a', group: 'tests' as const, difficulty: 'basic' as const, status: 'passed' as const,
      finalVerifiedSuccess: true, firstPatchPass: true, regression: false, toolRecovery: false,
      toolCalls: 5, tokens: 100, durationMs: 1000, unverifiedCompletion: false, changedFiles: [],
      reflectionRounds: 1, askHumanCount: 2, checklistTriggered: 0,
    },
    {
      id: 'b', title: 'b', group: 'tests' as const, difficulty: 'hard' as const, status: 'failed' as const,
      finalVerifiedSuccess: false, firstPatchPass: false, regression: false, toolRecovery: false,
      toolCalls: 8, tokens: 200, durationMs: 2000, unverifiedCompletion: false, changedFiles: [],
      reflectionRounds: 3, askHumanCount: 0, checklistTriggered: 1,
    },
  ];
  const report = createReport({ schemaVersion: 2, runId: 'r', generatedAt: 'now', model: 'm', promptHash: 'h', selection: 'all' }, tasks);
  assert(report.summary.reflectionRounds === 2, `mean reflectionRounds = 2, got ${report.summary.reflectionRounds}`);
  assert(report.summary.askHumanCount === 1, `mean askHumanCount = 1, got ${report.summary.askHumanCount}`);
  assert(report.summary.checklistTriggered === 0.5, `mean checklistTriggered = 0.5, got ${report.summary.checklistTriggered}`);
}

// 8. renderSummary 包含 "Quality dimensions" 小节 + 3 个均值行 + 表格新增 3 列。
{
  const tasks = [{
    id: 'a', title: 'a', group: 'tests' as const, difficulty: 'basic' as const, status: 'passed' as const,
    finalVerifiedSuccess: true, firstPatchPass: true, regression: false, toolRecovery: false,
    toolCalls: 1, tokens: 1, durationMs: 1, unverifiedCompletion: false, changedFiles: [],
    reflectionRounds: 2, askHumanCount: 1, checklistTriggered: 1,
  }];
  const report = createReport({ schemaVersion: 2, runId: 'r', generatedAt: 'now', model: 'm', promptHash: 'h', selection: 'all' }, tasks);
  const text = renderSummary(report);
  assert(text.includes('Quality dimensions (per task average)'),
    'renderSummary must include "Quality dimensions" header');
  assert(text.includes('Reflection rounds:'),
    'renderSummary must include reflection rounds line');
  assert(text.includes('Ask-human calls:'),
    'renderSummary must include ask-human calls line');
  assert(text.includes('Checklist triggered:'),
    'renderSummary must include checklist triggered line');
  // 表格新增 3 列:Reflect / AskH / ChkL
  assert(text.includes('| Reflect |') && text.includes('| AskH |') && text.includes('| ChkL |'),
    'renderSummary table must include 3 new columns');
}

console.log('quality-metrics regression checks passed');
