import type { Tool } from '../types.js';
import {
  searchEntries,
  loadStalenessMap,
  type MemoryType,
  type MemoryStatus,
  type MemoryEntry,
  type EntryStaleness,
} from '../../memory/store.js';
import { describeAnchorState, evaluateAnchors, type EntryAnchorState } from '../../memory/anchor.js';
import { searchGraphFacts } from '../../memory/graph.js';
import { recordRecallSearch } from '../../memory/recall-stats.js';

// ---------- memory_search ----------
// 唯一记忆搜索入口:关键词搜记忆正文(多词子串匹配,name 权重最高)+ 知识图谱事实段
// (CJK 分词加权、边级相关度 + 一跳邻接,跨 global/project 两 scope)。命中条目即 bump
// recallCount(遗忘衰减依据)。结果走 capToolResultForHistory 的放宽上限(同 use_skill)。
const GRAPH_FACTS_LIMIT = 10;

/**
 * R14:状态标记。**默认 active 且非失效时不输出任何东西**——绝大多数查询走默认
 * `status:'active'`,那条路径必须零噪音,否则每条记忆都多一行前缀,白占上下文。
 *
 * R2:代码锚点失效走同一个位置但**分开措辞**。两种失效要模型做的事不一样:
 * `STALE-DERIVED` 是「这条结论的根据没了」,`STALE-CODE` 是「结论可能仍对,但它描述的
 * 那段代码/行号/细节要重新核对」——合并成一句会丢掉这个区别。
 */
function statusMark(e: MemoryEntry, st: EntryStaleness | undefined, anchor: EntryAnchorState | undefined): string {
  const parts: string[] = [];
  if (e.status === 'superseded') parts.push(`SUPERSEDED${e.supersededBy ? ` → ${e.supersededBy}` : ''}`);
  else if (e.status === 'archived') parts.push('ARCHIVED');
  if (st?.stale) {
    // 失效原因是给模型判断"还能不能用"的关键:源被取代(结论可能仍成立)
    // 与源被删(根据没了)是两回事。
    const why = [
      st.inactive.length > 0 ? `源已失效: ${st.inactive.join(', ')}` : '',
      st.missing.length > 0 ? `源已被删除: ${st.missing.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    parts.push(`STALE-DERIVED${why ? ` (${why})` : ''}`);
  }
  if (anchor?.stale) {
    const why = describeAnchorState(anchor);
    parts.push(`STALE-CODE${why ? ` (${why})` : ''}`);
  }
  return parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
}

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    'Search memory entries by keyword (substring match), returning full body. Also surfaces knowledge-graph facts (active edges across project + global), ranked by CJK-aware term overlap on entity names/aliases/relation/fact, plus one-hop neighbor edges for context.',
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
      status: typeof args.status === 'string' ? (args.status as MemoryStatus | 'any') : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
    // R14:派生条目的失效判定要拿全库做源查找(源可能在另一 scope,也可能已被硬删),
    // 不能在命中结果集内自洽判断。searchEntries 已 bump 过 recall,这里再 loadAll
    // 拿到的是同一份(含脏集增量),不会引入不一致。
    const staleInfo = r.length > 0 ? loadStalenessMap() : new Map<string, EntryStaleness>();
    // R2:锚点判定只针对**命中条目**,不走 loadAnchorStaleMap(那会扫全库并 stat 每个锚点)。
    // 命中集通常 5 条,而且 readCached 有 mtime 缓存,成本可以忽略。
    const anchorInfo = new Map<string, EntryAnchorState>();
    for (const e of r) {
      if (!e.anchors || e.anchors.length === 0) continue;
      anchorInfo.set(e.id, evaluateAnchors(e.anchors));
    }
    const entryText = r
      .map((e) => {
        // R1.5:条件-动作字段放在最前面,它们是"要不要用上这条记忆"的判断依据;
        // 只有存在时才输出,老条目无此字段不受影响。
        const lead = [e.trigger ? `when: ${e.trigger}` : '', e.action ? `do: ${e.action}` : '']
          .filter(Boolean)
          .join('\n');
        // R14:状态标记必须紧贴标题。模型是把整块结果当"现状"读的——一条已被取代的
        // 条目混在 active 里,它不会自己去比对 updatedAt。实测 status='any' 时 archived
        // 条目能占到前 4 名,不给标记就等于把过期事实当现状喂进去。
        const mark = statusMark(e, staleInfo.get(e.id), anchorInfo.get(e.id));
        return `# [${e.id}] ${e.name} (${e.type}, recalled ${e.recallCount})${mark}\nsummary: ${e.summary}\n${
          lead ? lead + '\n' : ''
        }\n${e.body}`;
      })
      .join('\n\n---\n\n');

    // 知识图谱事实段:边级相关度检索(容错:图坏了不连累条目搜索)。
    let graphText = '';
    let graphHit = false;
    try {
      const hits = searchGraphFacts(query, { scope: 'all', limit: GRAPH_FACTS_LIMIT, neighbors: 4 });
      graphHit = hits.length > 0;
      if (graphHit) {
        const lines = hits.map((h) => {
          const src = h.srcEntity?.name ?? h.edge.src;
          const dst = h.dstEntity?.name ?? h.edge.dst;
          const fact = h.edge.fact ? ` (${h.edge.fact})` : '';
          const tag = h.viaNeighbor ? ' [neighbor]' : '';
          const scopeTag = h.edge.scope === 'global' ? '[global]' : '[project]';
          return `${scopeTag} ${src} --[${h.edge.relation}]--> ${dst}${fact}${tag}`;
        });
        graphText = `\n\n## 知识图谱事实\n${lines.join('\n')}`;
      }
    } catch {
      // 静默:图谱段是增强,失败只降级为纯条目结果
    }
    recordRecallSearch(graphHit); // 埋点:pull 召回使用情况(写盘失败静默)

    if (!entryText && !graphText) return `(无匹配记忆:query="${query}")`;
    if (!entryText) return `(无匹配记忆条目,但图谱有命中)\n${graphText.trimStart()}`;
    return entryText + graphText;
  },
};
