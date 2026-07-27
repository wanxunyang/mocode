import { spawn, spawnSync } from 'node:child_process';
import { MAX_OUTPUT } from '../constants.js';
import { getSandboxRoot, filterEnv, isCommandDenied, jailResolve } from '../../sandbox/index.js';
import type { Tool, ToolOutcome } from '../types.js';
import { t } from '../../i18n/index.js';

const OUTPUT_HEAD_LIMIT = Math.floor(MAX_OUTPUT * 0.4);
const OUTPUT_TAIL_LIMIT = MAX_OUTPUT - OUTPUT_HEAD_LIMIT;

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
  timeout = 120000,
  signal?: AbortSignal,
  cwd?: string,
): Promise<RawCommandResult> {
  const startedAt = Date.now();
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
    const child = spawn(
      isWin ? 'cmd.exe' : 'bash',
      isWin ? ['/d', '/s', '/c', command] : ['-c', command],
      {
        cwd: executionCwd,
        env: filterEnv(process.env),
        // Without this, Node re-quotes cmd.exe arguments and `node -e "..."` can become
        // a string literal that exits 0, causing false-positive validation on Windows.
        windowsVerbatimArguments: isWin,
      },
    );
    const output = new BoundedCommandOutput();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const killTree = (): void => {
      try {
        if (isWin) {
          if (child.pid != null) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
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
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done({ ...result, durationMs: Date.now() - startedAt });
    };
    const onAbort = (): void => {
      killTree();
      finish({ status: 'aborted', exitCode: null, output: output.render().trim() });
    };
    const onChunk = (chunk: Buffer): void => output.append(chunk.toString('utf8'));

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
    timer = setTimeout(() => {
      killTree();
      finish({ status: 'timed_out', exitCode: null, output: output.render().trim() });
    }, timeout);
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
    'Run a shell command, merging stdout+stderr. Default timeout 120s. For tests, builds, git, etc.\n' +
    'Multiple independent run_command calls may be issued in one response to save model round-trips; they execute serially, so do not depend one on another\'s output within the same message.',
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute (single line)' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds, default 120000' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = String(args.command);
    const timeout = Number(args.timeout ?? 120000);
    return commandOutcome(await runCommandRaw(command, timeout, ctx?.signal));
  },
};
