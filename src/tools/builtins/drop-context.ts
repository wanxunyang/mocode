import type { Tool, DropContextFilter } from '../types.js';

// ---------- drop_context ----------
/**
 * 运行中上下文剔除工具:agent 检索到大量无关信息后,主动把历史里无关的 tool 结果替换为存根,
 * 释放上下文空间(保 tool_call_id 配对不变量,只改 content)。
 *
 * 与 compact 的区别:compact 是阈值触发的整体压缩(微截 + 摘要);drop_context 是 agent 主动、
 * 精准剔除"已判定无关"的具体 tool 结果。
 *
 * 保护:history[0](system)与当前轮(最后一个 user 及其之后)永不剔除——agent 还在用。
 * 已是存根的不重复剔除(幂等)。永不抛错。
 *
 * 筛选(各维度 AND 组合,全部可选;不传 = 剔除所有可剔除的旧 tool 结果):
 *  - toolNames:只剔除这些工具名的结果(如 ["grep","read_file"])
 *  - contains:只剔除内容包含所有这些词(AND、大小写不敏感)的结果
 *
 * plan 模式不禁用:纯上下文管理,无文件 / 命令副作用。
 */
export const dropContextTool: Tool = {
  name: 'drop_context',
  description: [
    'Drop (stub-replace) irrelevant OLDER tool results from history to free context.',
    'COST-AWARE: ~300-token round-trip; only call if freed tokens clearly exceed it — i.e. MULTIPLE bulky results (e.g. a wide grep/read sweep of mostly-irrelevant hits), not a single small one or near done.',
    'Never dropped: system prompt and the CURRENT turn (last user message onward). Idempotent. Filters AND-combine; omit both = drop all droppable. Returns dropped count, freed tokens, tool names.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      toolNames: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Only drop results from these tool names (e.g. ["grep","read_file"]). Empty/omitted = no tool-name filter.',
      },
      contains: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Only drop results whose content contains ALL of these keywords (AND, case-insensitive). Empty/omitted = no content filter.',
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const dropContext = ctx?.dropContext;
    if (!dropContext) {
      // 无注入(理论上不会:runAgentCore 总注入)。降级:不改 history,告知 agent。
      return '错误:上下文剔除回调不可用(未由 agent 循环注入),无法剔除。';
    }
    const filter: DropContextFilter = {};
    if (Array.isArray(args.toolNames)) {
      filter.toolNames = (args.toolNames as unknown[])
        .filter((v) => typeof v === 'string' && v.length > 0)
        .map((v) => String(v));
    }
    if (Array.isArray(args.contains)) {
      filter.contains = (args.contains as unknown[])
        .filter((v) => typeof v === 'string' && v.length > 0)
        .map((v) => String(v));
    }
    const result = dropContext(filter);
    return result.dropped === 0
      ? '未剔除任何工具结果(无匹配的旧 tool 消息,或均在当前轮保护区内不可剔除)。'
      : [
          `已剔除 ${result.dropped} 条无关工具结果,释放约 ${result.freedTokens} tokens。`,
          '被剔除项(已替换为存根,tool_call_id 配对不变):',
          ...result.items.map(
            (it) => `  - ${it.toolName} (id …${it.toolCallId})`,
          ),
          '这些结果在后续上下文中仅保留存根标记,不再占用篇幅。',
        ].join('\n');
  },
};
