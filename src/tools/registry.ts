import type { Tool, ToolCapabilities, ToolOutcome } from './types.js';
import { ToolRuntime } from './tool-runtime.js';
import type { ToolExecutionOptions } from './tool-runtime.js';

// 注意:不顶层 import builtins——会构成 registry → builtins → task(sub-agent) → agent/spawn
// → agent/core → registry 的模块循环。官方默认工具包由 builtins/index.ts 经 installBuiltinTools 自注册。

/**
 * 默认工具运行时。现有模块级 API 均为薄委托；新调用方可创建独立 ToolRuntime。
 * 官方默认工具包不顶层 import，由 builtins/index.ts 经 installBuiltinTools() 注入。
 */
export const defaultToolRuntime = new ToolRuntime();

/** 稳定数组引用；defaultToolRuntime 重建时仅原地 splice。 */
export const tools: Tool[] = defaultToolRuntime.tools;

/** 装配官方默认工具包(coding preset)。幂等:重复 install 覆盖上次,不累积。 */
export function installBuiltinTools(list: Tool[]): void {
  defaultToolRuntime.installBuiltinTools(list);
}

export function registerToolsExtension(source: string, additions: Tool[]): string[];
/** 向后兼容：未命名扩展使用 external 槽位。 */
export function registerToolsExtension(additions: Tool[]): string[];
export function registerToolsExtension(sourceOrAdditions: string | Tool[], maybeAdditions?: Tool[]): string[] {
  return typeof sourceOrAdditions === 'string'
    ? defaultToolRuntime.registerToolsExtension(sourceOrAdditions, maybeAdditions ?? [])
    : defaultToolRuntime.registerToolsExtension(sourceOrAdditions);
}

export function clearToolsExtension(source: string): void {
  defaultToolRuntime.clearToolsExtension(source);
}

export function findTool(name: string): Tool | undefined {
  return defaultToolRuntime.findTool(name);
}

/** 缺少声明或找不到工具时返回保守能力，绝不把未知扩展并发执行。 */
export function getToolCapabilities(toolOrName: Tool | string | undefined): ToolCapabilities {
  return defaultToolRuntime.getToolCapabilities(toolOrName);
}

export function getToolResourceKeys(toolOrName: Tool | string | undefined, args: Record<string, unknown>): string[] {
  return defaultToolRuntime.getToolResourceKeys(toolOrName, args);
}

/** resource-locked write 是可生成文件 diff/按路径记 rollback 的文件 mutation。 */
export function isFileMutationCapabilities(capabilities: ToolCapabilities): boolean {
  return defaultToolRuntime.isFileMutationCapabilities(capabilities);
}

/** 按工具名判定(兼容入口);热路径请直接复用已解析的 capabilities。 */
export function isFileMutationTool(name: string): boolean {
  return defaultToolRuntime.isFileMutationTool(name);
}

/**
 * 结构化工具调度入口。永不抛错；旧字符串工具在此归一化为 ToolOutcome。
 * 权限仍由 Agent 在展示工具头之前预检，保持现有交互时序。
 */
export async function executeToolOutcome(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: ToolExecutionOptions,
): Promise<ToolOutcome> {
  return defaultToolRuntime.executeToolOutcome(name, argsRaw, signal, opts);
}

/** 字符串兼容入口：现有调用方、TUI 和 LLM history 无需同步迁移。 */
export async function executeTool(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: ToolExecutionOptions,
): Promise<string> {
  return defaultToolRuntime.executeTool(name, argsRaw, signal, opts);
}

export { ToolRuntime } from './tool-runtime.js';
export type { ToolExecutionOptions, ToolRuntimeDependencies } from './tool-runtime.js';
export type { Tool, ToolCapabilities, ToolContext, ToolOutcome, ToolExecuteResult } from './types.js';
