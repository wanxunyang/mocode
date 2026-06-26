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

/** 调一次 LLM。若有 tool_calls 则返回,由 agent 循环执行后回灌。 */
export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  const resp = await client.chat.completions.create({
    model: config.model,
    messages,
    tools: chatTools,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
  });
  const msg = resp.choices[0]?.message;
  if (!msg) throw new Error('LLM 返回了空响应');
  return {
    content: msg.content ?? null,
    toolCalls: (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  };
}
