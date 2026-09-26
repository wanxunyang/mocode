// 后台任务 launcher / kill：spawn 一个 detached 子进程跑内部 `--job-runner <id>` 模式，
// 子进程 stdio 重定向到 <id>.log；父进程退出不影响它（detached + 独立进程组）。
//
// 形态自适应：编译产物 src/index.js 存在 → node 直跑；否则（开发态）用 tsx 跑
// src/index.ts，与 `npm start` 同源。

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

/** 构造 detached 子进程的命令与参数。 */
function runnerSpec(jobId: string): { command: string; args: string[] } {
  if (existsSync(compiledEntry)) {
    return { command: process.execPath, args: [compiledEntry, '--job-runner', jobId] };
  }
  return {
    command: process.execPath,
    // 不走 tsx CLI：它内部会 respawn 一个不带 windowsHide 的 node（弹窗根因）。
    // 直接用 node 加载 tsx loader，单进程、不弹窗。
    args: ['--require', tsxPreflight, '--import', pathToFileURL(tsxLoader).href, sourceEntry, '--job-runner', jobId],
  };
}

export interface LaunchResult {
  record: JobRecord;
  child: ChildProcess;
}

/** 创建记录并启动 detached job。spawn 失败时记录置 failed 并抛出。 */
export function launchBackgroundJob(prompt: string): LaunchResult {
  const id = createJobId();
  const logPath = logPathFor(id);
  const record: JobRecord = {
    id,
    prompt,
    status: 'running',
    cwd: process.cwd(),
    logPath,
    startedAt: new Date().toISOString(),
  };
  saveJob(record);

  const { command, args } = runnerSpec(id);
  // 'a' 保日志跨多次启动累积；同一 fd 给 stdout+stderr，输出顺序即写入顺序。
  const outFd = openSync(logPath, 'a');
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
  });
  child.unref();

  if (child.pid) {
    saveJob({ ...record, pid: child.pid });
  }
  child.on('error', () => {
    // spawn 失败（tsx/node 路径缺失等）：落 failed，避免 job 永远挂 running。
    updateJob(id, { status: 'failed', finishedAt: new Date().toISOString() }, { force: true });
  });

  return { record: { ...record, pid: child.pid }, child };
}

/**
 * 树杀 job 进程并置 killed。
 * Windows：taskkill /T /F 杀整棵进程树（job 可能派生了 shell/dev_server）。
 * POSIX：detached 子进程是新进程组组长，负 pid 杀整个进程组。
 */
export function killBackgroundJob(record: JobRecord): boolean {
  if (typeof record.pid !== 'number') return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true });
    if (r.status !== 0) return false;
  } else {
    try {
      process.kill(-record.pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  updateJob(record.id, { status: 'killed', finishedAt: new Date().toISOString() }, { force: true });
  return true;
}
