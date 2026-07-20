// ASK-01 fixture: 提问预算提示。
//
// 断言:
// 1. ASK_HUMAN_PER_TURN_BUDGET = 2(与工作纪律段 "at most 2 ask_human calls per turn" 一致)。
// 2. askHumanBudgetAnnotation(count, status):
//    - count < 2 && success → null(无注释,避免噪声)
//    - count == 2 && success → "this was your 2nd call... budget = 2"
//    - count > 2 && success → "EXCEEDED ... call #N ... stop asking"
//    - count == 2 && error/denied/aborted → null(失败不追加)
// 3. 与 RETRY-01 反思指针不重复: 同一工具失败时,RETRY 块在先,ASK 块在后(或无)。
// 4. 同步:work-discipline 段 "Budget: at most 2 ask_human calls per turn" 文案就位。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { ASK_HUMAN_PER_TURN_BUDGET, askHumanBudgetAnnotation } = await import('../src/agent/core.js');
const { buildWorkDisciplineSection } = await import('../src/agent/work-discipline.js');
const { buildChecklistUserMessage } = await import('../src/agent/middleware/checklist.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

// 1. 预算常量 = 2(与工作纪律段 "at most 2" 一致)。
{
  assert(ASK_HUMAN_PER_TURN_BUDGET === 2, `ASK_HUMAN_PER_TURN_BUDGET must be 2, got ${ASK_HUMAN_PER_TURN_BUDGET}`);
}

// 2. askHumanBudgetAnnotation 触发矩阵。
{
  // 计数 0 / 1 + success → null
  assert(askHumanBudgetAnnotation(0, 'success') === null, 'count 0 + success → null');
  assert(askHumanBudgetAnnotation(1, 'success') === null, 'count 1 + success → null');
  // 计数 2 + success → "2nd call" 提示
  const at2 = askHumanBudgetAnnotation(2, 'success');
  assert(typeof at2 === 'string' && at2.includes('[ask budget]'),
    'count 2 + success → [ask budget] tag');
  assert(at2?.includes('2nd') === true, 'count 2 should mention "2nd"');
  assert(at2?.includes('budget = 2') === true, 'count 2 should state budget = 2');
  // 计数 3+ + success → "EXCEEDED" 提示
  const at3 = askHumanBudgetAnnotation(3, 'success');
  assert(typeof at3 === 'string' && at3.includes('EXCEEDED'),
    'count 3 + success → EXCEEDED tag');
  assert(at3?.includes('Stop asking') === true, 'count 3 should say "Stop asking"');
  assert(at3?.includes('#3') === true, 'count 3 should reference #3');
  const at5 = askHumanBudgetAnnotation(5, 'success');
  assert(at5?.includes('#5') === true, 'count 5 should reference #5');
  // 失败 / aborted 状态不追加
  for (const status of ['error', 'denied', 'aborted'] as const) {
    assert(askHumanBudgetAnnotation(2, status) === null, `count 2 + ${status} → null`);
    assert(askHumanBudgetAnnotation(5, status) === null, `count 5 + ${status} → null`);
  }
}

// 3. 与 RETRY-01 正交:同时追加时,RETRY 块在先(appendRetryAnnotations 顺序在前),
//    ASK 块在后;两块的 anchor 字符串不重叠。
{
  const askBlock = askHumanBudgetAnnotation(3, 'success');
  assert(askBlock !== null && askBlock.includes('[ask budget'),
    'ask block should be non-null at count 3');
  assert(!askBlock!.includes('[retry reflection'),
    'ask block must not include [retry reflection] anchor (orthogonal)');
  assert(!askBlock!.includes('TRANSIENT_'),
    'ask block must not include retry category enum');
}

// 4. 同步:work-discipline 段确实包含 "at most 2 ask_human" 与 5 个卡点关键词。
{
  const sec = buildWorkDisciplineSection();
  assert(sec.includes('When to ask instead of guess'),
    'work discipline section should include "When to ask instead of guess" header');
  assert(sec.includes('Budget: at most 2 `ask_human` calls per turn'),
    'work discipline section should include ask_human budget line');
  const askKeywords = [
    'Cross-package impact',
    'Naming conventions',
    'Keep or remove old API',
    'Test expectations',
    'Implicit success criteria',
  ];
  for (const k of askKeywords) {
    assert(sec.includes(k), `work discipline section missing ask keyword: ${k}`);
  }
  // 5 类 bullet 编号稳定(1./2./3./4./5.)
  for (let i = 1; i <= 5; i += 1) {
    assert(sec.includes(`${i}. **`), `work discipline section missing numbered ask item ${i}`);
  }
}

// 5. 同步:checklist 尾部确实包含 ASK-01 bonus 段。
{
  const msg = buildChecklistUserMessage();
  assert(msg.includes('Bonus (ASK-01)'),
    'checklist should include ASK-01 bonus footer');
  assert(msg.includes('guessing any fact the user did not state'),
    'checklist bonus should mention guessing');
  // 不破坏 5 项与 LangChain 对齐的硬约定。
  const numbered = (msg.match(/^\d\. /gm) ?? []).length;
  assert(numbered === 5, `checklist must have exactly 5 numbered items, got ${numbered}`);
}

// 6. 跨段一致性:纪律段 "at most 2" 与预算常量与 budget 块文案三者一致。
{
  const sec = buildWorkDisciplineSection();
  const at2 = askHumanBudgetAnnotation(2, 'success');
  assert(sec.includes('at most 2') && ASK_HUMAN_PER_TURN_BUDGET === 2 && at2?.includes('budget = 2'),
    'all three sources (discipline / constant / annotation) must agree on budget = 2');
}

console.log('ask-budget regression checks passed');
