import type { Tool } from '../types.js';
import { saveEntry, type MemoryType } from '../../memory/store.js';
import { addTriple } from '../../memory/graph.js';

// ---------- memory_save ----------
// 存一条长期记忆(跨会话)。启动只把标题/摘要注入索引(几百 token);详情按需 memory_search 取。
// 撞库(name→id 已存在)拒绝,引导用 memory_update。
// 可选 links:把本条记忆挂进知识图谱(memory-graph.json)——src 省略时默认以记忆 name 为主实体。
export const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    'Save a cross-session long-term memory entry. Store only non-obvious, useful facts/decisions/pitfalls. Title enters the startup index; retrieve body via memory_search. Optionally attach knowledge-graph links (triples) to relate this memory to entities.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short unique title (converted to id; rejected if it collides with an existing one)' },
      summary: { type: 'string', description: 'One-line summary (goes into the index; keep it short)' },
      body: { type: 'string', description: 'Full content (details/context/evidence)' },
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
        description: 'Category, default fact',
      },
      pinned: { type: 'boolean', description: 'Pin (exempt from auto-forgetting decay), default false' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Store at project level (<cwd>/.mocode/) or global (~/.mocode/), default project',
      },
      links: {
        type: 'array',
        description:
          'Optional knowledge-graph triples relating this memory to entities, e.g. [{"src":"mocode","relation":"depends_on","dst":"JSONL store"}]. src defaults to the memory name when omitted.',
        items: {
          type: 'object',
          properties: {
            src: { type: 'string', description: 'Source entity name (defaults to the memory name)' },
            relation: { type: 'string', description: 'Relation, snake_case, e.g. depends_on / decided_by / conflicts_with' },
            dst: { type: 'string', description: 'Target entity name' },
            fact: { type: 'string', description: 'Optional one-line statement for the edge' },
          },
          required: ['relation', 'dst'],
        },
      },
    },
    required: ['name', 'summary', 'body'],
  },
  async execute(args) {
    const name = String(args.name ?? '').trim();
    const summary = String(args.summary ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!name) return '错误:缺少 name。';
    if (!summary) return '错误:缺少 summary。';
    if (!body) return '错误:缺少 body。';
    const type =
      typeof args.type === 'string' ? (args.type as MemoryType) : undefined;
    const scope = args.scope === 'global' ? 'global' : 'project';
    const r = saveEntry({
      name,
      summary,
      body,
      type,
      pinned: args.pinned === true,
      scope,
    });
    if (!r.ok) {
      return `已存在同名记忆 [${r.exists}]。改用 memory_update(id="${r.exists}", …) 更新,或换一个 name。`;
    }
    // 知识图谱挂边:容错——图失败不影响记忆保存结果
    const links = Array.isArray(args.links) ? args.links : [];
    let linked = 0;
    for (const l of links) {
      if (!l || typeof l !== 'object') continue;
      const link = l as { src?: unknown; relation?: unknown; dst?: unknown; fact?: unknown };
      const tr = addTriple({
        src: typeof link.src === 'string' && link.src.trim() ? link.src : name,
        relation: typeof link.relation === 'string' ? link.relation : '',
        dst: typeof link.dst === 'string' ? link.dst : '',
        fact: typeof link.fact === 'string' ? link.fact : undefined,
        sourceEntry: r.id,
        scope,
      });
      if (tr.ok) linked++;
    }
    const linkNote = links.length > 0 ? `;知识图谱挂边 ${linked}/${links.length}` : '';
    return `已保存记忆 [${r.id}] "${name}"(下次启动进索引)${linkNote}。`;
  },
};
