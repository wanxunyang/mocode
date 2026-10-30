import type { Tool } from '../types.js';
import { listEntries, wantsTrigger, type MemoryType, type MemoryStatus } from '../../memory/store.js';

// ---------- memory_list ----------
// 列索引(id/name/summary,无正文、不 bump recall)。用于浏览有哪些、拿 id 再 memory_search 取正文。
// R3：显式标出「该有 trigger 却还没有」的条目。前摄通道的唯一供料就是 trigger，
// 模型只有在列表里看得见缺口时才会去补；不暴露缺口 = 通道永远是空索引（实测覆盖率 0）。
export const memoryListTool: Tool = {
  name: 'memory_list',
  description:
    'List the memory index (id/name/summary, no body). Get an id, then use memory_search for the full body. Entries marked "NO-TRIGGER" are pitfall/decision/feedback memories still missing a trigger, so the proactive channel can never surface them — fill it via memory_update when you know the situation they apply to.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
      },
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'archived', 'any'],
        description: 'Default active',
      },
    },
  },
  async execute(args) {
    const items = listEntries({
      type: typeof args.type === 'string' ? (args.type as MemoryType) : undefined,
      status: typeof args.status === 'string' ? (args.status as MemoryStatus | 'any') : undefined,
    });
    if (items.length === 0) return '(无记忆条目)';
    const lines = items.map((i) => {
      const gap = !i.hasTrigger && wantsTrigger(i.type) ? ' [NO-TRIGGER]' : '';
      return `- ${i.id}: ${i.name} — ${i.summary} (${i.type}, ${i.status})${gap}`;
    });
    const gaps = items.filter((i) => !i.hasTrigger && wantsTrigger(i.type)).length;
    if (gaps > 0) {
      lines.push(
        `\n${gaps} 条条目缺 trigger，前摄通道永远命中不到它们。若你清楚某条适用的具体场景（不是"改代码时"这类泛化说法），用 memory_update 补上 trigger/action。`,
      );
    }
    return lines.join('\n');
  },
};
