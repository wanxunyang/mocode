// 后台任务 launcher / kill：spawn 一个 detached 子进程，父进程退出不影响它
//（detached + 独立进程组），stdio 重定向到日志文件。
//
// 形态自适应：编译产物 src/index.js 存在 → node 直跑；否则（开发态）用 node 加载
// tsx loader 单进程跑 src/index.ts（不用 tsx CLI：它会 respawn 一个不 hide 的弹窗 node）。
//
// 通用件 buildEntryArgs / spawnDetached 也供 schedule 守护进程复用（src/schedule/daemon.ts）。

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { createJobId, saveJob, updateJob, logPathFor, type JobRecord } from './store.js';

const jobsDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(jobsDir, '..');
const projectRoot = path.resolve(srcDir, '..');

const compiledEntry = path.join(srcDir, 'index.js');
const sourceEntry = path.join(srcDir, 'index.ts');
const tsxLoader = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const tsxPreflight = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'preflight.cjs');

/**
 * 构造「node …入口… internalArgs」的完整参数。
 * 生产/开发形态自动选择，调用方只需给入口之后的内部参数（如 ['--job-runner', id]）。
 */
export function buildEntryArgs(internalArgs: string[]): string[] {
  if (existsSync(compiledEntry)) return [compiledEntry, ...internalArgs];
  return ['--require', tsxPreflight, '--import', pathToFileURL(tsxLoader).href, sourceEntry, ...internalArgs];
}

/**
 * detached spawn 一个 node 子进程。stdio 重定向到 logPath（stdout+stderr 同一 fd）。
 * 调用方负责后续 saveJob 等状态回写。
 */
export function spawnDetached(internalArgs: string[], logPath: string, cwd: string = process.cwd()): ChildProcess {
  const outFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, buildEntryArgs(internalArgs), {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    cwd,
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  return child;
}

export interface LaunchResult {
  record: JobRecord;
  child: ChildProcess;
}

export interface LaunchOptions {
  sessionDir?: string;
  worktree?: boolean;
  botName?: string;
}

/** 创建记录并启动 detached job。spawn 失败时记录置 failed。 */
export function launchBackgroundJob(prompt: string, opts: LaunchOptions = {}): LaunchResult {
  const id = createJobId();
  const logPath = logPathFor(id);
  const record: JobRecord = {
    id,
    prompt,
    status: 'running',
    cwd: process.cwd(),
    logPath,
    startedAt: new Date().toISOString(),
    ...(opts.sessionDir ? { sessionDir: opts.sessionDir } : {}),
    ...(opts.worktree ? { worktree: true } : {}),
    ...(opts.botName ? { botName: opts.botName } : {}),
  };
  saveJob(record);

  const child = spawnDetached(['--job-runner', id], logPath);

  if (child.pid) saveJob({ ...record, pid: child.pid });
  child.on('error', () => {
    updateJob(id, { status: 'failed', finishedAt: new Date().toISOString() }, { force: true });
  });

  return { record: { ...record, pid: child.pid }, child };
}

/**
 * 树杀进程并置 killed。
 * Windows：taskkill /T /F 杀整棵进程树；POSIX：负 pid 杀整个进程组。
 */
export function killTree(pid: number): boolean {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return r.status === 0;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** 树杀 job 并置 killed。 */
export function killBackgroundJob(record: JobRecord): boolean {
  if (typeof record.pid !== 'number') return false;
  if (!killTree(record.pid)) return false;
  updateJob(record.id, { status: 'killed', finishedAt: new Date().toISOString() }, { force: true });
  return true;
}
