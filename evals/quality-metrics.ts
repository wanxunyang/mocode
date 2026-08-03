// Quality-metrics regression checks retained after removing the completion gate.
process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { reduceTraceMetrics } = await import('../src/session/trace-metrics.js');
const { createReport, renderSummary } = await import('./coding/report.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const event = (type: 'tool_call_end' | 'retry_reflection' | 'ask_human_call', data: Record<string, unknown>) => ({
  schemaVersion: 1 as const,
  eventId: 'e', ts: '0', sessionId: 's', turnId: 0, type, data,
});
const toolResult = (content: string) => ({ role: 'tool' as const, tool_call_id: 'c', content });

const fallback = reduceTraceMetrics([], [
  toolResult('[retry reflection: CONFLICT]\nhint'),
  toolResult('[retry reflection: INVALID_ARGUMENTS]\nhint'),
]);
assert(fallback.reflectionRounds === 2, 'reflection fallback must scan history');
assert(fallback.askHumanCount === 0, 'ask_human defaults to zero');

const hard = reduceTraceMetrics([
  event('retry_reflection', { category: 'CONFLICT' }),
  event('ask_human_call', { status: 'success' }),
  event('tool_call_end', { name: 'ask_human', status: 'success' }),
], []);
assert(hard.reflectionRounds === 1, 'hard reflection event must be counted');
assert(hard.askHumanCount === 1, 'hard ask event must take precedence over legacy tool event');

const tasks = [{
  id: 'a', title: 'a', group: 'tests' as const, difficulty: 'basic' as const,
  status: 'passed' as const, finalVerifiedSuccess: true, regression: false,
  toolRecovery: false, toolCalls: 1, tokens: 1, durationMs: 1, changedFiles: [],
  reflectionRounds: 2, askHumanCount: 1,
}];
const report = createReport({ schemaVersion: 2, runId: 'r', generatedAt: 'now', model: 'm', promptHash: 'h', selection: 'all' }, tasks);
assert(report.summary.reflectionRounds === 2, 'report reflection average');
assert(report.summary.askHumanCount === 1, 'report ask average');
assert(renderSummary(report).includes('Quality dimensions'), 'summary quality section');

console.log('quality-metrics regression checks passed');