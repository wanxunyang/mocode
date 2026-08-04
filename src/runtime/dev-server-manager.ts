// 常驻后台进程管理器(dev server 等)。
//
// 与 run_command 的关键区别:run_command 是前台命令,超时或本轮 abort 即 killTree;
// 这里的进程必须**跨工具调用存活**,所以生命周期只由显式 stop 或进程退出 / 全局 shutdown 决定。
// 传入的 signal 只用于取消「启动 + 就绪等待」,绝不用于杀已就绪的服务 —— 否则用户下一次
// Ctrl+C 会顺手把 dev server 干掉。
//
// 非安全边界:命令仍是任意 shell 命令(与 run_command 同级风险),故工具层声明 dangerous 风险,
// 由权限系统在执行前向用户确认。

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { filterEnv, getSandboxRoot, isCommandDenied, jailResolve } from '../sandbox/index.js';

export type DevServerState = 'running' | 'exited' | 'stopped';
export type DevServerErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'SANDBOX_DENIED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'PROCESS_FAILED'
  | 'EXECUTION_ERROR';

export class DevServerManagerError extends Error {
  constructor(public readonly code: DevServerErrorCode, message: string) {
    super(message);
    this.name = 'DevServerManagerError';
  }
}

export interface StartDevServerOptions {
  command: string;
  cwd?: string;
  readyUrl?: string;
  readyPattern?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DevServerSnapshot {
  id: string;
  pid: number;
  state: DevServerState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: string;
}

export interface StartDevServerResult extends DevServerSnapshot {
  ready: boolean;
  readyUrl?: string;
  readyPattern?: string;
  logTail?: string;
}

export interface ReadDevServerLogsResult {
  id: string;
  state: DevServerState;
  offset: number;
  nextOffset: number;
  size: number;
  hasMore: boolean;
  content: string;
}

export interface StopDevServerResult extends DevServerSnapshot {
  alreadyStopped: boolean;
}

interface DevServerRecord extends DevServerSnapshot {
  child: ChildProcess;
  logFd: number | null;
  stopRequested: boolean;
  recentLog: string;
}

const servers = new Map<string, DevServerRecord>();

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 180_000;
const READY_POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;
const STOP_GRACE_MS = 1_500;
const DEFAULT_LOG_BYTES = 8_000;
const MAX_LOG_BYTES = 64_000;
const RECENT_LOG_CHARS = 4_000;
const IS_WINDOWS = process.platform === 'win32';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 进程是否仍存活;EPERM 说明 pid 存在但不属于当前用户。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function snapshot(record: DevServerRecord): DevServerSnapshot {
  return {
    id: record.id,
    pid: record.pid,
    state: record.state,
    exitCode: record.exitCode,
    signal: record.signal,
    command: record.command,
    cwd: record.cwd,
    logPath: record.logPath,
    startedAt: record.startedAt,
  };
}

function requireRecord(id: string): DevServerRecord {
  const record = servers.get(id);
  if (!record) {
    const known = [...servers.keys()];
    throw new DevServerManagerError(
      'INVALID_ARGUMENTS',
      known.length
        ? `Unknown dev server id "${id}". Known ids: ${known.join(', ')}.`
        : `Unknown dev server id "${id}". No dev server has been started in this session.`,
    );
  }
  return record;
}

/** 只允许回环地址:防止 agent 借就绪探测去扫内网 / 打外网。 */
function validateReadyUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DevServerManagerError('INVALID_ARGUMENTS', `Invalid readyUrl: ${input}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DevServerManagerError('INVALID_ARGUMENTS', 'readyUrl must use http or https.');
  }
  if (!loopback || url.username || url.password) {
    throw new DevServerManagerError(
      'INVALID_ARGUMENTS',
      'readyUrl must target localhost, 127.0.0.1, or ::1 without credentials.',
    );
  }
  return url;
}

function compileReadyPattern(input: string): RegExp {
  try {
    return new RegExp(input, 'i');
  } catch (error) {
    throw new DevServerManagerError('INVALID_ARGUMENTS', `Invalid readyPattern: ${errorMessage(error)}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DevServerManagerError('ABORTED', 'Dev server startup wait was aborted.'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** 任意 HTTP 响应都算就绪:dev server 常在 / 返回 404 但端口已可用。 */
async function probeReady(url: URL): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function killTree(pid: number): void {
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // 已退出或无权限:best-effort。
  }
}

function finalizeExit(record: DevServerRecord, code: number | null, signalCode: NodeJS.Signals | null): void {
  record.state = record.stopRequested ? 'stopped' : 'exited';
  record.exitCode = code;
  record.signal = signalCode;
  if (record.logFd !== null) {
    try {
      closeSync(record.logFd);
    } catch {
      // 忽略:进程收尾期文件句柄可能已失效。
    }
    record.logFd = null;
  }
}

/** 进程可能在事件回调之外被外部杀掉,读状态时顺带对账。 */
function reconcile(record: DevServerRecord): DevServerRecord {
  if (record.state === 'running' && !isAlive(record.pid)) {
    finalizeExit(record, record.child.exitCode, record.child.signalCode);
  }
  return record;
}

export async function startDevServer(opts: StartDevServerOptions): Promise<StartDevServerResult> {
  const command = opts.command.trim();
  if (!command) {
    throw new DevServerManagerError('INVALID_ARGUMENTS', 'command is required to start a dev server.');
  }
  const denied = isCommandDenied(command);
  if (denied) {
    throw new DevServerManagerError('SANDBOX_DENIED', denied);
  }

  const root = getSandboxRoot() ?? process.cwd();
  let cwd = root;
  if (opts.cwd) {
    try {
      cwd = jailResolve(opts.cwd);
    } catch (error) {
      throw new DevServerManagerError('SANDBOX_DENIED', errorMessage(error));
    }
  }

  const readyUrl = opts.readyUrl ? validateReadyUrl(opts.readyUrl) : null;
  const readyPattern = opts.readyPattern ? compileReadyPattern(opts.readyPattern) : null;
  const timeoutMs = Math.min(
    Math.max(Number(opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS), 1_000),
    MAX_READY_TIMEOUT_MS,
  );

  const id = `srv-${randomBytes(3).toString('hex')}`;
  const logPath = jailResolve(join('.mocode', 'dev-servers', `${id}.log`));
  await mkdir(dirname(logPath), { recursive: true });

  let logFd: number;
  try {
    logFd = openSync(logPath, 'a');
  } catch (error) {
    throw new DevServerManagerError('EXECUTION_ERROR', `Unable to open log file: ${errorMessage(error)}`);
  }

  let child: ChildProcess;
  try {
    child = spawn(
      IS_WINDOWS ? 'cmd.exe' : 'bash',
      IS_WINDOWS ? ['/d', '/s', '/c', command] : ['-c', command],
      {
        cwd,
        env: filterEnv(process.env),
        windowsVerbatimArguments: IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    closeSync(logFd);
    throw new DevServerManagerError('EXECUTION_ERROR', `Unable to spawn dev server: ${errorMessage(error)}`);
  }

  if (child.pid === undefined) {
    closeSync(logFd);
    throw new DevServerManagerError('EXECUTION_ERROR', 'Dev server process did not report a pid.');
  }

  const record: DevServerRecord = {
    id,
    pid: child.pid,
    state: 'running',
    exitCode: null,
    signal: null,
    command,
    cwd,
    logPath,
    startedAt: new Date().toISOString(),
    child,
    logFd,
    stopRequested: false,
    recentLog: '',
  };
  servers.set(id, record);

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    record.recentLog = (record.recentLog + text).slice(-RECENT_LOG_CHARS);
    if (record.logFd === null) return;
    try {
      writeSync(record.logFd, text);
    } catch {
      // 日志写失败不影响进程本身。
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', (error) => onChunk(Buffer.from(`\n[spawn error] ${error.message}\n`)));
  child.on('close', (code, signalCode) => finalizeExit(record, code, signalCode));

  const deadline = Date.now() + timeoutMs;
  const wantsReadySignal = Boolean(readyUrl || readyPattern);
  let ready = false;

  try {
    while (wantsReadySignal && Date.now() < deadline) {
      if (record.state !== 'running') {
        throw new DevServerManagerError(
          'PROCESS_FAILED',
          `Dev server exited before becoming ready (exitCode=${record.exitCode ?? 'null'}). Recent output:\n${record.recentLog.trim() || '(no output)'}`,
        );
      }
      if (readyPattern?.test(record.recentLog)) {
        ready = true;
        break;
      }
      if (readyUrl && await probeReady(readyUrl)) {
        ready = true;
        break;
      }
      await sleep(READY_POLL_INTERVAL_MS, opts.signal);
    }
  } catch (error) {
    // 启动失败 / 被中断:不留孤儿进程。
    record.stopRequested = true;
    killTree(record.pid);
    finalizeExit(record, record.child.exitCode, record.child.signalCode);
    throw error;
  }

  if (wantsReadySignal && !ready) {
    record.stopRequested = true;
    killTree(record.pid);
    finalizeExit(record, record.child.exitCode, record.child.signalCode);
    throw new DevServerManagerError(
      'TIMEOUT',
      `Dev server did not become ready within ${timeoutMs}ms and was stopped. Recent output:\n${record.recentLog.trim() || '(no output)'}`,
    );
  }

  return {
    ...snapshot(reconcile(record)),
    ready,
    ...(opts.readyUrl ? { readyUrl: opts.readyUrl } : {}),
    ...(opts.readyPattern ? { readyPattern: opts.readyPattern } : {}),
    ...(record.recentLog.trim() ? { logTail: record.recentLog.trim().slice(-1_000) } : {}),
  };
}

export function listDevServers(): DevServerSnapshot[] {
  return [...servers.values()].map((record) => snapshot(reconcile(record)));
}

export function getDevServerStatus(id?: string): DevServerSnapshot[] {
  if (!id) return listDevServers();
  return [snapshot(reconcile(requireRecord(id)))];
}

export async function readDevServerLogs(
  id: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<ReadDevServerLogsResult> {
  const record = reconcile(requireRecord(id));
  const size = (await stat(record.logPath).catch(() => null))?.size ?? 0;
  const limit = Math.min(Math.max(Number(opts.limit ?? DEFAULT_LOG_BYTES), 1), MAX_LOG_BYTES);
  // 缺省读尾部(最新输出);显式 offset 支持增量轮询。
  const requested = opts.offset === undefined ? Math.max(0, size - limit) : Math.max(0, Number(opts.offset));
  const start = Math.min(requested, size);
  const length = Math.min(limit, size - start);

  let content = '';
  if (length > 0) {
    const handle = await open(record.logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      content = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  return {
    id: record.id,
    state: record.state,
    offset: start,
    nextOffset: start + length,
    size,
    hasMore: start + length < size,
    content,
  };
}

export async function stopDevServer(id: string): Promise<StopDevServerResult> {
  const record = reconcile(requireRecord(id));
  if (record.state !== 'running') {
    return { ...snapshot(record), alreadyStopped: true };
  }

  record.stopRequested = true;
  killTree(record.pid);

  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && isAlive(record.pid)) {
    await sleep(50);
  }
  if (isAlive(record.pid) && !IS_WINDOWS) {
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      // 已退出。
    }
  }
  finalizeExit(record, record.child.exitCode, record.child.signalCode);
  return { ...snapshot(record), alreadyStopped: false };
}

/** 全局退出清理:同步树杀所有仍存活的后台进程。可重复调用。 */
export function stopAllDevServersSync(): void {
  for (const record of servers.values()) {
    if (record.state !== 'running') continue;
    record.stopRequested = true;
    killTree(record.pid);
    finalizeExit(record, record.child.exitCode, record.child.signalCode);
  }
}
