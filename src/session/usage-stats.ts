/**
 * Per-step token 用量记录与聚合(#token-efficiency P1)。
 *
 * 纯函数 + 类型:无 fs / config 依赖,落盘由 SessionStore.appendUsage 负责,
 * 与 vision-window.ts / context pipeline 同款叶子形态。
 */
import type { ChatUsage } from '../llm/index.js';

/** 一次模型调用的用量记录行(usage.jsonl 每行一条)。 */
export interface UsageRecord {
  step: number;
  /** main = agent 主请求;compact = 摘要器调用。 */
  phase: 'main' | 'compact';
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** 本次写入缓存的 token(Anthropic);缺省 0。 */
  cacheCreationTokens?: number;
  /** 请求前裸估算(与压力线同口径),用于校验估算偏差。 */
  estimatedTotal?: number;
}

/** 从 ChatUsage 构造记录;usage 缺失返 null。 */
export function toUsageRecord(
  step: number,
  phase: UsageRecord['phase'],
  usage: ChatUsage | undefined,
  estimatedTotal?: number,
): UsageRecord | null {
  if (!usage) return null;
  return {
    step,
    phase,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
    ...(usage.cacheCreationTokens ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
    ...(estimatedTotal != null ? { estimatedTotal } : {}),
  };
}

export interface UsageTotals {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cacheCreation: number;
  calls: number;
}

export interface UsageSummary {
  records: number;
  compactCalls: number;
  main: UsageTotals;
  compact: UsageTotals;
  total: UsageTotals;
  /** Σcached / Σinput;后端从未上报 cached 时为 null(显示 n/a)。 */
  cacheHitRate: number | null;
  mainCacheHitRate: number | null;
  compactCacheHitRate: number | null;
  /** Σoutput 中 reasoning 占比。 */
  reasoningShare: number;
  /** 实测 input / 裸估算 的平均比值(无估算样本时 null)。 */
  estimateRatio: number | null;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0, calls: 0 };
}

function add(totals: UsageTotals, r: UsageRecord): void {
  totals.input += r.inputTokens;
  totals.output += r.outputTokens;
  totals.cached += r.cachedTokens;
  totals.reasoning += r.reasoningTokens;
  totals.cacheCreation += r.cacheCreationTokens ?? 0;
  totals.calls++;
}

function hitRate(t: UsageTotals): number | null {
  if (t.calls === 0) return null;
  // 后端从未上报过 cached → 无法计算,不是 0%。
  if (t.cached === 0) return null;
  return t.cached / Math.max(t.input, 1);
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const main = emptyTotals();
  const compact = emptyTotals();
  let cacheReported = false;
  let estimateRatioSum = 0;
  let estimateSamples = 0;

  for (const r of records) {
    add(r.phase === 'compact' ? compact : main, r);
    if (r.cachedTokens > 0) cacheReported = true;
    if (r.estimatedTotal && r.estimatedTotal > 0) {
      estimateRatioSum += r.inputTokens / r.estimatedTotal;
      estimateSamples++;
    }
  }

  const total = emptyTotals();
  for (const r of records) add(total, r);

  // 全部记录里从未出现 cached 字段 → 所有命中率都 n/a;
  // 有过 cached(即使某 phase 为 0)则该 phase 按真实 0 计算。
  const rate = (t: UsageTotals): number | null => {
    if (!cacheReported || t.calls === 0) return null;
    return t.cached / Math.max(t.input, 1);
  };

  return {
    records: records.length,
    compactCalls: compact.calls,
    main,
    compact,
    total,
    cacheHitRate: hitRate(total),
    mainCacheHitRate: rate(main),
    compactCacheHitRate: rate(compact),
    reasoningShare: total.output > 0 ? total.reasoning / total.output : 0,
    estimateRatio: estimateSamples > 0 ? estimateRatioSum / estimateSamples : null,
  };
}

function pct(n: number | null): string {
  return n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}

function fmtTotals(t: UsageTotals): string {
  return `${t.calls} calls · in ${t.input} · out ${t.output} · cached ${t.cached} · reasoning ${t.reasoning}`;
}

/** 拍平成人类可读(/stats 命令输出)。 */
export function formatUsageSummary(s: UsageSummary): string {
  const lines: string[] = [];
  lines.push(`Token usage — ${s.records} record(s), ${s.compactCalls} compact call(s)`);
  lines.push(
    `  Cache hit rate: total ${pct(s.cacheHitRate)} · main ${pct(s.mainCacheHitRate)} · compact ${pct(s.compactCacheHitRate)}`,
  );
  lines.push(`  Main      ${fmtTotals(s.main)}`);
  if (s.compact.calls > 0) lines.push(`  Compact   ${fmtTotals(s.compact)}`);
  lines.push(
    `  Total     in ${s.total.input} · out ${s.total.output} · reasoning share ${(s.reasoningShare * 100).toFixed(1)}%` +
      (s.estimateRatio != null ? ` · measured/estimate ${s.estimateRatio.toFixed(2)}` : ''),
  );
  return lines.join('\n');
}
