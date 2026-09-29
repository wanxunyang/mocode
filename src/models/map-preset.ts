/**
 * 目录 (provider, model) → 现有 ModelPreset 的纯映射（#model-catalog M1）。
 *
 * 不做 I/O、不读 config 单例；apiKey 由调用方传入（或经 resolveApiKey 从 env 读）。
 * 这样命令层与测试都能直接用，且不落盘——落盘仍归 presets.ts。
 */
import type { CatalogModel, CatalogProvider } from './types.js';
import { classifyModel, resolveModelBaseURL, toPresetProvider } from './protocol.js';

/** 上下文窗口缺失/为 0 时的保守默认（宁可小，避免超长发出去被拒）。 */
export const FALLBACK_CONTEXT_WINDOW = 128000;

/**
 * 按 provider.env 声明的变量名顺序找一个已设置的 key；都没有返回 null。
 * 读 process.env 是本模块唯一触碰环境的地方，调用方可传 env 覆盖以便测试。
 */
export function resolveApiKey(provider: CatalogProvider, env: NodeJS.ProcessEnv = process.env): string | null {
  // models.dev 的 google-vertex.env 是 project/location/ADC，不是 Express API key；不能误当密钥。
  const googleKeyEnvs = ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'];
  const keyNames = isGeminiProvider(provider)
    ? provider.npm === '@ai-sdk/google-vertex'
      ? googleKeyEnvs
      : [...new Set([...googleKeyEnvs, ...(provider.env ?? [])])]
    : (provider.env ?? []);
  for (const keyName of keyNames) {
    const v = env[keyName];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** 把目录来源拼成合法预设名：`<provider>-<model>` 去非法字符。 */
export function isGeminiProvider(provider: Pick<CatalogProvider, 'id' | 'npm'>): boolean {
  return (
    provider.id === 'google' ||
    provider.id === 'google-vertex' ||
    provider.npm === '@ai-sdk/google' ||
    provider.npm === '@ai-sdk/google-vertex'
  );
}

/** Vertex 目录的首个 env 是 project 变量；API key 接入时应优先提示实际使用的 key。 */
export function preferredKeyEnvName(provider: CatalogProvider): string {
  if (isGeminiProvider(provider)) return 'GOOGLE_CLOUD_API_KEY';
  return provider.env?.[0] ?? 'API_KEY';
}

export function defaultPresetName(providerId: string, modelId: string): string {
  const raw = `${providerId}-${modelId}`;
  const sanitized =
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'preset';
  return sanitized;
}

export interface BuildPresetInput {
  provider: CatalogProvider;
  model: CatalogModel;
  apiKey: string;
  /** 覆盖预设名；不传用 defaultPresetName。 */
  name?: string;
  /** 覆盖实际下发的模型名（火山等 endpoint id 与目录 id 不一致时用）。 */
  modelOverride?: string;
}

/**
 * 产出可直接 savePreset 的对象。provider 不被现有 fetch 支持时返回 null
 * （命令层据此置灰/拒绝，避免存一个必错的预设）。
 */
export function buildPreset(input: BuildPresetInput) {
  const { provider, model } = input;
  const proto = classifyModel(provider, model);
  const presetProvider = toPresetProvider(proto);
  if (!presetProvider) return null;

  const baseURL = resolveModelBaseURL(provider, model);
  if (!baseURL) return null;

  const contextWindow =
    typeof model.limit?.context === 'number' && model.limit.context > 0
      ? Math.floor(model.limit.context)
      : FALLBACK_CONTEXT_WINDOW;

  return {
    name: input.name ?? defaultPresetName(provider.id, model.id),
    provider: presetProvider,
    baseURL,
    apiKey: input.apiKey,
    model: input.modelOverride ?? model.id,
    contextWindow,
    anthropicPromptCache: presetProvider === 'anthropic',
  };
}
