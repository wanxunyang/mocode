import type OpenAI from 'openai';
import type { Config } from '../config/index.js';

/** LLM 配置中 transport 真正消费的最小运行时视图；完整 Config 可直接传入。 */
export type ModelRuntimeConfig = Pick<
  Config,
  'provider' | 'baseURL' | 'apiKey' | 'maxTokens' | 'includeUsage' | 'anthropicPromptCache'
>;

export type ChatCreateImpl = (
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } | undefined,
) => Promise<AsyncIterable<unknown>>;

export type AnthropicFetchImpl = (input: string, init: RequestInit) => Promise<Response>;

/** 每个 RuntimeContext 独占的底层客户端状态；transport 始终从该可变容器取当前客户端。 */
export interface ChatClientState {
  openAI: OpenAI;
  openAICreateImpl: ChatCreateImpl | null;
  anthropicFetchImpl: AnthropicFetchImpl;
}

/** provider 单次请求所需的显式运行时依赖。 */
export interface ModelProviderRuntime {
  config: ModelRuntimeConfig;
  getModel: () => string;
  clientState: ChatClientState;
}
