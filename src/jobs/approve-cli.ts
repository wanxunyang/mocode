// `mocode approve <jobId>` / `mocode deny <jobId>`：写决定文件，唤醒挂起的 bg job。
import { approveJob, listPendingApprovals } from './approval.js';

export function runApproveCli(rawArgs: string[], decision: 'approved' | 'denied'): number {
  let id = rawArgs[0];
  // 无参数：恰好一个挂起审批时自动选中，否则列出全部。
  if (!id) {
    const pending = listPendingApprovals();
    if (pending.length === 1) {
      id = pending[0]?.jobId;
    } else {
      if (pending.length === 0) process.stdout.write('No pending approvals.\n');
      else {
        for (const p of pending) {
          process.stdout.write(`  ${p.jobId}  ${p.tool}  ${p.argsPreview.split('\n')[0]}\n`);
        }
        process.stdout.write('Usage: mocode approve <jobId>\n');
      }
      return pending.length === 1 ? 0 : 1;
    }
  }

  const r = approveJob(id, decision);
  if (!r.ok) {
    process.stderr.write(`mocode: ${r.reason ?? 'failed'}\n`);
    return 1;
  }
  process.stdout.write(`${decision === 'approved' ? 'Approved' : 'Denied'} ${id}; job continues.\n`);
  return 0;
}
