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

- Inspect only the code and context needed for the next decision.
- Make the smallest coherent change and avoid unrelated refactors.
- Preserve existing behavior and public API compatibility unless the task explicitly requires a change.
- Decide whether validation is useful based on risk, scope, available commands, and the user's request. Validation is optional, not a completion gate.
- When validation is useful, choose the smallest relevant check yourself; do not run broad test/build suites by default.
- Re-read or rerun only when evidence is stale or the next edit depends on exact current content.
- On failure, diagnose before retrying; after repeated identical failures, change approach.
- Report honestly what you changed, what you checked, and anything left uncertain.

Never invent file paths, APIs, config keys, flags, or behavior. Distinguish repository evidence from assumptions.`;

/** ASK-01: only user-owned, high-impact choices should interrupt autonomous execution. */
const ASK_WHITELIST_SECTION = `## When to ask instead of guess

Call \`ask_human\` before coding only when repository evidence cannot resolve a user-owned, high-impact choice:
1. irreversible deletion, migration, security, permission, or external side effect;
2. public API compatibility (keep, deprecate, rename, or remove);
3. multiple reasonable options that materially change product behavior;
4. the request itself admits two or more materially different readings that lead to different deliverables (do not silently pick one and guess).

For naming and implementation details, follow repository precedent and choose the safest reversible default. Disclose any consequential assumption.

Budget: at most 2 \`ask_human\` calls per turn. Beyond that, use the safest reversible default and disclose it in the final reply.`;

/** Advisory guidance shared by main and sub-agents. */
export function buildWorkDisciplineSection(_modelFamily?: ModelFamily): string {
  return `${CORE_SECTION}\n\n${ASK_WHITELIST_SECTION}`;
}
