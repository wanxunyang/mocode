import { spawn, type ChildProcess } from 'node:child_process';
import type { McpRemoteServerSpec, McpServerSpec, McpToolDefinition, McpToolResult } from './types.js';

const PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};
type SseEvent = { event: string; data: string };

abstract class McpTransport {
  constructor(protected readonly receive: (message: unknown) => void) {}
  abstract start(): Promise<void>;
  abstract send(message: JsonObject): Promise<void>;
  abstract close(): Promise<void>;
}

class StdioTransport extends McpTransport {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);

  constructor(
    receive: (message: unknown) => void,
    private readonly spec: Extract<McpServerSpec, { transport: 'stdio' }>,
  ) {
    super(receive);
  }

  async start(): Promise<void> {
    if (this.child) return;
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.spec.command);
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', () => {
      /* MCP stderr 是诊断输出，不混入协议流。 */
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      if (code !== 0 && signal == null) this.receive({ error: { message: `stdio server 已退出 (${code})` } });
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  async send(message: JsonObject): Promise<void> {
    if (!this.child?.stdin?.writable) throw new Error('MCP stdio server 未连接');
    const body = `${JSON.stringify(message)}\n`;
    // MCP stdio 传输使用 NDJSON；接收端仍兼容 Content-Length，方便接入历史 LSP 风格服务。
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin!.write(body, (error) => (error ? reject(error) : resolve())),
    );
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    child.kill();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) return;
        const line = this.buffer.subarray(0, newline).toString('utf8').trim();
        this.buffer = this.buffer.subarray(newline + 1);
        this.receiveJson(line);
        continue;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length\s*:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      this.receiveJson(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
  }

  private receiveJson(raw: string): void {
    try {
      this.receive(JSON.parse(raw));
    } catch {
      /* 忽略 server 的非协议 stdout，避免打断会话。 */
    }
  }
}

class StreamableHttpTransport extends McpTransport {
  private sessionId: string | null = null;

  constructor(
    receive: (message: unknown) => void,
    private readonly spec: McpRemoteServerSpec,
  ) {
    super(receive);
  }
  async start(): Promise<void> {
    /* 每个 JSON-RPC 请求自行 POST，无长连接需预热。 */
  }

  async send(message: JsonObject): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutFor(this.spec));
    try {
      const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...this.spec.headers,
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const response = await fetch(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: 'error',
      });
      this.captureSession(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        await consumeSse(response.body, (event) => this.receiveEvent(event), controller.signal);
      } else {
        const text = await response.text();
        if (text.trim()) this.receiveEvent({ event: 'message', data: text });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
  private captureSession(response: Response): void {
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
  }
  private receiveEvent(event: SseEvent): void {
    try {
      this.receive(JSON.parse(event.data));
    } catch {
      /* 非 JSON SSE event 无法作为 MCP 响应。 */
    }
  }
}

class SseTransport extends McpTransport {
  private endpoint: URL | null = null;
  private controller: AbortController | null = null;
  private connecting: Promise<void> | null = null;
  private resolveEndpoint: (() => void) | null = null;
  private rejectEndpoint: ((error: Error) => void) | null = null;

  constructor(
    receive: (message: unknown) => void,
    private readonly spec: McpRemoteServerSpec,
  ) {
    super(receive);
  }

  async start(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.controller = new AbortController();
    this.connecting = new Promise<void>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    void this.open();
    return this.connecting;
  }

  async send(message: JsonObject): Promise<void> {
    await this.start();
    if (!this.endpoint) throw new Error('SSE MCP server 未提供 message endpoint');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutFor(this.spec));
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.spec.headers },
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    this.endpoint = null;
    this.connecting = null;
  }

  private async open(): Promise<void> {
    try {
      const response = await fetch(this.spec.url, {
        headers: { accept: 'text/event-stream', ...this.spec.headers },
        signal: this.controller?.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      await consumeSse(
        response.body,
        (event) => {
          if (event.event === 'endpoint') {
            this.endpoint = new URL(event.data, this.spec.url);
            this.resolveEndpoint?.();
            return;
          }
          try {
            this.receive(JSON.parse(event.data));
          } catch {
            /* 忽略非 MCP SSE event。 */
          }
        },
        this.controller?.signal,
      );
      if (!this.endpoint) throw new Error('SSE MCP server 在连接关闭前未提供 endpoint');
    } catch (error) {
      if (!this.controller?.signal.aborted) this.rejectEndpoint?.(asError(error));
    }
  }
}

/** 统一的 MCP client：完成 initialize、tools/list、tools/call 及请求超时/abort 管理。 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private initialized = false;
  private closed = false;
  cachedTools: McpToolDefinition[] = [];

  constructor(
    public readonly name: string,
    readonly spec: McpServerSpec,
  ) {
    const receive = (message: unknown): void => this.onMessage(message);
    // 向后兼容早期仅提供 command/args 的 stdio 配置；新配置显式写 transport 更清晰。
    this.transport =
      spec.transport === 'stdio' || ('command' in spec && typeof spec.command === 'string')
        ? new StdioTransport(receive, spec as Extract<McpServerSpec, { transport: 'stdio' }>)
        : spec.transport === 'sse'
          ? new SseTransport(receive, spec)
          : new StreamableHttpTransport(receive, spec as McpRemoteServerSpec);
  }

  isReady(): boolean {
    return this.initialized && !this.closed;
  }

  async initialize(): Promise<void> {
    if (this.isReady()) return;
    this.closed = false;
    await this.transport.start();
    const result = await this.request<JsonObject>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mocode-ai', version: '0.6.8' },
    });
    if (!result || typeof result !== 'object') throw new Error('MCP initialize 返回了无效响应');
    await this.notify('notifications/initialized', {});
    this.initialized = true;
    await this.listTools();
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (this.closed) throw new Error('MCP client 已关闭');
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request<JsonObject>('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new Error('MCP tools/list 返回了无效 tools');
      for (const tool of result.tools) {
        if (!isRecord(tool) || typeof tool.name !== 'string') continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : undefined,
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    this.cachedTools = tools;
    return tools;
  }

  async callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.isReady()) throw new Error(`MCP server ${this.name} 未连接`);
    const result = await this.request<JsonObject>('tools/call', { name, arguments: arguments_ }, signal);
    return {
      content: Array.isArray(result.content) ? result.content : [],
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === true ? { isError: true } : {}),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
    for (const [id] of this.pending) this.fail(id, new Error('MCP client 已关闭'));
    await this.transport.close();
  }

  private async notify(method: string, params: JsonObject): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method, params });
  }

  private request<T>(method: string, params: JsonObject, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('MCP client 已关闭'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, new Error(`MCP ${method} 请求超时`)), timeoutFor(this.spec));
      const onAbort = (): void => this.fail(id, new Error(`MCP ${method} 已中断`));
      const pending: Pending = { resolve: (value) => resolve(value as T), reject, timer, signal, onAbort };
      this.pending.set(id, pending);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      void this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((error) => this.fail(id, asError(error)));
    });
  }

  private onMessage(raw: unknown): void {
    if (!isRecord(raw) || (typeof raw.id !== 'number' && typeof raw.id !== 'string')) return;
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
    if (!Number.isInteger(id) || !this.pending.has(id)) return;
    if (isRecord(raw.error)) {
      this.fail(id, new Error(typeof raw.error.message === 'string' ? raw.error.message : 'MCP JSON-RPC error'));
    } else {
      this.succeed(id, raw.result);
    }
  }

  private succeed(id: number, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(value);
  }

  private fail(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    pending.reject(error);
  }
}

function timeoutFor(spec: McpServerSpec): number {
  return spec.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
}

async function consumeSse(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!body) throw new Error('MCP SSE 响应没有 body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('MCP SSE 请求已中断');
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffered.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffered.slice(0, boundary);
        const separatorLength =
          buffered[boundary] === '\r'
            ? buffered[boundary + 2] === '\r'
              ? 4
              : 3
            : buffered[boundary + 1] === '\r'
              ? 3
              : 2;
        buffered = buffered.slice(boundary + separatorLength);
        const event = parseSseBlock(block);
        if (event) onEvent(event);
      }
      if (done) break;
    }
    const finalEvent = parseSseBlock(buffered);
    if (finalEvent) onEvent(finalEvent);
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
