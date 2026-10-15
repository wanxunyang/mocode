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

/**
 * 每个 RuntimeContext 独占的底层客户端状态；transport 始终从该可变容器取当前客户端。
 *
 * OpenAI SDK 客户端懒持有:openai 包是千余文件的巨型依赖,模块顶层 import 会让冷启动
 * (开机后磁盘缓存冷)多花数秒。首帧 UI 不需要它,故推迟到首次真实请求经 getOpenAI()
 * 时才加载;注入了 openAICreateImpl 的测试/桩路径永不加载。
 */
export interface ChatClientState {
  /** 首次调用时才加载 openai 包并实例化客户端;之后返回缓存实例。 */
  getOpenAI: () => Promise<OpenAI>;
  /** /model 等切换 baseURL/apiKey 后调用:丢弃缓存客户端,下次 getOpenAI 用新配置重建。 */
  resetOpenAI: (config: ModelRuntimeConfig) => void;
  openAICreateImpl: ChatCreateImpl | null;
  anthropicFetchImpl: AnthropicFetchImpl;
}

/** provider 单次请求所需的显式运行时依赖。 */
export interface ModelProviderRuntime {
  config: ModelRuntimeConfig;
  getModel: () => string;
  clientState: ChatClientState;
}
