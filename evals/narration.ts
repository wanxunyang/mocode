// NARR-01 fixture: 工具轮旁白(interstitial narration)的分类与回压。
//
// 背景:prompt 里 "During tool-calling turns, stay silent..." 只是软约束,
// 模型自评"这句话是否重要"必然偏宽松。这里补机制层:
//   - classifyNarration 判定一条 assistant 消息(content + tool_calls)是否算旁白;
//   - 超软预算才追加回压提示(未超只 emit trace,可度量、不打扰);
//   - trace 新增 'narration' 事件类型,让旁白率能被统计而不是靠肉眼。
//
// 断言:
// 1. NARRATION_CHAR_BUDGET = 120(软预算,与提示文案里的数字一致)。
// 2. 纯工具调用(content 空 / 仅空白)→ null,即"理想情况不产生任何信号"。
// 3. 短旁白(<= 预算)→ overBudget=false 且 hint=null(只度量,不回压)。
// 4. 长旁白(> 预算)→ overBudget=true 且 hint 含 [narration] 标记 + 三类例外白名单。
// 5. chars 按 code point 计数,中文一字算 1(不是 UTF-8 字节数)。
// 6. hint 文案里的工具调用数量单复数正确(1 tool call / 2 tool calls)。
// 7. 与 ASK-01 / RETRY-01 注入块正交:三者标记互不重叠,可安全拼接。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const {
  NARRATION_CHAR_BUDGET,
  classifyNarration,
  askHumanBudgetAnnotation,
} = await import('../src/agent/core.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

/** 生成指定 code point 长度的 ASCII 文本。 */
const ascii = (n: number): string => 'a'.repeat(n);

// 1. 软预算常量。
{
  assert(NARRATION_CHAR_BUDGET === 120,
    `NARRATION_CHAR_BUDGET must be 120, got ${NARRATION_CHAR_BUDGET}`);
}

// 2. 纯工具调用 → null(无旁白,理想情况不产生任何事件/提示)。
{
  assert(classifyNarration(null, 1) === null, 'null content → null');
  assert(classifyNarration(undefined, 1) === null, 'undefined content → null');
  assert(classifyNarration('', 1) === null, 'empty content → null');
  assert(classifyNarration('   \n\t  ', 2) === null, 'whitespace-only content → null');
}

// 3. 短旁白:只度量,不回压。
{
  const short = classifyNarration('Found it.', 1);
  assert(short !== null, 'short prose must still be classified (measurable)');
  assert(short?.chars === 9, `chars must be 9, got ${short?.chars}`);
  assert(short?.overBudget === false, 'short prose must not be over budget');
  assert(short?.hint === null, 'short prose must not produce a back-pressure hint');

  // 正好等于预算 → 仍不回压(边界:<= 预算放行)。
  const atBudget = classifyNarration(ascii(NARRATION_CHAR_BUDGET), 1);
  assert(atBudget?.chars === NARRATION_CHAR_BUDGET, 'boundary chars must equal budget');
  assert(atBudget?.overBudget === false, 'exactly at budget → not over budget');
  assert(atBudget?.hint === null, 'exactly at budget → no hint');
}

// 4. 长旁白:超预算 → 回压提示含标记与三类例外白名单。
{
  const over = classifyNarration(ascii(NARRATION_CHAR_BUDGET + 1), 1);
  assert(over?.overBudget === true, 'budget + 1 → over budget');
  const hint = over?.hint;
  assert(typeof hint === 'string' && hint.includes('[narration]'),
    'over-budget hint must carry the [narration] tag');
  assert(hint?.includes(`soft budget = ${NARRATION_CHAR_BUDGET}`) === true,
    'hint must state the soft budget so the model knows the threshold');
  assert(hint?.includes(String(NARRATION_CHAR_BUDGET + 1)) === true,
    'hint must report the actual character count');
  // 三类例外白名单(决策分叉 / 风险披露 / 最终答案)——这是可执行的判据,
  // 取代 "something important enough" 那种模型自评式措辞。
  assert(hint?.includes('decision fork') === true, 'hint must whitelist decision forks');
  assert(hint?.includes('risk') === true, 'hint must whitelist error/risk disclosure');
  assert(hint?.includes('final answer') === true, 'hint must whitelist the final answer');
  assert(hint?.includes('no preamble') === true,
    'hint must tell the model to call the next tool with no preamble');
}

// 5. code point 计数:中文一字算 1。
{
  const zh = '代码量很大'; // 5 个汉字
  const r = classifyNarration(zh, 1);
  assert(r?.chars === 5, `CJK must count as code points (5), got ${r?.chars}`);
  assert(r?.overBudget === false, '5 CJK chars is well under budget');

  // 121 个汉字 → 超预算(证明不是按字节判定:121 汉字 UTF-8 是 363 字节,
  // 而 121 个 ASCII 也是 121 字节,两者都必须只按 code point 判定)。
  const longZh = '字'.repeat(NARRATION_CHAR_BUDGET + 1);
  const rl = classifyNarration(longZh, 1);
  assert(rl?.chars === NARRATION_CHAR_BUDGET + 1,
    `long CJK chars must be ${NARRATION_CHAR_BUDGET + 1}, got ${rl?.chars}`);
  assert(rl?.overBudget === true, 'budget + 1 CJK chars → over budget');
}

// 6. 单复数正确(文案质量:避免 "1 tool calls")。
{
  const one = classifyNarration(ascii(200), 1);
  assert(one?.hint?.includes('1 tool call (') === true,
    `singular form expected for 1 tool call, got: ${one?.hint?.slice(0, 160)}`);
  const many = classifyNarration(ascii(200), 3);
  assert(many?.hint?.includes('3 tool calls (') === true,
    `plural form expected for 3 tool calls, got: ${many?.hint?.slice(0, 160)}`);
}

// 7. 与 ASK-01 注入块正交:标记互不重叠,拼接后两段都可被识别。
//    (core.ts 里 finalOutput = annotated + askBudget + narrationHint。)
{
  const askBlock = askHumanBudgetAnnotation(3, 'success');
  const narrationHint = classifyNarration(ascii(200), 1)?.hint;
  assert(typeof askBlock === 'string' && typeof narrationHint === 'string',
    'both annotation blocks must be present for the orthogonality check');
  assert(!askBlock!.includes('[narration]'), 'ask budget block must not contain narration tag');
  assert(!narrationHint!.includes('[ask budget'), 'narration hint must not contain ask budget tag');
  const combined = `tool output${askBlock}${narrationHint}`;
  assert(combined.includes('[ask budget EXCEEDED]') && combined.includes('[narration]'),
    'concatenated output must preserve both markers');
  assert(combined.indexOf('[ask budget') < combined.indexOf('[narration]'),
    'narration hint is appended last (matches core.ts finalOutput order)');
}

console.log('narration regression checks passed');
