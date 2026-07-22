// PROMPT-01: Build-and-Self-Verify working discipline.
//
// 把"完成必须验证"作为 system prompt 的一等公民,而不是事后选项。注入一段
// 4 阶段纪律(Plan & Discover → Build → Verify → Fix),并提供 per-model
// 措辞(anthropic / openai / qwen)让 base model 拿到最适合自己的表述。
//
// 关键约束:
// - 纯函数,无副作用,无 config 依赖 → 不踩 TDZ,易测,易回滚。
// - 段标题在 buildMocodeCorePrompt 之外,不会被 `## Project context` 索引
//   切片误伤;且 buildBasePrompt 注入位置在 ## Workflow 之前,确保 LLM
//   先看到纪律再看工具/平台细节。
// - per-model 措辞是"轻量"差异:3 个家族共享 4 阶段结构,只在首句/标签
//   上贴近该家族的指令遵从习惯;真正的 prompt 反演化交给 AHE。
// - 语种统一英文:4 份都用同一份核心纪律文本,避免多语种漂移;用户语言
//   偏好由现有 i18n 段(assistant.languageInstruction)负责。

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
const CORE_SECTION = `## Working discipline — coding tasks (Build-and-Self-Verify)

Treat "verification" as a first-class part of the task, not an afterthought. Use the smallest evidence-driven loop below.

### Phase 1 — Plan & Discover
- State the goal and a concrete acceptance signal, then inspect the relevant code before changing it.
- Ask only when an unresolved choice is high-impact or user-owned; otherwise follow repository evidence and proceed.

### Phase 2 — Build
- Make the smallest coherent change; avoid unrelated refactors.
- Add or update a focused test when behavior changes and the project has an applicable test suite.
- Re-read only when a dependent edit needs fresh exact content or state may be stale.

### Phase 3 — Verify
- Run the smallest executable check that proves the requested behavior, then read its complete result.
- Compare evidence with the user's request, not merely with the diff.

### Phase 4 — Fix
- Diagnose the root cause, make a focused correction, and rerun the relevant check.
- After three identical failures, change the approach instead of repeating the same call.

**Hard rule (non-negotiable):** "I read the code and it looks right" is not a completion signal. Report the verification performed, or state clearly why it could not be run.`;

/**
 * 把核心段适配到指定 model family:只改首行(语序 / 强动词)与段标题
 * 末尾的 [model: X] 标签。Phase 内容保持原样,4 份共享同一份结构化文本。
 */
function adapt(model: ModelFamily, opener: string): string {
  return CORE_SECTION
    .replace(
      '## Working discipline — coding tasks (Build-and-Self-Verify)',
      `## Working discipline — coding tasks (Build-and-Self-Verify) [model: ${model}]`,
    )
    .replace(
      'Treat "verification" as a first-class part of the task, not an afterthought.',
      opener,
    );
}

/** ASK-01: only user-owned, high-impact choices should interrupt autonomous execution. */
const ASK_WHITELIST_SECTION = `## When to ask instead of guess

Call \`ask_human\` before coding only when repository evidence cannot resolve a user-owned, high-impact choice:
1. irreversible deletion, migration, security, permission, or external side effect;
2. public API compatibility (keep, deprecate, rename, or remove);
3. multiple reasonable options that materially change product behavior.

For naming, implementation detail, and verification commands, follow repository precedent and choose the safest reversible default. Disclose any consequential assumption.

Budget: at most 2 \`ask_human\` calls per turn. Beyond that, use the safest reversible default and disclose it in the final reply.`;

/**
 * 拼出纪律段 + ASK-01 卡点白名单。返回完整段(两段用 \`\\n\\n\` 隔开);
 * 工厂之前只返回纪律段,ASK-01 落地后变成纪律 + 白名单两段;
 * ASK-01 段是固定英文,不参与 per-model 适配(避免 4 份变体维护成本)。
 */
export function buildWorkDisciplineSection(modelFamily?: ModelFamily): string {
  let section: string;
  switch (modelFamily) {
    case 'anthropic':
      section = adapt('anthropic', 'Verification is a hard prerequisite for completion, not a courtesy.');
      break;
    case 'openai':
      section = adapt('openai', 'Every coding task MUST complete these four phases in order. Skipping or merging phases is treated as a failure.');
      break;
    case 'qwen':
      section = adapt('qwen', 'Verification is a hard prerequisite for completion; "I wrote the code" is not evidence the code works.');
      break;
    case 'other':
    case undefined:
    default:
      section = CORE_SECTION;
  }
  return `${section}\n\n${ASK_WHITELIST_SECTION}`;
}
