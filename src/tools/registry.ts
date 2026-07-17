import type { Tool, ToolContext, DropContextFilter, DropContextResult } from './types.js';
import { builtinTools } from './builtins/index.js';
import {
  beginPathMutation,
  beginWorkspaceMutation,
  endPathMutation,
  endWorkspaceMutation,
} from '../rollback/index.js';
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
 * opts.dropContext:上下文剔除回调(drop_context 工具用),透传给 tool.execute 经 ctx。
 */
export async function executeTool(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: { dropContext?: (filter: DropContextFilter) => DropContextResult }
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
    // 沙箱先重写/校验路径，保证快照与实际执行目标完全一致。
    const sbErr = enforceSandbox(name, args);
    if (sbErr) return sbErr;

    const pathCapture =
      (name === 'write_file' || name === 'edit_file') &&
      typeof args.path === 'string' &&
      args.path
        ? beginPathMutation(args.path)
        : null;
    // shell 与 MCP 的副作用无法从参数可靠推断：以工作区前后状态识别实际改动。
    // task 本身不扫描；其子 agent 共享当前轮，并在各自真实写工具处记账。
    const workspaceCapture =
      name === 'run_command' || name.startsWith('mcp__')
        ? beginWorkspaceMutation()
        : null;

    try {
      return await tool.execute(args, {
        signal,
        dropContext: opts?.dropContext,
      });
    } finally {
      if (pathCapture) endPathMutation(pathCapture, name);
      if (workspaceCapture) endWorkspaceMutation(workspaceCapture, name);
    }
  } catch (e) {
    return `错误:工具 ${name} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export type { Tool, ToolContext, DropContextFilter, DropContextResult } from './types.js';
