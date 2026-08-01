// PROMPT-01 fixture: 单元级断言 Build-and-Self-Verify 纪律段在
// buildBasePrompt 里的可见性,以及 per-model 措辞切换;同时也断言
// buildMocodeCorePrompt 仍然能正确切到 ## Project context 切片。
//
// 性质:无 LLM 调用,纯字符串/import 探针;走 buildBasePrompt 的
// "现拼现读"路径(config 单例 + model getter),与 agent 运行时一致。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { config } = await import('../src/config/index.js');
const {
  buildBasePrompt,
  buildMocodeCorePrompt,
} = await import('../src/config/index.js');
const {
  buildWorkDisciplineSection,
  inferModelFamily,
} = await import('../src/agent/work-discipline.js');
/** @typedef {'anthropic'|'openai'|'qwen'|'other'} ModelFamily */
/** @type {ModelFamily[]} */
const ModelFamilies = ['anthropic', 'openai', 'qwen', 'other'];

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const PHASE_HEADERS = [
  '### Phase 1 — Plan & Discover',
  '### Phase 2 — Build',
  '### Phase 3 — Verify',
  '### Phase 4 — Fix',
];

const HARD_RULE_NEEDLE = '"I read the code and it looks right" is not a completion signal';

// 1. 纪律段函数自身:四个 phase、反面规则、注入标题全在英文严谨版里。
{
  const section = buildWorkDisciplineSection('other');
  for (const header of PHASE_HEADERS) {
    assert(section.includes(header), `core section missing phase: ${header}`);
  }
  assert(section.includes(HARD_RULE_NEEDLE), 'core section missing hard rule');
  assert(section.includes('## Working discipline — coding tasks (Build-and-Self-Verify)'),
    'core section missing section title');
}

// 2. per-model 切换:anthropic / openai / qwen 都拼出独立开场句,但 4 份
//    共享同一套 4 阶段结构(无语种漂移)。标题行对 4 份必须**完全相同**——
//    per-model 差异只体现在开场句上(不再往标题注入 "[model: X]" 标签,
//    那对模型是无意义噪声)。
{
  const families: Array<'anthropic' | 'openai' | 'qwen' | 'other'> = ['anthropic', 'openai', 'qwen', 'other'];
  const openers = new Set<string>();
  const firstLines = new Set<string>();
  for (const f of families) {
    const s = buildWorkDisciplineSection(f);
    assert(s.includes('## Working discipline — coding tasks (Build-and-Self-Verify)'),
      `${f} section dropped base title`);
    for (const header of PHASE_HEADERS) {
      assert(s.includes(header), `${f} section missing shared phase: ${header}`);
    }
    assert(s.includes(HARD_RULE_NEEDLE), `${f} section missing shared hard rule`);
    assert(!s.includes(`[model: ${f}]`), `${f} section must NOT self-tag the model family`);
    const lines = s.split('\n');
    firstLines.add(lines[0] ?? '');
    // 开场句 = 标题后的第一段非空行(adapt 只替换这一句)。
    openers.add(lines.find((line, i) => i > 0 && line.trim().length > 0) ?? '');
  }
  // 标题行 4 份完全一致(前缀缓存友好 + 无自我指涉噪声)。
  assert(firstLines.size === 1,
    `title line must be identical across families, got: ${[...firstLines].join(' | ')}`);
  // 开场句 4 份各不相同,证明 per-model 适配起效。
  assert(openers.size === families.length,
    `per-model opener should differ across all ${families.length} families, got: ${[...openers].join(' | ')}`);
  assert(buildWorkDisciplineSection('anthropic').includes('not a courtesy'),
    'anthropic opener missing');
  assert(buildWorkDisciplineSection('openai').includes('MUST complete these four phases in order'),
    'openai opener missing');
  assert(buildWorkDisciplineSection('qwen').includes('"I wrote the code" is not evidence the code works'),
    'qwen opener missing');
}

// 2b. NARRATION-01 配套:Phase 1 的复述规则必须是**条件式**(仅歧义时复述),
//     且显式声明自己是"工具轮静默"的唯一例外——否则与 ## Tool use 首条冲突,
//     模型会每轮开头都吐一句旁白。
{
  const section = buildWorkDisciplineSection('other');
  assert(section.includes('ONLY when it admits two or more materially different readings'),
    'restatement rule must be conditional on genuine ambiguity');
  assert(section.includes('An unambiguous request gets no restatement'),
    'restatement rule must explicitly opt out for unambiguous requests');
  assert(section.includes('single exception to staying silent during tool-calling turns'),
    'restatement rule must declare itself the sole exception to the silence rule');
  assert(!section.includes('Open with a one-sentence restatement of your interpretation'),
    'unconditional "open with a restatement" wording must be gone');
}


// 3. inferModelFamily:嗅探各家族 + fallback 到 other。
{
  assert(inferModelFamily('claude-3-5-sonnet') === 'anthropic', 'claude → anthropic');
  assert(inferModelFamily('gpt-4o') === 'openai', 'gpt → openai');
  assert(inferModelFamily('o1-preview') === 'openai', 'o1 → openai');
  assert(inferModelFamily('qwen2.5-coder-32b') === 'qwen', 'qwen → qwen');
  assert(inferModelFamily('qwen-max') === 'qwen', 'qwq → qwen');
  assert(inferModelFamily('llama-3.1-70b') === 'other', 'llama → other (fallback)');
  assert(inferModelFamily(undefined) === 'other', 'undefined → other');
}

// 4. buildBasePrompt 真的把纪律段拼进 system prompt,且四阶段全在。
{
  const prompt = buildBasePrompt();
  assert(prompt.includes('## Working discipline — coding tasks (Build-and-Self-Verify)'),
    'buildBasePrompt did not inject discipline section');
  for (const header of PHASE_HEADERS) {
    assert(prompt.includes(header), `buildBasePrompt missing phase: ${header}`);
  }
  assert(prompt.includes(HARD_RULE_NEEDLE), 'buildBasePrompt missing hard rule needle');

  // 纪律段必须在 ## Workflow 之前(LLM 先看纪律,再看工具细节)。
  const disciplineIdx = prompt.indexOf('## Working discipline — coding tasks');
  const workflowIdx = prompt.indexOf('## Workflow');
  assert(disciplineIdx > 0 && workflowIdx > disciplineIdx,
    'discipline section must come before ## Workflow');
}

// 5. buildMocodeCorePrompt 切片仍能正确切到 project context:纪律段不破坏
//    ## Project context (dynamic reference) / ## Termination & Reporting 边界。
//    设计意图:子 agent 不该看动态项目上下文 → core 抽出体里**不应**含 project context 段。
{
  const core = buildMocodeCorePrompt();
  const projectIdx = core.indexOf('## Project context (dynamic reference)');
  const terminationIdx = core.indexOf('## Termination & Reporting');
  assert(projectIdx < 0,
    'buildMocodeCorePrompt should still STRIP ## Project context (dynamic reference) (sub-agent isolation)');
  assert(terminationIdx > 0, 'buildMocodeCorePrompt should still contain ## Termination & Reporting');
  // 纪律段标题应在 buildMocodeCorePrompt 里保留(主+子 agent 都需要看到工作纪律)。
  assert(core.includes('## Working discipline — coding tasks (Build-and-Self-Verify)'),
    'discipline section must survive core prompt extraction (kept in both main and sub)');
}

// 6. config.model 切换 per-model 措辞真实生效(走 buildBasePrompt 现拼现读路径)。
//    断言开场句而非 "[model: X]" 标签——标签已移除(见 work-discipline.ts 的 adapt 注释),
//    开场句才是 per-model 适配唯一的可观测差异。
{
  const originalModel = config.model;
  try {
    config.model = 'gpt-4o-mini';
    const prompt = buildBasePrompt();
    assert(prompt.includes('MUST complete these four phases in order'),
      'setting config.model to gpt-4o must switch to openai wording');

    config.model = 'qwen2.5-coder';
    const prompt2 = buildBasePrompt();
    assert(prompt2.includes('"I wrote the code" is not evidence the code works'),
      'setting config.model to qwen2.5 must switch to qwen wording');

    config.model = 'claude-3-5-sonnet';
    const prompt3 = buildBasePrompt();
    assert(prompt3.includes('not a courtesy'),
      'setting config.model to claude must switch to anthropic wording');
  } finally {
    config.model = originalModel;
  }
}


console.log('work-discipline regression checks passed');
