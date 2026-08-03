// Quality-metrics regression checks retained after removing strategy injections.
process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { reduceTraceMetrics } = await import('../src/session/trace-metrics.js');
const { createReport, renderSummary } = await import('./coding/report.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const event = (type: 'tool_call_end' | 'ask_human_call', data: Record<string, unknown>) => ({
  schemaVersion: 1 as const,
  eventId: 'e', ts: '0', sessionId: 's', turnId: 0, type, data,
});

const metrics = reduceTraceMetrics([
  event('ask_human_call', { status: 'success' }),
  event('tool_call_end', { tool: 'ask_human', status: 'success' }),
]);
assert(metrics.askHumanCount === 1, 'structured ask_human event must be counted once');
assert(!('toolRetries' in metrics), 'tool retry metric must be absent');

const tasks = [{
  id: 'a', title: 'a', group: 'tests' as const, difficulty: 'basic' as const,
  status: 'passed' as const, finalVerifiedSuccess: true, regression: false,
  toolRecovery: false, toolCalls: 1, tokens: 1, durationMs: 1, changedFiles: [],
  askHumanCount: 1,
}];
const report = createReport({ schemaVersion: 2, runId: 'r', generatedAt: 'now', model: 'm', promptHash: 'h', selection: 'all' }, tasks);
assert(report.summary.askHumanCount === 1, 'report ask average');
assert(renderSummary(report).includes('Quality dimensions'), 'summary quality section');

console.log('quality-metrics regression checks passed');