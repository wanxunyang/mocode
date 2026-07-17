import type { Tool, ToolContext, DropContextFilter, DropContextResult } from './types.js';
import { builtinTools } from './builtins/index.js';
import { recordMutation } from '../rollback/index.js';
import { enforceSandbox } from '../sandbox/index.js';

/**
 * 可扩展工具注册表。数组实例始终稳定，使已经持有 tools 引用的 agent/LLM 能看到运行时新增工具。
 * 扩展按 source 替换，MCP 重连或配置刷新不会累积旧工具。
 */
const extensions = new Map<string, Tool[]>();
export const tools: Tool[] = [...builtinTools];

export function registerToolsExtension(source: string, additions: Tool[]): string[];
/** 向后兼容：未命名扩展使用 external 槽位。 */
export function registerToolsExtension(additions: Tool[]): string[];
export function registerToolsExtension(sourceOrAdditions: string | Tool[], maybeAdditions?: Tool[]): string[] {
  const source = typeof sourceOrAdditions === 'string' ? sourceOrAdditions : 'external';
  const additions = typeof sourceOrAdditions === 'string' ? (maybeAdditions ?? []) : sourceOrAdditions;
  extensions.set(source, additions);
  const rejected = additions
    .filter((tool) => builtinTools.some((builtin) => builtin.name === tool.name))
    .map((tool) => tool.name);
  rebuildTools();
  return rejected;
}

export function clearToolsExtension(source: string): void {
  if (extensions.delete(source)) rebuildTools();
}

function rebuildTools(): void {
  const names = new Set<string>();
  const next: Tool[] = [];
  for (const tool of [...builtinTools, ...Array.from(extensions.values()).flat()]) {
    if (names.has(tool.name)) continue;
    names.add(tool.name);
    next.push(tool);
  }
  tools.splice(0, tools.length, ...next);
}

/**
 * 按名调度工具,统一 try/catch + JSON 解析,返回字符串而非抛错。
 * signal 透传给 tool.execute(经 ctx):长任务工具(run_command/web_fetch)abort 即时取消,
 * 让用户 Ctrl+C 能跟手中断工具执行(而非等命令跑完 / 超时)。
 * opts.skipRollback:子 agent 逻辑隔离用——跳过 recordMutation,子 agent 改动不进主回滚快照链。
 * opts.dropContext:上下文剔除回调(drop_context 工具用),透传给 tool.execute 经 ctx。
 */
export async function executeTool(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: { skipRollback?: boolean; dropContext?: (filter: DropContextFilter) => DropContextResult }
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
    return await tool.execute(args, {
      signal,
      skipRollback: opts?.skipRollback,
      dropContext: opts?.dropContext,
    });
  } catch (e) {
    return `错误:工具 ${name} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export type { Tool, ToolContext, DropContextFilter, DropContextResult } from './types.js';
