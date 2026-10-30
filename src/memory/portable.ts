/**
 * R8.1 / R9.2:记忆包的导出与导入。
 *
 * 为什么需要它:开源项目的记忆是**用户自己的数据**,而"能导出"是信任的前提——
 * 换成"你只能在这台机器的这个目录下看到它",用户就没法迁移、备份、或在怀疑
 * 被写脏时拿出证据。同时它也是 R9 冷启动的载体:换机后一条命令接上。
 *
 * 为什么打包成**单文件 JSON**而不是 zip:
 *  ① 无依赖(仓库纯 ESM,不想为一个导出功能引入压缩库);
 *  ② 用户能直接 `less` 看内容——"我能看到"和"我能删"同等重要;
 *  ③ 记忆库本身是 JSONL + JSON,体量在几 MB 量级,压缩收益不抵可读性的损失。
 *
 * 叶子模块约定:只依赖 node 内置 + memory 内部模块。不碰 config / agent / llm。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadAll, importEntries, type MemoryEntry } from './store.js';
import { loadAllGraph, importGraphPart, type GraphEntity, type GraphEdge } from './graph.js';
import { memoryWriteBlockReason } from './write-gate.js';
import { appendAudit } from './audit.js';

/**
 * 包格式版本。**只在结构发生不兼容变化时**才 +1:
 * 新增可选字段不算(旧包能读,新字段缺失由各读路径惰性兜住)。
 * 读端对**更高**版本拒收(可能是新版本写的、含当前代码不认识的语义),
 * 对更低版本放行(missing 字段按既有惰性约定处理)。
 */
export const MEMORY_PACK_SCHEMA_VERSION = 1;

export interface MemoryPack {
  schemaVersion: number;
  /** 导出时刻(ISO)。 */
  exportedAt: string;
  /** 导出时的条目总数,便于导入前核对是否被截断。 */
  entries: MemoryEntry[];
  graph: { entities: GraphEntity[]; edges: GraphEdge[] };
}

/** 全量打包(global + project 两库 + 图谱)。 */
export function buildPack(): MemoryPack {
  const g = loadAllGraph();
  return {
    schemaVersion: MEMORY_PACK_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    entries: loadAll(),
    graph: { entities: g.entities, edges: g.edges },
  };
}

/** 默认导出路径:带时间戳,避免连续导出互相覆盖。 */
export function defaultPackPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(process.cwd(), '.mocode', `memory-pack-${ts}.json`);
}

/** 写包(原子写;父目录不存在则建)。返回实际路径。 */
export function writePack(pack: MemoryPack, target?: string): string {
  const p = target ? path.resolve(target) : defaultPackPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(pack, null, 2), 'utf8');
  renameSync(tmp, p);
  appendAudit({
    at: pack.exportedAt,
    action: 'export',
    detail: `导出 ${pack.entries.length} 条记忆 + ${pack.graph.entities.length} 实体/${pack.graph.edges.length} 边 → ${p}`,
  });
  return p;
}

export type ParsePackResult = { ok: true; pack: MemoryPack } | { ok: false; reason: string };

/**
 * 解析并校验一个包。
 *
 * 校验刻意**宽松但明确**:只要顶层结构与 version 对得上就放行,单条坏数据由
 * `importEntries` / `importGraphPart` 各自跳过。理由与读库一致——一个字段写坏的
 * 条目不该让整份备份无法还原,那是备份最没用的时刻。
 */
export function parsePack(raw: string): ParsePackResult {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON:${e instanceof Error ? e.message : String(e)}` };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: '包内容不是对象' };
  const o = obj as Partial<MemoryPack>;
  const v = typeof o.schemaVersion === 'number' ? o.schemaVersion : NaN;
  if (!Number.isFinite(v)) return { ok: false, reason: '缺少 schemaVersion' };
  if (v > MEMORY_PACK_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `包的 schemaVersion=${v} 高于当前支持的 ${MEMORY_PACK_SCHEMA_VERSION},请升级 mocode 后再导入`,
    };
  }
  if (!Array.isArray(o.entries)) return { ok: false, reason: '缺少 entries 数组' };
  const graph = o.graph && typeof o.graph === 'object' ? o.graph : { entities: [], edges: [] };
  return {
    ok: true,
    pack: {
      schemaVersion: v,
      exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : new Date().toISOString(),
      entries: o.entries as MemoryEntry[],
      graph: {
        entities: Array.isArray((graph as { entities?: unknown }).entities)
          ? ((graph as { entities: GraphEntity[] }).entities as GraphEntity[])
          : [],
        edges: Array.isArray((graph as { edges?: unknown }).edges)
          ? ((graph as { edges: GraphEdge[] }).edges as GraphEdge[])
          : [],
      },
    },
  };
}

export type ApplyPackResult =
  | {
      ok: true;
      added: number;
      updated: number;
      skipped: number;
      addedEntities: number;
      addedEdges: number;
    }
  | { ok: false; blocked: 'paused' | 'disabled' };

/**
 * 把包落库。**先条目后图谱**:条目是主数据,图谱是派生引用(sourceEntry 指向条目 id);
 * 若顺序反过来,一次中途失败会留下指向不存在条目的边。
 *
 * 暂停/关闭时整体拒收,而不是部分导入——半个包比没有包更难排查。
 */
export function applyPack(pack: MemoryPack): ApplyPackResult {
  const blocked = memoryWriteBlockReason();
  if (blocked) return { ok: false, blocked };
  const e = importEntries(pack.entries);
  if ('blocked' in e) return { ok: false, blocked: e.blocked };
  const g = importGraphPart(pack.graph.entities, pack.graph.edges);
  if ('blocked' in g) return { ok: false, blocked: g.blocked };
  appendAudit({
    at: new Date().toISOString(),
    action: 'import',
    detail:
      `导入 ${e.added} 新增/${e.updated} 更新/${e.skipped} 跳过条目,` + `${g.addedEntities} 实体/${g.addedEdges} 边`,
  });
  return {
    ok: true,
    added: e.added,
    updated: e.updated,
    skipped: e.skipped,
    addedEntities: g.addedEntities,
    addedEdges: g.addedEdges,
  };
}

/** 从磁盘读一个包并落库(命令层的便捷入口)。 */
export function importPackFile(file: string): ApplyPackResult | { ok: false; reason: string } {
  const p = path.resolve(file);
  if (!existsSync(p)) return { ok: false, reason: `文件不存在:${p}` };
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读取失败:${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = parsePack(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return applyPack(parsed.pack);
}
