// Job runner：detached 子进程的内部入口（`mocode --job-runner <id>`）。
// 复用 runHeadless 跑任务（输出已被 launcher 重定向到 <id>.log），
// 结束后按退出码回写 job 终态，并 best-effort 发结束通知（MOCODE_NOTIFY_WEBHOOK）。

import { getJob, updateJob } from './store.js';
import { runHeadless } from '../headless.js';
import { sendNotification } from '../notify/index.js';
import { config } from '../config/index.js';

export async function runJobRunner(jobId: string): Promise<number> {
  const record = getJob(jobId);
  if (!record) {
    process.stderr.write(`job runner: unknown job ${jobId}\n`);
    return 1;
  }

  const startedAt = Date.now();
  let exitCode: number;
  try {
    exitCode = await runHeadless({
      prompt: record.prompt,
      json: false,
      verbose: false,
      skipPermissions: false,
      ...(record.sessionDir ? { sessionDir: record.sessionDir } : {}),
      ...(record.worktree ? { worktree: true } : {}),
    });
  } catch (e) {
    updateJob(jobId, { status: 'failed', finishedAt: new Date().toISOString(), exitCode: 1 }, { force: true });
    process.stderr.write(`job runner crashed: ${e instanceof Error ? e.message : String(e)}\n`);
    await sendNotification(config.notifyWebhook, {
      status: 'failed',
      prompt: record.prompt,
      sessionId: jobId,
      elapsedMs: Date.now() - startedAt,
      model: config.model,
    });
    return 1;
  }

  const status = exitCode === 0 ? 'succeeded' : 'failed';
  // force：被手动 kill 后进程仍可能在此回写，killed 状态由 killBackgroundJob 强制保留。
  updateJob(jobId, { status, finishedAt: new Date().toISOString(), exitCode }, { force: false });

  // 被 kill 的 job（记录仍是 killed）不发常规成功/失败通知，避免与用户意图冲突。
  const after = getJob(jobId);
  if (after?.status !== 'killed') {
    await sendNotification(config.notifyWebhook, {
      status,
      prompt: record.prompt,
      sessionId: jobId,
      elapsedMs: Date.now() - startedAt,
      model: config.model,
    });
  }
  return exitCode;
}
