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

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCallRef[];
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
  });

  let content = '';
  let hasContent = false;
  const toolAcc = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >();

  for await (const chunk of stream) {
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
  };
}
