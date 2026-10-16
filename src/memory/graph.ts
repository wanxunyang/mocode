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
  /**
   * 轻量实体类型(轻量本体,memory-2.2):缺省 'unknown'。当前仅用于 person 合并守卫等
   * 安全用途,不做 domain/range 强校验;将来完整 ontology 再扩展(Person/Tool/Port…)。
   */
  type?: string;
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
export function loadScopeGraph(scope: MemoryScope): GraphFile {
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
  return g.entities.find((e) => e.id === q || norm(e.name) === q || e.aliases.some((a) => norm(a) === q));
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
  opts: { summary?: string; alias?: string; scope?: MemoryScope; type?: string } = {},
): UpsertEntityResult {
  const scope: MemoryScope = opts.scope === 'global' ? 'global' : 'project';
  const trimmed = name.trim();
  if (!trimmed) return { id: '', created: false, rejected: 'empty-name' };
  const nextType = opts.type?.trim() || undefined;
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
    if (nextType && (hit.type ?? '') !== nextType) {
      hit.type = nextType;
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
    type: nextType,
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
  const clash = g.edges.find((e) => !e.invalidAt && e.src === s.id && e.dst === d.id && e.relation === relation);
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
  const edges = g.edges.filter((e) => !e.invalidAt && (hitIds.has(e.src) || hitIds.has(e.dst)));
  return { entities: scored.map((x) => x.e), edges };
}

// ── 边(事实)级词面检索:供 memory_search 的图谱事实段 ─────────────────────
// searchGraph 是实体名/别名子串匹配,中文整句 fact 与多词 query 召回弱。这里用
// context/text-search 的 CJK 分词(unigram+bigram)对「端点实体名/别名 + relation +
// fact」做加权词面打分,再做一跳邻接扩展(命中实体相连的其它 active 边,降权补全)。

import { tokenize } from '../context/text-search.js';

export interface FactHit {
  edge: GraphEdge;
  srcEntity: GraphEntity | null;
  dstEntity: GraphEntity | null;
  score: number;
  /** true = 非直接命中,而是命中实体的一跳邻接边(降权补全上下文)。 */
  viaNeighbor: boolean;
}

export interface FactSearchOptions {
  scope?: MemoryScope | 'all';
  limit?: number;
  /** 一跳邻接扩展的最大边数(默认 4);0 关闭。 */
  neighbors?: number;
}

const FIELD_WEIGHTS = { name: 6, alias: 4, fact: 2, relation: 2 } as const;

/** 统计 query terms 在一段文本里的命中次数。 */
function termHits(terms: string[], text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (lower.includes(t)) hits++;
  return hits;
}

/**
 * 边级相关度检索。仅 active 边;按 scope 过滤。排序:score 降序、其次边 id(稳定)。
 * 要求至少一个 query term 直接命中才返回(邻接边依附于直接命中,不会凭空出现)。
 */
export function searchGraphFacts(query: string, opts: FactSearchOptions = {}): FactHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const scope = opts.scope ?? 'all';
  const limit = Math.max(1, opts.limit ?? 8);
  const neighborCap = Math.max(0, opts.neighbors ?? 4);

  const g = loadAllGraph();
  const inScope = (s: MemoryScope) => scope === 'all' || s === scope;
  const byId = new Map(g.entities.map((e) => [e.id, e]));
  const activeEdges = g.edges.filter((e) => !e.invalidAt && inScope(e.scope));

  const scoreEdge = (e: GraphEdge): number => {
    const src = byId.get(e.src);
    const dst = byId.get(e.dst);
    let score = 0;
    if (src) {
      score += termHits(terms, src.name) * FIELD_WEIGHTS.name;
      for (const a of src.aliases) score += termHits(terms, a) * FIELD_WEIGHTS.alias;
    }
    if (dst) {
      score += termHits(terms, dst.name) * FIELD_WEIGHTS.name;
      for (const a of dst.aliases) score += termHits(terms, a) * FIELD_WEIGHTS.alias;
    }
    score += termHits(terms, e.relation) * FIELD_WEIGHTS.relation;
    score += termHits(terms, e.fact) * FIELD_WEIGHTS.fact;
    return score;
  };

  const direct = activeEdges
    .map((edge) => ({ edge, score: scoreEdge(edge) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.edge.id.localeCompare(b.edge.id));

  const chosen: FactHit[] = [];
  const chosenIds = new Set<string>();
  const hitEndpoints = new Set<string>();
  for (const { edge, score } of direct.slice(0, limit)) {
    chosen.push({
      edge,
      srcEntity: byId.get(edge.src) ?? null,
      dstEntity: byId.get(edge.dst) ?? null,
      score,
      viaNeighbor: false,
    });
    chosenIds.add(edge.id);
    hitEndpoints.add(edge.src);
    hitEndpoints.add(edge.dst);
  }

  // 一跳邻接:命中实体相连的其它 active 边,固定降权(0.45× 直接边的保底分),补足上下文。
  if (neighborCap > 0 && chosen.length > 0) {
    const directTop = direct[0]?.score ?? 1;
    const neighborScore = Math.max(1, Math.round(directTop * 0.45));
    const extras = activeEdges
      .filter((e) => !chosenIds.has(e.id) && (hitEndpoints.has(e.src) || hitEndpoints.has(e.dst)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, neighborCap);
    for (const edge of extras) {
      chosen.push({
        edge,
        srcEntity: byId.get(edge.src) ?? null,
        dstEntity: byId.get(edge.dst) ?? null,
        score: neighborScore,
        viaNeighbor: true,
      });
    }
  }
  return chosen;
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
export function neighborsOf(nameOrId: string, depth: number = 1, relation?: string): NeighborResult {
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

// ── 规范用户画像实体(G0 身份归一)──────────────────────────────────────────
//
// 全局图里历史上反思自由起名,把同一个用户碎成多个实体(实测:mocode user / 万 /
// user-name-wanjizhu / user-role-… 互不相连)。这里固定一个主键实体,所有"关于人"
// 的属性都挂到它身上;角色值(user-role-*)是属性的**值**不是人,不并入。

/** 全局规范用户实体的固定 id(概念名 person:primary,实现用文件安全 slug)。 */
export const PRIMARY_PERSON_ID = 'person-primary';
/** 规范用户实体的轻量类型标记。 */
export const PERSON_TYPE = 'Person';
/** 未分型实体的占位类型(历史数据无 type 字段时按此处理,不参与跨类型守卫)。 */
export const UNKNOWN_TYPE = 'unknown';

/** 实体有效类型(缺省/空串视为 unknown)。 */
function entityType(e: GraphEntity): string {
  const t = (e.type ?? '').trim();
  return t || UNKNOWN_TYPE;
}

/** 判定一个全局实体是否"用户指称碎片"(应并入 primary),角色值实体除外。 */
function isPersonFragment(e: GraphEntity, selfNameHints: Set<string>): boolean {
  const id = e.id.toLowerCase();
  const name = e.name.trim().toLowerCase();
  if (id === PRIMARY_PERSON_ID) return false;
  if (id.startsWith('user-role-')) return false; // 角色值,不是人
  if (id === 'mocode-user' || name === 'mocode user') return true;
  if (id.startsWith('user-name-')) return true;
  // 经 named 边收集到的自称(如"万")
  if (selfNameHints.has(name)) return true;
  return false;
}

/** 确保全局规范用户实体存在(固定 id,绕过自由 slug);返回其最新内容。 */
export function ensurePrimaryPerson(displayName?: string): GraphEntity {
  const scope: MemoryScope = 'global';
  const g = loadScopeGraph(scope);
  let p = g.entities.find((e) => e.id === PRIMARY_PERSON_ID);
  if (!p) {
    const now = nowIso();
    p = {
      id: PRIMARY_PERSON_ID,
      name: (displayName ?? 'user').trim() || 'user',
      aliases: [],
      summary: '规范用户实体(所有跨项目的用户画像属性挂这里)',
      type: PERSON_TYPE,
      createdAt: now,
      updatedAt: now,
      scope,
    };
    g.entities.push(p);
    writeGraphForScope(scope, g);
    return p;
  }
  let dirty = false;
  if (entityType(p) !== PERSON_TYPE) {
    p.type = PERSON_TYPE; // 历史库回填:G0 已建的 primary 当时无 type
    dirty = true;
  }
  if (displayName && displayName.trim() && displayName.trim() !== p.name) {
    if (!p.aliases.includes(p.name)) p.aliases.push(p.name);
    p.name = displayName.trim();
    dirty = true;
  }
  if (!p.summary) {
    p.summary = '规范用户实体(所有跨项目的用户画像属性挂这里)';
    dirty = true;
  }
  if (dirty) {
    p.updatedAt = nowIso();
    writeGraphForScope(scope, g);
  }
  return p;
}

export interface MergeReport {
  target: string;
  merged: string[];
  /** 迁移后边去重而被失效的边数。 */
  dedupedEdges: number;
  /** 非空表示未合并(如跨类型守卫拦截);merged 此时为空。 */
  rejected?: string;
}

/**
 * 把同一 scope 内 source 实体并入 target:
 *  - source 的 active 边 endpoint 改写为 target;改写后与 target 现有 active 边
 *    (src,relation,dst) 全等的重复边置 invalidAt(时序失效,不删);
 *  - source 名字/别名并入 target.aliases;source 标 mergedInto 保留(可追溯、可被别名词命中)。
 * 类型守卫(轻量本体):双方都已明确分型(非 unknown)且类型不同 → 拒绝,防止把
 * Port/Hobby 等异类实体误并进 Person;任一方 unknown(历史未分型)则照常允许。
 * 幂等:source===target 或不存在则 no-op(null)。
 */
export function mergeEntities(targetId: string, sourceId: string, scope: MemoryScope = 'global'): MergeReport | null {
  if (targetId === sourceId) return null;
  const g = loadScopeGraph(scope);
  const target = g.entities.find((e) => e.id === targetId);
  const source = g.entities.find((e) => e.id === sourceId);
  if (!target || !source) return null;

  const tt = entityType(target);
  const st = entityType(source);
  if (tt !== UNKNOWN_TYPE && st !== UNKNOWN_TYPE && tt !== st) {
    return { target: targetId, merged: [], dedupedEdges: 0, rejected: `type-mismatch: ${st} != ${tt}` };
  }

  const activeOf = (id: string) => g.edges.filter((e) => !e.invalidAt && (e.src === id || e.dst === id));
  const existsActive = (src: string, relation: string, dst: string) =>
    g.edges.some((e) => !e.invalidAt && e.src === src && e.relation === relation && e.dst === dst);

  let dedupedEdges = 0;
  for (const edge of activeOf(sourceId)) {
    const nextSrc = edge.src === sourceId ? targetId : edge.src;
    const nextDst = edge.dst === sourceId ? targetId : edge.dst;
    if (nextSrc === nextDst) {
      edge.invalidAt = nowIso(); // 自指环(并入自己)无意义,失效
      dedupedEdges++;
      continue;
    }
    if (existsActive(nextSrc, edge.relation, nextDst) && (nextSrc !== edge.src || nextDst !== edge.dst)) {
      edge.invalidAt = nowIso(); // target 已有等价 active 边,去重
      dedupedEdges++;
      continue;
    }
    edge.src = nextSrc;
    edge.dst = nextDst;
  }

  const addAlias = (a: string) => {
    const v = a.trim();
    if (v && v !== target.name && !target.aliases.includes(v)) target.aliases.push(v);
  };
  addAlias(source.name);
  for (const a of source.aliases) addAlias(a);
  (source as GraphEntity & { mergedInto?: string }).mergedInto = targetId;
  source.updatedAt = nowIso();
  target.updatedAt = nowIso();

  writeGraphForScope(scope, g);
  return { target: targetId, merged: [sourceId], dedupedEdges };
}

export interface CanonicalizeReport {
  primary: string;
  displayName: string | null;
  merged: string[];
  dedupedEdges: number;
}

/**
 * 一次性身份归一(幂等):确保 person-primary 存在,把全局图里的用户指称碎片
 * (mocode-user / user-name-* / 沿 named 边找到的自称,如"万")并入它。
 * 角色值实体(user-role-*)、兴趣、地点、项目/工具实体不碰。返回合并报告(无操作时 merged 为空)。
 */
export function canonicalizePrimaryPerson(): CanonicalizeReport {
  const scope: MemoryScope = 'global';
  const g = loadScopeGraph(scope);
  // 沿 named 边收集自称:X --named--> N,则 N.name 是用户的名字。
  const selfNameHints = new Set<string>();
  for (const e of g.edges) {
    if (e.invalidAt || e.relation !== 'named') continue;
    const src = g.entities.find((x) => x.id === e.src);
    const dst = g.entities.find((x) => x.id === e.dst);
    if (src && dst && (src.id === 'mocode-user' || src.id.startsWith('user-name-') || /user/i.test(src.name))) {
      selfNameHints.add(dst.name.trim().toLowerCase());
    }
  }
  const fragments = g.entities.filter((e) => isPersonFragment(e, selfNameHints));
  // 显示名:优先最短的中文/字母自称(通常是"万"),退回已存在 primary 的名字。
  const existing = g.entities.find((e) => e.id === PRIMARY_PERSON_ID);
  const nameCandidates = [...selfNameHints].filter((n) => n && !/^user/.test(n));
  const displayName = nameCandidates.sort((a, b) => a.length - b.length)[0] ?? existing?.name ?? null;

  ensurePrimaryPerson(displayName ?? undefined);

  let deduped = 0;
  const merged: string[] = [];
  for (const f of fragments) {
    const r = mergeEntities(PRIMARY_PERSON_ID, f.id, scope);
    if (r && !r.rejected) {
      merged.push(f.id);
      deduped += r.dedupedEdges;
    }
  }
  return { primary: PRIMARY_PERSON_ID, displayName, merged, dedupedEdges: deduped };
}
