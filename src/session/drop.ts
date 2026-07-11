// 运行中上下文剔除(drop_context 工具的核心):把历史里无关的 tool 结果替换为存根。
//
// 与 compact 的区别:compact 是阈值触发的整体压缩(微截 + 摘要),drop_context 是 agent 主动、
// 精准剔除"已判定无关"的具体 tool 结果——agent 检索到大量无关信息后主动调用,释放上下文。
//
// 不变量(对齐 compact.ts):
//  - 永不动 history[0](system prompt)。
//  - 永不动当前轮:从末尾向前找到最后一个 user 消息,该 user 及其之后的 tool 结果一律保留
//    (agent 本轮还在用,踢了会丢失正在进行的上下文)。
//  - tool_call_id 配对:只改 tool 消息的 content,不删消息、不动 tool_calls 数组结构、不改 id。
//  - 原地修改 history(同 compact:length=0;push 重建,repl 持有同一引用)。
//  - 永不抛错(对齐「调度器永不抛错」契约);无匹配 / 无可剔除 → 返 dropped=0。

import type { ChatMessage } from '../llm/index.js';
import {
  messageTokens,
  estimateTokens,
} from '../llm/index.js';
import type { DropContextFilter, DropContextResult } from '../tools/types.js';
import { lastUserIndex, toText, toolNameOf } from '../context/utils.js';

/**
 * 剔除历史里命中的旧 tool 结果(原地修改 history)。
 *
 * 筛选(各维度 AND 组合):
 *  - toolNames:只剔除这些工具名的结果(空 = 不限)
 *  - contains:只剔除内容包含所有这些词(AND、大小写不敏感)的结果(空 = 不限)
 *
 * 保护:history[0](system)+ 当前轮(最后一个 user 及其之后)永不剔除。
 * 已是存根的 tool 消息(含「已剔除」标记)不重复剔除(幂等)。
 *
 * 永不抛错;无匹配返 dropped=0。
 */
export function dropContextFromHistory(
  history: ChatMessage[],
  filter: DropContextFilter,
): DropContextResult {
  const toolNames =
    filter.toolNames && filter.toolNames.length > 0
      ? new Set(filter.toolNames)
      : null;
  const contains =
    filter.contains && filter.contains.length > 0
      ? filter.contains.map((s) => s.toLowerCase())
      : null;

  // 当前轮保护区:最后一个 user 及其之后一律保留(agent 还在用)。
  const guard = lastUserIndex(history);
  // guard <= 0 表示无 user 或 user 就是 history[0](不会):整段历史都可剔除(除 history[0])。
  const protectedFrom = guard > 0 ? guard : 0; // < protectedFrom 的才可剔除(即 [1, protectedFrom)

  const items: { toolName: string; toolCallId: string }[] = [];
  let freedTokens = 0;
  const STUB_PREFIX = '⌦[已剔除:与当前任务无关]';

  for (let i = 1; i < protectedFrom; i++) {
    const m = history[i];
    if (m.role !== 'tool') continue;
    const content = toText((m as { content?: unknown }).content);
    // 幂等:已是存根(含标记)不重复剔除。
    if (content.startsWith(STUB_PREFIX)) continue;

    // 维度 1:工具名
    const tname = toolNameOf(history, i);
    if (toolNames && (!tname || !toolNames.has(tname))) continue;

    // 维度 2:内容关键词(AND)
    if (contains) {
      const lower = content.toLowerCase();
      if (!contains.every((kw) => lower.includes(kw))) continue;
    }

    // 命中 → 替换为存根(保 tool_call_id 不动,只改 content)
    const before = messageTokens(m);
    const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
    const stub = `${STUB_PREFIX} 原 ${tname ?? 'tool'} 结果(${content.length} 字符,约 ${before} tokens)${id ? ` · id …${id.slice(-6)}` : ''}⌫`;
    (m as { content?: string }).content = stub;
    const after = messageTokens(m);
    freedTokens += Math.max(0, before - after);
    items.push({
      toolName: tname ?? 'tool',
      toolCallId: id.slice(-6),
    });
  }

  return {
    dropped: items.length,
    freedTokens,
    items,
  };
}

/** 给 drop_context 工具结果格式化人类可读摘要(回灌给 agent)。 */
export function formatDropResult(r: DropContextResult): string {
  if (r.dropped === 0) {
    return '未剔除任何工具结果(无匹配的旧 tool 消息,或均在当前轮保护区内不可剔除)。';
  }
  const lines = [
    `已剔除 ${r.dropped} 条无关工具结果,释放约 ${r.freedTokens} tokens。`,
    '被剔除项(已替换为存根,tool_call_id 配对不变):',
  ];
  for (const it of r.items) {
    lines.push(`  - ${it.toolName} (id …${it.toolCallId})`);
  }
  lines.push('这些结果在后续上下文中仅保留存根标记,不再占用篇幅。');
  return lines.join('\n');
}

// 供 drop_context 工具估算用(避免直接 import llm 的公开 API 造成耦合,这里重导出)。
export { estimateTokens };
