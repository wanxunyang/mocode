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
import { resolveResourceLockRequests, toolResourceLockManager } from './resource-lock.js';
import { executeWithToolRetry, type ToolRetryInfo } from './retry.js';
import { validateToolArguments } from './validation.js';
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
    // Legacy string errors carry no transient classification and are never retried blindly.
    retryable: false,
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

export interface ToolExecutionOptions {
  dropContext?: (filter: DropContextFilter) => DropContextResult;
  onLockAcquired?: (args: Record<string, unknown>) => void;
  onRetry?: (info: ToolRetryInfo) => void;
}

function isTransientExecutionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: number; code?: string; name?: string; message?: string };
  if (value.name === 'AbortError' || value.name === 'APIUserAbortError') return false;
  if (value.status === 408 || value.status === 429 ||
    (typeof value.status === 'number' && value.status >= 500)) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']
    .includes(value.code ?? '')) return true;
  return value.name === 'APIConnectionError' ||
    value.name === 'APIConnectionTimeoutError' ||
    (typeof value.message === 'string' && /\btime(?:d)?\s*out\b|ETIMEDOUT/i.test(value.message));
}

function executionErrorOutcome(
  name: string,
  error: unknown,
  startedAt: number,
  changedFiles: string[],
): ToolOutcome {
  const transient = isTransientExecutionError(error);
  const value = error as { code?: string; name?: string } | undefined;
  const timeout = transient && (value?.code === 'ETIMEDOUT' ||
    value?.name === 'APIConnectionTimeoutError' ||
    (error instanceof Error && /\btime(?:d)?\s*out\b|ETIMEDOUT/i.test(error.message)));
  return {
    status: 'error',
    code: timeout ? 'TIMEOUT' : transient ? 'NETWORK_ERROR' : 'EXECUTION_ERROR',
    retryable: transient,
    output: t('toolError.execution', {
      name,
      message: error instanceof Error ? error.message : String(error),
    }),
    changedFiles,
    durationMs: Date.now() - startedAt,
  };
}

/** One complete attempt: acquire/release locks and capture rollback independently. */
async function executeToolAttempt(
  tool: Tool,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  opts: ToolExecutionOptions | undefined,
  notifyLockAcquired: boolean,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const capabilities = getToolCapabilities(tool);
  let mutationVersionBefore: number | undefined;
  let capturedPath: string | undefined;
  try {
    const requests = resolveResourceLockRequests(capabilities, args);
    return await toolResourceLockManager.withLocks(requests, signal, async () => {
      if (notifyLockAcquired) opts?.onLockAcquired?.(args);
      const mutationBefore = getCurrentTurnMutationState();
      mutationVersionBefore = mutationBefore.version;
      // Transactional tools own their full write-set capture inside ChangeSet commit.
      const pathCapture = !capabilities.delegatesResourceLocks &&
        isFileMutationTool(tool.name) && typeof args.path === 'string' && args.path
        ? beginPathMutation(args.path)
        : null;
      capturedPath = pathCapture?.path;
      const workspaceCapture = capabilities.effect === 'process' || capabilities.effect === 'unknown'
        ? beginWorkspaceMutation()
        : null;

      let raw: ToolExecuteResult;
      try {
        raw = await tool.execute(args, { signal, dropContext: opts?.dropContext });
      } finally {
        if (pathCapture) endPathMutation(pathCapture, tool.name);
        if (workspaceCapture) endWorkspaceMutation(workspaceCapture, tool.name);
      }

      const mutationAfter = getCurrentTurnMutationState();
      const changedFiles = mutationAfter.version !== mutationBefore.version
        ? pathCapture
          ? mutationAfter.changedFiles.filter((item) => item.path === pathCapture.path).map((item) => item.path)
          : mutationAfter.changedFiles.map((item) => item.path)
        : [];
      if (signal?.aborted) {
        const aborted = terminalOutcome('aborted', 'ABORTED', String(isStructuredOutcome(raw) ? raw.output : raw), startedAt, changedFiles);
        return isStructuredOutcome(raw) ? { ...aborted, usage: raw.usage } : aborted;
      }
      return normalizeOutcome(raw, Date.now() - startedAt, changedFiles);
    });
  } catch (error) {
    const mutationAfter = getCurrentTurnMutationState();
    const changedFiles = mutationVersionBefore !== undefined && mutationAfter.version !== mutationVersionBefore
      ? capturedPath
        ? mutationAfter.changedFiles.filter((item) => item.path === capturedPath).map((item) => item.path)
        : mutationAfter.changedFiles.map((item) => item.path)
      : [];
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return terminalOutcome('aborted', 'ABORTED', t('command.interrupted'), startedAt, changedFiles);
    }
    return executionErrorOutcome(tool.name, error, startedAt, changedFiles);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
  const startedAt = Date.now();
  if (signal?.aborted) {
    return terminalOutcome('aborted', 'ABORTED', t('command.interrupted'), startedAt);
  }

  const tool = findTool(name);
  if (!tool) {
    return terminalOutcome('error', 'UNKNOWN_TOOL', t('toolError.unknown', { name }), startedAt);
  }

  let parsed: unknown;
  try {
    parsed = argsRaw.trim() ? JSON.parse(argsRaw) : {};
  } catch {
    return terminalOutcome(
      'error',
      'INVALID_JSON',
      t('toolError.invalidJson', { name, arguments: argsRaw }),
      startedAt,
    );
  }

  const validation = validateToolArguments(tool, parsed);
  if (!validation.valid) {
    return terminalOutcome(
      'error',
      validation.code,
      `错误:工具 ${name} 参数无效: ${validation.message}`,
      startedAt,
    );
  }
  const args = parsed as Record<string, unknown>;
  const fingerprint = `${name}\x00${stableJson(args)}`;
  const sandboxError = enforceSandbox(name, args);
  if (sandboxError) {
    return terminalOutcome('denied', 'SANDBOX_DENIED', sandboxError, startedAt);
  }

  const capabilities = getToolCapabilities(tool);
  try {
    return await executeWithToolRetry(
      capabilities,
      fingerprint,
      signal,
      (attempt) => executeToolAttempt(tool, args, signal, opts, attempt === 1),
      opts?.onRetry,
    );
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return terminalOutcome('aborted', 'ABORTED', t('command.interrupted'), startedAt);
    }
    return executionErrorOutcome(name, error, startedAt, []);
  }
}

/** 字符串兼容入口：现有调用方、TUI 和 LLM history 无需同步迁移。 */
export async function executeTool(
  name: string,
  argsRaw: string,
  signal?: AbortSignal,
  opts?: ToolExecutionOptions,
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
export type { ToolRetryInfo } from './retry.js';
