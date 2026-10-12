/**
 * 消息形状的 transport 边界消毒(纯函数,无副作用,不依赖 config/registry)。
 *
 * 独立成叶子模块:openai 路径(llm/index.ts)与 anthropic 路径(providers/anthropic.ts)
 * 都要用它,而 anthropic.ts 又被 index.ts import——放 index.ts 会形成循环。
 */
import type OpenAI from 'openai';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * 把「无文本、无 tool_calls」的 assistant 消息的 `content: null` 改写成空字符串。
 *
 * 背景:`content: null` 在 assistant 消息上**只在携带 tool_calls 时合法**(那是 OpenAI 自己
 * 吐 tool_call 时的规范形状)。纯文本轮次写成 null 会被严格 OpenAI 兼容网关整请求拒绝。
 * speedbear(https://speedbear.redbearai.com/api/v1)实测:
 *   `{"error_code":"REQUEST_VALIDATION_FAILED",
 *     "detail":"messages[12].content 不能为 null(assistant 消息仅在携带 tool_calls/
 *               function_call 时允许省略 content;无文本请传空字符串 \"\")"}`
 * 且形状探针逐条确认:`null`+tool_calls → 200;`content:[]` → 200;缺 content 字段 → 200;
 * `content:""` → 200;连续 user 消息 → 200。**只有「null 且无 tool_calls」这一种被拒。**
 *
 * 在 agent 侧的表现极具迷惑性——「某个会话从某一轮起每一步都 400、换个会话同模型却正常」:
 * 毒消息一旦写进 history 就会每轮重发,而它是**合法 JSON、合法 OpenAI 类型**,肉眼 review
 * 抓不到;`/resume` 也救不回来(毒在落盘文件里)。更隐蔽的是它的来源:SSE 流中途结束
 * (网关超时/上游掐断)时 SDK 不抛错,`content` 停在 null、tool_calls 为空,
 * 框架把它当「agent 完成了这一轮」照写 history——于是一步正常的历史被永久污染。
 *
 * 与 `sanitizeToolSchemas`(剔 uniqueItems)同源同策:**放 transport 边界而非只修构造点**——
 * 已经被旧版本写进 session.json 的中毒会话、外部注入的历史、resume 续接的会话都能自愈,
 * 只修构造点救不了存量。构造点(`agent/stages/history-manager.ts`)同步收敛,保证新历史
 * 不再生产这种形状,两层各司其职。
 *
 * 无需改写时返回**原数组引用**——history 参与前缀缓存,逐字节稳定才能命中;
 * 每次新建对象会击穿缓存(同 `sanitizeToolSchemas` 的返回值约定)。
 */
export function sanitizeAssistantContent(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const raw = message as { content?: unknown; tool_calls?: unknown };
    // 带 tool_calls 时 null 是规范形状(OpenAI 自己就这么吐),原样保留。
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) return message;
    if (raw.content !== null) return message;
    changed = true;
    return { ...(message as object), content: '' } as ChatMessage;
  });
  return changed ? next : messages;
}
