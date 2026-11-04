/**
 * 用量命令组:/stats(当前会话诊断)· /usage(跨工作空间用量)
 *
 * /stats 读会话级 usage.jsonl,输出 cache 命中率 / 分层用量 / compact 次数。
 * /usage 读全局账本 ~/.mocode/usage-daily.jsonl:总览两行 + 固定高度柱状图(长区间
 * 自动按周聚合,替代会撑出几百行的按天表格)+ 高峰日 Top5 + 工作区/模型 Top5 表。
 * /usage import 回填历史会话 usage.jsonl(幂等)。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { fmtCompactTokens } from '../../ui/render.js';
import { t } from '../../i18n/index.js';
import { getActiveSessionStore } from '../../session/store.js';
import { formatUsageSummary, summarizeUsage, type UsageRecord } from '../../session/usage-stats.js';
import {
  readGlobalUsage,
  summarizeGlobalUsage,
  type GlobalUsageSummary,
  type UsageDayRow,
  type UsageGroupRow,
} from '../../session/global-usage.js';
import { bucketizeDays, renderUsageBars } from '../../session/usage-chart.js';
import { backfillGlobalUsage } from '../../session/backfill-usage.js';
import { getWorkspaceRoot } from '../../workspace/index.js';
import { unhandled, next, type CommandHandler } from './types.js';

/** 计数千分位(请求数/会话数等)。 */
function n(v: number): string {
  return v.toLocaleString('en-US');
}

/** token 统一缩写:<1k 整数,1k-1M 用 k,≥1M 用 M(复用全项目同口径)。 */
function tok(v: number): string {
  return fmtCompactTokens(v);
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a';
}

/** 构造 GFM 表格:headers/rows 等宽;align 列 'l'(左,默认)或 'r'(右)。 */
function mdTable(headers: string[], rows: string[][], align: ('l' | 'r')[]): string {
  const sep = align.map((a) => (a === 'r' ? '---:' : ':---')).join('|');
  const lines = [`| ${headers.join(' | ')} |`, `|${sep}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

/** 工作区/模型排行表(Top 5)。 */
function groupTable(title: string, colName: string, rows: UsageGroupRow[]): string {
  const body = rows.slice(0, 5).map((r) => [r.key, tok(r.input), tok(r.output), n(r.calls), n(r.sessions)]);
  return (
    `${ui.accent}${title}${ui.reset}\n\n` +
    mdTable(
      [colName, t('repl.usageColIn'), t('repl.usageColOut'), t('repl.usageColCalls'), t('repl.usageColSessions')],
      body,
      ['l', 'r', 'r', 'r', 'r'],
    ) +
    (rows.length > 5 ? `\n\n${ui.dim}${t('repl.usageMore', { n: rows.length - 5 })}${ui.reset}` : '')
  );
}

/** 汇总指标键值表(两列)。 */
function overviewTable(s: GlobalUsageSummary): string {
  const b = s.total;
  const rows: string[][] = [
    [`${ui.bold}${t('repl.usageKTotal')}${ui.reset}`, `${ui.bold}${tok(b.input + b.output)}${ui.reset}`],
    [t('repl.usageKInput'), tok(b.input)],
    [t('repl.usageKOutput'), tok(b.output)],
    [t('repl.usageKRequests'), n(b.calls)],
    [t('repl.usageKSessions'), n(s.sessionCount)],
    [t('repl.usageKWorkspaces'), n(s.workspaceCount)],
    [t('repl.usageKCacheHit'), pct(b.cached, b.input)],
    [t('repl.usageKReasoningShare'), pct(b.reasoning, b.output)],
    [t('repl.usageKCacheWrite'), tok(b.cacheCreation)],
    [t('repl.usageKDailyAvg'), tok(Math.round((b.input + b.output) / s.days))],
  ];
  if (s.compact.calls > 0) {
    rows.push([
      t('repl.usageKCompact'),
      `${tok(s.compact.input)} in / ${tok(s.compact.output)} out / ${n(s.compact.calls)}`,
    ]);
  }
  return mdTable([t('repl.usageKMetric'), t('repl.usageKValue')], rows, ['l', 'r']);
}

/** 高峰日 Top5:一行紧凑文本(图给趋势,这里给精确值)。 */
function peaksLine(byDay: UsageDayRow[]): string {
  const top = byDay
    .filter((d) => d.calls > 0)
    .sort((a, b) => b.input + b.output - (a.input + a.output))
    .slice(0, 5)
    .map((d) => `${d.day.slice(5)} ${tok(d.input + d.output)}`);
  return top.length ? `${ui.dim}${t('repl.usagePeaks', { days: top.join('  ·  ') })}${ui.reset}` : '';
}

/** 渲染 /usage 主体:总览表 → 柱状图 → 高峰日 → 排行两表。 */
function renderUsageReport(s: GlobalUsageSummary): void {
  layout.contentWrite(
    `\n${ui.accent}${t('repl.usageTitle', { from: s.fromDay, to: s.toDay, days: s.days })}${ui.reset}\n\n`,
  );
  layout.contentWriteMdOnce(overviewTable(s));
  layout.contentWrite('\n\n');

  const buckets = bucketizeDays(s.byDay);
  const bars = renderUsageBars(buckets, layout.getGeo().cols);
  if (bars.length) {
    for (const line of bars) layout.contentWrite(`  ${line}\n`);
    layout.contentWrite(`  ${ui.dim}${t('repl.usageBarsNote')}${ui.reset}\n`);
    const span = buckets[buckets.length - 1]?.spanDays ?? 1;
    if (span > 1) {
      layout.contentWrite(`  ${ui.dim}${t('repl.usageBarsBucket', { span })}${ui.reset}\n`);
    }
    const peaks = peaksLine(s.byDay);
    if (peaks) layout.contentWrite(`  ${peaks}\n`);
    layout.contentWrite('\n');
  }

  layout.contentWriteMdOnce(groupTable(t('repl.usageByWorkspace'), t('repl.usageColWorkspace'), s.byWorkspace));
  layout.contentWrite('\n\n');
  layout.contentWriteMdOnce(groupTable(t('repl.usageByModel'), t('repl.usageColModel'), s.byModel));
  layout.contentWrite('\n');
}

export const statsCommands: CommandHandler[] = [
  // /usage import:把各工作区旧会话的 usage.jsonl 回填进全局账本(幂等,可重复执行)。
  (ctx) => {
    if (ctx.line !== '/usage import' && ctx.line !== '/usage import ') return unhandled();
    const r = backfillGlobalUsage({ extraRoots: [getWorkspaceRoot()] });
    if (r.records === 0 && r.skippedTracked > 0) {
      layout.contentWrite(`${ui.dim}${t('repl.usageImportNothing', { skipped: n(r.skippedTracked) })}${ui.reset}\n`);
    } else if (r.records === 0) {
      layout.contentWrite(`${ui.dim}${t('repl.usageImportZero')}${ui.reset}\n`);
    } else {
      layout.contentWrite(
        `${ui.accent}${t('repl.usageImportDone', {
          records: n(r.records),
          sessions: n(r.sessions),
          workspaces: n(r.workspaces),
          skipped: n(r.skippedTracked),
        })}${ui.reset}\n`,
      );
    }
    return next();
  },
  // /usage [days]:跨工作空间用量。默认 7 天,可传天数(如 /usage 300);非法参数给用法提示。
  (ctx) => {
    if (ctx.line !== '/usage' && !ctx.line.startsWith('/usage ')) return unhandled();
    const arg = ctx.line.replace(/^\/usage\s*/, '').trim();
    let days = 7;
    if (arg) {
      const parsed = Number(arg);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 366) {
        layout.contentWrite(`${ui.yellow}${t('repl.usageBadArg')}${ui.reset}\n`);
        return next();
      }
      days = parsed;
    }
    const records = readGlobalUsage();
    if (records.length === 0) {
      layout.contentWrite(`${ui.dim}${t('repl.usageNoData')}${ui.reset}\n`);
      return next();
    }
    renderUsageReport(summarizeGlobalUsage(records, days));
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/stats') return unhandled();
    const sessionId = ctx.state.currentSessionId;
    if (!sessionId) {
      layout.contentWrite('  No active session yet.\n');
      return next();
    }
    const raw = getActiveSessionStore().readUsage(sessionId) as UsageRecord[];
    if (raw.length === 0) {
      layout.contentWrite('  No usage recorded yet (run a task first).\n');
      return next();
    }
    layout.contentWrite(`  ${formatUsageSummary(summarizeUsage(raw))}\n`);
    return next();
  },
];
