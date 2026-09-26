import { spawn, spawnSync } from 'node:child_process';
import { MAX_OUTPUT } from '../constants.js';
import { getSandboxRoot, filterEnv, isCommandDenied, jailResolve } from '../../sandbox/index.js';
import type { Tool, ToolOutcome } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  shellParamDescription,
  defaultShellKind,
  parseShellKind,
  shellSpawnSpec,
  type ShellKind,
} from '../../runtime/shell.js';

const OUTPUT_HEAD_LIMIT = Math.floor(MAX_OUTPUT * 0.4);
const OUTPUT_TAIL_LIMIT = MAX_OUTPUT - OUTPUT_HEAD_LIMIT;

/**
 * 前台命令的超时窗口钳制。
 *
 * 下界 1s:防模型传 0/负数把 timer 变成「立即超时」,命令还没 spawn 就被判 timed_out。
 * 上界 10min:run_command 声明 concurrency:'serial' + resources:['workspace']
 * (builtins/index.ts:54),执行期间持有全局 workspace 锁 —— 一条超时 1 小时的命令会把
 * 所有其它工具调用(含子 agent)一起挂死,且 TUI 只能等或 Ctrl+C。需要长驻的进程走
 * dev_server(跨调用存活 + 日志增量读 + 树杀),不是把前台超时拉长。
 */
export const MIN_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** 把模型给的 timeout 钳进 [MIN, MAX];非有限数(NaN/Infinity/非法字符串)回落默认值。 */
export function clampCommandTimeout(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_COMMAND_TIMEOUT_MS), MAX_COMMAND_TIMEOUT_MS);
}

/** 有界采集：短输出逐字保留；超限后保留 head+tail，避免构建/测试错误只出现在尾部时被丢弃。 */
class BoundedCommandOutput {
  private head = '';
  private tail = '';
  private total = 0;

  append(text: string): void {
    this.total += text.length;
    const headRoom = OUTPUT_HEAD_LIMIT - this.head.length;
    const headPart = headRoom > 0 ? text.slice(0, headRoom) : '';
    this.head += headPart;
    const rest = text.slice(headPart.length);
    if (rest) this.tail = (this.tail + rest).slice(-OUTPUT_TAIL_LIMIT);
  }

  render(): string {
    if (this.total <= MAX_OUTPUT) return this.head + this.tail;
    const removed = this.total - MAX_OUTPUT;
    return `${this.head}\n${t('command.outputTruncated', { count: removed })}\n${this.tail}`;
  }
}

export interface RawCommandResult {
  status: 'passed' | 'failed' | 'timed_out' | 'aborted' | 'spawn_error' | 'denied';
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/** Execute a command with the same sandbox, output cap and cancellation semantics as run_command. */
export async function runCommandRaw(
  command: string,
  timeout = DEFAULT_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
  cwd?: string,
  shell?: ShellKind,
): Promise<RawCommandResult> {
  const startedAt = Date.now();
  // 内部调用方(skill 注入等)也走同一钳制:防止任何路径把前台命令挂成无限期持锁。
  const effectiveTimeout = clampCommandTimeout(timeout);
  const deny = isCommandDenied(command);
  if (deny) {
    return { status: 'denied', exitCode: null, output: `错误:${deny}`, durationMs: 0 };
  }

  let executionCwd = getSandboxRoot() ?? process.cwd();
  if (cwd) {
    try {
      executionCwd = jailResolve(cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'denied', exitCode: null, output: `错误:${message}`, durationMs: 0 };
    }
  }

  return new Promise<RawCommandResult>((done) => {
    const isWin = process.platform === 'win32';
    const spec = shellSpawnSpec(shell ?? defaultShellKind(), command);
    const child = spawn(spec.file, spec.args, {
      cwd: executionCwd,
      env: filterEnv(process.env),
      // cmd.exe 需要 verbatim:否则 Node 重新引号化参数,`node -e "..."` 会退化成
      // 字符串字面量并 exit 0,造成 Windows 上的假阳性验证。其它 shell 必须关。
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      windowsHide: true,
    });
    const output = new BoundedCommandOutput();
    let finished = false;

    const killTree = (): void => {
      try {
        if (isWin) {
          if (child.pid != null) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          }
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Process already exited or best-effort termination failed.
      }
    };
    const finish = (result: Omit<RawCommandResult, 'durationMs'>): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done({ ...result, durationMs: Date.now() - startedAt });
    };
    const onAbort = (): void => {
      killTree();
      finish({ status: 'aborted', exitCode: null, output: output.render().trim() });
    };
    const onChunk = (chunk: Buffer): void => output.append(chunk.toString('utf8'));

    // 先起 timer 再挂事件:finish/onAbort 是闭包,里面要 clearTimeout(timer)。
    // 把 timer 的初始化提到所有引用它的注册点之前,避免依赖"事件回调必然异步"这一前提。
    const timer = setTimeout(() => {
      killTree();
      finish({ status: 'timed_out', exitCode: null, output: output.render().trim() });
    }, effectiveTimeout);

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (error) => {
      finish({ status: 'spawn_error', exitCode: null, output: error.message });
    });
    child.on('close', (code) => {
      finish({
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        output: output.render().trim(),
      });
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Preserve the public run_command text protocol while exposing structured status internally. */
export function formatCommandResult(result: RawCommandResult): string {
  const output = result.output.trim();
  if (result.status === 'denied') return result.output;
  if (result.status === 'aborted') return `${t('command.interrupted')}\n${output}`;
  if (result.status === 'timed_out') return `${t('command.timedOut')}\n${output}`;
  if (result.status === 'spawn_error') return t('command.executionFailed', { message: result.output });
  return `${t('command.exitCode', { code: result.exitCode ?? 'null' })}\n${output || t('toolSummary.noOutput')}`;
}

/** Convert the raw process status into the common structured tool contract. */
function commandOutcome(result: RawCommandResult): ToolOutcome {
  const output = formatCommandResult(result);
  switch (result.status) {
    case 'passed':
      return { status: 'success', code: 'OK', retryable: false, output, durationMs: result.durationMs };
    case 'aborted':
      return { status: 'aborted', code: 'ABORTED', retryable: false, output, durationMs: result.durationMs };
    case 'denied':
      return { status: 'denied', code: 'SANDBOX_DENIED', retryable: false, output, durationMs: result.durationMs };
    case 'timed_out':
      return { status: 'error', code: 'TIMEOUT', retryable: false, output, durationMs: result.durationMs };
    case 'failed':
      return { status: 'error', code: 'PROCESS_FAILED', retryable: false, output, durationMs: result.durationMs };
    case 'spawn_error':
      return { status: 'error', code: 'EXECUTION_ERROR', retryable: false, output, durationMs: result.durationMs };
  }
}

// ---------- run_command ----------
export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a FOREGROUND shell command, merging stdout+stderr. Default timeout 120s, hard cap 10min; pass shell=cmd|powershell|bash to pick the interpreter (platform default and MOCODE_SHELL override are stated in the system prompt). Non-interactive cmd cannot run `timeout /t` — use shell=powershell (`Start-Sleep`) or shell=bash (`sleep`) for waits.\n' +
    'Anything that must keep running after this call returns — dev server, model service, watcher, log tail — belongs to dev_server (survives across calls; gives an id for incremental logs and process-tree kill). Do NOT detach via `start /b`, `nohup`, `&`: you lose both the logs and the handle.\n' +
    "Multiple independent calls may be issued in one response (they run serially, in order); do not depend one on another's output within the same message.",
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute (single line)' },
      timeout: {
        type: 'integer',
        description: `Timeout in milliseconds (default ${DEFAULT_COMMAND_TIMEOUT_MS}, clamped to ${MIN_COMMAND_TIMEOUT_MS}..${MAX_COMMAND_TIMEOUT_MS}). Raise it only for genuinely slow foreground work; use dev_server for long-running processes.`,
      },
      shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'], description: shellParamDescription() },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = String(args.command);
    const timeout = clampCommandTimeout(args.timeout);
    // shell 非法值不静默忽略:明确报错,否则模型以为在 powershell 里跑却落到 cmd,
    // 语法错误难以归因。合法值大小写/别名由 parseShellKind 归一。
    let shell: ShellKind | undefined;
    if (args.shell !== undefined) {
      const parsed = parseShellKind(args.shell);
      if (!parsed) {
        return {
          status: 'error',
          code: 'INVALID_ARGUMENTS',
          retryable: false,
          output: `错误:无效的 shell "${String(args.shell)}"。可选值:cmd / powershell / bash。`,
        };
      }
      shell = parsed;
    }
    const result = await runCommandRaw(command, timeout, ctx?.signal, undefined, shell);
    const outcome = commandOutcome(result);
    // 钳制要显式告知:模型传了 30min 却按 10min 判超时,不说清它会以为是环境抽风而盲目重试。
    if (args.timeout !== undefined && Number(args.timeout) !== timeout && result.status === 'timed_out') {
      outcome.output = `${outcome.output}\n(请求的 timeout=${Number(args.timeout)}ms 已钳制到 ${timeout}ms;需要长驻进程请改用 dev_server)`;
    }
    return outcome;
  },
};
