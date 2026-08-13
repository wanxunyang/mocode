// memory 知识图谱层(Tier-2):Graphiti 式时序三元组,纯 JSON 文件存储。
// 叶子模块:仅依赖 node 标准库 + tools/constants(常量叶子)+ store.ts 的类型,
// 与 store.ts 同风格:同步读写、整文件 tmp+rename 原子落盘、静默容错。
//
// 两文件(镜像 store.ts 的双 scope):
//   全局  ~/.mocode/memory-graph.json
//   项目  <cwd>/.mocode/memory-graph.json
// 文件形如 {"entities":[...],"edges":[...]}。scope 以所在文件为准(loadAllGraph 归一化)。
//
// 时序语义(抄 Graphiti/Zep 的核心思想,文件实现):边带 validAt/invalidAt。
// 新三元组与既有 active 边同(src,dst,relation)且 fact 不同 → 旧边 invalidAt=now(不删,可追溯);
// fact 相同 → 幂等跳过。查询默认只看 active(invalidAt==null)。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_GRAPH_EDGES, MAX_GRAPH_ENTITIES } from '../tools/constants.js';
import type { MemoryScope } from './store.js';

export interface GraphEntity {
  id: string;
  name: string;
  aliases: string[];
  summary: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  scope: MemoryScope;
}

export interface GraphEdge {
  id: string;
  src: string; // entity id
  dst: string; // entity id
  relation: string; // 小写归一化
  fact: string; // 可选一句话陈述
  validAt: string; // ISO
  invalidAt: string | null; // 被新边取代时置时间戳(时序失效,不删除)
  sourceEntry: string | null; // 源 memory 条目 id(可溯源)
  scope: MemoryScope;
}

interface GraphFile {
  entities: GraphEntity[];
  edges: GraphEdge[];
}

// ── 路径 / 原子写(同 store.ts 风格)──────────────────────────────────────
function globalGraphPath(): string {
  return path.join(os.homedir(), '.mocode', 'memory-graph.json');
}
function projectGraphPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-graph.json');
}
function graphPathForScope(scope: MemoryScope): string {
  return scope === 'global' ? globalGraphPath() : projectGraphPath();
}
function ensureDir(p: string): void {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function writeGraphAtomic(p: string, g: GraphFile): void {
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(g, null, 2), 'utf8');
  renameSync(tmp, p);
}
function readGraphFile(p: string): GraphFile {
  if (!existsSync(p)) return { entities: [], edges: [] };
  try {
    const raw = readFileSync(p, 'utf8');
    if (!raw.trim()) return { entities: [], edges: [] };
    const obj = JSON.parse(raw) as Partial<GraphFile>;
    return {
      entities: Array.isArray(obj.entities) ? obj.entities : [],
      edges: Array.isArray(obj.edges) ? obj.edges : [],
    };
  } catch {
    return { entities: [], edges: [] }; // 损坏文件不连累全局
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

let entCounter = 0;
/** 实体名 → ASCII slug;纯 CJK 等空结果用 ent 前缀兜底(同 store.ts slugify 思路)。 */
function entitySlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s) return s;
  entCounter++;
  return 'ent-' + Date.now().toString(36) + entCounter.toString(36);
}

let edgeCounter = 0;
function nextEdgeId(): string {
  edgeCounter++;
  return 'edge-' + Date.now().toString(36) + edgeCounter.toString(36);
}

/** 读两文件并按文件归一化 scope。 */
export function loadAllGraph(): GraphFile {
  const out: GraphFile = { entities: [], edges: [] };
  for (const scope of ['global', 'project'] as const) {
    const g = readGraphFile(graphPathForScope(scope));
    for (const e of g.entities) {
      e.scope = scope;
      out.entities.push(e);
    }
    for (const e of g.edges) {
      e.scope = scope;
      out.edges.push(e);
    }
  }
  return out;
}

function writeGraphForScope(scope: MemoryScope, g: GraphFile): void {
  const p = graphPathForScope(scope);
  ensureDir(p);
  writeGraphAtomic(p, { entities: g.entities, edges: g.edges });
}

/** 单 scope 的完整图(读文件,scope 归一化)。 */
function loadScopeGraph(scope: MemoryScope): GraphFile {
  const g = readGraphFile(graphPathForScope(scope));
  for (const e of g.entities) e.scope = scope;
  for (const e of g.edges) e.scope = scope;
  return g;
}

// ── 实体 ─────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.trim().toLowerCase();

function findEntityIn(g: GraphFile, name: string): GraphEntity | undefined {
  const q = norm(name);
  if (!q) return undefined;
  return g.entities.find(
    (e) => e.id === q || norm(e.name) === q || e.aliases.some((a) => norm(a) === q),
  );
}

/** 全局找实体(两 scope,project 优先——项目事实比全局更具体)。 */
export function findEntity(name: string): GraphEntity | undefined {
  const proj = findEntityIn(loadScopeGraph('project'), name);
  if (proj) return proj;
  return findEntityIn(loadScopeGraph('global'), name);
}

export interface UpsertEntityResult {
  id: string;
  created: boolean;
  rejected?: string;
}

/**
 * upsert 实体:按 name/alias/id 匹配,命中则合并 alias/summary;未命中建新。
 * scope 容量保护:超限先清孤儿实体(无任何 active 边相连);仍超 → 拒绝新实体。
 */
export function upsertEntity(
  name: string,
  opts: { summary?: string; alias?: string; scope?: MemoryScope } = {},
): UpsertEntityResult {
  const scope: MemoryScope = opts.scope === 'global' ? 'global' : 'project';
  const trimmed = name.trim();
  if (!trimmed) return { id: '', created: false, rejected: 'empty-name' };
  const g = loadScopeGraph(scope);
  const hit = findEntityIn(g, trimmed);
  if (hit) {
    let dirty = false;
    if (opts.alias && !hit.aliases.some((a) => norm(a) === norm(opts.alias!))) {
      hit.aliases.push(opts.alias.trim());
      dirty = true;
    }
    if (opts.summary && opts.summary.trim() && opts.summary.trim() !== hit.summary) {
      hit.summary = opts.summary.trim();
      dirty = true;
    }
    if (dirty) {
      hit.updatedAt = nowIso();
      writeGraphForScope(scope, g);
    }
    return { id: hit.id, created: false };
  }
  // 新建:容量保护
  if (g.entities.length >= MAX_GRAPH_ENTITIES) {
    const linked = new Set<string>();
    for (const e of g.edges) {
      if (!e.invalidAt) {
        linked.add(e.src);
        linked.add(e.dst);
      }
    }
    g.entities = g.entities.filter((e) => linked.has(e.id));
    if (g.entities.length >= MAX_GRAPH_ENTITIES) {
      return { id: '', created: false, rejected: 'entity-cap' };
    }
  }
  const now = nowIso();
  const ent: GraphEntity = {
    id: entitySlug(trimmed),
    name: trimmed,
    aliases: opts.alias && norm(opts.alias) !== norm(trimmed) ? [opts.alias.trim()] : [],
    summary: opts.summary?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
    scope,
  };
  // slug 碰撞兜底(两个不同名字 slug 相同)
  while (g.entities.some((e) => e.id === ent.id)) ent.id += 'x';
  g.entities.push(ent);
  writeGraphForScope(scope, g);
  return { id: ent.id, created: true };
}

// ── 边(时序三元组)──────────────────────────────────────────────────────
export interface TripleInput {
  src: string;
  relation: string;
  dst: string;
  fact?: string;
  sourceEntry?: string | null;
  scope?: MemoryScope;
}

export type AddTripleResult =
  | { ok: true; edgeId: string; superseded: number; duplicate?: boolean }
  | { ok: false; reason: string };

/**
 * 写一条三元组。src/dst 自动 upsert 为实体。
 * 冲突策略:同 scope 内已有 active 边同(src,dst,relation):
 *  - fact 相同 → 幂等跳过(duplicate);
 *  - fact 不同 → 旧边 invalidAt=now(时序失效),新边入库。
 * 容量保护:边超限先清已失效边;仍超 → 拒绝。
 */
export function addTriple(input: TripleInput): AddTripleResult {
  const src = input.src?.trim();
  const dst = input.dst?.trim();
  const relation = input.relation?.trim().toLowerCase().replace(/\s+/g, '_');
  if (!src || !dst || !relation) return { ok: false, reason: 'missing src/relation/dst' };
  if (src.length > 80 || dst.length > 80 || relation.length > 60) {
    return { ok: false, reason: 'src/dst/relation too long' };
  }
  const scope: MemoryScope = input.scope === 'global' ? 'global' : 'project';
  const s = upsertEntity(src, { scope });
  if (s.rejected) return { ok: false, reason: `src entity: ${s.rejected}` };
  const d = upsertEntity(dst, { scope });
  if (d.rejected) return { ok: false, reason: `dst entity: ${d.rejected}` };

  const g = loadScopeGraph(scope);
  const fact = (input.fact ?? '').trim();
  const clash = g.edges.find(
    (e) => !e.invalidAt && e.src === s.id && e.dst === d.id && e.relation === relation,
  );
  if (clash) {
    if (!fact || clash.fact === fact) {
      return { ok: true, edgeId: clash.id, superseded: 0, duplicate: true };
    }
    clash.invalidAt = nowIso(); // 时序失效,保留可追溯
  }

  // 容量保护:先清失效边
  if (g.edges.length >= MAX_GRAPH_EDGES) {
    g.edges = g.edges.filter((e) => !e.invalidAt);
    if (g.edges.length >= MAX_GRAPH_EDGES) {
      return { ok: false, reason: 'edge-cap' };
    }
  }
  const edge: GraphEdge = {
    id: nextEdgeId(),
    src: s.id,
    dst: d.id,
    relation,
    fact,
    validAt: nowIso(),
    invalidAt: null,
    sourceEntry: input.sourceEntry ?? null,
    scope,
  };
  g.edges.push(edge);
  writeGraphForScope(scope, g);
  return { ok: true, edgeId: edge.id, superseded: clash ? 1 : 0 };
}

// ── 查询 ────────────────────────────────────────────────────────────────
export interface GraphSearchResult {
  entities: GraphEntity[];
  edges: GraphEdge[]; // 命中实体相连的 active 边
}

/** 实体关键词搜索(多词子串,name/alias/id 加权),返回命中实体 + 相连 active 边。 */
export function searchGraph(query: string, limit: number = 8): GraphSearchResult {
  const g = loadAllGraph();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = g.entities
    .map((e) => {
      let sc = 0;
      const name = e.name.toLowerCase();
      const id = e.id.toLowerCase();
      const aliases = e.aliases.map((a) => a.toLowerCase());
      for (const t of terms) {
        if (id.includes(t)) sc += 8;
        if (name.includes(t)) sc += 10;
        if (aliases.some((a) => a.includes(t))) sc += 6;
        if (e.summary.toLowerCase().includes(t)) sc += 2;
      }
      return { e, sc };
    })
    .filter((x) => (terms.length === 0 ? true : x.sc > 0))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, Math.max(1, Math.min(limit, 20)));
  const hitIds = new Set(scored.map((x) => x.e.id));
  const edges = g.edges.filter(
    (e) => !e.invalidAt && (hitIds.has(e.src) || hitIds.has(e.dst)),
  );
  return { entities: scored.map((x) => x.e), edges };
}

export interface NeighborResult {
  center: GraphEntity | null;
  entities: GraphEntity[]; // 不含 center
  edges: GraphEdge[]; // BFS 覆盖的 active 边(depth=2 含二跳)
  truncated: boolean;
}

/** active 边的无向邻接表(一次建表,O(V+E));可选 relation 过滤。 */
type Adjacency = Map<string, GraphEdge[]>;
function buildAdjacency(g: GraphFile, relation?: string): Adjacency {
  const adj: Adjacency = new Map();
  for (const e of g.edges) {
    if (e.invalidAt) continue;
    if (relation && e.relation !== relation) continue;
    const a = adj.get(e.src);
    if (a) a.push(e);
    else adj.set(e.src, [e]);
    const b = adj.get(e.dst);
    if (b) b.push(e);
    else adj.set(e.dst, [e]);
  }
  return adj;
}

/**
 * 邻居遍历:depth 1-3(BFS + 邻接表 O(V+E)),只看 active 边,边数封顶 40 防图爆炸。
 * relation 可选:只沿该类型的边走(深跳聚焦用,如沿 depends_on 链追踪)。
 */
export function neighborsOf(
  nameOrId: string,
  depth: number = 1,
  relation?: string,
): NeighborResult {
  const g = loadAllGraph();
  const center = findEntityIn(g, nameOrId) ?? g.entities.find((e) => e.id === nameOrId);
  if (!center) return { center: null, entities: [], edges: [], truncated: false };
  const rel = relation?.trim().toLowerCase().replace(/\s+/g, '_') || undefined;
  const maxDepth = Math.max(1, Math.min(Math.floor(depth) || 1, 3));
  const MAX_EDGES_OUT = 40;
  const adj = buildAdjacency(g, rel);
  const visited = new Set<string>([center.id]);
  const seenEdges = new Set<string>();
  const outEdges: GraphEdge[] = [];
  let frontier = [center.id];
  let truncated = false;
  outer: for (let d = 0; d < maxDepth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of adj.get(id) ?? []) {
        if (seenEdges.has(e.id)) continue;
        seenEdges.add(e.id);
        if (outEdges.length >= MAX_EDGES_OUT) {
          truncated = true;
          break outer; // 截断立即退出,不再空扫剩余边
        }
        outEdges.push(e);
        const other = e.src === id ? e.dst : e.src;
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const entities = g.entities.filter((e) => visited.has(e.id) && e.id !== center.id);
  return { center, entities, edges: outEdges, truncated };
}

export interface PathResult {
  from: GraphEntity;
  to: GraphEntity;
  path: GraphEntity[]; // 含两端;单实体时长度为 1
  edges: GraphEdge[]; // 路径上的边,len = path.length - 1
}

const MAX_PATH_DEPTH = 6;

/**
 * 两实体间最短路径:active 边视为无向,双向 BFS(每次展开较小前沿),
 * 总跳数封顶 MAX_PATH_DEPTH 防图爆炸。不连通 / 未知端 → null。
 */
export function pathBetween(aNameOrId: string, bNameOrId: string): PathResult | null {
  const g = loadAllGraph();
  const from = findEntityIn(g, aNameOrId) ?? g.entities.find((e) => e.id === aNameOrId);
  const to = findEntityIn(g, bNameOrId) ?? g.entities.find((e) => e.id === bNameOrId);
  if (!from || !to) return null;
  if (from.id === to.id) return { from, to, path: [from], edges: [] };

  interface Trace {
    prev: string | null;
    edge: GraphEdge | null;
  }
  const fwd = new Map<string, Trace>([[from.id, { prev: null, edge: null }]]);
  const bwd = new Map<string, Trace>([[to.id, { prev: null, edge: null }]]);
  let fFront = [from.id];
  let bFront = [to.id];
  const adj = buildAdjacency(g);
  let meet: string | null = null;

  for (let d = 0; d < MAX_PATH_DEPTH && !meet; d++) {
    const expandFwd = fFront.length <= bFront.length;
    const mine = expandFwd ? fwd : bwd;
    const theirs = expandFwd ? bwd : fwd;
    const frontier = expandFwd ? fFront : bFront;
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of adj.get(id) ?? []) {
        const other = e.src === id ? e.dst : e.src;
        if (mine.has(other)) continue;
        mine.set(other, { prev: id, edge: e });
        next.push(other);
        if (theirs.has(other)) {
          meet = other;
          break;
        }
      }
      if (meet) break;
    }
    if (expandFwd) fFront = next;
    else bFront = next;
  }
  if (!meet) return null;

  // 重组:fwd 链 from→…→meet,再接 bwd 链 meet→…→to
  const rev: string[] = [];
  for (let cur: string | null = meet; cur; cur = fwd.get(cur)?.prev ?? null) rev.push(cur);
  rev.reverse(); // [from, ..., meet]
  const pathIds = [...rev];
  const pathEdges: GraphEdge[] = [];
  for (const id of rev.slice(1)) {
    const e = fwd.get(id)?.edge;
    if (e) pathEdges.push(e);
  }
  for (let cur: string | null = meet; ; ) {
    const t = bwd.get(cur);
    if (!t?.prev) break;
    if (t.edge) pathEdges.push(t.edge);
    pathIds.push(t.prev);
    cur = t.prev;
  }
  const byId = new Map<string, GraphEntity>();
  for (const e of g.entities) if (!byId.has(e.id)) byId.set(e.id, e);
  const path = pathIds.map((id) => byId.get(id)).filter((e): e is GraphEntity => !!e);
  return { from, to, path, edges: pathEdges };
}

export interface GraphStats {
  entities: number;
  edgesActive: number;
  edgesInvalid: number;
  byScope: { project: { entities: number; edges: number }; global: { entities: number; edges: number } };
}

export function graphStats(): GraphStats {
  const g = loadAllGraph();
  const count = (scope: MemoryScope) => ({
    entities: g.entities.filter((e) => e.scope === scope).length,
    edges: g.edges.filter((e) => e.scope === scope && !e.invalidAt).length,
  });
  return {
    entities: g.entities.length,
    edgesActive: g.edges.filter((e) => !e.invalidAt).length,
    edgesInvalid: g.edges.filter((e) => !!e.invalidAt).length,
    byScope: { project: count('project'), global: count('global') },
  };
}
