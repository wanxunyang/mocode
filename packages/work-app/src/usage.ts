/**
 * 跨工作空间 token 账本的**主进程侧**读取与聚合。
 *
 * 为什么要在 work-app 里再实现一份：账本是 `~/.mocode/usage-daily.jsonl`（全局、跨项目），
 * 与任何工作区/任务都无关。原先「用量」面板必须挂在某个任务的 host 上才能查，于是
 * 「没开工作区就看不了自己的总用量」—— 而这次查询真正需要的只是一个文件。
 * 现在主进程就地算完，不为了看账本去冷启动一个 host 子进程（≈8s + 常驻内存）。
 *
 * 与 core 的 src/session/global-usage.ts 同源同形状（字段名、聚合口径、补齐零天都一样），
 * 因为 GUI 的 panels.ts 直接消费 GlobalUsageSummary。改动聚合口径必须两边一起改；
 * 账本本身的写入仍只在 core（appendGlobalUsage），这里只读。
 */
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 全局账本路径：跨工作空间，故放 ~/.mocode 而非项目目录（与 core 一致）。 */
export function globalUsagePath(): string {
  return path.join(os.homedir(), '.mocode', 'usage-daily.jsonl');
}

export type GlobalUsagePhase = 'main' | 'compact';

export interface GlobalUsageRecord {
  ts: string;
  day: string;
  workspace: string;
  model: string;
  phase: GlobalUsagePhase;
  sessionId?: string;
  source?: 'live' | 'backfill';
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cacheCreation: number;
}

export interface UsageBucket {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cacheCreation: number;
  calls: number;
}

export interface UsageDayRow extends UsageBucket {
  day: string;
  sessions: number;
}

export interface UsageGroupRow extends UsageBucket {
  key: string;
  sessions: number;
}

export interface GlobalUsageSummary {
  fromDay: string;
  toDay: string;
  days: number;
  total: UsageBucket;
  byDay: UsageDayRow[];
  byWorkspace: UsageGroupRow[];
  byModel: UsageGroupRow[];
  main: UsageBucket;
  compact: UsageBucket;
  sessionCount: number;
  workspaceCount: number;
}

/** 本地日期 YYYY-MM-DD；运行机器本地时间即用户口径的「今天」。 */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 窗口起点：含今天在内往前 days 天。 */
export function windowStart(days: number, today = new Date()): string {
  const d = new Date(today);
  d.setDate(d.getDate() - (Math.max(1, days) - 1));
  return localDay(d);
}

// 账本已到 8MB / 3 万行量级，切 7/30/180/365 天会重复解析同一个文件；
// 按 (mtime, size) 缓存——新记录追加必然改动这两项，不会看到陈旧数据。
let cache: { key: string; records: GlobalUsageRecord[] } | null = null;

/** 读全部全局记录；文件不存在或损坏行跳过。 */
export function readGlobalUsage(): GlobalUsageRecord[] {
  const file = globalUsagePath();
  let key: string;
  try {
    const info = statSync(file);
    key = `${info.mtimeMs}:${info.size}`;
    if (cache?.key === key) return cache.records;
  } catch {
    cache = null;
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    cache = null;
    return [];
  }
  const out: GlobalUsageRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as GlobalUsageRecord;
      if (typeof rec.day === 'string' && typeof rec.input === 'number' && typeof rec.output === 'number') {
        out.push(rec);
      }
    } catch {
      // 跳过损坏行
    }
  }
  cache = { key, records: out };
  return out;
}

function emptyBucket(): UsageBucket {
  return { input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0, calls: 0 };
}

function addInto(b: UsageBucket, r: GlobalUsageRecord): void {
  b.input += r.input;
  b.output += r.output;
  b.cached += num(r.cached);
  b.reasoning += num(r.reasoning);
  b.cacheCreation += num(r.cacheCreation);
  b.calls++;
}

/** 账本里的计数字段可能是旧版本缺项，缺失按 0 计，避免 NaN 传染整张表。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 聚合最近 days 天的全局用量：按天（补齐零天）、按工作区、按模型、按 phase。 */
export function summarizeGlobalUsage(records: readonly GlobalUsageRecord[], days: number): GlobalUsageSummary {
  const toDay = localDay();
  const fromDay = windowStart(days);
  const inWindow = records.filter((r) => r.day >= fromDay && r.day <= toDay);

  const total = emptyBucket();
  const main = emptyBucket();
  const compact = emptyBucket();
  const dayMap = new Map<string, UsageDayRow>();
  const wsMap = new Map<string, UsageGroupRow>();
  const modelMap = new Map<string, UsageGroupRow>();
  const daySessions = new Map<string, Set<string>>();
  const groupOf = (map: Map<string, UsageGroupRow>, key: string): UsageGroupRow => {
    let row = map.get(key);
    if (!row) {
      row = { key, ...emptyBucket(), sessions: 0 };
      map.set(key, row);
    }
    return row;
  };
  const sessions = new Set<string>();

  for (const r of inWindow) {
    addInto(total, r);
    addInto(r.phase === 'compact' ? compact : main, r);

    let dayRow = dayMap.get(r.day);
    if (!dayRow) {
      dayRow = { day: r.day, ...emptyBucket(), sessions: 0 };
      dayMap.set(r.day, dayRow);
      daySessions.set(r.day, new Set());
    }
    addInto(dayRow, r);

    addInto(groupOf(wsMap, r.workspace || '(unknown)'), r);
    addInto(groupOf(modelMap, r.model || '(unknown)'), r);

    if (r.sessionId) {
      sessions.add(`${r.workspace}::${r.sessionId}`);
      daySessions.get(r.day)?.add(r.sessionId);
    }
  }

  // distinct session 计数（按工作区/模型）
  const wsSessionSets = new Map<string, Set<string>>();
  const modelSessionSets = new Map<string, Set<string>>();
  for (const r of inWindow) {
    if (!r.sessionId) continue;
    const ws = r.workspace || '(unknown)';
    const model = r.model || '(unknown)';
    if (!wsSessionSets.has(ws)) wsSessionSets.set(ws, new Set());
    wsSessionSets.get(ws)!.add(r.sessionId);
    if (!modelSessionSets.has(model)) modelSessionSets.set(model, new Set());
    modelSessionSets.get(model)!.add(r.sessionId);
  }
  for (const row of wsMap.values()) row.sessions = wsSessionSets.get(row.key)?.size ?? 0;
  for (const row of modelMap.values()) row.sessions = modelSessionSets.get(row.key)?.size ?? 0;
  for (const row of dayMap.values()) row.sessions = daySessions.get(row.day)?.size ?? 0;

  // 补齐窗口内零用量日（从 fromDay 逐天 +1，本地日期）
  const byDay: UsageDayRow[] = [];
  const cursor = new Date(`${fromDay}T00:00:00`);
  for (let i = 0; i < Math.max(1, days); i++) {
    const key = localDay(cursor);
    byDay.push(dayMap.get(key) ?? { day: key, ...emptyBucket(), sessions: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const byTotal = (a: UsageGroupRow, b: UsageGroupRow): number => b.input + b.output - (a.input + a.output);

  return {
    fromDay,
    toDay,
    days: byDay.length,
    total,
    byDay,
    byWorkspace: [...wsMap.values()].sort(byTotal),
    byModel: [...modelMap.values()].sort(byTotal),
    main,
    compact,
    sessionCount: sessions.size,
    workspaceCount: wsMap.size,
  };
}