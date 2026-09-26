// D3 checkpoint 存储：每个 bg job 在工具批次提交后把完整 history 快照
// 原子写到 <id>.checkpoint.json。崩溃 / 机器重启后可用
// `mocode resume-job <id>` 从最后一个 checkpoint 在新进程断点续跑。

import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../llm/index.js';
import { jobsRoot } from './store.js';

function checkpointPath(jobId: string): string {
  return path.join(jobsRoot(), `${jobId}.checkpoint.json`);
}

export function writeCheckpoint(jobId: string, history: readonly ChatMessage[]): void {
  fs.mkdirSync(jobsRoot(), { recursive: true });
  const target = checkpointPath(jobId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(history)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

export function readCheckpoint(jobId: string): ChatMessage[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath(jobId), 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : null;
  } catch {
    return null;
  }
}

export function deleteCheckpoint(jobId: string): void {
  try {
    fs.rmSync(checkpointPath(jobId));
  } catch {
    // already gone
  }
}
