// 后台任务存储：每个 job 一个 <id>.json 记录 + <id>.log 日志（detached 子进程的
// stdout/stderr 直接重定向到该文件）。
//
// 根目录：<sandboxRoot>/.mocode/jobs/。sandboxRoot 与 headless / REPL 同源
// （入口先 setSandboxRoot，store 动态读取，不缓存）。

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSandboxRoot } from '../sandbox/index.js';

export type JobStatus = 'running' | 'paused' | 'succeeded' | 'failed' | 'killed';

export interface JobRecord {
  id: string;
  prompt: string;
  status: JobStatus;
  /** detached 子进程 PID，供 /jobs kill。 */
  pid?: number;
  cwd: string;
  logPath: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  /** isolated session dir passed through to runHeadless. */
  sessionDir?: string;
  /** run inside a git worktree. */
  /** named bot identity to run as. */
  botName?: string;
  worktree?: boolean;
}

/** 与 session 同风格的时间戳 id：YYYYMMDD-HHMMSS-rand。 */
export function createJobId(now = new Date()): string {
  const p = (n: number, l = 2): string => String(n).padStart(l, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function jobsRoot(): string {
  return path.join(getSandboxRoot() ?? process.cwd(), '.mocode', 'jobs');
}

function recordPath(id: string): string {
  return path.join(jobsRoot(), `${id}.json`);
}

export function logPathFor(id: string): string {
  return path.join(jobsRoot(), `${id}.log`);
}

export function saveJob(record: JobRecord): void {
  fs.mkdirSync(jobsRoot(), { recursive: true });
  // per-file 原子写：先写 tmp 再 rename，避免读侧看到半截 JSON。
  const target = recordPath(record.id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

export function getJob(id: string): JobRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')) as JobRecord;
  } catch {
    return null;
  }
}

/**
 * 更新 job 状态。默认保护：记录已是终态 killed 时不被覆盖
 * （runner 退出回写与手动 kill 存在竞态）。force 可绕过。
 */
export function updateJob(id: string, patch: Partial<JobRecord>, opts: { force?: boolean } = {}): JobRecord | null {
  const current = getJob(id);
  if (!current) return null;
  if (!opts.force && current.status === 'killed' && patch.status !== 'killed') return current;
  const next: JobRecord = { ...current, ...patch };
  saveJob(next);
  return next;
}

/** 列出全部 job，新的在前。 */
export function listJobs(): JobRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(jobsRoot());
  } catch {
    return [];
  }
  const records: JobRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(jobsRoot(), file), 'utf8')) as JobRecord);
    } catch {
      // 跳过损坏记录
    }
  }
  return records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** 读日志尾部，默认最多 4KB。 */
export function readJobLog(id: string, maxBytes = 4096): string {
  const logPath = logPathFor(id);
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '(no logs yet)';
  }
}
