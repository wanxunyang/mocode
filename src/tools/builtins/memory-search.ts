import type { Tool } from '../types.js';
import { searchEntries, type MemoryType, type MemoryStatus } from '../../memory/store.js';
import { searchGraph } from '../../memory/graph.js';

// ---------- memory_search ----------
// 唯一记忆搜索入口:关键词搜记忆正文(多词子串匹配,name 权重最高)+ 知识图谱事实段
// (命中实体的 active 边)。命中条目即 bump recallCount(遗忘衰减依据)。
// 结果走 capToolResultForHistory 的放宽上限(同 use_skill,保正文完整)。
const GRAPH_FACTS_LIMIT = 10;

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    'Search memory entries by keyword (substring match), returning full body. Also surfaces knowledge-graph facts (active edges) for entities matching the query.',
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
    const entryText = r
      .map(
        (e) =>
          `# [${e.id}] ${e.name} (${e.type}, recalled ${e.recallCount})\nsummary: ${e.summary}\n\n${e.body}`,
      )
      .join('\n\n---\n\n');

    // 知识图谱事实段:命中实体的 active 边(容错:图坏了不连累条目搜索)。
    let graphText = '';
    try {
      const g = searchGraph(query, 8);
      if (g.edges.length > 0) {
        const lines = g.edges
          .slice(0, GRAPH_FACTS_LIMIT)
          .map((e) => `${e.src} --[${e.relation}]--> ${e.dst}${e.fact ? ` (${e.fact})` : ''}`);
        const more = g.edges.length > GRAPH_FACTS_LIMIT ? `\n…(共 ${g.edges.length} 条,其余用 memory_graph action=neighbors 展开)` : '';
        graphText = `\n\n## 知识图谱事实\n${lines.join('\n')}${more}`;
      }
    } catch {
      // 静默:图谱段是增强,失败只降级为纯条目结果
    }

    if (!entryText && !graphText) return `(无匹配记忆:query="${query}")`;
    if (!entryText) return `(无匹配记忆条目,但图谱有命中)\n${graphText.trimStart()}`;
    return entryText + graphText;
  },
};
