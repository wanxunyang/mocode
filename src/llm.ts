import OpenAI from 'openai';
import { config } from './config.js';
import { tools } from './tools.js';

const client = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
});

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ChatCallbacks {
  /** 每个文本片段到达时触发（最终答案流式输出）。 */
  onContentDelta?: (delta: string) => void;
  /** 某个 tool call 首次解析出名字时触发（实时显示工具调用）。 */
  onToolCallStart?: (name: string, preview: string) => void;
}

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

/** 调一次 LLM。支持流式返回,文本片段通过回调实时输出,工具调用按 index 累加后返回。 */
export async function chat(
  messages: ChatMessage[],
  callbacks: ChatCallbacks = {}
): Promise<ChatResult> {
  const stream = await client.chat.completions.create({
    model: config.model,
    messages,
    tools: chatTools,
    stream: true,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
  });

  let content = '';
  const toolCalls = new Map<number, ToolCallRef>();
  const emittedStart = new Set<number>();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      callbacks.onContentDelta?.(delta.content);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        if (!toolCalls.has(index)) {
          toolCalls.set(index, { id: tc.id ?? '', name: '', arguments: '' });
        }
        const ref = toolCalls.get(index)!;
        if (tc.id) ref.id = tc.id;
        if (tc.function?.name) {
          ref.name = tc.function.name;
          if (!emittedStart.has(index)) {
            emittedStart.add(index);
            const preview =
              ref.arguments.length > 80
                ? ref.arguments.slice(0, 80) + '…'
                : ref.arguments;
            callbacks.onToolCallStart?.(ref.name, preview);
          }
        }
        if (tc.function?.arguments) {
          ref.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCallsList = Array.from(toolCalls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc)
    .filter((tc) => tc.name);

  return {
    content: content || null,
    toolCalls: toolCallsList,
  };
}
