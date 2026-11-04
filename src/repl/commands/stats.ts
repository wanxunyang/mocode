/**
 * 用量命令组:/stats(当前会话诊断)· /usage(跨工作空间按天汇总)
 *
 * /stats 读会话级 usage.jsonl,输出 cache 命中率 / 分层用量 / compact 次数。
 * /usage 读全局账本 ~/.mocode/usage-daily.jsonl(每次模型调用追加,含工作区/模型/
 * 本地日期),以 GFM 表格输出最近 N 天的总览、按天、工作区与模型排行
 * (经 contentWriteMdOnce 走 markdown 表格渲染,数字列右对齐)。
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
  type UsageBucket,
  type UsageDayRow,
  type UsageGroupRow,
} from '../../session/global-usage.js';
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

function dayRows(byDay: UsageDayRow[]): string[][] {
  return byDay.map((d) => {
    if (d.calls === 0) {
      const dash = `${ui.dim}—${ui.reset}`;
      return [
        `${ui.dim}${d.day}${ui.reset}`,
        dash,
        dash,
        dash,
        dash,
        dash,
        `${ui.dim}${t('repl.usageEmptyDay')}${ui.reset}`,
      ];
    }
    return [
      `${ui.cyan}${d.day}${ui.reset}`,
      tok(d.input),
      tok(d.output),
      tok(d.cached),
      tok(d.reasoning),
      n(d.calls),
      pct(d.cached, d.input),
    ];
  });
}

/** 按天表:无用量日整行 dim,数字列右对齐,末行合计(每个着色单元格自带 reset 防串色)。 */
function dailyTable(s: GlobalUsageSummary): string {
  const rows = dayRows(s.byDay);
  const b: UsageBucket = s.total;
  const bold = (v: string): string => `${ui.bold}${v}${ui.reset}`;
  rows.push([
    bold(t('repl.usageTotalRow')),
    bold(tok(b.input)),
    bold(tok(b.output)),
    bold(tok(b.cached)),
    bold(tok(b.reasoning)),
    bold(n(b.calls)),
    bold(pct(b.cached, b.input)),
  ]);
  return mdTable(
    [
      t('repl.usageColDate'),
      t('repl.usageColIn'),
      t('repl.usageColOut'),
      t('repl.usageColCached'),
      t('repl.usageColReason'),
      t('repl.usageColCalls'),
      t('repl.usageColHit'),
    ],
    rows,
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
  );
}

/** 工作区/模型排行表(Top 8,按 input+output 降序已在聚合层排好)。 */
function groupTable(title: string, colName: string, rows: UsageGroupRow[]): string {
  const body = rows.slice(0, 8).map((r) => [r.key, tok(r.input), tok(r.output), n(r.calls), n(r.sessions)]);
  return (
    `${ui.accent}${title}${ui.reset}\n\n` +
    mdTable(
      [colName, t('repl.usageColIn'), t('repl.usageColOut'), t('repl.usageColCalls'), t('repl.usageColSessions')],
      body,
      ['l', 'r', 'r', 'r', 'r'],
    ) +
    (rows.length > 8 ? `\n\n${ui.dim}${t('repl.usageMore', { n: rows.length - 8 })}${ui.reset}` : '')
  );
}

export const statsCommands: CommandHandler[] = [
  // /usage [days]:跨工作空间按天汇总。默认 7 天,可传天数(如 /usage 30);非法参数给用法提示。
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
    const s = summarizeGlobalUsage(records, days);
    // 标题与普通文案走裸通道;表格逐个走 md 通道(各自独立渲染,避免跨段识别问题)。
    layout.contentWrite(
      `\n${ui.accent}${t('repl.usageTitle', { from: s.fromDay, to: s.toDay, days: s.days })}${ui.reset}\n\n`,
    );
    layout.contentWriteMdOnce(overviewTable(s));
    layout.contentWrite('\n\n');
    layout.contentWriteMdOnce(dailyTable(s));
    layout.contentWrite('\n\n');
    layout.contentWriteMdOnce(groupTable(t('repl.usageByWorkspace'), t('repl.usageColWorkspace'), s.byWorkspace));
    layout.contentWrite('\n\n');
    layout.contentWriteMdOnce(groupTable(t('repl.usageByModel'), t('repl.usageColModel'), s.byModel));
    layout.contentWrite('\n');
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
