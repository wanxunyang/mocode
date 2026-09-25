import { config, effectiveReasoningEffort, getActiveModel } from '../../config/index.js';
import type {
  ChatMessage,
  ChatResult,
  ChatTool,
  ChatUsage,
  LlmRequestOverrides,
  StreamHandlers,
  ToolCallRef,
} from '../index.js';
import { resolveReasoningParams } from '../reasoning.js';
import type { AnthropicFetchImpl, ModelProviderRuntime } from '../runtime.js';
import { markStreamInterrupted } from '../stream-interrupt.js';

type JsonObject = Record<string, unknown>;
type AnthropicRole = 'user' | 'assistant';
type AnthropicBlock = Record<string, unknown> & { type: string };
type AnthropicMessage = { role: AnthropicRole; content: AnthropicBlock[] };

let fetchImplOverride: AnthropicFetchImpl | null = null;

/** 仅供单测注入；生产路径使用 Node 18+ 全局 fetch。 */
export function __setAnthropicFetchImpl(impl: AnthropicFetchImpl | null): void {
  fetchImplOverride = impl;
}

/** Default runtime keeps the historical process-level test override behavior. */
export function defaultAnthropicFetch(input: string, init: RequestInit): Promise<Response> {
  return (fetchImplOverride ?? fetch)(input, init);
}

function parseJsonObject(value: string): JsonObject {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

function textBlocks(content: unknown): AnthropicBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }];
  const blocks: AnthropicBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type !== 'image_url') continue;
    const image = part.image_url as { url?: unknown } | undefined;
    if (typeof image?.url !== 'string') continue;
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(image.url);
    if (!match) continue;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] },
    });
  }
  return blocks;
}

function appendMessage(
  messages: AnthropicMessage[],
  role: AnthropicRole,
  blocks: AnthropicBlock[],
  cacheCandidates: AnthropicBlock[],
  cacheable = true,
): void {
  if (blocks.length === 0) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: [...blocks] });
  if (cacheable) cacheCandidates.push(...blocks);
}

/**
 * 把会话落盘使用的 OpenAI 兼容消息转换为 Anthropic Messages 内容块。
 * history 保持旧格式以兼容已有 session；provider 边界负责 tool_use/tool_result 编码。
 */
export function encodeAnthropicMessages(
  input: ChatMessage[],
  promptCache = config.anthropicPromptCache,
): { system: AnthropicBlock[]; messages: AnthropicMessage[] } {
  const system: AnthropicBlock[] = [];
  const messages: AnthropicMessage[] = [];
  const cacheCandidates: AnthropicBlock[] = [];
  let dialogStarted = false;

  for (const raw of input) {
    const message = raw as unknown as {
      role?: string;
      content?: unknown;
      tool_call_id?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    if (message.role === 'system' && !dialogStarted) {
      system.push(...textBlocks(message.content));
      continue;
    }
    dialogStarted = true;
    if (message.role === 'system') {
      const blocks = textBlocks(message.content).map((block) => ({
        ...block,
        text: `[System reminder]\n${String(block.text ?? '')}`,
      }));
      // 动态尾部 reminder 每步可能变化，不把 cache breakpoint 放在它之后。
      appendMessage(messages, 'user', blocks, cacheCandidates, false);
      continue;
    }
    if (message.role === 'user') {
      appendMessage(messages, 'user', textBlocks(message.content), cacheCandidates);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = textBlocks(message.content);
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id ?? '',
          name: call.function?.name ?? '',
          input: parseJsonObject(call.function?.arguments ?? ''),
        });
      }
      appendMessage(messages, 'assistant', blocks, cacheCandidates);
      continue;
    }
    if (message.role === 'tool') {
      appendMessage(
        messages,
        'user',
        [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
          },
        ],
        cacheCandidates,
      );
    }
  }

  /** Anthropic 允许的最大 cache 断点数(硬上限,超出直接 400)。 */
  const MAX_CACHE_BREAKPOINTS = 4;
  /** tools 断点在 encodeAnthropicTools 里打;tool 列表通常恒非空,这里保守预留它那一份额度。 */
  const TOOLS_BREAKPOINT_RESERVE = 1;
  /** 文档建议「最近 3 个 tool_result」;实际额度受 MAX_CACHE_BREAKPOINTS 约束后通常是 2。 */
  const MAX_TOOL_RESULT_BREAKPOINTS = 3;

  /**
   * 打 cache 断点。对齐 Anthropic computer use 官方实践:**system + tools + 最近若干 tool_result**。
   *
   * 以前只在"最后一个稳定消息块"打 1 个 —— 那通常是本轮刚回灌的 tool_result / 最新用户图,
   * 每轮都不一样,既拍不到真正稳定的前缀,又浪费了额度。
   *
   * 前缀越长、命中率越高,所以断点优先给**靠后但仍稳定**的 tool_result(tool 结果一旦提交永不改)。
   *
   * 注意:断点打在**本函数新建的 block 对象**上,不会写回 history 的消息对象 →
   * 天然"每轮清空",不存在跨轮累积超限的问题。
   */
  function markCacheBreakpoints(system: AnthropicBlock[], cacheCandidates: AnthropicBlock[]): void {
    let used = TOOLS_BREAKPOINT_RESERVE;
    if (system.length > 0) {
      system[system.length - 1].cache_control = { type: 'ephemeral' };
      used++;
    }
    const toolResults = cacheCandidates.filter((block) => block.type === 'tool_result');
    const slots = Math.min(MAX_TOOL_RESULT_BREAKPOINTS, MAX_CACHE_BREAKPOINTS - used);
    if (slots <= 0) return;
    if (toolResults.length > 0) {
      for (const block of toolResults.slice(-slots)) {
        block.cache_control = { type: 'ephemeral' };
      }
      return;
    }
    // 纯对话(没有 tool_result)时退化到旧行为:最后一个稳定消息块。
    const last = cacheCandidates[cacheCandidates.length - 1];
    if (last) last.cache_control = { type: 'ephemeral' };
  }

  if (promptCache) {
    markCacheBreakpoints(system, cacheCandidates);
  }
  return { system, messages };
}

export function encodeAnthropicTools(
  tools: readonly ChatTool[],
  promptCache = config.anthropicPromptCache,
): JsonObject[] {
  const encoded: JsonObject[] = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }));
  if (promptCache && encoded.length > 0) {
    encoded[encoded.length - 1] = {
      ...encoded[encoded.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  return encoded;
}

function endpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  if (/\/v1\/messages$/i.test(base)) return base;
  return `${base}/v1/messages`;
}

export function buildAnthropicRequest(
  messages: ChatMessage[],
  tools: readonly ChatTool[],
  runtime?: Pick<ModelProviderRuntime, 'config' | 'getModel'>,
  overrides?: LlmRequestOverrides,
): JsonObject {
  const runtimeConfig = runtime?.config ?? config;
  const encoded = encodeAnthropicMessages(messages, runtimeConfig.anthropicPromptCache);
  const anthropicTools = encodeAnthropicTools(tools, runtimeConfig.anthropicPromptCache);
  const effort = effectiveReasoningEffort(overrides?.reasoningEffort);
  const reasoningParams =
    effort === 'auto'
      ? {}
      : resolveReasoningParams(effort, {
          provider: 'anthropic',
          model: runtime?.getModel() ?? getActiveModel(),
          maxTokens: runtimeConfig.maxTokens,
        });
  return {
    model: runtime?.getModel() ?? getActiveModel(),
    max_tokens: runtimeConfig.maxTokens ?? 8192,
    stream: true,
    system: encoded.system,
    messages: encoded.messages,
    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    ...reasoningParams,
  };
}

class AnthropicHttpError extends Error {
  status: number;
  code?: string;
  headers: Headers;

  constructor(status: number, message: string, headers: Headers, code?: string) {
    super(message);
    this.name = 'AnthropicAPIError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let message = `Anthropic API HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const body = JSON.parse(await response.text()) as {
      error?: { message?: unknown; type?: unknown };
    };
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.type === 'string') code = body.error.type;
  } catch {
    // 非 JSON 错误页只保留状态码，避免把代理 HTML 大段写进 TUI。
  }
  throw new AnthropicHttpError(response.status, message, response.headers, code);
}

interface SseRecord {
  event: string;
  data: string;
}

function decodeSseRecord(record: string): SseRecord | null {
  let event = '';
  const data: string[] = [];
  for (const line of record.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

async function* readSse(response: Response): AsyncIterable<SseRecord> {
  if (!response.body) throw new Error('Anthropic 流式响应缺少 body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const record = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = decodeSseRecord(record);
      if (parsed) yield parsed;
    }
    if (done) break;
  }
  const parsed = decodeSseRecord(buffer);
  if (parsed) yield parsed;
}

function finiteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageFromAnthropic(raw: Record<string, unknown>): ChatUsage {
  const direct = finiteToken(raw.input_tokens);
  const cacheRead = finiteToken(raw.cache_read_input_tokens);
  const cacheCreation = finiteToken(raw.cache_creation_input_tokens);
  const output = finiteToken(raw.output_tokens);
  const prompt = direct + cacheRead + cacheCreation;
  return {
    promptTokens: prompt,
    completionTokens: output,
    totalTokens: prompt + output,
    cachedTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: 0,
  };
}

function addLiveCount(text: string, state: { cjk: number; other: number }): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7a3)
    )
      state.cjk++;
    else state.other++;
  }
}

/** Anthropic Messages API 单次请求；外层 chat() 继续统一负责重试。 */
export async function anthropicChatOnce(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  tools: readonly ChatTool[],
  runtime?: ModelProviderRuntime,
  overrides?: LlmRequestOverrides,
): Promise<ChatResult> {
  const runtimeConfig = runtime?.config ?? config;
  const fetchImpl = runtime?.clientState.anthropicFetchImpl ?? defaultAnthropicFetch;
  const response = await fetchImpl(endpoint(runtimeConfig.baseURL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': runtimeConfig.apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
    },
    body: JSON.stringify(buildAnthropicRequest(messages, tools, runtime, overrides)),
    signal,
  });
  if (!response.ok) await throwResponseError(response);

  let content = '';
  let usage: ChatUsage | undefined;
  const toolAcc = new Map<number, ToolCallRef>();
  const live = { cjk: 0, other: 0 };
  const reportLive = (): void => {
    handlers.onProgress?.({ completionTokens: Math.ceil(live.cjk + live.other / 4) });
  };

  for await (const record of readSse(response)) {
    if (record.data === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(record.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === 'string' ? event.type : record.event;
    if (type === 'error') {
      const error = event.error as { message?: unknown; type?: unknown } | undefined;
      const thrown = new Error(typeof error?.message === 'string' ? error.message : 'Anthropic stream error');
      thrown.name = typeof error?.type === 'string' ? error.type : 'AnthropicStreamError';
      // 打「流中途中断」标记:HTTP 层已 200 建连说明请求本身被接受了,流内报错必然是服务端侧
      // (overloaded_error / api_error 等瞬时故障)。没有这个标记,它就是个无 status 的普通
      // Error → isRetryableError 一条都不命中 → 整轮 run 直接终止、一次都不重试。
      // 真正的重试门槛由 chatWithRuntime 的「本次尝试零产出」前提把关。
      markStreamInterrupted(thrown);
      throw thrown;
    }
    if (type === 'message_start') {
      const message = event.message as { usage?: Record<string, unknown> } | undefined;
      if (message?.usage) usage = usageFromAnthropic(message.usage);
      continue;
    }
    if (type === 'content_block_start') {
      const index = finiteToken(event.index);
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        content += block.text;
        addLiveCount(block.text, live);
        handlers.onText?.(block.text);
        reportLive();
      } else if (block?.type === 'tool_use') {
        const initialInput =
          block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : undefined;
        const call: ToolCallRef = {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          // 流式 tool_use 通常以 input:{} 开始，真正 JSON 紧随 input_json_delta；
          // 只有非空 input 才直接采用，避免累加成 `{}{...}`。
          arguments: initialInput && Object.keys(initialInput).length > 0 ? JSON.stringify(initialInput) : '',
        };
        toolAcc.set(index, call);
        if (call.name) handlers.onToolCall?.(call.name);
      }
      continue;
    }
    if (type === 'content_block_delta') {
      const index = finiteToken(event.index);
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        content += delta.text;
        addLiveCount(delta.text, live);
        handlers.onText?.(delta.text);
        reportLive();
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const call = toolAcc.get(index) ?? { id: '', name: '', arguments: '' };
        call.arguments += delta.partial_json;
        toolAcc.set(index, call);
        addLiveCount(delta.partial_json, live);
        reportLive();
      }
      continue;
    }
    if (type === 'message_delta') {
      const raw = event.usage as Record<string, unknown> | undefined;
      if (raw) {
        const previous = usage ?? usageFromAnthropic({});
        const output = finiteToken(raw.output_tokens);
        usage = {
          ...previous,
          completionTokens: output,
          totalTokens: previous.promptTokens + output,
        };
      }
    }
  }

  if (usage) {
    handlers.onProgress?.({
      completionTokens: usage.completionTokens,
      promptTokens: usage.promptTokens,
      cachedTokens: usage.cachedTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    });
  }
  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({ ...call, arguments: call.arguments || '{}' }));
  return { content: content || null, toolCalls, usage };
}
