/**
 * 目录 provider → mocode 现有请求路径的判定（#model-catalog M1）。
 *
 * 单一事实点：上游用 `npm`（Vercel AI SDK 包名）表达协议；mocode 不加载这些包，
 * 只据它映射到自己的两条 fetch 路径。新增协议适配时只改这里。
 */
import type { CatalogProvider } from './types.js';

export type MocodeProtocol = 'openai-chat' | 'anthropic-messages' | 'unsupported';

/** OpenAI 官方端点（官方 provider 记录通常不带 api 字段）。 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Anthropic 官方端点：provider 记录同样不带 api（端点内置 SDK）。
 * 不带 /v1——anthropic.ts 的 endpoint() 会在后面拼 `/v1/messages`。
 */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * 判定该 provider 能否用 mocode 现有 fetch 直发。
 * - 官方 anthropic 包 → Anthropic Messages 路径
 * - openai-compatible 且带端点 → OpenAI Chat 路径
 * - 官方 openai 包 → OpenAI Chat 路径（端点缺省补官方 /v1）
 * - 其余（google/bedrock/azure/vertex/各 gateway…）→ 二期，UI 置灰
 */
export function classifyProvider(provider: CatalogProvider): MocodeProtocol {
  switch (provider.npm) {
    case '@ai-sdk/anthropic':
      return 'anthropic-messages';
    case '@ai-sdk/openai-compatible':
      return provider.api && provider.api.trim() ? 'openai-chat' : 'unsupported';
    case '@ai-sdk/openai':
      return 'openai-chat';
    default:
      return 'unsupported';
  }
}

/** provider 实际要用的 baseURL：官方 openai/anthropic 缺 api 时补默认，其余原样返回。 */
export function resolveBaseURL(provider: CatalogProvider): string {
  if (provider.api && provider.api.trim()) return provider.api.trim();
  if (provider.npm === '@ai-sdk/openai') return OPENAI_DEFAULT_BASE_URL;
  if (provider.npm === '@ai-sdk/anthropic') return ANTHROPIC_DEFAULT_BASE_URL;
  return '';
}

/** 映射到 ModelPreset.provider（presets.ts 的两值）。 */
export function toPresetProvider(proto: MocodeProtocol): 'openai' | 'anthropic' | null {
  if (proto === 'openai-chat') return 'openai';
  if (proto === 'anthropic-messages') return 'anthropic';
  return null;
}
