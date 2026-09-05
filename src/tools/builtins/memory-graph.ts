import type { Tool } from '../types.js';
import { addTriple, graphStats, neighborsOf, pathBetween } from '../../memory/graph.js';

// ---------- memory_graph ----------
// 知识图谱维护工具:邻居遍历(1-3 跳,可 relation 过滤)、两点最短路径、手工加三元组、看图统计。
// 关键词搜索已并入 memory_search(条目 + 图谱事实一次返回),本工具不再提供 search。
// 底层 memory-graph.json(Graphiti 式时序边:新事实取代旧边时旧边置 invalidAt,不删)。
// neighbors/path/stats 只读;add 写。

function fmtEdges(
  edges: { src: string; dst: string; relation: string; fact: string; invalidAt: string | null }[],
): string {
  if (edges.length === 0) return '(无边)';
  return edges.map((e) => `${e.src} --[${e.relation}]--> ${e.dst}${e.fact ? ` (${e.fact})` : ''}`).join('\n');
}

function fmtEntities(entities: { id: string; name: string; summary: string; scope: string }[]): string {
  if (entities.length === 0) return '(无实体)';
  return entities.map((e) => `- ${e.id}: ${e.name}${e.summary ? ` — ${e.summary}` : ''} [${e.scope}]`).join('\n');
}

export const memoryGraphTool: Tool = {
  name: 'memory_graph',
  risk: 'confirm',
  description:
    'Maintain/explore the knowledge-graph memory layer (entities + temporal triples). Keyword search lives in memory_search. ' +
    'action=neighbors: BFS 1-3 hops around an entity (optional relation filter to follow one edge type); ' +
    'action=path: shortest path between two entities (bidirectional BFS, max 6 hops); ' +
    'action=add: add a triple (src --relation--> dst); existing edges with same src/relation/dst are temporally invalidated, not deleted; ' +
    'action=stats: graph size overview.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['neighbors', 'path', 'add', 'stats'],
        description: 'What to do',
      },
      query: { type: 'string', description: 'neighbors: entity name or id; path: start entity' },
      depth: { type: 'integer', description: 'neighbors: hops, 1-3, default 1' },
      src: { type: 'string', description: 'add: source entity name' },
      relation: {
        type: 'string',
        description:
          'add: relation in snake_case, e.g. depends_on / decided_by. neighbors: optional edge-type filter to follow only that relation',
      },
      dst: { type: 'string', description: 'add: target entity name; path: end entity' },
      fact: { type: 'string', description: 'add: optional one-line statement for the edge' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'add: which graph file to write, default project',
      },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action ?? '').trim();

    if (action === 'stats') {
      const s = graphStats();
      return [
        `实体 ${s.entities} 条边(active ${s.edgesActive} / 已失效 ${s.edgesInvalid})`,
        `project: ${s.byScope.project.entities} 实体, ${s.byScope.project.edges} 边`,
        `global:  ${s.byScope.global.entities} 实体, ${s.byScope.global.edges} 边`,
      ].join('\n');
    }

    if (action === 'neighbors') {
      const query = String(args.query ?? '').trim();
      if (!query) return '错误:neighbors 需要 query(实体名或 id)。';
      const depth = typeof args.depth === 'number' ? args.depth : 1;
      const rel = typeof args.relation === 'string' ? args.relation.trim() : '';
      const r = neighborsOf(query, depth, rel || undefined);
      if (!r.center) return `(图中没有实体 "${query}")`;
      const relNote = rel ? `,仅 ${rel} 边` : '';
      const lines = [
        `## ${r.center.name} (${r.center.id})${r.center.summary ? ` — ${r.center.summary}` : ''}`,
        r.entities.length > 0 ? `\n## 邻居实体\n${fmtEntities(r.entities)}` : '',
        `\n## 边(${r.edges.length}${relNote}${r.truncated ? ',已截断' : ''})\n${fmtEdges(r.edges)}`,
      ].filter(Boolean);
      return lines.join('\n');
    }

    if (action === 'path') {
      const from = String(args.query ?? '').trim();
      const to = String(args.dst ?? '').trim();
      if (!from || !to) return '错误:path 需要 query(起点实体)和 dst(终点实体)。';
      const r = pathBetween(from, to);
      if (!r) return `(无 active 路径:${from} ⇸ ${to},或端点实体不存在)`;
      const chain = r.path.map((e) => e.name).join(' → ');
      const lines = [
        `## ${r.from.name} ⇢ ${r.to.name}(${r.edges.length} 跳)`,
        `路径:${chain}`,
        `\n## 边\n${fmtEdges(r.edges)}`,
      ];
      return lines.join('\n');
    }

    if (action === 'add') {
      const src = String(args.src ?? '').trim();
      const relation = String(args.relation ?? '').trim();
      const dst = String(args.dst ?? '').trim();
      if (!src || !relation || !dst) return '错误:add 需要 src、relation、dst。';
      const r = addTriple({
        src,
        relation,
        dst,
        fact: typeof args.fact === 'string' ? args.fact : undefined,
        scope: args.scope === 'global' ? 'global' : 'project',
      });
      if (!r.ok) return `错误:三元组未写入 (${r.reason})。`;
      if (r.duplicate) return `已存在相同三元组 (${r.edgeId}),幂等跳过。`;
      const sup = r.superseded > 0 ? `;旧边已时序失效(${r.superseded} 条)` : '';
      return `已写入三元组 ${src} --[${relation.toLowerCase().replace(/\s+/g, '_')}]--> ${dst} [${r.edgeId}]${sup}。`;
    }

    return `错误:未知 action "${action}",可用 neighbors/path/add/stats(关键词搜索请用 memory_search)。`;
  },
};
