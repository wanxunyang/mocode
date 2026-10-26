// Lightweight, advisory working guidance. The agent decides how much discovery and
// validation each task needs; the framework does not enforce a completion gate.

export type ModelFamily = 'anthropic' | 'openai' | 'qwen' | 'other';

/**
 * 从 config.model 字符串里嗅探 model family。匹配规则尽量宽松,够用即可。
 * 未来 AHE 闭环后可以换成 config.modelFamily 字段。
 */
export function inferModelFamily(model: string | undefined): ModelFamily {
  if (!model) return 'other';
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('openai')) return 'openai';
  if (m.includes('qwen') || m.includes('qwq') || m.includes('tongyi')) return 'qwen';
  return 'other';
}

/**
 * 4 阶段核心纪律(英文)。4 个 model family 共用此文本,只在首句与标题
 * 标签上做轻量变体。保持短小，详细的完成检查由动态 checklist 按需注入。
 */
const CORE_SECTION = `Use your judgment to choose the shortest reliable path from the request to a useful result.

- Answer directly when you already can: questions, explanations, advice, reviews, and read-only analysis that the conversation and known evidence already support get a direct answer with no tools, no extra investigation, and no validation. Reach for a tool only when the answer genuinely depends on information you do not have.
- Inspect only the code and context needed for the next decision; do not gather evidence "just in case".
- Make the smallest coherent change and avoid unrelated refactors.
- Preserve existing behavior and public API compatibility unless the task explicitly requires a change.
- Validation (typecheck/lint/build/test, or running the change) applies only to work that changes code or behavior. Decide whether it is useful based on risk, scope, available commands, and the user's request; it is never required for pure questions, explanations, or read-only analysis. It is optional, not a completion gate, and the user asking for an answer is not asking for verification.
- When validation is useful, choose the smallest relevant check yourself; do not run broad test/build suites by default. Trivial, self-evidently correct edits (comments, docs, typo fixes) need no check either.
- Re-read or rerun only when evidence is stale or the next edit depends on exact current content.
- On failure, diagnose before retrying; after repeated identical failures, change approach.
- Report honestly what you changed, what you checked, and anything left uncertain.

Never invent file paths, APIs, config keys, flags, or behavior. Distinguish repository evidence from assumptions.`;

/**
 * ASK-02: user decisions and key modifications are the user's call, not the agent's.
 * The agent must call `ask_human` BEFORE acting; only trivial, reversible details may be decided alone.
 */
const ASK_WHITELIST_SECTION = `## When to ask instead of guess

The user owns every decision and every key change. NEVER decide these on your own: call \`ask_human\` FIRST, wait for the answer, then act. Asking is the default; acting alone is the exception.

Ask BEFORE acting when any of these applies:
1. A decision point: two or more reasonable approaches, designs, libraries, or behaviors exist and the user has not chosen one. Present the options with trade-offs and your recommendation; do not pick silently.
2. A key modification: changing public APIs, data formats, schemas, config semantics, or default behavior; adding, removing, or upgrading dependencies; renaming/moving/deleting files or modules; changing architecture or cross-module contracts; touching auth, permissions, security, or build/CI/release setup.
3. A broad or risky change: edits spanning many files, large refactors, anything hard to reverse, or any external side effect (push, deploy, network writes, data deletion/migration).
4. Scope growth: the work needs more than what the user asked for (extra features, unrelated fixes, behavior changes), or the request admits two or more materially different readings.
5. Evidence conflicts or gaps: repository evidence is missing, contradictory, or stale on something that changes the outcome.
6. A failed approach: the same approach failed twice and the next step is a different approach, tool, or tradeoff than the user agreed to.

For ambiguous or vague requests, load the \`brainstorming\` skill and clarify through a short dialogue (one question at a time) before starting work. For a key modification, state what will change, why, and the impact in \`question\`/\`context\`, offer a confirm / adjust / cancel style choice, and make no related edits until the user answers.

If the user cancels or answers "you decide", stop guessing: take the safest reversible option and state it. Do not repeat a question the user already answered.

Only these may be decided alone: naming and style that follow repository precedent, local implementation details inside an already-approved change, and read-only investigation. Disclose any assumption you made.

There is no per-turn cap on \`ask_human\`: ask as often as a decision genuinely requires, but batch related questions into one call instead of asking one trivial thing at a time. If \`ask_human\` is unavailable or no user can answer (non-interactive run), choose the safest reversible option, avoid the key modification if possible, and disclose it in the final reply.`;

/** Advisory guidance shared by main and sub-agents. */
export function buildWorkDisciplineSection(_modelFamily?: ModelFamily): string {
  return `${CORE_SECTION}\n\n${ASK_WHITELIST_SECTION}`;
}
