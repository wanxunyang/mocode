/**
 * 后台任务命令组:/jobs · /jobs log [id前缀] · /jobs kill [id前缀]
 *
 * 不依赖 REPL 闭包状态（job 真相在 .mocode/jobs/），所以是这批命令里最独立的一组。
 * id 可只给时间戳前缀（如 /jobs kill 20260926-1730），唯一定位即可。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { listJobs, readJobLog, type JobRecord, type JobStatus } from '../../jobs/store.js';
import { killBackgroundJob } from '../../jobs/launch.js';
import { unhandled, next, type CommandHandler } from './types.js';

const STATUS_COLOR: Record<JobStatus, string> = {
  paused: ui.cyan,
  running: ui.yellow,
  succeeded: ui.green,
  failed: ui.red,
  killed: ui.dim,
};

function findJob(idPrefix: string | undefined): JobRecord | undefined {
  const jobs = listJobs();
  if (!idPrefix) return jobs[0];
  const matches = jobs.filter((j) => j.id.startsWith(idPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

function oneLinePrompt(prompt: string): string {
  const line = prompt.split('\n')[0] ?? '';
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
}

function renderList(): void {
  const jobs = listJobs().slice(0, 10);
  if (jobs.length === 0) {
    layout.contentWrite(`${ui.dim}(没有后台任务。用 mocode run --bg "任务" 启动)${ui.reset}\n`);
    return;
  }
  for (const job of jobs) {
    const color = STATUS_COLOR[job.status];
    layout.contentWrite(
      `  ${color}●${ui.reset} ${ui.bold}${job.id}${ui.reset}  ${color}${job.status}${ui.reset}\n` +
        `      ${ui.dim}${oneLinePrompt(job.prompt)}${ui.reset}\n`,
    );
  }
  layout.contentWrite(`${ui.dim}  /jobs log [id前缀] 看尾日志 · /jobs kill [id前缀] 杀任务${ui.reset}\n`);
}

export const jobsCommands: CommandHandler[] = [
  // /jobs approve|deny [id前缀]
  async (ctx) => {
    if (ctx.cmd !== '/jobs') return unhandled();
    const parts = ctx.line.split(/\s+/);
    if (parts[1] !== 'approve' && parts[1] !== 'deny') return unhandled();
    const job = findJob(parts[2]);
    if (!job) {
      layout.contentWrite(`${ui.yellow}(没找到唯一匹配的任务)${ui.reset}\n`);
      return next();
    }
    if (job.status !== 'paused') {
      layout.contentWrite(`${ui.dim}任务 ${job.id} 状态 ${job.status}，无需审批${ui.reset}\n`);
      return next();
    }
    const { runApproveCli } = await import('../../jobs/approve-cli.js');
    runApproveCli([job.id], parts[1] === 'approve' ? 'approved' : 'denied');
    return next();
  },
  // /jobs kill [id前缀]
  (ctx) => {
    if (ctx.cmd !== '/jobs') return unhandled();
    const parts = ctx.line.split(/\s+/);
    if (parts[1] !== 'kill') return unhandled();
    const job = findJob(parts[2]);
    if (!job) {
      layout.contentWrite(`${ui.yellow}(没找到唯一匹配的任务)${ui.reset}\n`);
      return next();
    }
    if (job.status !== 'running' && job.status !== 'paused') {
      layout.contentWrite(`${ui.dim}任务 ${job.id} 已是 ${job.status}，无需 kill${ui.reset}\n`);
      return next();
    }
    const ok = killBackgroundJob(job);
    layout.contentWrite(
      ok
        ? `${ui.yellow}已 kill 任务 ${job.id}${ui.reset}\n`
        : `${ui.red}kill 失败（进程可能已退出；PID=${job.pid ?? '?'})${ui.reset}\n`,
    );
    return next();
  },
  // /jobs log [id前缀]
  (ctx) => {
    if (ctx.cmd !== '/jobs') return unhandled();
    const parts = ctx.line.split(/\s+/);
    if (parts[1] !== 'log') return unhandled();
    const job = findJob(parts[2]);
    if (!job) {
      layout.contentWrite(`${ui.yellow}(没找到唯一匹配的任务)${ui.reset}\n`);
      return next();
    }
    layout.contentWrite(`${ui.bold}── log ${job.id} ──${ui.reset}\n`);
    layout.contentWrite(`${readJobLog(job.id)}\n`);
    return next();
  },
  // /jobs（列表）
  (ctx) => {
    if (ctx.line !== '/jobs') return unhandled();
    renderList();
    return next();
  },
];
