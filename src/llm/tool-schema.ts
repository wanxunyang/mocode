/**
 * 工具 JSON Schema 的 transport 边界消毒(纯函数,无副作用,不依赖 config/registry)。
 *
 * 独立成叶子模块:openai 路径(llm/index.ts)与 anthropic 路径(providers/anthropic.ts)
 * 都要用它,而 anthropic.ts 又被 index.ts import——放 index.ts 会形成循环。
 */
import type OpenAI from 'openai';

type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * 递归剔除工具参数 schema 里的 `uniqueItems` 关键字。
 *
 * 背景:`uniqueItems` 是合法的 JSON Schema 关键字,OpenAI / qwen / 多数兼容后端都接受;
 * 但 kimi-k3 经 dashscope compatible-mode 的模型服务层**不接受**它,收到即整请求 400:
 *   `<400> InternalError.Algo: An error occurred in model serving,
 *    error message is: [Invalid request parameters.]`
 * 实测确定性 6/6:同一请求含 uniqueItems 必拒、去掉必过;而 format / const /
 * patternProperties / $defs / minProperties / minItems 等关键字均被接受。
 *
 * 在 agent 侧的表现极具迷惑性——"干着干着突然每一步都 400、一把就结束":
 * 工具路由(add_tool_groups / select_tool_groups)的 schema 一旦带上 uniqueItems,
 * 该 turn 路由出的工具子集每步都会重发同一份毒 schema,于是每步都被拒;
 * 换成 qwen3.8-max 等容忍 uniqueItems 的模型又立刻恢复正常。与 history 内容、
 * 上下文长度、tool_call 配对**全部无关**(仅 system+user 两条消息 + 这一个工具即必拒)。
 *
 * 放在 transport 边界而非只修构造点:MCP / 外部注册工具、续接会话里可能已存着带
 * uniqueItems 的 schema,只修构造点无法自愈。无需改写时返回**原数组引用**——
 * 工具 schema 计入前缀缓存,逐字节稳定才能命中;每次新建对象会击穿缓存。
 */
export function sanitizeToolSchemas(tools: readonly ChatTool[]): ChatTool[] {
  let sawUnsupported = false;
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(src)) {
        if (key === 'uniqueItems') {
          sawUnsupported = true;
          continue;
        }
        out[key] = strip(child);
      }
      return out;
    }
    return value;
  };
  const next = tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: strip(tool.function.parameters) as typeof tool.function.parameters,
    },
  }));
  return sawUnsupported ? next : (tools as ChatTool[]);
}
