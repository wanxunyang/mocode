// Quality-metrics regression checks retained after removing strategy injections.
process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { reduceTraceMetrics } = await import('../src/session/trace-metrics.js');
const { createReport, renderSummary } = await import('./coding/report.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const event = (type: 'tool_call_end' | 'ask_human_call', data: Record<string, unknown>, step?: number) => ({
  schemaVersion: 1 as const,
  eventId: 'e',
  ts: '0',
  sessionId: 's',
  turnId: 0,
  type,
  ...(step === undefined ? {} : { step }),
  data,
});

const sameBatch = reduceTraceMetrics([
  event('tool_call_end', { tool: 'edit_file', status: 'error' }, 0),
  event('tool_call_end', { tool: 'edit_file', status: 'success' }, 0),
]);
assert(!sameBatch.toolRecovery, 'same-step parallel completion order must not count as recovery');

const metrics = reduceTraceMetrics([
  event('ask_human_call', { status: 'success' }),
  event('tool_call_end', { tool: 'edit_file', status: 'error' }, 0),
  event('tool_call_end', { tool: 'read_file', status: 'success' }, 0),
  event('tool_call_end', { tool: 'edit_file', status: 'success' }, 1),
]);
assert(metrics.askHumanCount === 1, 'structured ask_human event must be counted once');
assert(metrics.toolRecovery, 'the same tool succeeding in a later model step must count as recovery');
assert(metrics.toolRecoveryAttempts === 1, 'one distinct failed tool must create one recovery opportunity');
assert(metrics.toolRecoveries === 1, 'one distinct failed tool recovered');
assert(!('toolRetries' in metrics), 'tool retry metric must be absent');

const tasks = [
  {
    id: 'a',
    title: 'a',
    group: 'tests' as const,
    difficulty: 'basic' as const,
    status: 'passed' as const,
    finalVerifiedSuccess: true,
    firstPatchPass: true,
    regression: false,
    toolRecovery: true,
    toolRecoveryAttempts: 1,
    toolRecoveries: 1,
    toolCalls: 3,
    tokens: 1,
    durationMs: 1,
    changedFiles: [],
    askHumanCount: 1,
  },
];
const report = createReport(
  { schemaVersion: 3, runId: 'r', generatedAt: 'now', model: 'm', promptHash: 'h', selection: 'all' },
  tasks,
);
assert(report.summary.askHumanCount === 1, 'report ask average');
assert(report.summary.firstPatchPassRate === 1, 'report first-patch rate');
assert(report.summary.toolRecoveryRate === 1, 'report same-tool recovery rate');
assert(renderSummary(report).includes('Quality dimensions'), 'summary quality section');

console.log('quality-metrics regression checks passed');
