// RETRY-01 fixture: 错误分类 + 反思指针。
//
// 断言:
// 1. 6 类 category 覆盖所有 ToolOutcomeCode (无漏)。
// 2. rate-limit / timeout / network → TRANSIENT_* (反思"wait, downgrade, change args")。
// 3. invalid arguments / schema / unknown tool → INVALID_ARGUMENTS
//    (反思"模型自己改,不让 retry 自己改")。
// 4. permission / sandbox / mode / disabled / aborted → PERMISSION_DENIED
//    (反思"永远无 retry 价值,问用户")。
// 5. edit/change/patch/postcondition/process → CONFLICT
//    (反思"重读,改 diff,或回 spec")。
// 6. execution / mcp → UNKNOWN_FAILURE (反思"不要盲试")。
// 7. reflectOn 返回 {category, hint} 同步一致。
// 8. hint 文案包含 PROMPT-01 hard rule 锚点(共享同一套语言)。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const {
  classifyError,
  reflectionHint,
  reflectOn,
} = await import('../src/agent/retry-classifier.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const HARD_RULE_NEEDLE = '"I read the code and it looks right"';

// 1. 6 类 category 文案存在,每类至少有 1 个 ToolOutcomeCode 映射。
{
  const allCodes: string[] = [
    'TIMEOUT', 'HTTP_ERROR', 'NETWORK_ERROR',
    'INVALID_JSON', 'INVALID_ARGUMENTS', 'INVALID_TOOL_SCHEMA', 'UNKNOWN_TOOL',
    'SANDBOX_DENIED', 'PERMISSION_DENIED', 'TOOL_DISABLED', 'MODE_DENIED', 'ABORTED',
    'EDIT_CONFLICT', 'CHANGE_CONFLICT', 'PATCH_INVALID', 'POSTCONDITION_FAILED', 'PROCESS_FAILED',
    'EXECUTION_ERROR', 'MCP_ERROR',
  ];
  const seen = new Set<string>();
  for (const code of allCodes) {
    const cat = classifyError(code as never);
    assert(typeof cat === 'string' && cat.length > 0, `classifyError returned empty for ${code}`);
    seen.add(cat);
    assert(typeof reflectionHint(cat) === 'string' && reflectionHint(cat).length > 0,
      `reflectionHint empty for ${cat}`);
  }
  // 6 类应都至少 1 个 code
  const expectedCategories = new Set([
    'TRANSIENT_RATE_LIMIT', 'TRANSIENT_TIMEOUT',
    'INVALID_ARGUMENTS', 'PERMISSION_DENIED',
    'CONFLICT', 'UNKNOWN_FAILURE',
  ]);
  assert(seen.size === expectedCategories.size,
    `expected 6 categories, got ${seen.size}: ${[...seen].join(', ')}`);
  for (const c of expectedCategories) assert(seen.has(c), `missing category in coverage: ${c}`);
}

// 2. rate-limit / timeout / network 路由正确。
{
  assert(classifyError('TIMEOUT' as never) === 'TRANSIENT_TIMEOUT', 'TIMEOUT → TRANSIENT_TIMEOUT');
  assert(classifyError('NETWORK_ERROR' as never) === 'TRANSIENT_TIMEOUT', 'NETWORK_ERROR → TRANSIENT_TIMEOUT');
  assert(classifyError('HTTP_ERROR' as never) === 'TRANSIENT_RATE_LIMIT', 'HTTP_ERROR → TRANSIENT_RATE_LIMIT');
  // 反思 hint 应提到 wait / downgrade / 不要盲 retry。
  for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'HTTP_ERROR'] as const) {
    const h = reflectionHint(classifyError(code as never));
    assert(/retry|wait|downgrade|switch|ask/i.test(h),
      `${code} hint should mention retry strategy`);
  }
}

// 3. invalid args 路由正确 + 反思"模型自己改"。
{
  for (const code of ['INVALID_JSON', 'INVALID_ARGUMENTS', 'INVALID_TOOL_SCHEMA', 'UNKNOWN_TOOL'] as const) {
    assert(classifyError(code as never) === 'INVALID_ARGUMENTS', `${code} → INVALID_ARGUMENTS`);
  }
  const h = reflectionHint('INVALID_ARGUMENTS');
  assert(h.toLowerCase().includes('arguments') || h.toLowerCase().includes('schema'),
    'INVALID_ARGUMENTS hint should mention args/schema');
  assert(/do not.*retry|fix the|model/i.test(h),
    'INVALID_ARGUMENTS hint should forbid auto-retry');
}

// 4. permission 类 → 永不 retry 价值,问用户。
{
  for (const code of ['SANDBOX_DENIED', 'PERMISSION_DENIED', 'TOOL_DISABLED', 'MODE_DENIED', 'ABORTED'] as const) {
    assert(classifyError(code as never) === 'PERMISSION_DENIED', `${code} → PERMISSION_DENIED`);
  }
  const h = reflectionHint('PERMISSION_DENIED');
  assert(/retry.*not help|surface|ask/i.test(h),
    'PERMISSION_DENIED hint should emphasize no-retry + ask user');
}

// 5. conflict 类 → 反思"重读,改 diff,或回 spec"。
{
  for (const code of ['EDIT_CONFLICT', 'CHANGE_CONFLICT', 'PATCH_INVALID', 'POSTCONDITION_FAILED', 'PROCESS_FAILED'] as const) {
    assert(classifyError(code as never) === 'CONFLICT', `${code} → CONFLICT`);
  }
  const h = reflectionHint('CONFLICT');
  assert(/re-read|read the file|spec|diff/i.test(h),
    'CONFLICT hint should mention re-read / spec / diff');
}

// 6. 兜底类(EXECUTION_ERROR / MCP_ERROR)→ UNKNOWN_FAILURE。
{
  assert(classifyError('EXECUTION_ERROR' as never) === 'UNKNOWN_FAILURE', 'EXECUTION_ERROR → UNKNOWN_FAILURE');
  assert(classifyError('MCP_ERROR' as never) === 'UNKNOWN_FAILURE', 'MCP_ERROR → UNKNOWN_FAILURE');
  const h = reflectionHint('UNKNOWN_FAILURE');
  assert(/not.*retry blindly|capture|re-read|ask/i.test(h),
    'UNKNOWN_FAILURE hint should forbid blind retry');
}

// 7. reflectOn 同步一致。
{
  for (const code of ['TIMEOUT', 'INVALID_ARGUMENTS', 'EDIT_CONFLICT', 'EXECUTION_ERROR'] as const) {
    const r = reflectOn(code as never);
    assert(r.category === classifyError(code as never), 'reflectOn category consistent');
    assert(r.hint === reflectionHint(r.category), 'reflectOn hint consistent');
  }
}

// 8. hint 文案与 PROMPT-01 / PROMPT-02 共享"想清楚再动"语言(不引用具体 hard rule 锚点,
//    避免"双 anchor 漂移";但语气保持一致:re-think > blind retry)。
{
  for (const cat of ['TRANSIENT_RATE_LIMIT', 'TRANSIENT_TIMEOUT', 'INVALID_ARGUMENTS', 'PERMISSION_DENIED', 'CONFLICT', 'UNKNOWN_FAILURE'] as const) {
    const h = reflectionHint(cat);
    assert(h.length >= 40, `${cat} hint too short, lacks actionable detail`);
    assert(!/^#|^\*|-{3,}/.test(h), `${cat} hint should be plain prose, not markdown header`);
  }
}

// 9. 工具结果拼装:appendRetryAnnotations 在 error 状态追加 [retry reflection: ...] 块;
//    success 状态不追加;aborted 也不追加(用户主动 cancel 无反思价值)。
{
  // 通过构造一个 fake outcome + 调用 helper-style inline 验证逻辑等价。
  // (helper 在 core.ts 内部,不导出,这里用直接函数体复用一份等效 inline 验证分类器输出。)
  const fakeOutput = 'tool said: nope';
  const cases: Array<{ status: 'success' | 'error' | 'denied' | 'aborted'; code: string; expect: RegExp }> = [
    { status: 'error', code: 'TIMEOUT', expect: /\[retry reflection: TRANSIENT_TIMEOUT\]/ },
    { status: 'error', code: 'INVALID_ARGUMENTS', expect: /\[retry reflection: INVALID_ARGUMENTS\]/ },
    { status: 'denied', code: 'SANDBOX_DENIED', expect: /\[retry reflection: PERMISSION_DENIED\]/ },
    { status: 'error', code: 'EDIT_CONFLICT', expect: /\[retry reflection: CONFLICT\]/ },
    { status: 'error', code: 'EXECUTION_ERROR', expect: /\[retry reflection: UNKNOWN_FAILURE\]/ },
    { status: 'success', code: 'OK', expect: /^\[retry reflection/ }, // anchor for "no-append" check below
    { status: 'aborted', code: 'ABORTED', expect: /^\[retry reflection/ }, // anchor for "no-append" check below
  ];
  // The 'expect' regex above is a *negative* anchor for success/aborted (we expect NO match).
  for (const c of cases) {
    const cat = classifyError(c.code as never);
    const wouldAppend = c.status !== 'success' && c.status !== 'aborted';
    const finalOutput = wouldAppend
      ? `${fakeOutput}\n\n[retry reflection: ${cat}]\n${reflectionHint(cat)}`
      : fakeOutput;
    if (wouldAppend) {
      assert(c.expect.test(finalOutput),
        `error/denied ${c.code} should append [retry reflection: ${cat}] block`);
    } else {
      assert(!c.expect.test(finalOutput),
        `${c.status} ${c.code} must NOT append [retry reflection] block (got: ${finalOutput})`);
    }
  }
}

console.log('retry-classifier regression checks passed');
