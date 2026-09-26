// C4 Reattach：`mocode attach [id前缀]`——从头回放 job 日志，并实时跟随新输出，
// 直到 job 进入终态（succeeded/failed/killed）且日志排空后退出。
//
// 纯 stdout 流式（与 headless 同性质），故不嵌进全屏 TUI：TUI 内 /jobs attach
// 只提示在另一终端运行。轮询而非持久句柄——跨平台、且 job 文件由别的进程写入。

import fs from 'node:fs';
import { getJob, listJobs, type JobRecord, type JobStatus } from './store.js';

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'killed']);
const POLL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resolveJob(idPrefix: string | undefined): JobRecord | null {
  if (!idPrefix) {
    const running = listJobs().filter((j) => !TERMINAL.has(j.status));
    return running.length === 1 ? running[0] : (listJobs()[0] ?? null);
  }
  const matches = listJobs().filter((j) => j.id.startsWith(idPrefix));
  return matches.length === 1 ? matches[0] : null;
}

export async function runAttachCli(rawArgs: string[]): Promise<number> {
  const idPrefix = rawArgs[0];
  const initial = resolveJob(idPrefix);
  if (!initial) {
    process.stderr.write('mocode: no unique matching job to attach\n');
    return 1;
  }

  process.stdout.write(`── attach ${initial.id} ──\n`);
  let offset = 0;
  let stableRounds = 0;

  for (;;) {
    // 1) 排空当前新增日志。
    try {
      const stat = fs.statSync(initial.logPath);
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        const fd = fs.openSync(initial.logPath, 'r');
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        process.stdout.write(buf);
        stableRounds = 0;
      }
    } catch {
      // 日志暂时不可读（尚未创建/被锁），下轮再试。
    }

    // 2) 查最新状态。
    const job = getJob(initial.id) ?? initial;
    if (TERMINAL.has(job.status)) {
      // 终态后再多等两轮，确保末尾输出已落盘并排空，避免丢最后几行。
      stableRounds += 1;
      if (stableRounds >= 2) {
        if (!process.stdout.isTTY) process.stdout.write(`\n[${job.status}]`);
        else process.stdout.write(`\n${job.status}\n`);
        return job.status === 'succeeded' ? 0 : 1;
      }
    }
    await sleep(POLL_MS);
  }
}
