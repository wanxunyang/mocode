import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostCommand, HostEnvelope } from '@mocode/protocol/host';
export type { HostAttachment, HostCommand, HostEnvelope } from '@mocode/protocol/host';

export interface HostLaunchSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  hostPath: string;
  usesElectronNode: boolean;
}

export interface MocodeHostLaunchOptions {
  hostPath?: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface HostStartOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface HostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface AgentHostClientOptions {
  startupTimeoutMs?: number;
}

type Listener<T> = (value: T) => void | Promise<void>;

type ReadyState = {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  promise: Promise<void>;
};

type MocodePackageManifest = {
  name?: string;
  bin?: string | Record<string, string>;
};

const require = createRequire(import.meta.url);
const runtimeModuleDirectory = path.dirname(fileURLToPath(import.meta.url));

function executableWorks(executable: string): boolean {
  try {
    const version = execFileSync(executable, ['-v'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4_000,
      windowsHide: true,
    }).trim();
    const major = /^v(\d+)\./.exec(version)?.[1];
    return major !== undefined && Number(major) >= 18;
  } catch {
    return false;
  }
}

function resolveNodeExecutable(explicit?: string): { command: string; usesElectronNode: boolean } {
  const candidates = [explicit, process.env.MOCODE_HOST_NODE, 'node'].filter((value): value is string =>
    Boolean(value),
  );
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\nodejs\\node.exe', 'D:\\nodejs\\node.exe');
    candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node.exe'));
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }
  for (const candidate of candidates) {
    if (candidate !== 'node' && !existsSync(candidate)) continue;
    if (executableWorks(candidate)) return { command: candidate, usesElectronNode: false };
  }
  return { command: process.execPath, usesElectronNode: true };
}

function readPackageManifest(manifestPath: string): MocodePackageManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as MocodePackageManifest;
  } catch {
    return null;
  }
}

function hostFromManifest(manifestPath: string): string | null {
  const manifest = readPackageManifest(manifestPath);
  if (manifest?.name !== 'mocode-ai') return null;
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['mocode-agent-host'];
  if (!relative) return null;
  const candidate = path.resolve(path.dirname(manifestPath), relative);
  return existsSync(candidate) ? candidate : null;
}

function findSourceWorkspaceHost(): string | null {
  let current = runtimeModuleDirectory;
  while (true) {
    const runtimeManifest = readPackageManifest(path.join(current, 'packages', 'runtime', 'package.json'));
    if (runtimeManifest?.name === '@mocode/runtime') {
      const found = hostFromManifest(path.join(current, 'package.json'));
      if (found) return found;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveHostPath(options: MocodeHostLaunchOptions): string {
  const explicit = options.hostPath ?? options.env?.MOCODE_HOST_PATH ?? process.env.MOCODE_HOST_PATH;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`Mocode Agent Host does not exist: ${resolved}`);
    return resolved;
  }
  try {
    const installed = require.resolve('mocode-ai/bin/mocode-agent-host.js');
    if (existsSync(installed)) return installed;
  } catch {
    // Source workspaces use the package manifest fallback below.
  }
  const workspace = findSourceWorkspaceHost();
  if (workspace) return workspace;
  throw new Error(
    'Cannot locate mocode-agent-host. Install mocode-ai or set MOCODE_HOST_PATH to its public bin entry.',
  );
}

/** Resolve the public mocode-ai host bin without depending on src/ or dist/ layout. */
export function resolveMocodeHostLaunchSpec(options: MocodeHostLaunchOptions = {}): HostLaunchSpec {
  const hostPath = resolveHostPath(options);
  const node = resolveNodeExecutable(options.nodePath);
  const env: NodeJS.ProcessEnv = { ...options.env };
  if (node.usesElectronNode) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    command: node.command,
    args: [hostPath],
    env,
    hostPath,
    usesElectronNode: node.usesElectronNode,
  };
}

/**
 * Process and NDJSON lifecycle client for the public mocode-agent-host entry.
 * Applications own restart policy; this class owns one child and its stream framing.
 */
export class AgentHostClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyState: ReadyState | null = null;
  private generation = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly expectedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly eventListeners = new Set<Listener<HostEnvelope>>();
  private readonly diagnosticListeners = new Set<Listener<string>>();
  private readonly exitListeners = new Set<Listener<HostExit>>();
  private readonly startupTimeoutMs: number;

  constructor(options: AgentHostClientOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  onEvent(listener: Listener<HostEnvelope>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDiagnostic(listener: Listener<string>): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  onExit(listener: Listener<HostExit>): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  start(spec: HostLaunchSpec, options: HostStartOptions): Promise<void> {
    const generation = ++this.generation;
    this.interruptCurrentChild();
    return this.enqueue(() => this.startChild(generation, spec, options));
  }

  private async startChild(generation: number, spec: HostLaunchSpec, options: HostStartOptions): Promise<void> {
    if (generation !== this.generation) return;
    await this.stopCurrentChild();
    if (generation !== this.generation) return;

    let buffer = '';
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: { ...process.env, ...spec.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    let settleReady!: () => void;
    let rejectReady!: (cause: Error) => void;
    let settled = false;
    const finishReady = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleReady();
    };
    const failReady = (cause: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(cause);
    };
    const readyPromise = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      rejectReady = reject;
    });
    this.readyState = { generation, child, promise: readyPromise };
    const timeoutMs = options.startupTimeoutMs ?? this.startupTimeoutMs;
    const timer = setTimeout(
      () => failReady(new Error(`Mocode Agent Host did not become ready within ${timeoutMs}ms.`)),
      timeoutMs,
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer = this.read(buffer, chunk, finishReady);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.emit(this.diagnosticListeners, chunk));
    child.once('error', (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failReady(error);
      this.emit(this.diagnosticListeners, error.message);
    });
    child.once('exit', (code, signal) => {
      const expected = this.expectedChildren.has(child);
      if (this.child === child) {
        this.child = null;
        this.readyState = null;
      }
      failReady(new Error(`Mocode Agent Host exited before readiness (code ${code ?? 'null'}).`));
      this.emit(this.exitListeners, { code, signal, expected });
    });

    try {
      await readyPromise;
    } catch (cause) {
      await this.stopChild(child);
      if (generation !== this.generation) return;
      throw cause;
    }
  }

  async waitReady(): Promise<void> {
    await this.getReadyState();
  }

  async send(command: HostCommand): Promise<void> {
    const state = this.readyState;
    if (!state) throw new Error('Mocode Agent Host has not been started.');
    await state.promise;
    this.assertReadyState(state);
    if (!state.child.stdin.writable) throw new Error('Mocode Agent Host is not writable.');
    await new Promise<void>((resolve, reject) => {
      state.child.stdin.write(`${JSON.stringify(command)}\n`, (cause) => (cause ? reject(cause) : resolve()));
    });
  }

  private async getReadyState(): Promise<ReadyState> {
    const state = this.readyState;
    if (!state) throw new Error('Mocode Agent Host has not been started.');
    await state.promise;
    this.assertReadyState(state);
    return state;
  }

  private assertReadyState(state: ReadyState): void {
    if (
      this.readyState !== state ||
      this.child !== state.child ||
      this.generation !== state.generation ||
      state.child.exitCode !== null
    ) {
      throw new Error('Mocode Agent Host was replaced before the command could be sent.');
    }
  }

  stop(): Promise<void> {
    this.generation += 1;
    this.interruptCurrentChild();
    return this.enqueue(() => this.stopCurrentChild());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }

  private interruptCurrentChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    this.expectedChildren.add(child);
    try {
      child.kill();
    } catch (cause) {
      this.emit(this.diagnosticListeners, cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async stopCurrentChild(): Promise<void> {
    const child = this.child;
    if (child) await this.stopChild(child);
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.expectedChildren.add(child);
    if (child.exitCode === null && child.pid !== undefined) {
      let finish!: () => void;
      const exited = new Promise<void>((resolve) => {
        finish = (): void => {
          child.off('exit', finish);
          child.off('close', finish);
          child.off('error', finish);
          resolve();
        };
        child.once('exit', finish);
        child.once('close', finish);
        child.once('error', finish);
      });
      if (!child.killed && !child.kill()) {
        child.off('exit', finish);
        child.off('close', finish);
        child.off('error', finish);
        throw new Error(`Unable to stop Mocode Agent Host process ${child.pid}.`);
      }
      await exited;
    }
    if (this.child === child) {
      this.child = null;
      this.readyState = null;
    }
  }

  private read(buffer: string, chunk: string, ready: () => void): string {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const envelope = JSON.parse(line) as HostEnvelope;
          this.emit(this.eventListeners, envelope);
          if (envelope.type === 'event' && envelope.event === 'runtime_ready') ready();
        } catch {
          this.emit(this.diagnosticListeners, `Mocode Agent Host emitted invalid NDJSON: ${line}`);
        }
      }
      newline = buffer.indexOf('\n');
    }
    return buffer;
  }

  private emit<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of listeners) {
      try {
        const result = listener(value);
        if (result) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // Observers cannot change process lifecycle.
      }
    }
  }
}
