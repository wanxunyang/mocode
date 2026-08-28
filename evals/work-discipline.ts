// Advisory work-discipline regression checks. No LLM calls.
process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { config, buildBasePrompt, buildMocodeCorePrompt } = await import('../src/config/index.js');
const { buildWorkDisciplineSection, inferModelFamily } = await import('../src/agent/work-discipline.js');
const { buildValidationCommandsSection } = await import('../src/verification/prompt.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

// ── advisory discipline section ───────────────────────────────────────────────
const section = buildWorkDisciplineSection();
assert(section.includes('Use your judgment'), 'discipline must delegate strategy to the agent');
assert(section.includes('Validation is optional, not a completion gate'), 'validation must be optional');
assert(section.includes('do not run broad test/build suites by default'), 'broad checks must not be automatic');
assert(section.includes('## When to ask instead of guess'), 'ask whitelist must stay in the discipline section');
assert(!section.includes('MUST complete'), 'discipline must not force phases');
assert(!section.includes('hard prerequisite'), 'discipline must not impose a verification gate');

for (const family of ['anthropic', 'openai', 'qwen', 'other'] as const) {
  assert(buildWorkDisciplineSection(family) === section, `${family} must receive the same advisory guidance`);
}
assert(inferModelFamily('claude-3-5-sonnet') === 'anthropic', 'claude family');
assert(inferModelFamily('gpt-4o') === 'openai', 'gpt family');
assert(inferModelFamily('qwen2.5-coder') === 'qwen', 'qwen family');
assert(inferModelFamily('llama-3.1') === 'other', 'fallback family');

// ── prompt assembly ──────────────────────────────────────────────────────────
const prompt = buildBasePrompt();
const workflowIdx = prompt.indexOf('## Workflow');
const principlesIdx = prompt.indexOf('## Engineering principles');
assert(workflowIdx > 0 && principlesIdx > workflowIdx, 'engineering principles must follow the workflow');
assert(prompt.includes(section), 'base prompt must embed the advisory discipline verbatim');
assert(
  prompt.includes('Verify: decide whether validation is useful by risk and scope'),
  'workflow must preserve agent choice over validation',
);

// ── discovered validation commands (deterministic project profile) ───────────
const validation = buildValidationCommandsSection();
assert(validation.includes('## Validation commands'), 'repository profile must yield a validation section');
assert(validation.includes('npm run typecheck'), 'root typecheck script must be discovered');
assert(validation.includes('Not a completion gate.'), 'validation map must stay advisory');
assert(
  validation.indexOf('npm run typecheck') < validation.indexOf('npm run test'),
  'commands must be listed in increasing cost order',
);
assert(prompt.includes(validation.trim()), 'base prompt must inject the discovered validation commands');
assert(
  buildValidationCommandsSection(`${process.cwd()}/does-not-exist-${Date.now()}`) === '',
  'unknown roots must degrade to an empty section',
);

// ── sub-agent core slice ─────────────────────────────────────────────────────
const core = buildMocodeCorePrompt();
assert(core.includes(section), 'sub-agent core must retain the advisory discipline');
assert(core.includes('## Validation commands'), 'sub-agent core must retain the validation map');
assert(!core.includes('## Project context'), 'sub-agent core must strip dynamic context');
assert(core.includes('## Reporting'), 'core must retain reporting rules');

const originalModel = config.model;
config.model = 'gpt-4o-mini';
assert(buildBasePrompt().includes('Validation is optional'), 'runtime prompt must remain advisory');
config.model = originalModel;

console.log('work-discipline regression checks passed');
