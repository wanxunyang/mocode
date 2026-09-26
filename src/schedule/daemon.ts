// 调度守护进程：detached 常驻，两件事——
// 1. 每 15s 扫描 schedules，cron 命中当前分钟即 launch 一个后台 job（分钟键去重，
//    lastRunAt 落盘，重启 / tick 模式也不会同分钟重复触发）。
// 2. 在 127.0.0.1 起 HTTP 端点：POST /trigger/<token> 立即触发，GET /health 探活。
//    仅监听回环；用 node:http 直连（fetch 会被 HTTP_PROXY 干扰，见 notify 模块的坑）。
//
// 另有 runTick()：单次扫描模式，供系统任务计划（Windows 任务计划/launchd + cron）
// 每 1-5 分钟调用一次，不想养常驻进程时用它。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawnDetached, killTree } from '../jobs/launch.js';
import { getSandboxRoot } from '../sandbox/index.js';
import { cronMatches } from './cron.js';
import { listSchedules, updateSchedule } from './store.js';
import type { ScheduleRecord } from './store.js';

const DEFAULT_PORT = 8788;

function stateDir(): string {
  return path.join(getSandboxRoot() ?? process.cwd(), '.mocode', 'schedules');
}

function daemonStatePath(): string {
  return path.join(stateDir(), 'daemon.json');
}

function daemonLogPath(): string {
  return path.join(stateDir(), 'daemon.log');
}

interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
}

export function getDaemonState(): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(daemonStatePath(), 'utf8')) as DaemonState;
  } catch {
    return null;
  }
}

/** 进程是否存活（pid 复用概率低，足够判活）。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const state = getDaemonState();
  return !!state && isPidAlive(state.pid);
}

/** 本地分钟键（本地时区，与 cron 的 getHours 等对齐；ISO 字符串是 UTC 不能用）。 */
function minuteKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 触发一个 schedule：launch 后台 job + 记 lastRunAt。 */
async function fireSchedule(s: ScheduleRecord, now: Date): Promise<void> {
  const { launchBackgroundJob } = await import('../jobs/launch.js');
  const { record } = launchBackgroundJob(s.prompt, {
    ...(s.worktree ? { worktree: true } : {}),
    ...(s.sessionDir ? { sessionDir: s.sessionDir } : {}),
    ...(s.botName ? { botName: s.botName } : {}),
  });
  updateSchedule(s.id, { lastRunAt: now.toISOString() });
  process.stdout.write(`[${now.toISOString()}] fired ${s.name} (${s.id}) → job ${record.id}\n`);
}

/** 单次扫描：所有 enabled 且有 cron 的 schedule，命中当前分钟且本分钟未跑过则触发。 */
export async function runTick(now: Date = new Date()): Promise<number> {
  const key = minuteKey(now);
  let fired = 0;
  for (const s of listSchedules()) {
    if (!s.enabled || !s.cron) continue;
    if (s.lastRunAt && minuteKey(new Date(s.lastRunAt)) === key) continue;
    let hit = false;
    try {
      hit = cronMatches(s.cron, now);
    } catch {
      // 损坏的 cron 跳过
    }
    if (hit) {
      await fireSchedule(s, now);
      fired += 1;
    }
  }
  return fired;
}

/** 读取并丢弃请求体。 */
function drainBody(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolvePromise) => {
    req.on('data', () => {});
    req.on('end', () => resolvePromise());
  });
}

/** 常驻守护：tick 循环 + HTTP 端点。 */
export function runDaemon(port: number = DEFAULT_PORT): void {
  const log = (msg: string): void => {
    process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
  };

  void runTick();
  const timer = setInterval(() => {
    void runTick().catch((e) => log(`tick error: ${String(e)}`));
  }, 15000);
  timer.unref?.();

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, schedules: listSchedules().length }));
      return;
    }

    const trigger = url.match(/^\/trigger\/([A-Za-z0-9]+)\/?$/);
    if ((req.method === 'POST' || req.method === 'GET') && trigger) {
      void drainBody(req).then(async () => {
        const token = trigger[1] ?? '';
        const sched = listSchedules().find((s) => s.webhookToken === token && s.enabled);
        if (!sched) {
          res.writeHead(404);
          res.end('unknown or disabled token');
          return;
        }
        const { launchBackgroundJob } = await import('../jobs/launch.js');
        const { record } = launchBackgroundJob(sched.prompt, {
          ...(sched.worktree ? { worktree: true } : {}),
          ...(sched.sessionDir ? { sessionDir: sched.sessionDir } : {}),
          ...(sched.botName ? { botName: sched.botName } : {}),
        });
        updateSchedule(sched.id, { lastRunAt: new Date().toISOString() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobId: record.id }));
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(port, '127.0.0.1', () => log(`scheduler daemon listening on 127.0.0.1:${port}`));
}

/** 启动 detached 守护进程；已在跑则直接返回当前状态。 */
export function startDaemon(port: number = DEFAULT_PORT): {
  started: boolean;
  state: DaemonState | null;
  reason?: string;
} {
  const existing = getDaemonState();
  if (existing && isPidAlive(existing.pid)) {
    return { started: false, state: existing, reason: 'already running' };
  }
  fs.mkdirSync(stateDir(), { recursive: true });
  const logPath = daemonLogPath();
  const child = spawnDetached(['--schedule-daemon', '--port', String(port)], logPath);
  if (!child.pid) return { started: false, state: null, reason: 'spawn failed' };
  const state: DaemonState = { pid: child.pid, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(daemonStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  return { started: true, state };
}

/** 停止守护进程并清状态。 */
export function stopDaemon(): boolean {
  const state = getDaemonState();
  if (!state) return false;
  const ok = killTree(state.pid);
  try {
    fs.rmSync(daemonStatePath());
  } catch {
    // ignore
  }
  return ok;
}
