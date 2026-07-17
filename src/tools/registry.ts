import type {
  Tool,
  ToolCapabilities,
  ToolContext,
  ToolOutcome,
  ToolExecuteResult,
  DropContextFilter,
  DropContextResult,
} from './types.js';
import { builtinTools } from './builtins/index.js';
import {
  beginPathMutation,
  beginWorkspaceMutation,
  endPathMutation,
  endWorkspaceMutation,
  getCurrentTurnMutationState,
} from '../rollback/index.js';
import { enforceSandbox } from '../sandbox/index.js';
import { t } from '../i18n/index.js';
import { isToolErrorOutput } from './result.js';

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

const DEFAULT_CAPABILITIES: ToolCapabilities = Object.freeze({
  effect: 'unknown',
  concurrency: 'serial',
  retry: 'never',
});

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

/** 缺少声明或找不到工具时返回保守能力，绝不把未知扩展并发执行。 */
export function getToolCapabilities(toolOrName: Tool | string | undefined): ToolCapabilities {
  const tool = typeof toolOrName === 'string' ? findTool(toolOrName) : toolOrName;
  return tool?.capabilities ?? DEFAULT_CAPABILITIES;
}

export function getToolResourceKeys(
  toolOrName: Tool | string | undefined,
  args: Record<string, unknown>,
): string[] {
  const capabilities = getToolCapabilities(toolOrName);
  try {
    return capabilities.resources?.(args) ?? [];
  } catch {
    return [];
  }
}

/** resource-locked write 是可生成文件 diff/按路径记 rollback 的文件 mutation。 */
export function isFileMutationTool(name: string): boolean {
  const capabilities = getToolCapabilities(name);
  return capabilities.effect === 'write' && capabilities.concurrency === 'resource-locked';
}

function isStructuredOutcome(value: ToolExecuteResult): value is ToolOutcome {
  return typeof value === 'object' && value !== null &&
    typeof value.status === 'string' && typeof value.code === 'string' &&
    typeof value.retryable === 'boolean' && typeof value.output === 'string';
}

function normalizeOutcome(
  value: ToolExecuteResult,
  capabilities: ToolCapabilities,
  durationMs: number,
  changedFiles: string[],
): ToolOutcome {
  if (isStructuredOutcome(value)) {
    return {
      ...value,
      durationMs: value.durationMs ?? durationMs,
      changedFiles: value.changedFiles ?? changedFiles,
    };
  }
  const failed = isToolErrorOutput(value);
  return {
    status: failed ? 'error' : 'success',
    code: failed ? 'EXECUTION_ERROR' : 'OK',
    retryable: failed && capabilities.retry !== 'never',
    output: value,
    changedFiles,
    durationMs,
  };
}

function terminalOutcome(
  status: ToolOutcome['status'],
  code: ToolOutcome['code'],
  output: string,
  startedAt: number,
  changedFiles: string[] = [],
): ToolOutcome {
  return {
    status,
    code,
    retryable: false,
    output,
    changedFiles,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 结构化工具调度入口。永不抛错；旧字符串工具在此归一化为 ToolOutcome。
 * 权限仍由 Agent 在展示工具头之前预检，保持现有交互时序。
 */
export async function executeToolOutcome(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: { dropContext?: (filter: DropContextFilter) => DropContextResult },
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  if (signal?.aborted) {
    return terminalOutcome('aborted', 'ABORTED', t('command.interrupted'), startedAt);
  }

  const tool = findTool(name);
  if (!tool) {
    return terminalOutcome('error', 'UNKNOWN_TOOL', t('toolError.unknown', { name }), startedAt);
  }

  let args: Record<string, unknown>;
  try {
    args = argsRaw.trim() ? JSON.parse(argsRaw) : {};
  } catch {
    return terminalOutcome(
      'error',
      'INVALID_JSON',
      t('toolError.invalidJson', { name, arguments: argsRaw }),
      startedAt,
    );
  }

  const capabilities = getToolCapabilities(tool);
  const mutationBefore = getCurrentTurnMutationState();
  try {
    const sandboxError = enforceSandbox(name, args);
    if (sandboxError) {
      return terminalOutcome('denied', 'SANDBOX_DENIED', sandboxError, startedAt);
    }

    const pathCapture =
      isFileMutationTool(name) && typeof args.path === 'string' && args.path
        ? beginPathMutation(args.path)
        : null;
    // 进程和未知扩展可能间接改动任意文件；已声明 write 的非文件工具自行管理其状态。
    const workspaceCapture =
      capabilities.effect === 'process' || capabilities.effect === 'unknown'
        ? beginWorkspaceMutation()
        : null;

    let raw: ToolExecuteResult;
    try {
      raw = await tool.execute(args, {
        signal,
        dropContext: opts?.dropContext,
      });
    } finally {
      if (pathCapture) endPathMutation(pathCapture, name);
      if (workspaceCapture) endWorkspaceMutation(workspaceCapture, name);
    }

    const mutationAfter = getCurrentTurnMutationState();
    const changedFiles = mutationAfter.version !== mutationBefore.version
      ? mutationAfter.changedFiles.map((item) => item.path)
      : [];
    if (signal?.aborted) {
      return terminalOutcome('aborted', 'ABORTED', String(isStructuredOutcome(raw) ? raw.output : raw), startedAt, changedFiles);
    }
    return normalizeOutcome(raw, capabilities, Date.now() - startedAt, changedFiles);
  } catch (error) {
    const mutationAfter = getCurrentTurnMutationState();
    const changedFiles = mutationAfter.version !== mutationBefore.version
      ? mutationAfter.changedFiles.map((item) => item.path)
      : [];
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return terminalOutcome('aborted', 'ABORTED', t('command.interrupted'), startedAt, changedFiles);
    }
    return terminalOutcome(
      'error',
      'EXECUTION_ERROR',
      t('toolError.execution', {
        name,
        message: error instanceof Error ? error.message : String(error),
      }),
      startedAt,
      changedFiles,
    );
  }
}

/** 字符串兼容入口：现有调用方、TUI 和 LLM history 无需同步迁移。 */
export async function executeTool(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: { dropContext?: (filter: DropContextFilter) => DropContextResult },
): Promise<string> {
  return (await executeToolOutcome(name, argsRaw, signal, opts)).output;
}

export type {
  Tool,
  ToolCapabilities,
  ToolContext,
  ToolOutcome,
  ToolExecuteResult,
  DropContextFilter,
  DropContextResult,
} from './types.js';
