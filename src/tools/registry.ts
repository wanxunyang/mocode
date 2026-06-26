import type { Tool } from './types.js';
import { builtinTools } from './builtins/index.js';
import { recordMutation } from '../rollback/index.js';

/**
 * 工具注册表。当前 = 内置工具;
 * 未来可在此合并 MCP 工具、用户自定义工具等(见 src/mcp/)。
 */
export const tools: Tool[] = builtinTools;

/** 按名调度工具,统一 try/catch + JSON 解析,返回字符串而非抛错。 */
export async function executeTool(name: string, argsRaw: string): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `错误:未知工具 "${name}"`;
  let args: Record<string, unknown>;
  try {
    args = argsRaw.trim() ? JSON.parse(argsRaw) : {};
  } catch {
    return `错误:工具 ${name} 的 arguments 不是合法 JSON: ${argsRaw}`;
  }
  try {
    // 撤销回滚用:write_file/edit_file 改动前记 before 快照(回滚时恢复到轮末状态)。
    if (
      (name === 'write_file' || name === 'edit_file') &&
      typeof args.path === 'string' &&
      args.path
    ) {
      recordMutation(args.path);
    }
    return await tool.execute(args);
  } catch (e) {
    return `错误:工具 ${name} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export type { Tool } from './types.js';
