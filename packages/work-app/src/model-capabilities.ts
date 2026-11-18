/**
 * 浏览器与主进程共用的模型类型、思考能力探测。
 *
 * 本文件只能包含纯 JavaScript/类型，不得 import node:*。renderer 没有打包器，
 * 会把这里原样交给 Chromium 执行；文件 I/O 与 env 应用放在 model-config.ts。
 */
export interface CatalogReasoningOption {
  type: 'toggle' | 'effort' | 'budget_tokens';
  values?: string[];
  min?: number;
}

export const EFFORT_VALUES = ['off', 'low', 'medium', 'high', 'auto'] as const;
export type EffortValue = (typeof EFFORT_VALUES)[number];
export type AdjustableEffort = Exclude<EffortValue, 'auto'>;

export function parseEffort(value: unknown): EffortValue | undefined {
  return typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as EffortValue
    : undefined;
}

export interface WorkPresetFile {
  name: string;
  provider: 'openai' | 'anthropic' | 'google';
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  anthropicPromptCache: boolean;
  /** 每模型独立的思考强度；缺省 auto = 不下发，沿用后端默认。 */
  reasoningEffort?: EffortValue;
  /** 单次回复输出上限；缺省不下发。 */
  maxTokens?: number;
  catalogProvider?: string;
  catalogModel?: string;
  capabilities?: {
    reasoning?: boolean;
    reasoningOptions?: CatalogReasoningOption[];
    toolCall?: boolean;
    attachment?: boolean;
  };
  pricing?: { input?: number; output?: number; cacheRead?: number };
}

export type WorkPresetDraft = Omit<WorkPresetFile, 'name' | 'anthropicPromptCache'> & {
  anthropicPromptCache?: boolean;
};

export interface ReasoningCapability {
  /** 是否识别到思考能力；supportedEfforts 才决定能否调整。 */
  supported: boolean;
  supportedEfforts: AdjustableEffort[];
  /** toggle = 只能关/开；levels = 有多档；unknown = 不敢给未知端点下发字段。 */
  mode: 'unsupported' | 'toggle' | 'levels' | 'unknown';
  /** 归一化档映射到的后端档位，如 medium → high；仅作展示。 */
  effortMap: Partial<Record<AdjustableEffort, string>>;
  /** 当前 maxTokens 太小时，UI 需要额外提示，不能假装档位已生效。 */
  requiresLargerOutput?: boolean;
}

/** 与 core resolveReasoningParams / paramsFromCatalog 的档位语义对齐。
 * 同档映射到多个后端值时，必须也修改 core；这里刻意不引入 core，守住 renderer 边界。 */
const TOGGLE_PROVIDERS = new Set(['zhipuai', 'volcengine', 'moonshotai']);
const EFFORT_PROVIDERS = new Set(['openai', 'openrouter', 'xai']);
const CATALOG_PROVIDERS = new Set(['deepseek', 'alibaba', ...TOGGLE_PROVIDERS, ...EFFORT_PROVIDERS]);

function catalogEffortMap(values: string[] | undefined, mediumPrefersHigh: boolean): ReasoningCapability['effortMap'] {
  if (!values?.length) return mediumPrefersHigh ? { low: 'low', medium: 'high', high: 'high' } : {};
  const lower = values.map((value) => value.toLowerCase());
  const find = (candidates: string[]): string | undefined => {
    for (const candidate of candidates) {
      const index = lower.findIndex((value) => value === candidate || value.includes(candidate));
      if (index >= 0) return values[index];
    }
    return undefined;
  };
  const result: ReasoningCapability['effortMap'] = {};
  for (const effort of ['low', 'medium', 'high'] as const) {
    const priorities = effort === 'low'
      ? ['low', 'minimal']
      : effort === 'medium'
        ? mediumPrefersHigh ? ['medium', 'mid', 'high'] : ['medium', 'mid', 'low']
        : ['high', 'xhigh', 'max', 'medium'];
    result[effort] = find(priorities) ?? (effort === 'high' ? values[values.length - 1] : values[0]);
  }
  return result;
}

/** 创建表单与悬停页共用的「支持不支持 / 支持几档」探测。请求翻译只在 core 发生。 */
export function reasoningCapabilityForPreset(preset: WorkPresetDraft): ReasoningCapability {
  const model = preset.model.toLowerCase();
  const catalogKnown = typeof preset.capabilities?.reasoning === 'boolean';
  const options = preset.capabilities?.reasoningOptions ?? [];
  const effortOption = options.find((option) => option.type === 'effort' && (option.values?.length ?? 0) > 0);
  const provider = preset.catalogProvider ?? '';
  const openAiModel = /\bo[134]\b|gpt-?5/.test(model);
  const deepseekModel = /deepseek[-_]?(?:v4|flash)/.test(model);
  const qwenModel = /qwen[-_]?3/.test(model);
  const toggleModel = /doubao[-_]?seed|glm[-_]?4[.-]?[56]|glm[-_]?5/.test(model);
  const regexSupported = openAiModel || deepseekModel || qwenModel || toggleModel;
  const supported = catalogKnown ? preset.capabilities?.reasoning === true : preset.provider === 'anthropic' || regexSupported;
  const unsupported = (mode: ReasoningCapability['mode']): ReasoningCapability => ({ supported, supportedEfforts: [], mode, effortMap: {} });
  if (!supported) return unsupported(catalogKnown ? 'unsupported' : 'unknown');
  // R1 会思考，但没有可供用户调节的开关或档位。
  if (/deepseek[-_]?r1/.test(model)) return unsupported('unsupported');

  // core 先尝试目录方言；仅在目录方言无法产出字段时才落型号正则。
  // 不能因型号里出现 deepseek/qwen 就把 Alibaba/OpenRouter 的方言换成官方 DeepSeek。
  if (provider === 'alibaba') {
    const budget = options.some((option) => option.type === 'budget_tokens');
    return budget
      ? { supported: true, supportedEfforts: ['off', 'low', 'medium', 'high'], mode: 'levels', effortMap: {} }
      : { supported: true, supportedEfforts: ['off', 'high'], mode: 'toggle', effortMap: {} };
  }
  if (provider === 'deepseek') {
    return { supported: true, supportedEfforts: ['off', 'low', 'medium', 'high'], mode: 'levels', effortMap: catalogEffortMap(effortOption?.values, true) };
  }
  if (EFFORT_PROVIDERS.has(provider)) {
    const effortMap = catalogEffortMap(effortOption?.values, false);
    // OpenAI 方言只有目录显式给 none/off/disabled 才能真关；否则 off 会降为最低思考档。
    const disableValue = effortOption?.values?.find((value) => /^(none|off|disabled)$/i.test(value));
    return {
      supported: true,
      supportedEfforts: [...(disableValue ? ['off' as const] : []), 'low', 'medium', 'high'],
      mode: 'levels',
      effortMap: disableValue ? { ...effortMap, off: disableValue } : effortMap,
    };
  }
  // 这些 core 方言只认开关，即使目录额外给了 effort values 也不能假装分档。
  if (TOGGLE_PROVIDERS.has(provider)) {
    return { supported: true, supportedEfforts: ['off', 'high'], mode: 'toggle', effortMap: {} };
  }

  // Anthropic 旧协议要求 budget_tokens 严格小于 max_tokens；core 会预留 1024 tokens
  // 给正文，因此 maxTokens<=1024 时根本不下发思考。UI 必须挡住，而不是保存一个无效档。
  if (preset.provider === 'anthropic' && !/4[.\-_](?:[6-9]|[1-9]\d)(?!\d)/.test(model)) {
    const requiresLargerOutput = preset.maxTokens !== undefined && preset.maxTokens <= 1024;
    return {
      supported: true,
      supportedEfforts: requiresLargerOutput ? ['off'] : ['off', 'low', 'medium', 'high'],
      mode: 'levels',
      effortMap: {},
      ...(requiresLargerOutput ? { requiresLargerOutput: true } : {}),
    };
  }

  // 无目录或未知厂商走 core 的型号白名单兜底。
  if (toggleModel) return { supported: true, supportedEfforts: ['off', 'high'], mode: 'toggle', effortMap: {} };
  if (deepseekModel || qwenModel || preset.provider === 'anthropic') {
    const deepseekOfficial = deepseekModel && !/dashscope(?:-[a-z]+)?\.aliyuncs\.com/i.test(preset.baseURL);
    return {
      supported: true,
      supportedEfforts: ['off', 'low', 'medium', 'high'],
      mode: 'levels',
      effortMap: deepseekOfficial ? catalogEffortMap(effortOption?.values, true) : {},
    };
  }
  if (openAiModel) {
    return { supported: true, supportedEfforts: ['low', 'medium', 'high'], mode: 'levels', effortMap: catalogEffortMap(effortOption?.values, false) };
  }
  // 目录可能描述思考能力，但 core 没实现这个厂商的字段方言：只允许 auto。
  return unsupported(CATALOG_PROVIDERS.has(provider) ? 'unsupported' : 'unknown');
}
