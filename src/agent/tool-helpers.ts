/**
 * agent 核心循环的工具辅助纯函数(从 core.ts 提取,2.0 步骤2 阶段A)。
 *
 * 这些函数不依赖 runAgentCore 的循环局部状态,只接受显式参数,故可安全模块化。
 * 它们覆盖:工具参数解析、文件编辑恢复提示、正文噪声判定、并发/锁调度分类、
 * 权限拒绝结果构造、mutation diff 旧内容预读、tool 结果回灌 history。
 *
 * 依赖说明:readDiffContext 用 jailResolve 直接 import(沙箱域,留待工具系统抽包统一处理);
 * pushToolResult 依赖 context/relevance/lifecycle/scheduler 的 metadata 登记,不改写历史正文。
 */

import { readFileSync } from 'node:fs';
import type { ChatMessage, ToolCallRef } from '../llm/index.js';
import { defaultToolRuntime, type ToolOutcome, type ToolRuntime } from '../tools/registry.js';
import { jailResolve } from '../sandbox/index.js';
import { contextState, type ContextState } from '../session/compact.js';
import { capToolResultForHistory } from '../session/compact.js';
import { recordArtifact, knownEditTargets } from '../context/index.js';
import { createRelevancePruner } from '../context/relevance.js';
import { isToolResultSuccess } from '../context/utils.js';
import type { LifecycleEngine } from '../context/lifecycle.js';
import type { BudgetScheduler } from '../session/scheduler.js';

/** 解析工具 arguments JSON;非法或空返 null(调用方据此降级到普通 preview)。 */
export function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** 需要「已知编辑目标」恢复提示的文件编辑工具;其余工具的参数报错不注入该提示。 */
const EDIT_HINT_TOOLS = new Set(['edit_file', 'write_file']);

/** 文件编辑工具参数校验失败时的恢复提示:把系统已知仍新鲜的「最近 read_file 的
 *  path + hash」直接递给模型照抄,替代其在长上下文里凭记忆复述。
 *  只展示事实、不替模型填值;没有候选(从未 read_file / 全部已失效)返 undefined。 */
export function argumentErrorHint(name: string, state: ContextState): string | undefined {
  if (!EDIT_HINT_TOOLS.has(name)) return undefined;
  const targets = knownEditTargets(state);
  if (targets.length === 0) return undefined;
  const lines = targets.map((target) => `  path=${target.path}  expected_hash=${target.hash}`).join('\n');
  return (
    '系统已知最近 read_file 且尚未被修改的文件(直接复制下面的 path / expected_hash,勿凭记忆复述):\n' +
    `${lines}\n如目标文件不在其中,先 read_file 该文件再发起编辑。`
  );
}

/** 判定 assistant content 是否只是 "Tool results:" 这类工具结果前缀噪声。
 *  部分模型(如 Claude)会在 tool_calls 前输出此种无意义过渡文本,写入 history
 *  会污染后续轮次上下文并在 TUI 上泄露为孤立行。 */
export function isToolResultsNoise(content: string): boolean {
  return /^(?:\s*Tool results:\s*)+$/i.test(content.trim());
}

/** 只有显式声明 parallel 且无需权限确认的工具才进入普通并发组。 */
export function isParallelTool(name: string, toolRuntime: ToolRuntime = defaultToolRuntime): boolean {
  const tool = toolRuntime.findTool(name);
  return !!tool && (tool.risk ?? 'safe') === 'safe' && toolRuntime.getToolCapabilities(tool).concurrency === 'parallel';
}

/** resource-locked 工具先顺序完成权限预检，再依赖 canonical resource lock 并发执行。 */
export function isResourceLockedTool(name: string, toolRuntime: ToolRuntime = defaultToolRuntime): boolean {
  const tool = toolRuntime.findTool(name);
  return !!tool && toolRuntime.getToolCapabilities(tool).concurrency === 'resource-locked';
}

export function isResourceLockedCall(call: ToolCallRef, toolRuntime: ToolRuntime = defaultToolRuntime): boolean {
  // sub-agent 是长时全域操作(嵌套 agent 与主 agent 同权,可写任意文件/跑任意命令),
  // 不进 mutation 并发批:逐个串行执行,避免两个子 agent 同时改工作区。
  return call.name !== 'sub-agent' && isResourceLockedTool(call.name, toolRuntime);
}

/** 权限拒绝时的结构化 ToolOutcome(供调度器统一回灌,不抛错中断循环)。 */
export function deniedOutcome(name: string): ToolOutcome {
  return {
    status: 'denied',
    code: 'PERMISSION_DENIED',
    retryable: false,
    output: `错误:用户拒绝了工具 ${name} 的执行。`,
  };
}

/** mutation 执行前读旧内容供 diff:write_file 取整文件旧内容(不存在→null=新建),
 * edit_file 取 old_string 起始行号(供 diff 显示真实文件行号)。读不到则 diff 退化为相对行号。
 * 非 mutation 或参数非法返 { preWriteOld: null, editStartLine: 1 }。失败不阻断。 */
export function readDiffContext(
  tc: ToolCallRef,
  parsed: Record<string, unknown> | null,
  resolvePath: (path: string) => string = jailResolve,
): { preWriteOld: string | null; editStartLine: number } {
  if (!parsed) return { preWriteOld: null, editStartLine: 1 };
  const p = String(parsed.path ?? '');
  if (!p) return { preWriteOld: null, editStartLine: 1 };
  if (tc.name === 'write_file') {
    try {
      // jailResolve:沙箱越界(../../、绝对外圈、软链出圈)抛错 → catch 兜底返 null,不泄露牢外内容(TOCTOU)
      return { preWriteOld: readFileSync(resolvePath(p), 'utf8'), editStartLine: 1 };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 文件不存在(新建)、不可读 或 沙箱越界(不泄露)
    }
  }
  if (tc.name === 'edit_file') {
    // 行尾归一化:LLM 生成的 old_string 用 LF(\n),但 Windows 文件可能是 CRLF(\r\n),
    // 不统一则 indexOf 必败、editStartLine 恒为 1。与 edit-file.ts 保持一致归一化为 LF。
    const oldStr = String(parsed.old_string ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    try {
      // jailResolve:同上,沙箱越界抛错 → catch 兜底,不泄露牢外内容
      const raw = readFileSync(resolvePath(p), 'utf8');
      const data = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const idx = oldStr ? data.indexOf(oldStr) : -1;
      return {
        preWriteOld: null,
        editStartLine: idx >= 0 ? data.slice(0, idx).split('\n').length : 1,
      };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 读不到:diff 退化为相对行号(含沙箱越界)
    }
  }
  return { preWriteOld: null, editStartLine: 1 };
}

/** 回灌 tool 结果到 history。
 *  正常路径只做单条 hard cap;原始 output 同时供 TUI 展示,因此用户与模型
 *  看到同一事实。Artifact/Relevance/Lifecycle 仅登记 metadata/provenance,
 *  不在这里改写旧正文;所有自动清理与压缩统一由 80% pressure scheduler 决定。 */
export function pushToolResult(
  history: ChatMessage[],
  tc: ToolCallRef,
  output: string,
  pruner: ReturnType<typeof createRelevancePruner> | null,
  lifecycle: LifecycleEngine | null,
  _scheduler: BudgetScheduler | null,
  runtimeContextState: ContextState = contextState,
  succeededOverride?: boolean,
): void {
  const succeeded = succeededOverride ?? isToolResultSuccess(output);
  const msg = {
    role: 'tool' as const,
    tool_call_id: tc.id,
    // Preserve evidence verbatim in normal operation; the hard per-result cap
    // remains solely as a request-size safety rail.
    content: capToolResultForHistory(tc.name, output),
  } as ChatMessage;
  history.push(msg);
  const messageIndex = history.length - 1;
  recordArtifact(runtimeContextState, history, messageIndex, output, succeeded);
  // 失败 read 不得淘汰旧 read;失败 consumer 也不能改变 lifecycle 上游状态。
  if (pruner) pruner.observePush(history, msg, succeeded);
  if (lifecycle) lifecycle.pushTool(history, messageIndex, succeeded);
  runtimeContextState.lifecycleStats = lifecycle?.stats();
}
