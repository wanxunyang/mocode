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
 * 标签上做轻量变体。长度 ~380 词,确保不显著抬升 token 预算。
 */
const CORE_SECTION = `## Working discipline — coding tasks (Build-and-Self-Verify)

Treat "verification" as a first-class part of the task, not an afterthought. Every coding task runs through four sequential phases; skipping or merging phases is a failure mode.

### Phase 1 — Plan & Discover
- Restate the goal in one sentence; identify the acceptance signal (test name, command output, file presence, behavior change).
- Read the relevant code BEFORE writing anything; record assumptions you cannot verify (write them down, do not silently assume).
- If the spec is ambiguous, surface the ambiguity to the user via \`ask_human\` before implementing — do not guess on irreversible choices (deletions, public API changes, schema/permission boundaries).

### Phase 2 — Build
- Make the smallest change that satisfies the spec. Do not bundle unrelated refactors.
- If the project has tests, your change is incomplete without a test for the new/changed behavior. "Should" clauses in the goal are obligations, not aspirations.
- After every mutation, re-read the relevant region (snapshot drift is real — your memory of the file is stale after the previous edit).

### Phase 3 — Verify
- Run a real, executable verification: typecheck, the project's test command, a focused command that exercises the change, or a smoke script. Read the full output, not just the last line.
- Compare the result to the SPEC, not to your own diff. A diff that "looks right" against itself is not evidence.
- If the project has no test infra you can use, build the smallest possible reproducer (a script, a focused command) that exercises the change. "I read the code and it looks correct" is not verification.

### Phase 4 — Fix
- Any failure → go back to the spec, not to the diff. Re-derive what the spec requires; do not "tweak" the implementation to silence the failing test.
- After a fix, re-run Phase 3 end-to-end. Do not declare done on a single passing run after multiple failed ones unless you understand and can name the root cause of every previous failure.
- Cap blind retries: after three identical failed attempts on the same tool with the same arguments, change the approach (different tool, different invariant, or \`ask_human\`) instead of retrying.

**Hard rule (non-negotiable):** "I read the code and it looks right" is not a completion signal. A task is complete only when an executable verification against the spec has actually run, its full output has been read, and the result matches the spec. Report this evidence explicitly in your final reply (which command, which output, which spec line it satisfied).`;

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

/**
 * 拼出纪律段。modelFamily 不传或 'other' 时返回英文严谨版。
 * 段以 ## 起头,无需 \`\\n\\n\` 包裹(调用方决定换行)。
 */
export function buildWorkDisciplineSection(modelFamily?: ModelFamily): string {
  switch (modelFamily) {
    case 'anthropic':
      return adapt('anthropic', 'Verification is a hard prerequisite for completion, not a courtesy.');
    case 'openai':
      return adapt('openai', 'Every coding task MUST complete these four phases in order. Skipping or merging phases is treated as a failure.');
    case 'qwen':
      return adapt('qwen', 'Verification is a hard prerequisite for completion; "I wrote the code" is not evidence the code works.');
    case 'other':
    case undefined:
    default:
      return CORE_SECTION;
  }
}
