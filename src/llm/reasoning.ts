/**
 * Reasoning Effort 适配层(#token-efficiency P3)。
 *
 * 用户只面对归一化五档 `off | low | medium | high | auto`,本模块按 provider +
 * 模型名模式匹配,翻译成各家方言字段:
 * - Anthropic 4.6+:`output_config.effort` + `thinking:{type:'adaptive'}`(新)
 * - Anthropic 旧版:`thinking:{type:'enabled', budget_tokens:N}`(budget 严格小于 max_tokens)
 * - OpenAI o 系 / gpt-5:`reasoning_effort`
 * - Qwen3(vLLM/OpenAI 兼容):`enable_thinking` + `thinking_budget`
 * - GLM-4.5/4.6/5:`thinking:{type:'enabled'|'disabled'}`
 *
 * 白名单驱动:未匹配到已知族的模型一律返回 {} —— 第三方中转可能因严格 schema
 * 校验对未知字段直接 400,不下发是唯一在所有后端都安全的策略。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'auto';

/**
 * Skill 激活期 effort scope(P3 §4.8):嵌套异步树(含子 agent)自动继承。
 * 取值优先级:显式 per-request overrides 参数 > 本 scope > 会话级 getActiveEffort()。
 * 刻意低于显式参数 —— compact/reflect 显式传 low 不被 skill effort 改写。
 */
const effortScope = new AsyncLocalStorage<ReasoningEffort>();

export function getScopedEffort(): ReasoningEffort | undefined {
  return effortScope.getStore();
}

/** 在 skill effort scope 内执行 fn;effort=auto 等同于不包。 */
export function runWithEffortScope<T>(effort: ReasoningEffort, fn: () => Promise<T>): Promise<T> {
  if (effort === 'auto') return fn();
  return effortScope.run(effort, fn);
}

const EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'auto'];

/** 解析外部输入(env / 命令行);非法值返回 undefined(调用方决定回落策略)。 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  let v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  v = v.trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined;
}

export interface ReasoningTarget {
  provider: 'openai' | 'anthropic';
  model: string;
  /** Anthropic budget_tokens 的 clamp 上界(max_tokens);不传按 8192 处理。 */
  maxTokens?: number;
}

/** 各档对应的思考预算(token):Anthropic budget_tokens / Qwen thinking_budget。 */
const THINK_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 1024,
  medium: 4096,
  high: 10240,
};

/** Anthropic:为正文预留的最小 token;budget = min(raw, maxTokens - RESERVED)。 */
const ANTHROPIC_OUTPUT_RESERVED = 1024;
const ANTHROPIC_DEFAULT_MAX = 8192;

/**
 * 目标模型是否识别 reasoning 参数(白名单命中)。
 * 供 /model show 给出「参数不会下发」提示,避免用户设了 high 却静默无效。
 */
export function recognizesReasoning(target: ReasoningTarget): boolean {
  if (target.provider === 'anthropic') return true;
  const m = target.model.toLowerCase();
  return (
    /\bo[134]\b/.test(m) ||
    /gpt-?5/.test(m) ||
    /qwen[-_]?3/.test(m) ||
    /deepseek[-_]?r1/.test(m) ||
    /glm[-_]?4[.-]?[56]/.test(m) ||
    /glm[-_]?5/.test(m)
  );
}

/**
 * 归一化 effort + 目标 → 要 merge 进请求体的字段(空对象 = 不下发)。纯函数。
 */
export function resolveReasoningParams(effort: ReasoningEffort, target: ReasoningTarget): Record<string, unknown> {
  if (effort === 'auto') return {};

  if (target.provider === 'anthropic') {
    const m = target.model.toLowerCase();
    // 仅认显式分隔的版本号 4-6/4.6/4_6/4-10…;宽松写法会误匹配名字里的日期(…20241022 中的 410)。
    const is46Plus = /4[.\-_](?:[6-9]|[1-9]\d)(?!\d)/.test(m);
    if (is46Plus) {
      if (effort === 'off') return { thinking: { type: 'disabled' } };
      return { output_config: { effort }, thinking: { type: 'adaptive' } };
    }
    if (effort === 'off') return {};
    // 旧版:budget 必须严格小于 max_tokens,clamp 后非正 → 无法启用,不下发。
    const maxTokens = target.maxTokens ?? ANTHROPIC_DEFAULT_MAX;
    const budget = Math.min(THINK_BUDGET[effort], maxTokens - ANTHROPIC_OUTPUT_RESERVED);
    if (budget <= 0) return {};
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }

  // ── OpenAI 兼容路径 ──
  const m = target.model.toLowerCase();

  // Qwen3(先于通用规则:名字里不含冲突模式,但显式更清晰)。
  if (/qwen[-_]?3/.test(m)) {
    if (effort === 'off') return { enable_thinking: false };
    return { enable_thinking: true, thinking_budget: THINK_BUDGET[effort as 'low' | 'medium' | 'high'] };
  }

  // GLM-4.5/4.6/5。
  if (/glm[-_]?4[.-]?[56]/.test(m) || /glm[-_]?5/.test(m)) {
    if (effort === 'off') return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'enabled' } };
  }

  // DeepSeek-R1:无开关参数,任何档位都不下发。
  if (/deepseek[-_]?r1/.test(m)) return {};

  // OpenAI o1/o3/o4 + gpt-5:off 无法真关,官方最低档 low。
  if (/\bo[134]\b/.test(m) || /gpt-?5/.test(m)) {
    if (effort === 'off') return { reasoning_effort: 'low' };
    return { reasoning_effort: effort };
  }

  // 未知模型/第三方网关:白名单策略,不下发。
  return {};
}
