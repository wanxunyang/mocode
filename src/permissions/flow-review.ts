/**
 * run_flow 的权限审查输入:把"这次回放到底会做什么"在启动前一次算清(design-notes/computer-use-rpa.md §5.3)。
 *
 * 回放内部的单步不再走 checkPermission,所以整条 flow 的敏感判定必须在这里完成:
 *   - 指纹绑定 flow 文件 hash:flow 被改过(哪怕同名)旧授权立即失效;
 *   - reasons 非空 → 调用方强制 once 级确认(secret 参数、敏感文本、删除/发送/支付类目标)。
 */
import { flowReviewReasons, loadFlow, resolveParams, summarizeFlow } from '../flows/flow.js';

export interface FlowRunReview {
  name: string;
  /** flow 文件 sha256;无法加载时为 undefined。 */
  hash?: string;
  reasons: string[];
  /** 面向用户的确认面板正文(不含 secret 取值)。 */
  summary: string;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export function reviewFlowRun(args: Record<string, unknown>): FlowRunReview {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const loaded = loadFlow(name);
  if (!loaded.ok) {
    return { name, reasons: [], summary: `run_flow ${JSON.stringify(name)}: ${loaded.error}` };
  }
  const { flow } = loaded;
  const given =
    args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : undefined;
  const resolved = resolveParams(flow, given);
  // 参数不合法时回放会直接 rejected;审查按 default 兜底,保证仍能判定 secret / 敏感目标。
  const values: Record<string, string> = resolved.ok
    ? resolved.values
    : Object.fromEntries(
        Object.entries(flow.params).flatMap(([k, p]) => (p.default !== undefined ? [[k, p.default]] : [])),
      );
  const reasons = flowReviewReasons(flow, values);

  const paramLines = Object.entries(flow.params).map(([k, p]) => {
    if (p.secret) return `  ${k} = ***`;
    const v = values[k];
    return `  ${k} = ${v === undefined ? '(missing)' : JSON.stringify(clip(v, 60))}`;
  });
  const summary = [summarizeFlow(flow), ...(paramLines.length ? ['Parameter values:', ...paramLines] : [])].join('\n');
  return { name, hash: loaded.hash, reasons, summary };
}
