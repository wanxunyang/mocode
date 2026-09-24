import type OpenAI from 'openai';
import {
  beginPathMutation as defaultBeginPathMutation,
  beginWorkspaceMutation as defaultBeginWorkspaceMutation,
  endPathMutation as defaultEndPathMutation,
  endWorkspaceMutation as defaultEndWorkspaceMutation,
  getCurrentTurnMutationState as defaultGetCurrentTurnMutationState,
} from '../rollback/index.js';
import { enforceSandbox as defaultEnforceSandbox } from '../sandbox/index.js';
import { t } from '../i18n/index.js';
import {
  resolveResourceLockRequests as defaultResolveResourceLockRequests,
  toolResourceLockManager,
} from './resource-lock.js';
import type { ResourceLockManager } from './resource-lock.js';
import { isToolErrorOutput } from './result.js';
import type { Tool, ToolCapabilities, ToolOutcome, ToolExecuteResult } from './types.js';
import { validateToolArguments } from './validation.js';

const DEFAULT_CAPABILITIES: ToolCapabilities = Object.freeze({
  effect: 'unknown',
  concurrency: 'serial',
});

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

/** Injectable execution services. Defaults preserve the process-global sandbox, rollback, and lock behavior. */
export interface ToolRuntimeDependencies {
  enforceSandbox: typeof defaultEnforceSandbox;
  resolveResourceLockRequests: typeof defaultResolveResourceLockRequests;
  resourceLockManager: Pick<ResourceLockManager, 'withLocks'>;
  beginPathMutation: typeof defaultBeginPathMutation;
  endPathMutation: typeof defaultEndPathMutation;
  beginWorkspaceMutation: typeof defaultBeginWorkspaceMutation;
  endWorkspaceMutation: typeof defaultEndWorkspaceMutation;
  getCurrentTurnMutationState: typeof defaultGetCurrentTurnMutationState;
}

const DEFAULT_DEPENDENCIES: ToolRuntimeDependencies = {
  enforceSandbox: defaultEnforceSandbox,
  resolveResourceLockRequests: defaultResolveResourceLockRequests,
  resourceLockManager: toolResourceLockManager,
  beginPathMutation: defaultBeginPathMutation,
  endPathMutation: defaultEndPathMutation,
  beginWorkspaceMutation: defaultBeginWorkspaceMutation,
  endWorkspaceMutation: defaultEndWorkspaceMutation,
  getCurrentTurnMutationState: defaultGetCurrentTurnMutationState,
};

function buildToolIndex(list: Tool[]): Map<string, Tool> {
  return new Map(list.map((tool) => [tool.name, tool]));
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

/**
 * 幂等工具的瞬时失败自动重试(retryable 契约的唯一消费点)。
 *
 * retryable 字段此前全项目零消费者:工具诚实地标了「这是瞬时失败」,却没人据此行动,
 * 模型只能靠再发一轮 tool call 自救(浪费一个完整 LLM 往返 + 常忘记重试)。
 * 现在 runtime 在**工具显式声明 idempotent** 时自动重发:
 * - 只对 capabilities.idempotent=true 的工具(web_fetch/web_search 这类无副作用 GET)生效;
 *   写/进程类工具永不自动重试 —— 重试语义由工具自己决定(如 edit_file 的 expected_hash 冲突)。
 * - 只重试 status='error' 且 retryable=true 的结果:denied/aborted 是终态,重试无意义。
 * - 退避 400ms/1200ms(最多 2 次):429 的 Retry-After 场景通常秒级窗口就够,
 *   再长会把「工具调用」拖成用户可感知的卡顿;仍失败则把重试次数写进 output,模型可自行决策。
 * - abort 敏感:等待期间用户 Ctrl+C 立即放弃,不空耗退避窗口。
 */
const RETRY_BACKOFF_MS = [400, 1200] as const;

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // onAbort 先声明再被 timer 闭包引用:避免 TDZ 依赖「回调必然异步」这一前提。
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

/** Instance-scoped tool registry and executor. Builtins are installed explicitly to avoid a registry/builtins cycle. */
export class ToolRuntime {
  /** Stable array identity: rebuilds always splice so existing consumers observe registration changes. */
  readonly tools: Tool[] = [];

  private readonly extensions = new Map<string, Tool[]>();
  private installedBuiltinTools: Tool[] = [];
  private toolIndex = buildToolIndex(this.tools);
  private readonly dependencies: ToolRuntimeDependencies;

  constructor(dependencies: Partial<ToolRuntimeDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  /** The currently installed builtin list, retained by reference for compatibility with the global registry. */
  get builtinTools(): readonly Tool[] {
    return this.installedBuiltinTools;
  }

  installBuiltinTools(list: Tool[]): void {
    this.installedBuiltinTools = list;
    this.rebuildTools();
  }

  registerToolsExtension(source: string, additions: Tool[]): string[];
  /** 向后兼容：未命名扩展使用 external 槽位。 */
  registerToolsExtension(additions: Tool[]): string[];
  registerToolsExtension(sourceOrAdditions: string | Tool[], maybeAdditions?: Tool[]): string[] {
    const source = typeof sourceOrAdditions === 'string' ? sourceOrAdditions : 'external';
    const additions = typeof sourceOrAdditions === 'string' ? (maybeAdditions ?? []) : sourceOrAdditions;
    this.extensions.set(source, additions);
    const rejected = additions
      .filter((tool) => this.installedBuiltinTools.some((builtin) => builtin.name === tool.name))
      .map((tool) => tool.name);
    this.rebuildTools();
    return rejected;
  }

  clearToolsExtension(source: string): void {
    if (this.extensions.delete(source)) this.rebuildTools();
  }

  findTool(name: string): Tool | undefined {
    return this.toolIndex.get(name);
  }

  /** 缺少声明或找不到工具时返回保守能力，绝不把未知扩展并发执行。 */
  getToolCapabilities(toolOrName: Tool | string | undefined): ToolCapabilities {
    const tool = typeof toolOrName === 'string' ? this.findTool(toolOrName) : toolOrName;
    return tool?.capabilities ?? DEFAULT_CAPABILITIES;
  }

  getToolResourceKeys(toolOrName: Tool | string | undefined, args: Record<string, unknown>): string[] {
    const capabilities = this.getToolCapabilities(toolOrName);
    try {
      return capabilities.resources?.(args) ?? [];
    } catch {
      return [];
    }
  }

  /** resource-locked write 是可生成文件 diff/按路径记 rollback 的文件 mutation。 */
  isFileMutationCapabilities(capabilities: ToolCapabilities): boolean {
    return capabilities.effect === 'write' && capabilities.concurrency === 'resource-locked';
  }

  /** 按工具名判定(兼容入口);热路径请直接复用已解析的 capabilities。 */
  isFileMutationTool(name: string): boolean {
    return this.isFileMutationCapabilities(this.getToolCapabilities(name));
  }

  /** 结构化工具调度入口。永不抛错；旧字符串工具在此归一化为 ToolOutcome。 */
  async executeToolOutcome(
    name: string,
    argsRaw: string,
    signal?: AbortSignal,
    opts?: ToolExecutionOptions,
  ): Promise<ToolOutcome> {
    const startedAt = Date.now();
    if (signal?.aborted) {
      return terminalOutcome('aborted', 'ABORTED', t('command.interrupted'), startedAt);
    }

    const tool = this.findTool(name);
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
    try {
      const sandboxError = this.dependencies.enforceSandbox(name, args);
      if (sandboxError) {
        return terminalOutcome('denied', 'SANDBOX_DENIED', sandboxError, startedAt);
      }
      return await this.executeToolWithRetry(tool, args, signal, opts);
    } catch (error) {
      return executionErrorOutcome(name, error, startedAt, []);
    }
  }

  /**
   * 幂等工具的自动重试外壳:非幂等工具直接执行一次(与旧行为逐字节一致,零开销)。
   * 只有 capabilities.idempotent=true 且结果 status='error' + retryable=true 才重发。
   */
  private async executeToolWithRetry(
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    opts: ToolExecutionOptions | undefined,
  ): Promise<ToolOutcome> {
    const capabilities = this.getToolCapabilities(tool);
    if (!capabilities.idempotent) return this.executeToolOnce(tool, args, signal, opts);

    let outcome = await this.executeToolOnce(tool, args, signal, opts);
    for (const backoff of RETRY_BACKOFF_MS) {
      // 只对瞬时 error 重试;denied/aborted/success 都是终态。abort 后立即停,不空耗退避。
      if (outcome.status !== 'error' || !outcome.retryable || signal?.aborted) break;
      // TIMEOUT 不自动重试:一次超时已经烧掉整个超时窗口(web_fetch 是 30s),再试两次最坏
      // 让单次工具调用变成 90s —— 用户看到的是 spinner 长时间冻住。超时通常是目标主机真的慢,
      // 重试收益低、体感代价高。retryable 标记仍保留,模型可自行判断是否再发一轮。
      if (outcome.code === 'TIMEOUT') break;
      await sleepWithSignal(backoff, signal);
      if (signal?.aborted) break;
      outcome = await this.executeToolOnce(tool, args, signal, opts);
    }
    // 重试用尽仍失败:把尝试次数写进 output,让模型知道「已经自动重试过了,别再无脑重发」。
    // TIMEOUT 走的是「未自动重试」路径,不能谎称重试过。
    if (outcome.status === 'error' && outcome.retryable && outcome.code !== 'TIMEOUT') {
      outcome = { ...outcome, output: `${outcome.output}\n(runtime 已自动重试 ${RETRY_BACKOFF_MS.length} 次仍失败)` };
    }
    return outcome;
  }

  /** 字符串兼容入口：现有调用方、TUI 和 LLM history 无需同步迁移。 */
  async executeTool(name: string, argsRaw: string, signal?: AbortSignal, opts?: ToolExecutionOptions): Promise<string> {
    return (await this.executeToolOutcome(name, argsRaw, signal, opts)).output;
  }

  private rebuildTools(): void {
    const names = new Set<string>();
    const next: Tool[] = [];
    for (const tool of [...this.installedBuiltinTools, ...Array.from(this.extensions.values()).flat()]) {
      if (names.has(tool.name)) continue;
      names.add(tool.name);
      next.push(tool);
    }
    this.tools.splice(0, this.tools.length, ...next);
    this.toolIndex = buildToolIndex(next);
  }

  /** Execute one tool call while holding its declared locks and capturing rollback state. */
  private async executeToolOnce(
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    opts: ToolExecutionOptions | undefined,
  ): Promise<ToolOutcome> {
    const startedAt = Date.now();
    const capabilities = this.getToolCapabilities(tool);
    let mutationVersionBefore: number | undefined;
    let capturedPath: string | undefined;
    try {
      const requests = this.dependencies.resolveResourceLockRequests(capabilities, args);
      return await this.dependencies.resourceLockManager.withLocks(requests, signal, async () => {
        opts?.onLockAcquired?.(args);
        const mutationBefore = this.dependencies.getCurrentTurnMutationState();
        mutationVersionBefore = mutationBefore.version;
        const pathCapture =
          !capabilities.delegatesResourceLocks &&
          this.isFileMutationCapabilities(capabilities) &&
          typeof args.path === 'string' &&
          args.path
            ? this.dependencies.beginPathMutation(args.path)
            : null;
        capturedPath = pathCapture?.path;
        const workspaceCapture =
          capabilities.effect === 'process' || capabilities.effect === 'unknown'
            ? await this.dependencies.beginWorkspaceMutation()
            : null;

        let raw: ToolExecuteResult;
        try {
          raw = await tool.execute(args, {
            signal,
            callId: opts?.callId,
            allowedToolNames: opts?.allowedToolNames,
            delegation: opts?.delegation,
          });
        } finally {
          if (pathCapture) this.dependencies.endPathMutation(pathCapture, tool.name);
          if (workspaceCapture) await this.dependencies.endWorkspaceMutation(workspaceCapture, tool.name);
        }

        const mutationAfter = this.dependencies.getCurrentTurnMutationState();
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
      const mutationAfter = this.dependencies.getCurrentTurnMutationState();
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
}
