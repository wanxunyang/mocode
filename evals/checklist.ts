// PROMPT-02 fixture: 单元级断言 PreCompletionChecklistMiddleware 的 5 项内容、
// 触发条件、opt-out、per-model 措辞;并断言与 PROMPT-01 纪律段正交(不重复措辞,
// 不替换 4 阶段正文)。
//
// 性质:无 LLM 调用,纯字符串/handler 探针。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const {
  CHECKLIST_ITEMS,
  buildChecklistUserMessage,
  defaultChecklistHandler,
  createPreCompletionChecklistMiddleware,
} = await import('../src/agent/middleware/checklist.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const FIVE_ITEMS_NEEDLES = [
  'actually run a command',
  'match the original spec',
  'boundary I claim to have covered',
  'existing test suite still pass',
  'cannot verify, did I tell the user explicitly',
];

const HARD_RULE_NEEDLE = '"I read the code and it looks right" is not a completion signal';

// 1. 5 项 checklist 内容就位(关键词在数组内出现,顺序稳定)。
{
  assert(CHECKLIST_ITEMS.length === 5, `checklist must have exactly 5 items, got ${CHECKLIST_ITEMS.length}`);
  const joined = CHECKLIST_ITEMS.join('\n');
  for (const needle of FIVE_ITEMS_NEEDLES) {
    assert(joined.includes(needle), `checklist missing keyword: ${needle}`);
  }
  // 顺序:LangChain 实证对齐 → run / spec / boundary / tests / tell-user。
  assert(CHECKLIST_ITEMS[0]?.startsWith('Did I actually run') === true,
    'item 1 must be about running a command');
  assert(CHECKLIST_ITEMS[4]?.includes('pretending to be done') === true,
    'item 5 must be about explicit disclosure');
}

// 2. buildChecklistUserMessage:含 [checklist] 标记 + 5 项 + 硬规则锚点。
{
  const msg = buildChecklistUserMessage();
  assert(msg.startsWith('[checklist]'),
    'user message must start with [checklist] tag for LLM to recognize gate');
  assert(msg.includes('Hard rule:'), 'user message must include hard-rule anchor');
  assert(msg.includes(HARD_RULE_NEEDLE), 'user message must include PROMPT-01 hard rule needle');
  for (const needle of FIVE_ITEMS_NEEDLES) {
    assert(msg.includes(needle), `user message missing keyword: ${needle}`);
  }
  // 5 项要编号 1. 2. 3. 4. 5.,LLM 才能引用具体某条。
  for (let i = 1; i <= 5; i += 1) {
    assert(msg.includes(`${i}. `), `user message missing numbered item ${i}`);
  }
}

// 3. per-model 措辞:openai MUST 关键词、anthropic gate 关键词、qwen 走英文严谨版(无中文)。
{
  const openai = buildChecklistUserMessage('openai');
  assert(openai.includes('MANDATORY'),
    'openai variant must use MUST/MANDATORY language');
  const anthropic = buildChecklistUserMessage('anthropic');
  assert(anthropic.includes('gate'),
    'anthropic variant must use gate language');
  // qwen 不再走中英混排;沿用英文严谨版,只换首句。
  const qwen = buildChecklistUserMessage('qwen');
  assert(qwen.startsWith('[checklist]'),
    'qwen variant must keep [checklist] tag');
  assert(!qwen.includes('无法验证'),
    'qwen variant must not include Chinese (PROMPT-01 removed Chinese)');
  // other / undefined → 默认严谨版。
  const other = buildChecklistUserMessage('other');
  const none = buildChecklistUserMessage(undefined);
  assert(other === none, 'other === undefined (default strict variant)');
}

// 4. defaultChecklistHandler 触发矩阵:
//    - plan 模式永远不触发
//    - 无 mutation 不触发
//    - passed 验证不触发(已被 autoValidate 接管)
//    - failed / none + 有 mutation → 触发
{
  assert(defaultChecklistHandler({ hadMutation: true, lastValidationStatus: 'none', mode: 'auto' }) === true,
    'hadMutation + no validation + auto → must fire');
  assert(defaultChecklistHandler({ hadMutation: true, lastValidationStatus: 'failed', mode: 'auto' }) === true,
    'hadMutation + failed validation + auto → must fire (LLM ignoring failure)');
  assert(defaultChecklistHandler({ hadMutation: false, lastValidationStatus: 'none', mode: 'auto' }) === false,
    'no mutation → no checklist (avoids noise)');
  assert(defaultChecklistHandler({ hadMutation: true, lastValidationStatus: 'passed', mode: 'auto' }) === false,
    'validation already passed → no checklist (avoid noise)');
  assert(defaultChecklistHandler({ hadMutation: true, lastValidationStatus: 'none', mode: 'plan' }) === false,
    'plan mode → no checklist (planning itself is the gate)');
}

// 5. middleware 工厂返回的句柄与默认一致。
{
  const m = createPreCompletionChecklistMiddleware();
  assert(m.handler === defaultChecklistHandler, 'middleware handler must default to defaultChecklistHandler');
  assert(m.buildUserMessage === buildChecklistUserMessage, 'middleware buildUserMessage must default');
  assert(m.items === CHECKLIST_ITEMS, 'middleware items must reference the readonly array');
}

// 6. 与 PROMPT-01 正交:checklist 不应内嵌 PROMPT-01 的 4 阶段正文(避免重复);
//    但应保留硬规则锚点(同一句话)以保持纪律一致。
{
  const msg = buildChecklistUserMessage();
  assert(!msg.includes('### Phase 1'),
    'checklist must not embed PROMPT-01 phase bodies (orthogonal)');
  assert(!msg.includes('### Phase 2'),
    'checklist must not embed PROMPT-01 phase bodies (orthogonal)');
  assert(!msg.includes('### Phase 3'),
    'checklist must not embed PROMPT-01 phase bodies (orthogonal)');
  assert(!msg.includes('### Phase 4'),
    'checklist must not embed PROMPT-01 phase bodies (orthogonal)');
  // 但保留 PROMPT-01 硬规则锚点(共享同一句话)。
  assert(msg.includes(HARD_RULE_NEEDLE),
    'checklist must share PROMPT-01 hard-rule needle (same language)');
}

console.log('checklist regression checks passed');
