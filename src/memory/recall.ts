// recall.ts —— 项目知识图谱的「可检索性」提示(pull 召回的触发器)。
//
// 问题:项目 triples 写入 memory-graph.json 后,常驻上下文里没有任何线索告诉模型
// "仓库里存了这些事实",模型不知道要搜 → 85 条事实近乎只写不读。这里产出一小段
// 稳定的项目图谱提示(主要主题实体 + 检索指引),拼进 system prompt,让模型在相关时
// 主动 memory_search / memory_graph。只给"地图"不给正文,正文仍走按需 pull(零空转成本)。
//
// 与 About you(global、内化画像)对称:这是 project 轨、可检索的仓库事实索引。
// 纯读、叶子依赖(graph)。内容只依赖图文件,会话内不随每步变化(同 Memory Index 的启动快照语义)。

import { loadScopeGraph, type GraphEntity } from './graph.js';
import type { MemoryScope } from './store.js';

/** 图谱提示段硬预算(字符)。 */
export const GRAPH_HINT_MAX_CHARS = 600;
/** 列出的主题实体上限。 */
const GRAPH_HINT_TOP_ENTITIES = 12;

/**
 * 项目图谱常驻提示:无 active 边 → 空串(零注入)。
 * 主题实体按 active 度数(参与的 active 边数)降序、再按名字排序,取前 N。
 */
export function buildProjectGraphHint(memoryEnabled: boolean = true, scope: MemoryScope = 'project'): string {
  if (!memoryEnabled) return '';
  const g = loadScopeGraph(scope);
  const activeEdges = g.edges.filter((e) => !e.invalidAt);
  if (activeEdges.length === 0) return '';

  const degree = new Map<string, number>();
  for (const e of activeEdges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  const named = g.entities.filter((x): x is GraphEntity => !!x && typeof x.name === 'string' && x.name.length > 0);
  const top = named
    .map((e) => ({ e, d: degree.get(e.id) ?? 0 }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d || a.e.name.localeCompare(b.e.name))
    .slice(0, GRAPH_HINT_TOP_ENTITIES)
    .map((x) => x.e.name);

  const header = `## Project knowledge graph (query on demand, not auto-loaded)`;
  const body =
    `This repo has a memory graph with ${g.entities.length} entities / ${activeEdges.length} facts ` +
    `(modules, tools, configs, decisions, pitfalls…). When relevant to the current task, query it before re-deriving: ` +
    `memory_search("keywords") also returns matching graph facts (CJK-aware, with one-hop neighbors); ` +
    `memory_graph action=neighbors|path expands connections. Main subjects: ${top.join('、')}.`;
  const out = ['', header, body].join('\n');
  return out.length <= GRAPH_HINT_MAX_CHARS
    ? out
    : out.slice(0, GRAPH_HINT_MAX_CHARS).replace(/[、,]\s*[^、,]*$/, ' …');
}
