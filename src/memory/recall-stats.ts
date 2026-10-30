// recall-stats.ts —— 项目图谱 pull 召回的轻量埋点。
//
// 目的(design-notes/memory/memory.md §2.1):项目图谱曾"只写不读"。pull 通道(常驻 hint + memory_search
// 强化)上线后,用零依赖计数器回答"模型到底有没有在用图谱":搜了几次、图谱段有几次命中。
// 数据只存项目 <cwd>/.mocode/memory-recall-stats.json,供 memory_graph stats 展示,据此
// 决定要不要再加"turn 起步阈值注入"的安全网。全部静默容错、tmp+rename 原子写。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RecallStats {
  /** memory_search 被调用次数。 */
  searches: number;
  /** 其中图谱事实段非空(有命中)次数。 */
  graphHits: number;
  /** 其中图谱段为空次数(searches = hits + empty)。 */
  graphEmpty: number;
  lastSearchedAt: string | null;
}

const EMPTY: RecallStats = { searches: 0, graphHits: 0, graphEmpty: 0, lastSearchedAt: null };

function statsPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-recall-stats.json');
}

/** 读取项目召回统计;文件缺失/损坏一律返回零值(不抛错)。 */
export function readRecallStats(): RecallStats {
  try {
    const p = statsPath();
    if (!existsSync(p)) return { ...EMPTY };
    const obj = JSON.parse(readFileSync(p, 'utf8')) as Partial<RecallStats>;
    return {
      searches: Number.isFinite(obj.searches) ? Number(obj.searches) : 0,
      graphHits: Number.isFinite(obj.graphHits) ? Number(obj.graphHits) : 0,
      graphEmpty: Number.isFinite(obj.graphEmpty) ? Number(obj.graphEmpty) : 0,
      lastSearchedAt: typeof obj.lastSearchedAt === 'string' ? obj.lastSearchedAt : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 记录一次 memory_search。graphHit=true 表示图谱事实段非空。
 * 返回更新后的统计;写盘失败静默(埋点绝不影响检索主流程)。
 */
export function recordRecallSearch(graphHit: boolean): RecallStats {
  const s = readRecallStats();
  s.searches += 1;
  if (graphHit) s.graphHits += 1;
  else s.graphEmpty += 1;
  s.lastSearchedAt = new Date().toISOString();
  try {
    const p = statsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    renameSync(tmp, p);
  } catch {
    // 静默:埋点不可写不影响功能
  }
  return s;
}

/** 一行人类可读摘要(供 memory_graph stats)。 */
export function formatRecallStats(s: RecallStats = readRecallStats()): string {
  if (s.searches === 0) return '图谱召回:尚无 memory_search 调用(pull 通道未被使用)';
  const rate = Math.round((s.graphHits / s.searches) * 100);
  return `图谱召回:memory_search ${s.searches} 次,图谱命中 ${s.graphHits}(${rate}%) / 空 ${s.graphEmpty}`;
}
