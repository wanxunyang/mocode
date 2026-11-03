import type { Tool } from '../types.js';
import { addTriple, graphStats, neighborsOf, parseAsOf, pathBetween, type EdgeProvenance } from '../../memory/graph.js';
import { formatRecallStats } from '../../memory/recall-stats.js';

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
      asOf: {
        type: 'string',
        description:
          'neighbors/path: answer "what did I believe at THAT moment" instead of now. ISO timestamp or YYYY-MM-DD (local midnight). Edges are time-sliced by validAt/invalidAt: an edge counts iff validAt <= asOf < invalidAt. Use it when the current answer contradicts an older decision and you need to know which belief was held then. Omit for the current view.',
      },
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
      prov: {
        type: 'string',
        enum: ['user_said', 'user_confirmed', 'tool_observed', 'reflection'],
        description:
          'add: provenance for belief grading. Global profile facts the user stated directly → user_said (internalized); reflection-only guesses → reflection (0.4, not internalized until confirmed).',
      },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action ?? '').trim();

    if (action === 'stats') {
      const s = graphStats();
      const pct = (n: number, total: number) => (total === 0 ? '—' : `${Math.round((n / total) * 100)}%`);
      const pv = s.vocab.project;
      const gv = s.vocab.global;
      const prov = Object.entries(s.provDistribution)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      return [
        `实体 ${s.entities} 条边(active ${s.edgesActive} / 已失效 ${s.edgesInvalid}),已分型实体 ${s.typedEntities}`,
        `project: ${s.byScope.project.entities} 实体, ${s.byScope.project.edges} 边`,
        `global:  ${s.byScope.global.entities} 实体, ${s.byScope.global.edges} 边`,
        `关系词表命中: project ${pv.inVocab}/${pv.total}(${pct(pv.inVocab, pv.total)}) | global ${gv.inVocab}/${gv.total}(${pct(gv.inVocab, gv.total)})`,
        `溯源分布: ${prov || '(无)'}`,
        `跨 scope 关系使用(观察用,非错误): project 用画像关系 ${s.crossScopeRelationUse.projectUsesProfileRel} 条 | global 用项目关系 ${s.crossScopeRelationUse.globalUsesProjectRel} 条`,
        `global 图指向本仓库源码路径的边: ${s.globalRepoPathEdges}(守卫生效后应为 0)`,
        formatRecallStats(),
      ].join('\n');
    }

    if (action === 'neighbors') {
      const query = String(args.query ?? '').trim();
      if (!query) return '错误:neighbors 需要 query(实体名或 id)。';
      const depth = typeof args.depth === 'number' ? args.depth : 1;
      const rel = typeof args.relation === 'string' ? args.relation.trim() : '';
      const asOf = parseAsOf(args.asOf);
      if (!asOf.ok) return `错误:${asOf.reason}`;
      const r = neighborsOf(query, depth, rel || undefined, asOf.ms);
      if (!r.center) return `(图中没有实体 "${query}")`;
      const relNote = rel ? `,仅 ${rel} 边` : '';
      const atNote = asOf.ms != null ? `,asOf ${new Date(asOf.ms).toISOString()}` : '';
      const lines = [
        `## ${r.center.name} (${r.center.id})${r.center.summary ? ` — ${r.center.summary}` : ''}`,
        r.entities.length > 0 ? `\n## 邻居实体\n${fmtEntities(r.entities)}` : '',
        `\n## 边(${r.edges.length}${relNote}${atNote}${r.truncated ? ',已截断' : ''})\n${fmtEdges(r.edges)}`,
        // 「那一刻没有边」与「实体不存在」是两种完全不同的答案,不说清楚会被误读成后者。
        asOf.ms != null && r.edges.length === 0 ? '\n(该时刻没有成立的边——实体在,但那时还没有这条关系)' : '',
      ].filter(Boolean);
      return lines.join('\n');
    }

    if (action === 'path') {
      const from = String(args.query ?? '').trim();
      const to = String(args.dst ?? '').trim();
      if (!from || !to) return '错误:path 需要 query(起点实体)和 dst(终点实体)。';
      const asOf = parseAsOf(args.asOf);
      if (!asOf.ok) return `错误:${asOf.reason}`;
      const r = pathBetween(from, to, asOf.ms);
      const scope = asOf.ms != null ? `该时刻(${new Date(asOf.ms).toISOString()})` : '现在';
      if (!r) return `(无 ${scope} 成立的路径:${from} ⇸ ${to},或端点实体不存在)`;
      const chain = r.path.map((e) => e.name).join(' → ');
      const lines = [
        `## ${r.from.name} ⇢ ${r.to.name}(${r.edges.length} 跳${asOf.ms != null ? `,asOf ${new Date(asOf.ms).toISOString()}` : ''})`,
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
      const prov = (['user_said', 'user_confirmed', 'tool_observed', 'reflection'] as const).find(
        (p) => args.prov === p,
      ) as EdgeProvenance | undefined;
      const r = addTriple({
        src,
        relation,
        dst,
        fact: typeof args.fact === 'string' ? args.fact : undefined,
        scope: args.scope === 'global' ? 'global' : 'project',
        prov,
      });
      if (!r.ok) return `错误:三元组未写入 (${r.reason})。`;
      if (r.duplicate) return `已存在相同三元组 (${r.edgeId}),幂等跳过。`;
      const sup = r.superseded > 0 ? `;旧边已时序失效(${r.superseded} 条)` : '';
      return `已写入三元组 ${src} --[${relation.toLowerCase().replace(/\s+/g, '_')}]--> ${dst} [${r.edgeId}]${sup}。`;
    }

    return `错误:未知 action "${action}",可用 neighbors/path/add/stats(关键词搜索请用 memory_search)。`;
  },
};
