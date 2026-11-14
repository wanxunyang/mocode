// 浏览器会话诊断的采集与落盘。
//
// 设计要点（对齐 Chrome DevTools MCP 的 Token-Optimized / Reference-over-Value）：
//  - 工具结果只回「计数 + 尾部若干行 + 日志路径」，绝不回吐全量控制台；
//    细节由模型自己 grep / read_file 日志文件按需取。
//  - 计数与环缓冲分开维护：环缓冲会丢弃最老的条目，但计数必须是累计值，
//    否则「有多少条报错」会随缓冲滑动而变小，模型据此会误判问题已消失。
//  - 日志写入串行排队（同一文件，不能交错），并设体积上限防止长会话撑爆磁盘。

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type DiagnosticBucket = 'console' | 'pageErrors' | 'failedRequests';

export interface DiagnosticsCounts {
  console: number;
  pageErrors: number;
  failedRequests: number;
}

export interface DiagnosticsTail {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
}

/** 暴露给模型的诊断摘要。 */
export interface BrowserDiagnostics {
  counts: DiagnosticsCounts;
  tail: DiagnosticsTail;
  /** 诊断明细日志；无法建目录时缺省。 */
  logPath?: string;
  /** 达到体积上限后停止追加，明细以既有内容为准。 */
  logTruncated?: boolean;
}

interface LogSink {
  path: string;
  bytes: number;
  truncated: boolean;
  queue: Promise<void>;
}

export interface DiagnosticsState {
  counts: DiagnosticsCounts;
  ring: DiagnosticsTail;
  log: LogSink | null;
  limits: { ring: number; tail: number; maxLogBytes: number };
}

export const DEFAULT_RING_LIMIT = 200;
export const DEFAULT_TAIL_SIZE = 10;
export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;

/** 会话日志落点：`<root>/.mocode/browser/<sessionId>.log`。 */
export function resolveDiagnosticsLogPath(root: string, sessionId: string): string {
  return path.join(root, '.mocode', 'browser', `${sessionId}.log`);
}

export interface CreateDiagnosticsOptions {
  /** 日志文件路径；null 表示只留内存（只读工作区等场景）。 */
  logPath?: string | null;
  ringLimit?: number;
  tailSize?: number;
  maxLogBytes?: number;
}

export function createDiagnostics(options: CreateDiagnosticsOptions = {}): DiagnosticsState {
  const state: DiagnosticsState = {
    counts: { console: 0, pageErrors: 0, failedRequests: 0 },
    ring: { console: [], pageErrors: [], failedRequests: [] },
    log: options.logPath ? { path: options.logPath, bytes: 0, truncated: false, queue: Promise.resolve() } : null,
    limits: {
      ring: options.ringLimit ?? DEFAULT_RING_LIMIT,
      tail: options.tailSize ?? DEFAULT_TAIL_SIZE,
      maxLogBytes: options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
    },
  };
  // 目录创建失败只需降级为纯内存，不该让浏览器能力整体不可用。
  if (state.log) {
    const sink = state.log;
    sink.queue = mkdir(path.dirname(sink.path), { recursive: true }).then(
      () => undefined,
      () => {
        state.log = null;
      },
    );
  }
  return state;
}

export function recordDiagnostic(state: DiagnosticsState, bucket: DiagnosticBucket, line: string): void {
  state.counts[bucket] += 1;
  const target = state.ring[bucket];
  target.push(line);
  if (target.length > state.limits.ring) target.splice(0, target.length - state.limits.ring);

  const sink = state.log;
  if (!sink || sink.truncated) return;
  const text = `[${bucket}] ${line}\n`;
  sink.bytes += Buffer.byteLength(text);
  if (sink.bytes > state.limits.maxLogBytes) {
    sink.truncated = true;
    return;
  }
  // 串行追加：并发事件各自接在上一次写入之后，避免同一文件内容交错。
  sink.queue = sink.queue
    .then(() => appendFile(sink.path, text))
    .catch(() => {
      /* 日志是增强能力，写失败不影响采集 */
    })
    .then(() => undefined);
}

export function snapshotDiagnostics(state: DiagnosticsState): BrowserDiagnostics {
  const cut = (items: string[]): string[] => items.slice(-state.limits.tail);
  return {
    counts: { ...state.counts },
    tail: {
      console: cut(state.ring.console),
      pageErrors: cut(state.ring.pageErrors),
      failedRequests: cut(state.ring.failedRequests),
    },
    ...(state.log ? { logPath: state.log.path } : {}),
    ...(state.log?.truncated ? { logTruncated: true } : {}),
  };
}

/** 等待排队中的日志写入落盘（测试与收尾时用）。 */
export async function flushDiagnostics(state: DiagnosticsState): Promise<void> {
  await state.log?.queue.catch(() => {});
}
