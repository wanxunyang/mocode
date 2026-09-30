/**
 * Vertex AI / Gemini 原生协议 provider。
 *
 * 端点形态：
 *   <baseURL>/<model>:streamGenerateContent?alt=sse
 * 其中 baseURL 可为：
 *   https://asia-northeast1-aiplatform.googleapis.com/v1/publishers/google/models（Vertex 日本）
 *   https://generativelanguage.googleapis.com/v1beta/models（Gemini Developer API）
 *
 * 认证：Vertex 的 Express API key 用 `x-goog-api-key`；Gemini Developer API 也兼容该头。
 */
import { randomUUID } from 'node:crypto';
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
import type { ModelProviderRuntime } from '../runtime.js';
import { readSse } from './sse.js';

type JsonObject = Record<string, unknown>;
type GeminiRole = 'user' | 'model';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: JsonObject };
  functionResponse?: { name: string; response: JsonObject };
  thoughtSignature?: string;
}

interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return String(content);
}

function imagePart(content: unknown): GeminiPart | null {
  if (!isRecord(content) || content.type !== 'image_url') return null;
  const imageUrl = content.image_url;
  const url =
    typeof imageUrl === 'string'
      ? imageUrl
      : isRecord(imageUrl) && typeof imageUrl.url === 'string'
        ? imageUrl.url
        : '';
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function appendContent(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const previous = contents[contents.length - 1];
  if (previous?.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
}

/**
 * 追加 system reminder（转成 user 文本）。
 * Vertex 要求含 functionResponse 的 user 轮保持纯净：把普通文本合并进该轮会报
 * "Requests ending with a model turn are not supported."（实测）。
 * 因此上一个 user 轮含 functionResponse 时，reminder 必须独立成一个 user 轮。
 */
function appendReminder(contents: GeminiContent[], text: string): void {
  const part: GeminiPart = { text: `[System reminder]\n${text}` };
  const previous = contents[contents.length - 1];
  if (previous?.role === 'user' && previous.parts.some((item) => !!item.functionResponse)) {
    contents.push({ role: 'user', parts: [part] });
  } else {
    appendContent(contents, 'user', [part]);
  }
}

function functionResponsePart(toolMessage: { content?: unknown }): GeminiPart {
  let response: JsonObject = { result: textFromContent(toolMessage.content) };
  const raw = textFromContent(toolMessage.content).trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) response = parsed;
      else response = { result: parsed };
    } catch {
      // 保留默认 { result }。
    }
  }
  return { functionResponse: { name: '', response } };
}

/**
 * 把 OpenAI Chat 形态转成 Gemini contents。
 * - system 不进 contents（见 buildGeminiRequest 的 systemInstruction）
 * - assistant.tool_calls → model parts[].functionCall
 * - role:tool → 紧随 model 之后的 functionResponse；Gemini 要求该轮 role 为 user
 */
export function encodeGeminiMessages(messages: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  let dialogStarted = false;

  for (const rawMessage of messages) {
    const message = rawMessage as {
      role?: string;
      content?: unknown;
      tool_call_id?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
        thoughtSignature?: string;
      }>;
    };

    if (message.role === 'system' && !dialogStarted) {
      const text = textFromContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    dialogStarted = true;

    if (message.role === 'system') {
      appendReminder(contents, textFromContent(message.content));
      continue;
    }

    if (message.role === 'tool') {
      // OpenAI 的 tool 消息只有 tool_call_id，name 不一定存在；name 在相邻 assistant tool_calls 中补齐。
      const part = functionResponsePart(message);
      appendContent(contents, 'user', [part]);
      continue;
    }

    if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (Array.isArray(message.content)) {
        for (const contentPart of message.content) {
          const image = imagePart(contentPart);
          if (image) parts.push(image);
          else {
            const text = textFromContent(contentPart);
            if (text) parts.push({ text });
          }
        }
      } else {
        const text = textFromContent(message.content);
        if (text) parts.push({ text });
      }

      for (const toolCall of message.tool_calls ?? []) {
        const name = toolCall.function?.name ?? '';
        let args: JsonObject = {};
        const rawArgs = toolCall.function?.arguments?.trim();
        if (rawArgs) {
          try {
            const parsed = JSON.parse(rawArgs) as unknown;
            if (isRecord(parsed)) args = parsed;
          } catch {
            // 保留空对象，避免把坏参数直接抛成非 JSON。
          }
        }
        parts.push({
          functionCall: { name, args },
          // 关键：上一轮 functionCall part 上的 thought signature 必须原样回灌，
          // 否则带思考的 Vertex 模型会拒绝整个请求。
          ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
        });
      }
      appendContent(contents, 'model', parts);
      continue;
    }

    const parts: GeminiPart[] = [];
    if (Array.isArray(message.content)) {
      for (const contentPart of message.content) {
        const image = imagePart(contentPart);
        if (image) parts.push(image);
        else {
          const text = textFromContent(contentPart);
          if (text) parts.push({ text });
        }
      }
    } else {
      const text = textFromContent(message.content);
      if (text) parts.push({ text });
    }
    appendContent(contents, 'user', parts);
  }

  // Gemini 要求 functionResponse 与对应 functionCall 配对。OpenAI 工具消息按 id 关联，
  // 这里用相邻 model functionCall 的名字回填无名 response。
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (content.role !== 'user') continue;
    const previousModel = [...contents.slice(0, i)].reverse().find((item) => item.role === 'model');
    const callNames = (previousModel?.parts ?? [])
      .map((part) => part.functionCall?.name)
      .filter((name): name is string => !!name);
    let callIndex = 0;
    for (const part of content.parts) {
      if (!part.functionResponse) continue;
      part.functionResponse.name = callNames[callIndex] ?? callNames[callNames.length - 1] ?? 'tool';
      callIndex++;
    }
  }

  return { system: systemParts.join('\n\n'), contents };
}

/** Gemini Schema 不接受 OpenAI 工具 schema 中常见的部分注解字段；递归转成其 Schema 子集。 */
export function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!isRecord(value)) return value;

  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === 'additionalProperties' || key === '$comment') continue;
    out[key] = sanitizeGeminiSchema(child);
  }
  // Gemini Schema.type 是单值枚举，不接受 OpenAPI 3.1 的 ["string", "null"]。
  if (Array.isArray(out.type)) {
    const types = out.type.filter((type): type is string => typeof type === 'string');
    const nullable = types.includes('null');
    out.type = types.find((type) => type !== 'null') ?? 'string';
    if (nullable) out.nullable = true;
  }
  return out;
}

export function encodeGeminiTools(tools: readonly ChatTool[]): JsonObject[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeGeminiSchema(tool.function.parameters ?? { type: 'object', properties: {} }),
      })),
    },
  ];
}

function thinkingBudget(effort: ReturnType<typeof effectiveReasoningEffort>): number | null {
  if (effort === 'auto') return null;
  if (effort === 'off') return 0;
  if (effort === 'low') return 1024;
  if (effort === 'medium') return 4096;
  return 24576;
}

function endpoint(baseURL: string, model: string): string {
  const base = baseURL.replace(/\/+$/, '');
  const escapedModel = encodeURIComponent(model).replace('%40', '@');
  const suffix = `/${escapedModel}`;
  if (base.endsWith(suffix) || base.includes(`${suffix}:`)) {
    return `${base}:streamGenerateContent?alt=sse`;
  }
  return `${base}${suffix}:streamGenerateContent?alt=sse`;
}

export function buildGeminiRequest(
  messages: ChatMessage[],
  tools: readonly ChatTool[],
  runtime?: Pick<ModelProviderRuntime, 'config' | 'getModel'>,
  overrides?: LlmRequestOverrides,
): JsonObject {
  const runtimeConfig = runtime?.config ?? config;
  const encoded = encodeGeminiMessages(messages);
  const geminiTools = encodeGeminiTools(tools);
  const effort = effectiveReasoningEffort(overrides?.reasoningEffort);
  const budget = thinkingBudget(effort);
  // Gemini 的思考 token 计入 maxOutputTokens：不给思考留余量时，思考先吃光预算，
  // finishReason=MAX_TOKENS 且正文为空/截断（3.8-flash 实测：maxOutputTokens=100 → 正文空，
  // =2000 → 92 thoughts + "OK"）。auto 档动态思考上限按 flash 系 24576 保守留量。
  const thinkingAllowance = budget ?? (effort === 'auto' ? 24576 : 0);
  const generationConfig: JsonObject = {
    maxOutputTokens: (runtimeConfig.maxTokens ?? 8192) + thinkingAllowance,
    temperature: 0.2,
    ...(budget === null ? {} : { thinkingConfig: { thinkingBudget: budget } }),
  };

  return {
    ...(encoded.system ? { systemInstruction: { parts: [{ text: encoded.system }] } } : {}),
    contents: encoded.contents,
    ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
    generationConfig,
  };
}

class GeminiHttpError extends Error {
  status: number;
  code?: string;
  headers: Headers;

  constructor(status: number, message: string, headers: Headers, code?: string) {
    super(message);
    this.name = 'GeminiAPIError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

async function throwResponseError(response: Response): Promise<never> {
  let message = `Gemini API HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const body = JSON.parse(await response.text()) as {
      error?: { message?: unknown; code?: unknown; status?: unknown };
    };
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.code === 'string') code = body.error.code;
    else if (typeof body.error?.status === 'string') code = body.error.status;
  } catch {
    // 非 JSON 错误页只保留状态码。
  }
  throw new GeminiHttpError(response.status, message, response.headers, code);
}

function usageFromGemini(raw: JsonObject): ChatUsage {
  const promptTokens = typeof raw.promptTokenCount === 'number' ? raw.promptTokenCount : 0;
  const completionTokens = typeof raw.candidatesTokenCount === 'number' ? raw.candidatesTokenCount : 0;
  const thoughts = typeof raw.thoughtsTokenCount === 'number' ? raw.thoughtsTokenCount : 0;
  const totalTokens = typeof raw.totalTokenCount === 'number' ? raw.totalTokenCount : promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens: 0,
    reasoningTokens: thoughts,
  };
}

/** Vertex/Gemini 单次流式请求；重试仍由外层 chatWithRuntime 统一处理。 */
export async function vertexChatOnce(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  tools: readonly ChatTool[] | undefined,
  runtime?: ModelProviderRuntime,
  overrides?: LlmRequestOverrides,
): Promise<ChatResult> {
  const runtimeConfig = runtime?.config ?? config;
  const model = runtime?.getModel() ?? getActiveModel();
  const activeTools = tools ?? [];
  const response = await fetch(endpoint(runtimeConfig.baseURL, model), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-goog-api-key': runtimeConfig.apiKey,
    },
    body: JSON.stringify(
      buildGeminiRequest(
        messages,
        activeTools,
        runtime ? { config: runtime.config, getModel: runtime.getModel } : undefined,
        overrides,
      ),
    ),
    signal,
  });
  if (!response.ok) await throwResponseError(response);

  let content = '';
  let usage: ChatUsage | undefined;
  const toolCalls: ToolCallRef[] = [];
  let reportedTool = false;
  let finishReason = '';
  const live = { cjk: 0, other: 0 };
  const countLive = (text: string): void => {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7a3))
        live.cjk++;
      else live.other++;
    }
  };
  const reportLive = (): void => {
    handlers.onProgress?.({ completionTokens: Math.ceil(live.cjk + live.other / 4) });
  };

  for await (const record of readSse(response)) {
    let event: JsonObject;
    try {
      event = JSON.parse(record.data) as JsonObject;
    } catch {
      continue;
    }
    const usageMetadata = event.usageMetadata;
    if (isRecord(usageMetadata)) usage = usageFromGemini(usageMetadata);

    const candidates = Array.isArray(event.candidates) ? event.candidates : [];
    const candidate = isRecord(candidates[0]) ? candidates[0] : undefined;
    if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
    const candidateContent = isRecord(candidate?.content) ? candidate.content : undefined;
    const parts = Array.isArray(candidateContent?.parts) ? candidateContent.parts : [];

    for (const rawPart of parts) {
      if (!isRecord(rawPart)) continue;
      // thought:true 的部分是模型思考（仅 includeThoughts 时才下发），不是正文，不能 onText/入 history。
      if (typeof rawPart.text === 'string' && rawPart.text && rawPart.thought !== true) {
        content += rawPart.text;
        countLive(rawPart.text);
        handlers.onText?.(rawPart.text);
        reportLive();
      }
      if (isRecord(rawPart.functionCall)) {
        const name = typeof rawPart.functionCall.name === 'string' ? rawPart.functionCall.name : '';
        const args = isRecord(rawPart.functionCall.args) ? rawPart.functionCall.args : {};
        // Vertex/Gemini 的 functionCall 不返回 OpenAI 风格 id；HistoryManager 要求
        // 非空且唯一的 tool_call id，故在 provider 边界生成本会话唯一 id。
        // 同 part 上的 thoughtSignature 一并捕获，供下一轮回灌。
        toolCalls.push({
          id: `gemini-${randomUUID()}`,
          name,
          arguments: JSON.stringify(args),
          ...(typeof rawPart.thoughtSignature === 'string' ? { thoughtSignature: rawPart.thoughtSignature } : {}),
        });
        if (!reportedTool && name) {
          handlers.onToolCall?.(name);
          reportedTool = true;
        }
      }
    }
  }

  if (usage) {
    handlers.onProgress?.({
      completionTokens: usage.completionTokens,
      promptTokens: usage.promptTokens,
      cachedTokens: usage.cachedTokens,
    });
  }

  // MAX_TOKENS 截断曾静默返回：模型没发完工具调用就结束 turn（「没干完活就结束」）。
  // 显式标注让用户与下一轮模型都看到截断事实；正常 STOP/SAFETY 等不加。
  if (finishReason === 'MAX_TOKENS' && (content || toolCalls.length > 0)) {
    const marker =
      '\n\n[mocode] Gemini finishReason=MAX_TOKENS：输出在 token 上限处被截断（思考也计入 maxOutputTokens）。可调大 MAX_TOKENS 或 /effort 降低思考强度。';
    content += marker;
    handlers.onText?.(marker);
  }

  return { content: content || null, toolCalls, usage };
}
