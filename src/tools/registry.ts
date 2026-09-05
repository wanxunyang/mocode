import type OpenAI from 'openai';
import type { Tool, ToolCapabilities, ToolOutcome, ToolExecuteResult } from './types.js';
// 注意:不顶层 import builtins——会构成 registry → builtins → task(sub-agent) → agent/spawn
// → agent/core → registry 的模块循环。官方默认工具包由 builtins/index.ts 经 installBuiltinTools 自注册。
import {
  beginPathMutation,
  beginWorkspaceMutation,
  endPathMutation,
  endWorkspaceMutation,
  getCurrentTurnMutationState,
} from '../rollback/index.js';
import { enforceSandbox } from '../sandbox/index.js';
import { resolveResourceLockRequests, toolResourceLockManager } from './resource-lock.js';
import { validateToolArguments } from './validation.js';
import { t } from '../i18n/index.js';
import { isToolErrorOutput } from './result.js';

/**
 * 可扩展工具注册表。数组实例始终稳定，使已经持有 tools 引用的 agent/LLM 能看到运行时新增工具。
 * 扩展按 source 替换，MCP 重连或配置刷新不会累积旧工具。
 *
 * 官方默认工具包不顶层 import——由装配方经 installBuiltinTools() 注入(见 builtins/index.ts 自注册)。
 * 这是「framework 与 coding preset 分离」的装配缝:@mocode/tool-system 不含 builtin,builtin 是可替换默认包。
 * 未 install 时 tools 为空数组;install 后 rebuild 合并 builtin + 已注册扩展。
 */
const extensions = new Map<string, Tool[]>();
let builtinTools: Tool[] = [];
export const tools: Tool[] = [];
/** 名字 → 工具 的 O(1) 索引，与 tools 数组在每次 rebuild 时同步重建；findTool 走此索引。 */
let toolIndex = buildToolIndex(tools);

function buildToolIndex(list: Tool[]): Map<string, Tool> {
  return new Map(list.map((tool) => [tool.name, tool]));
}

/**
 * 装配官方默认工具包(coding preset)。幂等:重复 install 覆盖上次,不累积。
 * 由 builtins/index.ts 在模块初始化时调用;入口(CLI/stdio host/eval/测试)只需 import builtins 即完成装配。
 */
export function installBuiltinTools(list: Tool[]): void {
  builtinTools = list;
  rebuildTools();
}

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
  toolIndex = buildToolIndex(next);
}

const DEFAULT_CAPABILITIES: ToolCapabilities = Object.freeze({
  effect: 'unknown',
  concurrency: 'serial',
});

export function findTool(name: string): Tool | undefined {
  return toolIndex.get(name);
}

/** 缺少声明或找不到工具时返回保守能力，绝不把未知扩展并发执行。 */
export function getToolCapabilities(toolOrName: Tool | string | undefined): ToolCapabilities {
  const tool = typeof toolOrName === 'string' ? findTool(toolOrName) : toolOrName;
  return tool?.capabilities ?? DEFAULT_CAPABILITIES;
}

export function getToolResourceKeys(toolOrName: Tool | string | undefined, args: Record<string, unknown>): string[] {
  const capabilities = getToolCapabilities(toolOrName);
  try {
    return capabilities.resources?.(args) ?? [];
  } catch {
    return [];
  }
}

/** resource-locked write 是可生成文件 diff/按路径记 rollback 的文件 mutation。 */
export function isFileMutationCapabilities(capabilities: ToolCapabilities): boolean {
  return capabilities.effect === 'write' && capabilities.concurrency === 'resource-locked';
}

/** 按工具名判定(兼容入口);热路径请直接复用已解析的 capabilities 走 isFileMutationCapabilities。 */
export function isFileMutationTool(name: string): boolean {
  return isFileMutationCapabilities(getToolCapabilities(name));
}

function isStructuredOutcome(value: ToolExecuteResult): value is ToolOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.status === 'string' &&
    typeof value.code === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.output === 'string'
  );
}

function normalizeOutcome(value: ToolExecuteResult, durationMs: number, changedFiles: string[]): ToolOutcome {
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
  onLockAcquired?: (args: Record<string, unknown>) => void;
  /** 本次调用的 tool_call id,透传给工具 ctx(编排型工具关联渲染用)。 */
  callId?: string;
  /** 产生调用时的 effective allow-list；仅用于子执行面求交和 skill 命令注入门禁。 */
  allowedToolNames?: readonly string[];
  /** 父 agent 委派前缀：编排工具(sub-agent/run_skill)据此让子 agent 复用主上下文命中缓存。 */
  delegation?: {
    history: readonly OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  };
  /** 参数校验失败(INVALID_ARGUMENTS)时追加到报错文案末尾的恢复提示。
   * 由 agent 注入系统已知的候选(如最近 read_file 的 path/hash),
   * 让模型照抄而非凭长上下文记忆复述。仅在参数校验失败时使用。 */
  argumentErrorHint?: string;
}

function isTransientExecutionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: number; code?: string; name?: string; message?: string };
  if (value.name === 'AbortError' || value.name === 'APIUserAbortError') return false;
  if (value.status === 408 || value.status === 429 || (typeof value.status === 'number' && value.status >= 500))
    return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(value.code ?? ''))
    return true;
  return (
    value.name === 'APIConnectionError' ||
    value.name === 'APIConnectionTimeoutError' ||
    (typeof value.message === 'string' && /\btime(?:d)?\s*out\b|ETIMEDOUT/i.test(value.message))
  );
}

function executionErrorOutcome(name: string, error: unknown, startedAt: number, changedFiles: string[]): ToolOutcome {
  const transient = isTransientExecutionError(error);
  const value = error as { code?: string; name?: string } | undefined;
  const timeout =
    transient &&
    (value?.code === 'ETIMEDOUT' ||
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

/** Execute one tool call while holding its declared locks and capturing rollback state. */
async function executeToolOnce(
  tool: Tool,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  opts: ToolExecutionOptions | undefined,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const capabilities = getToolCapabilities(tool);
  let mutationVersionBefore: number | undefined;
  let capturedPath: string | undefined;
  try {
    const requests = resolveResourceLockRequests(capabilities, args);
    return await toolResourceLockManager.withLocks(requests, signal, async () => {
      opts?.onLockAcquired?.(args);
      const mutationBefore = getCurrentTurnMutationState();
      mutationVersionBefore = mutationBefore.version;
      // Transactional tools own their full write-set capture inside ChangeSet commit.
      const pathCapture =
        !capabilities.delegatesResourceLocks &&
        isFileMutationCapabilities(capabilities) &&
        typeof args.path === 'string' &&
        args.path
          ? beginPathMutation(args.path)
          : null;
      capturedPath = pathCapture?.path;
      // 工作区快照是异步的:它遍历整棵工作树,同步实现会在每次 run_command/MCP 调用前后
      // 阻塞事件循环数秒(TUI 完全冻结)。await 让 spinner / 走时 / 键鼠在扫描期间继续工作。
      const workspaceCapture =
        capabilities.effect === 'process' || capabilities.effect === 'unknown' ? await beginWorkspaceMutation() : null;

      let raw: ToolExecuteResult;
      try {
        raw = await tool.execute(args, {
          signal,
          callId: opts?.callId,
          allowedToolNames: opts?.allowedToolNames,
          delegation: opts?.delegation,
        });
      } finally {
        if (pathCapture) endPathMutation(pathCapture, tool.name);
        if (workspaceCapture) await endWorkspaceMutation(workspaceCapture, tool.name);
      }

      const mutationAfter = getCurrentTurnMutationState();
      const changedFiles =
        mutationAfter.version !== mutationBefore.version
          ? pathCapture
            ? mutationAfter.changedFiles.filter((item) => item.path === pathCapture.path).map((item) => item.path)
            : mutationAfter.changedFiles.map((item) => item.path)
          : [];
      if (signal?.aborted) {
        const aborted = terminalOutcome(
          'aborted',
          'ABORTED',
          String(isStructuredOutcome(raw) ? raw.output : raw),
          startedAt,
          changedFiles,
        );
        return isStructuredOutcome(raw) ? { ...aborted, usage: raw.usage } : aborted;
      }
      return normalizeOutcome(raw, Date.now() - startedAt, changedFiles);
    });
  } catch (error) {
    const mutationAfter = getCurrentTurnMutationState();
    const changedFiles =
      mutationVersionBefore !== undefined && mutationAfter.version !== mutationVersionBefore
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
    const hint = opts?.argumentErrorHint?.trim();
    const message = hint
      ? `错误:工具 ${name} 参数无效: ${validation.message}\n${hint}`
      : `错误:工具 ${name} 参数无效: ${validation.message}`;
    return terminalOutcome('error', validation.code, message, startedAt);
  }
  const args = parsed as Record<string, unknown>;
  const sandboxError = enforceSandbox(name, args);
  if (sandboxError) {
    return terminalOutcome('denied', 'SANDBOX_DENIED', sandboxError, startedAt);
  }

  return executeToolOnce(tool, args, signal, opts);
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

export type { Tool, ToolCapabilities, ToolContext, ToolOutcome, ToolExecuteResult } from './types.js';
