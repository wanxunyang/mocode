/**
 * 思考能力自描述（#model-catalog M3）：把目录的 reasoning_options（能力形态）
 * 翻译成请求体字段。纯函数。
 *
 * 目录只给「形态」（toggle / effort / budget_tokens），请求体字段名是厂商方言，
 * 因此用一张按 catalogProviderId 的小方言表；型号天天变、厂商方言很少变。
 * 未知厂商保守不下发（第三方网关可能对未知字段直接 400）。
 */
import type { CatalogReasoningOption } from './types.js';
import { THINK_BUDGET_BY_EFFORT } from './budgets.js';

/** 字段方言：决定同一种能力形态用什么请求字段表达。 */
type Dialect =
  | 'openai-effort' // { reasoning_effort }
  | 'thinking-toggle' // { thinking: { type: 'enabled'|'disabled' } }
  | 'qwen'; // { enable_thinking, thinking_budget? }

/**
 * catalogProviderId → 方言。一家厂商一种方言（alibaba 全系 Qwen）。
 * 未列出的 provider 返回 undefined → 保守不下发。
 */
const PROVIDER_DIALECT: Record<string, Dialect> = {
  openai: 'openai-effort',
  openrouter: 'openai-effort',
  xai: 'openai-effort',
  alibaba: 'qwen',
  zhipuai: 'thinking-toggle',
  volcengine: 'thinking-toggle',
  deepseek: 'thinking-toggle',
  moonshotai: 'thinking-toggle',
};

export function dialectForProvider(catalogProviderId: string | undefined): Dialect | undefined {
  return catalogProviderId ? PROVIDER_DIALECT[catalogProviderId] : undefined;
}

/** 在 effort values 中按归一化档位挑一个合法值（按优先级，找不到回退到最低/最高档）。 */
function pickEffortValue(effort: 'low' | 'medium' | 'high', values: string[], off: boolean): string {
  const v = values.map((s) => s.toLowerCase());
  const priorities: Record<string, string[]> = off
    ? { any: ['off', 'disabled', 'minimal', 'low'] }
    : effort === 'low'
      ? { any: ['low', 'minimal'] }
      : effort === 'medium'
        ? { any: ['medium', 'mid', 'low'] }
        : { any: ['high', 'xhigh', 'max', 'medium'] };
  for (const cand of priorities.any) {
    const hit = v.find((x) => x === cand || x.includes(cand));
    if (hit) return values[v.indexOf(hit)];
  }
  // 回退：off/低档取最低，高档取最高。
  return off || effort === 'low' ? values[0] : values[values.length - 1];
}

export interface CatalogReasoningInput {
  /** 归一化档位（调用处已排除 auto/off 之外的处理；off 也可能进入）。 */
  effort: 'off' | 'low' | 'medium' | 'high';
  catalogProviderId?: string;
  reasoningOptions?: CatalogReasoningOption[];
  /** budget clamp 上界（Anthropic 风格时不用；qwen budget 仅参考）。 */
  maxTokens?: number;
}

/**
 * 目录能力 → 请求字段；无法安全下发时返回 {}。
 * 依据第一个匹配的 reasoning_option 决定形态。
 */
export function paramsFromCatalog(input: CatalogReasoningInput): Record<string, unknown> {
  const dialect = dialectForProvider(input.catalogProviderId);
  if (!dialect) return {};
  const opts = input.reasoningOptions ?? [];

  const toggle = opts.find((o) => o.type === 'toggle');
  const effortOpt = opts.find((o) => o.type === 'effort');
  const budgetOpt = opts.find((o) => o.type === 'budget_tokens');

  const isOff = input.effort === 'off';

  // ── qwen 方言：enable_thinking + thinking_budget（budget 选项优先给预算） ──
  if (dialect === 'qwen') {
    if (isOff) return { enable_thinking: false };
    const base: Record<string, unknown> = { enable_thinking: true };
    if (budgetOpt) {
      let budget = THINK_BUDGET_BY_EFFORT[input.effort as 'low' | 'medium' | 'high'];
      if (typeof budgetOpt.min === 'number') budget = Math.max(budgetOpt.min, budget);
      base.thinking_budget = budget;
    }
    return base;
  }

  // ── openai effort 方言 ──
  if (dialect === 'openai-effort') {
    if (effortOpt?.values && effortOpt.values.length > 0) {
      // OpenAI 官方无法真关：off 落到最低档。
      return { reasoning_effort: pickEffortValue(input.effort as 'low' | 'medium' | 'high', effortOpt.values, isOff) };
    }
    if (toggle) {
      return isOff ? { reasoning_effort: 'low' } : { reasoning_effort: input.effort };
    }
    // 无 effort/toggle 元数据但已知是 OpenAI 方言：直接下发归一化档位（off→low）。
    return { reasoning_effort: isOff ? 'low' : input.effort };
  }

  // ── thinking-toggle 方言 ──
  if (dialect === 'thinking-toggle') {
    if (effortOpt?.values && effortOpt.values.length > 0 && !isOff) {
      // 个别厂商用 thinking 但分档（如 deepseek low/high/max）：仍只开关，标 enabled。
      return { thinking: { type: 'enabled' } };
    }
    return { thinking: { type: isOff ? 'disabled' : 'enabled' } };
  }

  return {};
}

/** 目录是否声明该模型支持思考（供 recognizesReasoning）。 */
export function recognizesFromCatalog(reasoning: boolean | undefined): boolean {
  return reasoning === true;
}
