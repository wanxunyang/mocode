// RETRY-01: 错误反思分类器。
//
// 在 tools/retry.ts 之上叠加一层"反思"语义:把每个 ToolOutcomeCode 映射到
// 一个 ErrorCategory,供 (a) PROMPT 反思 prompt 注入、(b) QUAL-01 trace 指标。
//
// 设计要点:
// - 纯映射函数,无副作用 → 易测,易扩展(新 code → 改一处)。
// - 6 类对齐路线图 L163:`TRANSIENT_RATE_LIMIT` / `TRANSIENT_TIMEOUT` /
//   `INVALID_ARGUMENTS` / `PERMISSION_DENIED` / `CONFLICT` / `UNKNOWN_FAILURE`。
// - 提供"反思指针"模板(reflectionHint),与 PROMPT-01 hard rule
//   / PROMPT-02 checklist 共用同一套"先想清楚再动"语言,避免新造话。
// - 不**决策**重试与否(`shouldRetry` 在 tools/retry.ts 已经稳定;本次不动),
//   只**注解**每个错误"该反思什么"。

import type { ToolOutcomeCode } from '../tools/types.js';

/** 6 类反思错误分类。 */
export type ErrorCategory =
  | 'TRANSIENT_RATE_LIMIT'
  | 'TRANSIENT_TIMEOUT'
  | 'INVALID_ARGUMENTS'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'UNKNOWN_FAILURE';

/** code → category 的稳定映射。fixture 直接断言(避免漏改)。 */
const CODE_TO_CATEGORY: Readonly<Record<ToolOutcomeCode, ErrorCategory>> = {
  OK: 'UNKNOWN_FAILURE', // OK 不该走到这里;归 UNKNOWN 是为了编译期不漏。
  // rate-limit / timeout / network
  TIMEOUT: 'TRANSIENT_TIMEOUT',
  HTTP_ERROR: 'TRANSIENT_RATE_LIMIT', // 4xx/5xx 中除 408/429 之外的 5xx 视为 rate-limit 语义
  NETWORK_ERROR: 'TRANSIENT_TIMEOUT', // 网络层错(ECONNRESET 等)→ 与 timeout 同类反思
  // 参数 / schema(模型自己改,不是 retry 自己改)
  INVALID_JSON: 'INVALID_ARGUMENTS',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  INVALID_TOOL_SCHEMA: 'INVALID_ARGUMENTS',
  UNKNOWN_TOOL: 'INVALID_ARGUMENTS', // 调用了不存在的工具 → 模型改 tool name
  // 权限 / 沙箱 / 模式(永久拒绝)
  SANDBOX_DENIED: 'PERMISSION_DENIED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TOOL_DISABLED: 'PERMISSION_DENIED',
  MODE_DENIED: 'PERMISSION_DENIED',
  ABORTED: 'PERMISSION_DENIED', // 用户主动 abort,与 permission 同类(无 retry 价值)
  // 冲突 / 写失败(retry 之前必须重新读)
  EDIT_CONFLICT: 'CONFLICT',
  CHANGE_CONFLICT: 'CONFLICT',
  PATCH_INVALID: 'CONFLICT',
  POSTCONDITION_FAILED: 'CONFLICT',
  PROCESS_FAILED: 'CONFLICT',
  // 兜底
  EXECUTION_ERROR: 'UNKNOWN_FAILURE',
  MCP_ERROR: 'UNKNOWN_FAILURE',
};

export function classifyError(code: ToolOutcomeCode): ErrorCategory {
  return CODE_TO_CATEGORY[code];
}

/** 反思指针:每类错误给 LLM 一句"反思什么"的话。 */
const REFLECTION_HINTS: Readonly<Record<ErrorCategory, string>> = {
  TRANSIENT_RATE_LIMIT:
    'The remote is throttling or returned 5xx. Re-running the same call with identical arguments is unlikely to help — wait, downgrade call frequency, or reduce request size; do not retry the same args in tight loop.',
  TRANSIENT_TIMEOUT:
    'A network or process timeout occurred. Re-running the same call may help once, but if it fails again with identical args, the path/host/argument is wrong; switch tool, reduce scope, or ask the user.',
  INVALID_ARGUMENTS:
    'The tool rejected the call shape (JSON / schema / unknown tool). Read the tool description again and fix the arguments yourself; do not resend the same call and do not retry automatically — only the model can fix argument shape.',
  PERMISSION_DENIED:
    'The call was denied (sandbox / permission / disabled / mode). Retry will not help; surface the constraint to the user and ask for guidance or a permission grant.',
  CONFLICT:
    'A write/patch conflicted with the on-disk state. Do not resend the same args; re-read the file or change target, then re-derive the diff. If the conflict is structural, the plan itself is wrong — go back to the spec.',
  UNKNOWN_FAILURE:
    'An unclassified error occurred. Do not retry blindly; capture the message, re-read the tool description, and decide whether the same call with a smaller scope or a different tool is appropriate. If unsure, ask the user.',
};

export function reflectionHint(category: ErrorCategory): string {
  return REFLECTION_HINTS[category];
}

/**
 * 一站式:对 ToolOutcome 给出"反思 category + 反思 hint"。
 * 调用方一般是 tools/retry.ts 的 onRetry hook,把 hint 注入 retry 提示尾部。
 */
export function reflectOn(code: ToolOutcomeCode): { category: ErrorCategory; hint: string } {
  const category = classifyError(code);
  return { category, hint: reflectionHint(category) };
}
