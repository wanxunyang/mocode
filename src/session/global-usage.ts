/**
 * 跨工作空间的全局 token 账本。
 *
 * 会话级 usage.jsonl 按 <workspace>/.mocode/sessions/<id>/ 分散存放,且不含
 * 时间/工作区/模型字段,无法跨项目汇总。每次模型调用在写会话级 usage 之外,
 * 再向全局账本 `~/.mocode/usage-daily.jsonl` 追加一行(含时间、本地日期、
 * 工作区、模型、sessionId、phase),/usage 据此做按天/工作区/模型汇总。
 *
 * 与 SessionStore.appendUsage 同款策略:同步 append、失败静默(best-effort,
 * 记账绝不阻塞模型调用)。只统计本功能上线后新产生的调用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 全局账本默认路径:跨工作空间,故放 ~/.mocode 而非项目目录。 */
export const GLOBAL_USAGE_PATH = path.join(os.homedir(), '.mocode', 'usage-daily.jsonl');

/**
 * 路径覆盖(仅测试用):让账本落到临时目录,避免污染真实 ~/.mocode。
 * 模块在全量测试进程里可能被别的文件先静态 import 而绑定了真实 home,故不能靠改 env。
 */
let globalUsagePathOverride: string | undefined;
export function __setGlobalUsagePath(p: string | undefined): void {
  globalUsagePathOverride = p;
}
export function getGlobalUsagePath(): string {
  return globalUsagePathOverride ?? GLOBAL_USAGE_PATH;
}

export type GlobalUsagePhase = 'main' | 'compact';

export interface GlobalUsageRecord {
  /** ISO 时间戳(写入时刻)。 */
  ts: string;
  /** 本地日期 YYYY-MM-DD(按运行机器时区,与用户认知的"今天"一致)。 */
  day: string;
  /** 工作区绝对路径。 */
  workspace: string;
  model: string;
  phase: GlobalUsagePhase;
  sessionId?: string;
  /** 'live' = 实时记账(默认);'backfill' = 从历史会话 usage.jsonl 回填。 */
  source?: 'live' | 'backfill';
  input: number;
  output: number;
  /** 缓存读(promptTokens 的子集,按真实请求计费口径直接求和,不再从 input 扣减)。 */
  cached: number;
  /** 推理 token(completionTokens 的子集)。 */
  reasoning: number;
  /** 缓存写(Anthropic cache_creation)。 */
  cacheCreation: number;
}

/** 本地日期 YYYY-MM-DD;不引时区库——运行机器本地时间即用户口径的"天"。 */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type AppendInput = Omit<GlobalUsageRecord, 'ts' | 'day' | 'cached' | 'reasoning' | 'cacheCreation'> & {
  cached?: number;
  reasoning?: number;
  cacheCreation?: number;
  /** 回填历史记录时指定发生时刻(ISO);缺省取当前时刻。day 按此本地日期归集。 */
  ts?: string;
  /** 显式指定归集日期 YYYY-MM-DD(回填按会话创建日);缺省取 ts 的本地日期。 */
  day?: string;
};

/** 追加一行全局用量。任何 I/O 失败静默——记账不能拖垮主流程。 */
export function appendGlobalUsage(input: AppendInput): void {
  try {
    const when = input.ts ? new Date(input.ts) : new Date();
    const day = input.day ?? (Number.isNaN(when.getTime()) ? localDay() : localDay(when));
    const rec: GlobalUsageRecord = {
      ts: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
      day,
      input: input.input,
      output: input.output,
      cached: input.cached ?? 0,
      reasoning: input.reasoning ?? 0,
      cacheCreation: input.cacheCreation ?? 0,
      workspace: input.workspace,
      model: input.model,
      phase: input.phase,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.source === 'backfill' ? { source: 'backfill' as const } : {}),
    };
    fs.mkdirSync(path.dirname(getGlobalUsagePath()), { recursive: true });
    fs.appendFileSync(getGlobalUsagePath(), `${JSON.stringify(rec)}\n`, 'utf8');
  } catch {
    // best-effort, see file header
  }
}

/** 读全部全局记录;文件不存在或损坏行跳过。 */
export function readGlobalUsage(): GlobalUsageRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(getGlobalUsagePath(), 'utf8');
  } catch {
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
  return out;
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
  /** 窗口内逐日(含零用量日,补齐连续日期)。 */
  byDay: UsageDayRow[];
  byWorkspace: UsageGroupRow[];
  byModel: UsageGroupRow[];
  main: UsageBucket;
  compact: UsageBucket;
  sessionCount: number;
  workspaceCount: number;
}

function emptyBucket(): UsageBucket {
  return { input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0, calls: 0 };
}

function addInto(b: UsageBucket, r: GlobalUsageRecord): void {
  b.input += r.input;
  b.output += r.output;
  b.cached += r.cached;
  b.reasoning += r.reasoning;
  b.cacheCreation += r.cacheCreation;
  b.calls++;
}

/** 窗口起点:含今天在内往前 days 天。 */
export function windowStart(days: number, today = new Date()): string {
  const d = new Date(today);
  d.setDate(d.getDate() - (Math.max(1, days) - 1));
  return localDay(d);
}

/**
 * 聚合最近 days 天的全局用量:按天(补齐零天)、按工作区、按模型、按 phase;
 * 另给 distinct session / workspace 计数。组数按总 token 降序。
 */
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
  const groupSessions = (map: Map<string, UsageGroupRow>, key: string): UsageGroupRow => {
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

    const wsRow = groupSessions(wsMap, r.workspace || '(unknown)');
    addInto(wsRow, r);
    const modelRow = groupSessions(modelMap, r.model || '(unknown)');
    addInto(modelRow, r);

    if (r.sessionId) {
      sessions.add(`${r.workspace}::${r.sessionId}`);
      daySessions.get(r.day)?.add(r.sessionId);
    }
  }

  // distinct session 计数(按工作区/模型)
  const wsSessionSets = new Map<string, Set<string>>();
  const modelSessionSets = new Map<string, Set<string>>();
  for (const r of inWindow) {
    if (!r.sessionId) continue;
    if (!wsSessionSets.has(r.workspace || '(unknown)')) wsSessionSets.set(r.workspace || '(unknown)', new Set());
    wsSessionSets.get(r.workspace || '(unknown)')!.add(r.sessionId);
    if (!modelSessionSets.has(r.model || '(unknown)')) modelSessionSets.set(r.model || '(unknown)', new Set());
    modelSessionSets.get(r.model || '(unknown)')!.add(r.sessionId);
  }
  for (const row of wsMap.values()) row.sessions = wsSessionSets.get(row.key)?.size ?? 0;
  for (const row of modelMap.values()) row.sessions = modelSessionSets.get(row.key)?.size ?? 0;
  for (const row of dayMap.values()) row.sessions = daySessions.get(row.day)?.size ?? 0;

  // 补齐窗口内零用量日(从 fromDay 逐天 +1,本地日期)
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
