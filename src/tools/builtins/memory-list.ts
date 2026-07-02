import type { Tool } from '../types.js';
import { listEntries, type MemoryType, type MemoryStatus } from '../../memory/store.js';

// ---------- memory_list ----------
// 列索引(id/name/summary,无正文、不 bump recall)。用于浏览有哪些、拿 id 再 memory_search 取正文。
export const memoryListTool: Tool = {
  name: 'memory_list',
  description:
    'List the memory index (id/name/summary, no body). Get an id, then use memory_search for the full body.',
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
      status:
        typeof args.status === 'string'
          ? (args.status as MemoryStatus | 'any')
          : undefined,
    });
    if (items.length === 0) return '(无记忆条目)';
    return items
      .map((i) => `- ${i.id}: ${i.name} — ${i.summary} (${i.type}, ${i.status})`)
      .join('\n');
  },
};
