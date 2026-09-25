/**
 * 用量命令组:/stats(#token-efficiency P1)
 *
 * dialog-only:读取当前会话 usage.jsonl,输出 cache 命中率 / 分层用量 / compact 次数。
 * 后端从未上报 cached 时命中率显示 n/a,不报错。
 */
import * as layout from '../../ui/layout.js';
import { getActiveSessionStore } from '../../session/store.js';
import { formatUsageSummary, summarizeUsage, type UsageRecord } from '../../session/usage-stats.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const statsCommands: CommandHandler[] = [
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
