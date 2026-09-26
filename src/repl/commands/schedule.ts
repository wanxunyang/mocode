/**
 * 调度计划命令:/schedules
 * 只读列出 schedules + 守护进程状态；增删改/启停走 CLI `mocode schedule …`。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { listSchedules } from '../../schedule/store.js';
import { isDaemonRunning, getDaemonState } from '../../schedule/daemon.js';
import { unhandled, next, type CommandHandler } from './types.js';

function oneLine(prompt: string): string {
  const line = prompt.split('\n')[0] ?? '';
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
}

export const scheduleCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/schedules') return unhandled();
    const daemonState = getDaemonState();
    const daemon = isDaemonRunning() && daemonState;
    layout.contentWrite(
      daemon
        ? `${ui.dim}scheduler:${ui.reset} ${ui.green}running${ui.reset} ` +
            `${ui.dim}(pid ${daemonState?.pid}, port ${daemonState?.port})${ui.reset}\n`
        : `${ui.dim}scheduler:${ui.reset} ${ui.yellow}stopped${ui.reset} ` +
            `${ui.dim}(mocode schedule start)${ui.reset}\n`,
    );

    const all = listSchedules();
    if (all.length === 0) {
      layout.contentWrite(`${ui.dim}(no schedules; mocode schedule add …)${ui.reset}\n`);
      return next();
    }
    for (const s of all) {
      const trigger = s.cron ? s.cron : s.webhookToken ? `webhook:${s.webhookToken}` : '?';
      layout.contentWrite(
        `  ${s.enabled ? ui.green + '●' : ui.dim + '○'}${ui.reset} ${ui.bold}${s.name}${ui.reset} ` +
          `${ui.dim}${trigger}${ui.reset}\n      ${ui.dim}${oneLine(s.prompt)}${ui.reset}\n`,
      );
    }
    return next();
  },
];
