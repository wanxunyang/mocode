// 异步审批（park-and-wait）：bg 任务在非 TTY 下需要授权时，不 fail-closed 拒绝，
// 而是——
//   1. 写 <jobId>.approval.json 请求（含工具名/参数摘要）；
//   2. job 记录置 paused，发通知（MOCODE_NOTIFY_WEBHOOK）；
//   3. 进程挂起，每 1.5s 轮询 <jobId>.approval.decision；
//   4. `mocode approve <jobId>` 写决定 → checker 在同进程内返回 allow，
//      agent 带着完整内存历史继续，无需序列化。
//
// 已知限制：等待依赖进程存活；机器重启 / 进程被杀则需重新发起（v1 不做断点重放）。
// MOCODE_APPROVAL_TIMEOUT_MS 可设最大等待（默认 0 = 一直等），超时按 deny。

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createPermissionChecker, type PermissionChecker } from '../permissions/index.js';
import { sendNotification } from '../notify/index.js';
import { jobsRoot, updateJob } from './store.js';

function requestPath(jobId: string): string {
  return path.join(jobsRoot(), `${jobId}.approval.json`);
}
function decisionPath(jobId: string): string {
  return path.join(jobsRoot(), `${jobId}.approval.decision`);
}

export interface ApprovalRequest {
  jobId: string;
  tool: string;
  argsPreview: string;
  prompt: string;
  createdAt: string;
}

function argsPreview(tool: string, args: Record<string, unknown>): string {
  if (tool === 'run_command' && typeof args.command === 'string') return args.command.slice(0, 200);
  if (typeof args.path === 'string') return String(args.path);
  if (typeof args.url === 'string') return String(args.url);
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return '(unserializable args)';
  }
}

function writeApprovalRequest(jobId: string, tool: string, args: Record<string, unknown>, prompt: string): void {
  fs.mkdirSync(jobsRoot(), { recursive: true });
  const payload: ApprovalRequest = {
    jobId,
    tool,
    argsPreview: argsPreview(tool, args),
    prompt,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(requestPath(jobId), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function hasPendingApproval(jobId: string): boolean {
  try {
    fs.accessSync(requestPath(jobId));
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 挂起轮询，直到外部写决定文件；消费后清理请求/决定文件。 */
async function awaitDecision(jobId: string): Promise<'approved' | 'denied'> {
  const dp = decisionPath(jobId);
  const maxMs = Number(process.env.MOCODE_APPROVAL_TIMEOUT_MS ?? 0);
  const startedAt = Date.now();
  for (;;) {
    try {
      const v = fs.readFileSync(dp, 'utf8').trim();
      if (v === 'approved' || v === 'denied') {
        try {
          fs.rmSync(dp);
          fs.rmSync(requestPath(jobId));
        } catch {
          // cleanup best-effort
        }
        return v;
      }
    } catch {
      // 决定文件尚未出现
    }
    if (maxMs > 0 && Date.now() - startedAt > maxMs) {
      try {
        fs.rmSync(requestPath(jobId));
      } catch {
        // ignore
      }
      return 'denied';
    }
    await sleep(1500);
  }
}

/**
 * 异步审批 checker：包正常 checker，命中“需授权”时挂起等待。
 * 一旦批准，jobApproved=true → 本次运行后续动作不再逐个询问（语义：批准这个任务）。
 */
export function createAsyncApprovalChecker(deps: {
  jobId: string;
  sandboxRoot: string;
  getPrompt: () => string;
}): PermissionChecker {
  const inner = createPermissionChecker(config, deps.sandboxRoot);
  let jobApproved = false;

  return async (tool, args, signal, options) => {
    if (jobApproved) return 'allow';
    const decision = await inner(tool, args, signal, options);
    if (decision === 'allow') return 'allow';

    // 需要授权：置 paused + 写请求 + 通知，然后挂起。
    updateJob(deps.jobId, { status: 'paused' }, { force: true });
    writeApprovalRequest(deps.jobId, tool.name, args, deps.getPrompt());
    await sendNotification(config.notifyWebhook, {
      status: 'waiting',
      tool: tool.name,
      prompt: deps.getPrompt(),
      sessionId: deps.jobId,
      elapsedMs: 0,
      model: config.model,
    });

    const result = await awaitDecision(deps.jobId);
    if (result === 'approved') {
      jobApproved = true;
      updateJob(deps.jobId, { status: 'running' }, { force: true });
      return 'allow';
    }
    return 'deny';
  };
}

/** CLI/TUI 批准或拒绝：写决定文件。无挂起请求时报错。 */
export function approveJob(
  jobId: string,
  decision: 'approved' | 'denied',
): {
  ok: boolean;
  reason?: string;
} {
  if (!hasPendingApproval(jobId)) return { ok: false, reason: 'no pending approval for this job' };
  fs.writeFileSync(decisionPath(jobId), decision, 'utf8');
  return { ok: true };
}

/** 列出所有挂起的审批请求。 */
export function listPendingApprovals(): ApprovalRequest[] {
  let files: string[];
  try {
    files = fs.readdirSync(jobsRoot());
  } catch {
    return [];
  }
  const out: ApprovalRequest[] = [];
  for (const f of files) {
    if (!f.endsWith('.approval.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(jobsRoot(), f), 'utf8')) as ApprovalRequest);
    } catch {
      // skip corrupt
    }
  }
  return out;
}
