/**
 * 用量命令组:/stats(当前会话诊断)· /usage(跨工作空间按天汇总)
 *
 * /stats 读会话级 usage.jsonl,输出 cache 命中率 / 分层用量 / compact 次数。
 * /usage 读全局账本 ~/.mocode/usage-daily.jsonl(每次模型调用追加,含工作区/模型/
 * 本地日期),输出最近 N 天的按天表、总计、工作区与模型排行。
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

/** 固定宽右对齐(数字串无 ANSI)。 */
function col(v: string | number, width: number): string {
  const s = String(v);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a';
}

/** 工作区/模型排行:名称左截断(保留尾部,工作区尾部目录更有辨识度),数值右对齐。 */
function groupTable(title: string, rows: UsageGroupRow[], nameWidth: number): string[] {
  const lines = [`${ui.accent}${title}${ui.reset}`];
  if (rows.length === 0) {
    lines.push(`  ${ui.dim}${t('repl.usageNone')}${ui.reset}`);
    return lines;
  }
  for (const r of rows.slice(0, 8)) {
    let name = r.key;
    if (name.length > nameWidth) name = `…${name.slice(name.length - nameWidth + 1)}`;
    lines.push(
      `  ${ui.cyan}${name.padEnd(nameWidth)}${ui.reset}  ${col(tok(r.input), 7)} in  ${col(tok(r.output), 7)} out  ${col(n(r.calls), 5)} calls  ${ui.dim}${t('repl.usageSessions', { n: r.sessions })}${ui.reset}`,
    );
  }
  if (rows.length > 8) lines.push(`  ${ui.dim}${t('repl.usageMore', { n: rows.length - 8 })}${ui.reset}`);
  return lines;
}

function totalRow(b: UsageBucket): string {
  return `${t('repl.usageTotalRow')}  ${col(tok(b.input), 7)} in · ${col(tok(b.output), 7)} out · ${col(tok(b.cached), 7)} cached · ${col(tok(b.reasoning), 7)} reasoning`;
}

function formatGlobal(s: GlobalUsageSummary): string {
  const lines: string[] = [];
  const b = s.total;
  const grandTotal = b.input + b.output;
  lines.push(`${ui.accent}${t('repl.usageTitle', { from: s.fromDay, to: s.toDay, days: s.days })}${ui.reset}`);
  lines.push(
    `  ${t('repl.usageTotal', {
      total: tok(grandTotal),
      input: tok(b.input),
      output: tok(b.output),
      calls: n(b.calls),
      sessions: n(s.sessionCount),
      workspaces: n(s.workspaceCount),
    })}`,
  );
  lines.push(
    `  ${t('repl.usageMetrics', {
      hit: pct(b.cached, b.input),
      reasoning: pct(b.reasoning, b.output),
      cacheWrite: tok(b.cacheCreation),
      daily: tok(Math.round(grandTotal / s.days)),
    })}`,
  );
  if (s.compact.calls > 0) {
    lines.push(
      `  ${ui.dim}${t('repl.usageCompact', { input: tok(s.compact.input), output: tok(s.compact.output), calls: n(s.compact.calls) })}${ui.reset}`,
    );
  }
  lines.push('');

  // 按天表(列宽固定,终端对齐;token 一律缩写)
  lines.push(
    `  ${ui.dim}${t('repl.usageColDate').padEnd(10)} ${col('in', 7)} ${col('out', 7)} ${col('cached', 7)} ${col('reason', 7)} ${col('calls', 6)} hit${ui.reset}`,
  );
  for (const d of s.byDay) {
    if (d.calls === 0) {
      lines.push(`  ${ui.dim}${d.day}  ${t('repl.usageEmptyDay')}${ui.reset}`);
      continue;
    }
    lines.push(
      `  ${ui.cyan}${d.day}${ui.reset} ${col(tok(d.input), 7)} ${col(tok(d.output), 7)} ${col(tok(d.cached), 7)} ${col(tok(d.reasoning), 7)} ${col(n(d.calls), 6)} ${pct(d.cached, d.input)}`,
    );
  }
  lines.push(`  ${ui.bold}${totalRow(b)}${ui.reset}`);
  lines.push('');

  lines.push(...groupTable(t('repl.usageByWorkspace'), s.byWorkspace, 40));
  lines.push('');
  lines.push(...groupTable(t('repl.usageByModel'), s.byModel, 32));
  return lines.join('\n');
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
    layout.contentWrite(`  ${formatGlobal(summarizeGlobalUsage(records, days))}\n`);
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
