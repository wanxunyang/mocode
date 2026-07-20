// PROMPT-02: PreCompletionChecklistMiddleware.
//
// 在 agent 宣告完成(no tool calls + 有 candidate 正文)的那一刻,向 history
// 推一条 user 消息,让模型再走一轮对 5 项 checklist 做显式确认 —— 这是
// "硬关卡",与 PROMPT-01 的 4 阶段"软纪律"叠加。
//
// 关键约束:
// - 纯函数(handler / buildUserMessage) → 易测、易 opt-out。
// - 5 项 checklist 是稳定的字符串数组,fixture 可直接断言关键词。
// - 复用 PROMPT-01 核心文本中的 "verification is a hard prerequisite" 锚点
//   风格(不另起炉灶),但用单数第一人称直白的 checklist 措辞。
// - 与 thrash-tracker 风格正交:trash 是 hint(LLM 仍可继续 retry),checklist
//   是 gate(LLM 必须覆盖才能 done)。
// - opt-out 显式:plan 模式 / 调用方传 `preCompletionChecklist: false`。

import type { ModelFamily } from '../work-discipline.js';

/** 5 项 checklist 内容(稳定,fixture 直接断言)。措辞对齐 LangChain 实证。 */
export const CHECKLIST_ITEMS: readonly string[] = [
  'Did I actually run a command/test/compile, or did I just re-read my own code?',
  'Does the output match the original spec, not "what I thought I wrote"?',
  'Did I exercise the boundary I claim to have covered (not just the happy path)?',
  'Does the existing test suite still pass?',
  'If I cannot verify, did I tell the user explicitly instead of pretending to be done?',
];

/** 触发/不触发的判定上下文。 */
export interface ChecklistContext {
  /** 本 turn 内是否产生了 mutation(新增/修改/删除文件)。 */
  hadMutation: boolean;
  /** 最近一次 validation 的状态;'none' 表示本 turn 还没跑过 validation。 */
  lastValidationStatus: 'passed' | 'failed' | 'none';
  /** agent 模式(plan 不触发)。 */
  mode: 'auto' | 'plan';
  /** base model family,用于措辞变体(继承 PROMPT-01 per-model 适配)。 */
  modelFamily?: ModelFamily;
}

/** handler 决定:返回 true = 推 checklist 进 history,继续让模型走下一轮。 */
export type PreCompletionChecklistHandler = (ctx: ChecklistContext) => boolean;

/**
 * 拼出 checklist user 消息。固定 5 项 + 硬规则;以 `[checklist]` 起头
 * 便于 LLM 识别为强制二次确认(也便于 eval fixture 关键字定位)。
 */
export function buildChecklistUserMessage(modelFamily?: ModelFamily): string {
  const opener = modelFamily === 'anthropic'
    ? 'Verification gate — you have not actually run a command that exercises the change against the spec. Before declaring done, answer each item below explicitly:'
    : modelFamily === 'openai'
      ? 'MANDATORY pre-completion checklist. You MUST address every item below before your final reply:'
      : 'Pre-completion checklist — answer each item explicitly before declaring done:';

  const items = CHECKLIST_ITEMS.map((item, i) => `${i + 1}. ${item}`).join('\n');

  return `[checklist] ${opener}

${items}

Hard rule: "I read the code and it looks right" is not a completion signal. If you cannot run a verification, say so explicitly in your final reply. Do not paraphrase this checklist back as the answer — provide the actual evidence (which command, which output, which spec line it satisfied).

Bonus (ASK-01): Before declaring done, also answer: am I guessing any fact the user did not state? If yes, surface the guess to the user in your final reply or call \`ask_human\` (within the per-turn budget) — never silently guess on a non-reversible choice.`;
}

/** 默认 trigger 条件:有 mutation + 没工具调用 + 验证未通过或没跑过 + 非 plan。 */
export const defaultChecklistHandler: PreCompletionChecklistHandler = (ctx) => {
  if (ctx.mode === 'plan') return false;
  if (!ctx.hadMutation) return false;
  // 已经通过验证:放行,不再二次确认(避免噪声)。
  if (ctx.lastValidationStatus === 'passed') return false;
  return true;
};

/** 工厂:返回稳定句柄,便于在 eval / 测试里替换。 */
export interface PreCompletionChecklistMiddleware {
  /** 默认 handler(可被调用方替换为更严格的版本)。 */
  readonly handler: PreCompletionChecklistHandler;
  /** 拼出 user 消息的纯函数(注入到 history)。 */
  readonly buildUserMessage: (modelFamily?: ModelFamily) => string;
  /** 5 项 checklist 数组(只读)。 */
  readonly items: readonly string[];
}

export function createPreCompletionChecklistMiddleware(): PreCompletionChecklistMiddleware {
  return {
    handler: defaultChecklistHandler,
    buildUserMessage: buildChecklistUserMessage,
    items: CHECKLIST_ITEMS,
  };
}
