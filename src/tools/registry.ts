import type { Tool } from './types.js';
import { builtinTools } from './builtins/index.js';
import { recordMutation } from '../rollback/index.js';
import { enforceSandbox } from '../sandbox/index.js';

/**
 * 工具注册表。当前 = 内置工具;
 * 未来可在此合并 MCP 工具、用户自定义工具等(见 src/mcp/)。
 */
export const tools: Tool[] = builtinTools;

/**
 * 按名调度工具,统一 try/catch + JSON 解析,返回字符串而非抛错。
 * signal 透传给 tool.execute(经 ctx):长任务工具(run_command/web_fetch)abort 即时取消,
 * 让用户 Ctrl+C 能跟手中断工具执行(而非等命令跑完 / 超时)。
 * opts.skipRollback:子 agent 逻辑隔离用——跳过 recordMutation,子 agent 改动不进主回滚快照链。
 */
export async function executeTool(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: { skipRollback?: boolean }
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `错误:未知工具 "${name}"`;
  let args: Record<string, unknown>;
  try {
    args = argsRaw.trim() ? JSON.parse(argsRaw) : {};
  } catch {
    return `错误:工具 ${name} 的 arguments 不是合法 JSON: ${argsRaw}`;
  }
  try {
    // 沙箱:路径类工具(读/写/改)越界拒绝 + args.path 重写为牢内绝对;glob/grep pattern 校验。
    // 返 string = 拒绝(直接喂 LLM,不执行);返 null = 放行(可能已重写 args.path)。
    // 须在 recordMutation 前:让快照路径 = 牢内绝对路径,与回滚一致。不抛(契约:调度器永不抛错)。
    const sbErr = enforceSandbox(name, args);
    if (sbErr) return sbErr;
    // 撤销回滚用:write_file/edit_file 改动前记 before 快照(回滚时恢复到轮末状态)。
    // 子 agent(skipRollback)跳过:其改动不进主回滚链,主 /rollback 不撤销(靠 git 兜底)。
    if (
      !opts?.skipRollback &&
      (name === 'write_file' || name === 'edit_file') &&
      typeof args.path === 'string' &&
      args.path
    ) {
      recordMutation(args.path);
    }
    return await tool.execute(args, { signal, skipRollback: opts?.skipRollback });
  } catch (e) {
    return `错误:工具 ${name} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export type { Tool } from './types.js';
