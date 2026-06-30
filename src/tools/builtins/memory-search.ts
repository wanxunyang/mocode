import type { Tool } from '../types.js';
import { searchEntries, type MemoryType, type MemoryStatus } from '../../memory/store.js';

// ---------- memory_search ----------
// 关键词搜记忆正文(多词子串匹配,name 权重最高)。命中即 bump recallCount(遗忘衰减依据)。
// 结果走 capToolResultForHistory 的放宽上限(同 use_skill,保正文完整)。
export const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    '按关键词搜索记忆正文(多词子串匹配,按相关度排),返回匹配条目全文。命中记一次召回(影响遗忘衰减)。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词(id 或 name 里的词效果最好)' },
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
      },
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'archived', 'any'],
        description: '默认 active(只搜活的)',
      },
      limit: { type: 'integer', description: '返回条数,默认 5,上限 20' },
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
