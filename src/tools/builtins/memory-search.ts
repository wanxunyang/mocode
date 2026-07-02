import type { Tool } from '../types.js';
import { searchEntries, type MemoryType, type MemoryStatus } from '../../memory/store.js';

// ---------- memory_search ----------
// 关键词搜记忆正文(多词子串匹配,name 权重最高)。命中即 bump recallCount(遗忘衰减依据)。
// 结果走 capToolResultForHistory 的放宽上限(同 use_skill,保正文完整)。
export const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    'Search memory entries by keyword (substring match), returning full body.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords (words in id or name work best)' },
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
      },
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'archived', 'any'],
        description: 'Default active (only search live entries)',
      },
      limit: { type: 'integer', description: 'Number of entries to return, default 5, max 20' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return '错误:缺少 query。';
    const r = searchEntries(query, {
      type: typeof args.type === 'string' ? (args.type as MemoryType) : undefined,
      status:
        typeof args.status === 'string'
          ? (args.status as MemoryStatus | 'any')
          : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
    if (r.length === 0) return `(无匹配记忆:query="${query}")`;
    return r
      .map(
        (e) =>
          `# [${e.id}] ${e.name} (${e.type}, recalled ${e.recallCount})\nsummary: ${e.summary}\n\n${e.body}`,
      )
      .join('\n\n---\n\n');
  },
};
