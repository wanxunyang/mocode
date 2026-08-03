// Advisory work-discipline regression checks. No LLM calls.
process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { config, buildBasePrompt, buildMocodeCorePrompt } = await import('../src/config/index.js');
const { buildWorkDisciplineSection, inferModelFamily } = await import('../src/agent/work-discipline.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const section = buildWorkDisciplineSection();
assert(section.includes('## Working discipline — coding tasks'), 'missing discipline title');
assert(section.includes('Use your judgment'), 'discipline must delegate strategy to the agent');
assert(section.includes('Validation is optional, not a completion gate'), 'validation must be optional');
assert(section.includes('do not run broad test/build suites by default'), 'broad checks must not be automatic');
assert(!section.includes('MUST complete'), 'discipline must not force phases');
assert(!section.includes('hard prerequisite'), 'discipline must not impose a verification gate');

for (const family of ['anthropic', 'openai', 'qwen', 'other'] as const) {
  assert(buildWorkDisciplineSection(family) === section, `${family} must receive the same advisory guidance`);
}
assert(inferModelFamily('claude-3-5-sonnet') === 'anthropic', 'claude family');
assert(inferModelFamily('gpt-4o') === 'openai', 'gpt family');
assert(inferModelFamily('qwen2.5-coder') === 'qwen', 'qwen family');
assert(inferModelFamily('llama-3.1') === 'other', 'fallback family');

const prompt = buildBasePrompt();
const disciplineIdx = prompt.indexOf('## Working discipline — coding tasks');
const workflowIdx = prompt.indexOf('## Workflow');
assert(disciplineIdx > 0 && workflowIdx > disciplineIdx, 'discipline must precede workflow');
assert(prompt.includes('Decide for yourself whether a check is worth running'), 'workflow must preserve agent choice');

const core = buildMocodeCorePrompt();
assert(core.includes('## Working discipline — coding tasks'), 'sub-agent core must retain guidance');
assert(!core.includes('## Project context (dynamic reference)'), 'sub-agent core must strip dynamic context');
assert(core.includes('## Termination & Reporting'), 'core must retain reporting rules');

const originalModel = config.model;
config.model = 'gpt-4o-mini';
assert(buildBasePrompt().includes('Validation is optional'), 'runtime prompt must remain advisory');
config.model = originalModel;

console.log('work-discipline regression checks passed');