import OpenAI from 'openai';
import { config } from '../config/index.js';
import { tools } from '../tools/registry.js';

const client = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
});

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** 把内部工具定义转成 OpenAI 的 tool 格式 */
export const chatTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(
  (t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      // 不同版本 SDK 的 FunctionParameters 宽严不一,用 any 兜底
      parameters: t.parameters as any,
    },
  })
);

export interface ToolCallRef {
  id: string;
  name: string;
  arguments: string; // 原始 JSON 字符串
}

/** 一次 chat 调用返回的真实 token 用量(include_usage 时由后端给出)。 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCallRef[];
  usage?: ChatUsage;
}

/** 流式回调:文本增量 / 思考增量(reasoning_content)。 */
export interface StreamHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

/**
 * 流式调一次 LLM:增量回调文本 / 思考,内部累加 tool_calls 片段。
 * 思考内容走 delta.reasoning_content(DeepSeek / GLM / Qwen 等推理模型,
 * SDK 类型无此字段,用 as any 取;不支持的模型则无思考,只流文本)。
 * tool_calls 跨 chunk 按 index 累加(id / name / arguments 拼接)。
 * include_usage 时末尾 chunk 携带 usage,先读再 continue(末尾 chunk 无 delta)。
 */
export async function chat(
  messages: ChatMessage[],
  handlers: StreamHandlers = {}
): Promise<ChatResult> {
  const stream = await client.chat.completions.create({
    model: config.model,
    messages,
    tools: chatTools,
    stream: true,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    ...(config.includeUsage ? { stream_options: { include_usage: true } } : {}),
  });

  let content = '';
  let hasContent = false;
  let usage: ChatUsage | undefined;
  const toolAcc = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >();

  for await (const chunk of stream) {
    // usage:末尾 chunk(choices 可能为空)在 include_usage 时携带;先读再 continue。
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue; // 末尾 usage-only chunk 等无 delta

    // 思考内容(非标准字段,SDK 类型无)
    const reasoning =
      (delta as any).reasoning_content ?? (delta as any).reasoning;
    if (reasoning) handlers.onThinking?.(reasoning as string);

    if (delta.content) {
      content += delta.content;
      hasContent = true;
      handlers.onText?.(delta.content);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolAcc.get(idx);
        if (!entry) {
          entry = { name: '', arguments: '' };
          toolAcc.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls: ToolCallRef[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({
      id: e.id ?? '',
      name: e.name,
      arguments: e.arguments,
    }));

  return {
    content: hasContent ? content : null,
    toolCalls,
    usage,
  };
}

// ── token 估算(自包含,不依赖 ui / 外部 tokenizer)──────────────────────
// CJK 感知启发式:CJK 字符 ≈ 1 token,其余 ≈ 4 字符/token。
// 故意偏过估(安全侧):估算偏高 → 压缩触发偏早 → 不会溢出窗口。
// 真实 usage 由 chat() 的 include_usage 返回;此处仅作预检 / 兜底 / /context 显示。

/** 判断一个码点是否 CJK 表意 / 假名 / 韩文(按 1 token 计)。 */
function isCJK(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0x3040 && cp <= 0x30ff) || // 假名
    (cp >= 0xac00 && cp <= 0xd7a3) // 韩文音节
  );
}

/** 粗估一段文本的 token 数。CJK≈1/字,其余≈1/4字,向上取整。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCJK(cp)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/** 把任意消息内容(content 可能是 string | null | 多模态数组)拍平成字符串。 */
function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 估算单条消息的 token 数:结构开销 + content + tool_calls 参数。 */
export function messageTokens(m: ChatMessage): number {
  const role = (m as { role?: string }).role;
  let structural = 4; // {role}\n{content}\n 框架基线
  if (role === 'system') structural = 3;
  else if (role === 'tool') structural = 6;
  let body = contentToText((m as { content?: unknown }).content);
  const tcs = (m as { tool_calls?: { function?: { arguments?: string } }[] })
    .tool_calls;
  if (tcs) {
    for (const tc of tcs) body += tc?.function?.arguments ?? '';
  }
  return structural + estimateTokens(body);
}

/** 估算整段 messages 的 token 数(不含工具 schema,含 priming 常数)。 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let sum = 3; // priming:每轮对话的基础开销
  for (const m of messages) sum += messageTokens(m);
  return sum;
}

let schemaTokensCache: number | undefined;

/** 估算 chatTools(工具 schema)占用的一次性 token,带缓存。 */
export function estimateToolSchemaTokens(): number {
  if (schemaTokensCache === undefined) {
    schemaTokensCache = estimateTokens(JSON.stringify(chatTools)) + 16;
  }
  return schemaTokensCache;
}
