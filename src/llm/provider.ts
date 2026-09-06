/**
 * ModelProvider 抽象(2.0 步骤3):把「某种模型后端怎么做一次流式 chat」从 chat() 的
 * 硬编码 if-else 分流(config.provider === 'anthropic' ? … : …)变成注册表查找。
 * 新增 provider(Responses API / 本地模型 / 事件式模型)只需 registerModelProvider,
 * 不再需要改 chat() 本体。
 *
 * 本模块只对 index.ts 做 type-only import(运行期零依赖,不构成循环引用);
 * 不读 config、不持会话状态,注册表是显式的进程级插件点。默认 provider(openai /
 * anthropic)由 index.ts 在模块初始化时注册,与既有 config.provider 行为完全一致。
 */

import type { ChatMessage, ChatResult, ChatTool, StreamHandlers } from './index.js';
import type { ModelProviderRuntime } from './runtime.js';

/** 单次流式 LLM 请求的 provider 实现(无重试;重试由 chat() 外层统一负责)。 */
export interface ModelProvider {
  /** 与 config.provider / LLM_PROVIDER 对应的标识('openai' / 'anthropic' / …)。 */
  readonly name: string;
  /**
   * 执行一次流式 chat。签名对齐既有 chatOnce/anthropicChatOnce:
   * tools 为 undefined 时由 provider 自行决定缺省(如 anthropic 用 chatTools 兜底)。
   */
  chatOnce(
    messages: ChatMessage[],
    handlers: StreamHandlers,
    signal: AbortSignal | undefined,
    tools: ChatTool[] | undefined,
    /** Built-ins consume this explicit context; existing custom providers may ignore it. */
    runtime?: ModelProviderRuntime,
  ): Promise<ChatResult>;
}

const providers = new Map<string, ModelProvider>();

/** 注册一个 provider;同名覆盖(与 registerToolsExtension 的按源替换语义一致)。 */
export function registerModelProvider(provider: ModelProvider): void {
  providers.set(provider.name, provider);
}

/** 按名取 provider;未注册返 undefined(chat() 据此报清晰错误)。 */
export function getModelProvider(name: string): ModelProvider | undefined {
  return providers.get(name);
}

/** 列出已注册 provider 名(错误提示/诊断用)。 */
export function listModelProviders(): string[] {
  return [...providers.keys()];
}
