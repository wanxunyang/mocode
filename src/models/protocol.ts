/**
 * 目录 provider → mocode 请求路径的判定（#model-catalog M1）。
 *
 * 单一事实点：上游用 `npm`（Vercel AI SDK 包名）表达协议；mocode 不加载这些包，
 * 只据它映射到自己的 fetch 路径。新增协议适配时只改这里。
 */
import type { CatalogProvider } from './types.js';

export type MocodeProtocol = 'openai-chat' | 'anthropic-messages' | 'gemini-contents' | 'unsupported';

/** OpenAI 官方端点（官方 provider 记录通常不带 api 字段）。 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Anthropic 官方端点：provider 记录同样不带 api（端点内置 SDK）。
 * 不带 /v1——anthropic.ts 的 endpoint() 会在后面拼 `/v1/messages`。
 */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Gemini Developer API 的模型目录。 */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Vertex Express API 全局端点（不含区域前缀）：模型目录最全，API key 可直接直发。
 * Google GenAI SDK 的 `genai.Client(vertexai=True, api_key=...)` 默认就是这个端点。
 * 网络出口国家由本机代理决定，与 Vertex 区域无关。
 */
export const VERTEX_DEFAULT_BASE_URL = 'https://aiplatform.googleapis.com/v1/publishers/google/models';

/**
 * 判定该 provider 能否用 mocode 现有 fetch 直发。
 * - 官方 anthropic 包 → Anthropic Messages 路径
 * - openai-compatible 且带端点 → OpenAI Chat 路径
 * - 官方 openai 包 → OpenAI Chat 路径（端点缺省补官方 /v1）
 * - Google / Vertex Gemini → Gemini Contents 路径
 * - 其余（bedrock/azure/Vertex Anthropic/各 gateway…）→ 暂不支持
 */
export function classifyProvider(provider: CatalogProvider): MocodeProtocol {
  switch (provider.npm) {
    case '@ai-sdk/anthropic':
      return 'anthropic-messages';
    case '@ai-sdk/openai-compatible':
      return provider.api && provider.api.trim() ? 'openai-chat' : 'unsupported';
    case '@ai-sdk/openai':
      return 'openai-chat';
    case '@ai-sdk/google':
    case '@ai-sdk/google-vertex':
      return 'gemini-contents';
    default:
      return 'unsupported';
  }
}

function vertexBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  // 默认走全局 Express 端点；仅当显式设置 GOOGLE_VERTEX_LOCATION（需要数据驻留）时用区域端点。
  // 注意：区域端点的模型上线晚于全局端点，部分新模型在区域端点可能 404。
  const raw = env.GOOGLE_VERTEX_LOCATION?.trim().toLowerCase() ?? '';
  if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(raw)) {
    return `https://${raw}-aiplatform.googleapis.com/v1/publishers/google/models`;
  }
  return VERTEX_DEFAULT_BASE_URL;
}

/** 模型级协议覆盖优先；未覆盖时使用 provider 顶层协议。 */
export function classifyModel(
  provider: CatalogProvider,
  model?: { id?: string; provider?: { npm?: string; api?: string } },
): MocodeProtocol {
  const npm = model?.provider?.npm;
  if (npm === '@ai-sdk/google-vertex/anthropic') return 'unsupported';
  if (npm === '@ai-sdk/openai-compatible') {
    const api = model?.provider?.api?.trim();
    // Vertex MaaS 模板需要 project/location/ADC，不属于本次 Express API key 直连路径。
    return api && !api.includes('${') ? 'openai-chat' : 'unsupported';
  }
  return classifyProvider(provider);
}

/** 模型级 baseURL 覆盖优先；未覆盖时使用 provider 顶层端点。 */
export function resolveModelBaseURL(
  provider: CatalogProvider,
  model?: { id?: string; provider?: { npm?: string; api?: string } },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (model?.provider?.api?.trim()) return model.provider.api.trim();
  return resolveBaseURL(provider, env);
}

/** provider 实际要用的 baseURL：显式 api 优先，否则按协议补官方默认值。 */
export function resolveBaseURL(provider: CatalogProvider, env: NodeJS.ProcessEnv = process.env): string {
  if (provider.api && provider.api.trim()) return provider.api.trim();
  if (provider.npm === '@ai-sdk/openai') return OPENAI_DEFAULT_BASE_URL;
  if (provider.npm === '@ai-sdk/anthropic') return ANTHROPIC_DEFAULT_BASE_URL;
  if (provider.npm === '@ai-sdk/google') return GEMINI_DEFAULT_BASE_URL;
  if (provider.npm === '@ai-sdk/google-vertex') return vertexBaseURL(env);
  return '';
}

/** 映射到 ModelPreset.provider。 */
export function toPresetProvider(proto: MocodeProtocol): 'openai' | 'anthropic' | 'google' | null {
  if (proto === 'openai-chat') return 'openai';
  if (proto === 'anthropic-messages') return 'anthropic';
  if (proto === 'gemini-contents') return 'google';
  return null;
}
