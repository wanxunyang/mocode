import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import type { WorkAttachment } from './attachment-types.js';
export type RecoveryAttachment = WorkAttachment;
export interface RecoveryEnvelope {
  type: string;
  event?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  error?: string;
}
export type RecoveryStreamItem =
  | { kind: 'user'; text: string; attachments?: RecoveryAttachment[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; output: string; done: boolean; payload?: Record<string, unknown> }
  | { kind: 'error'; message: string };
export interface RecoverySnapshot {
  items: RecoveryStreamItem[];
  usagePercent: number | null;
  contextUsage: Record<string, unknown> | null;
  startedAt: number | null;
  pendingApproval: Record<string, unknown> | null;
  /** 由主进程按任务记录补充：仅进程仍活着时才为 true。 */
  running?: boolean;
  /** 上次进程退出时仍在运行；恢复现场但不自动重跑。 */
  interrupted?: boolean;
}

type LogEntry =
  | { seq: number; at: string; type: 'user'; text: string; attachments?: RecoveryAttachment[] }
  | { seq: number; at: string; type: 'event'; event: RecoveryEnvelope }
  | { seq: number; at: string; type: 'truncate'; userIndex: number }
  | { seq: number; at: string; type: 'regenerate'; userIndex: number };

export interface RecoveryLog {
  user(text: string, attachments?: RecoveryAttachment[]): void;
  event(envelope: RecoveryEnvelope): void;
  truncate(userIndex: number): void;
  regenerate(userIndex: number): void;
}

/** 任务 id 只能定位到恢复目录的直接子文件，不能借 IPC 参数逃逸出 userData。 */
function recoveryFile(root: string, taskId: string): string {
  const dir = path.resolve(root, 'task-recovery');
  const file = path.resolve(dir, `${taskId}.jsonl`);
  if (path.dirname(file) !== dir) throw new Error('Invalid task id for recovery log');
  return file;
}

/** userData 下的私有恢复日志；任务 id 来自主进程 randomUUID，不采用 renderer 传入的路径。 */
export function recoveryLog(root: string, taskId: string): RecoveryLog {
  let file: string;
  try { file = recoveryFile(root, taskId); } catch {
    return { user: () => {}, event: () => {}, truncate: () => {}, regenerate: () => {} };
  }
  const dir = path.dirname(file);
  let seq = 0;
  let initialized = false;
  let needsSeparator = false;
  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    try {
      const source = readFileSync(file, 'utf8');
      // 崩溃留下的半行没有换行符；先补分隔，否则新记录会粘在同一条坏 JSON 上。
      needsSeparator = source.length > 0 && !source.endsWith('\n');
      for (const line of source.split('\n')) {
        if (!line.trim()) continue;
        try { seq = Math.max(seq, Number((JSON.parse(line) as { seq?: unknown }).seq) || 0); } catch { /* 容忍崩溃留下的半行 */ }
      }
    } catch { /* 首个事件会创建目录 */ }
  };
  type LogEntryInput = LogEntry extends infer Entry
    ? Entry extends LogEntry ? Omit<Entry, 'seq' | 'at'> : never
    : never;
  const append = (entry: LogEntryInput): void => {
    try {
      initialize();
      mkdirSync(dir, { recursive: true });
      // 每条都是独立 JSONL。writeFileSync(flag:a) 返回前已交给内核，进程崩溃最多损失尾部。
      writeFileSync(file, `${needsSeparator ? '\n' : ''}${JSON.stringify({ ...entry, seq: ++seq, at: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'a' });
      needsSeparator = false;
    } catch {
      // 日志失败不能中止 agent；主会话的轮末保存仍然保留。
    }
  };
  return {
    user: (text, attachments) => append({ type: 'user', text, ...(attachments?.length ? { attachments } : {}) }),
    event: (event) => append({ type: 'event', event }),
    truncate: (userIndex) => append({ type: 'truncate', userIndex }),
    regenerate: (userIndex) => append({ type: 'regenerate', userIndex }),
  };
}

export function deleteRecoveryLog(root: string, taskId: string): void {
  try { rmSync(recoveryFile(root, taskId), { force: true }); } catch { /* 删除任务不应被恢复日志清理失败阻断 */ }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function validUserIndex(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/** 从用户消息序号定位对应的 user 事件；找不到目标时绝不清空日志。 */
function cutAtUser(entries: LogEntry[], userIndex: number, keepUser: boolean): LogEntry[] | null {
  let seen = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]!.type !== 'user') continue;
    seen += 1;
    if (seen === userIndex) return entries.slice(0, i + (keepUser ? 1 : 0));
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** JSONL 可能来自崩溃尾部，也可能是旧版本/损坏内容；只接受本模块认识的完整记录。 */
function validEntry(value: unknown): value is LogEntry {
  if (!isRecord(value) || !Number.isInteger(value.seq) || Number(value.seq) <= 0 || typeof value.at !== 'string') return false;
  if (value.type === 'user') {
    return typeof value.text === 'string' && (value.attachments === undefined || Array.isArray(value.attachments)
      && value.attachments.every((item) => isRecord(item) && typeof item.name === 'string'
        && ((typeof item.dataUrl === 'string' && item.text === undefined)
          || (typeof item.text === 'string' && item.text.length <= 100_000 && item.dataUrl === undefined))));
  }
  if (value.type === 'truncate' || value.type === 'regenerate') return validUserIndex(value.userIndex);
  if (value.type !== 'event' || !isRecord(value.event) || typeof value.event.type !== 'string') return false;
  if (value.event.event !== undefined && typeof value.event.event !== 'string') return false;
  if (value.event.payload !== undefined && !isRecord(value.event.payload)) return false;
  return value.event.error === undefined || typeof value.event.error === 'string';
}

/** 将 JSONL 还原成 renderer 的流式事件序列，再复用实时事件处理逻辑渲染。 */
export function readRecovery(root: string, taskId: string, running = false): RecoverySnapshot | null {
  let source: string;
  try { source = readFileSync(recoveryFile(root, taskId), 'utf8'); } catch { return null; }
  const entries: LogEntry[] = [];
  let lastSeq = 0;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!validEntry(entry) || entry.seq <= lastSeq) continue;
      entries.push(entry); lastSeq = entry.seq;
    } catch {
      // 只忽略损坏行；已成功落盘的前序输出仍可恢复。
    }
  }
  const effective: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'truncate' || entry.type === 'regenerate') {
      const cut = cutAtUser(effective, entry.userIndex, entry.type === 'regenerate');
      if (cut) effective.splice(0, effective.length, ...cut);
    } else effective.push(entry);
  }
  if (!effective.some((entry) => entry.type === 'user' || entry.type === 'event' && ['text_delta', 'tool_started', 'tool_output', 'tool_completed'].includes(entry.event.event ?? ''))) return null;
  const items: RecoveryStreamItem[] = [];
  let usagePercent: number | null = null;
  let contextUsage: Record<string, unknown> | null = null;
  let startedAt: number | null = null;
  let pendingApproval: Record<string, unknown> | null = null;
  let runOpen = false;
  let interrupted = false;
  const settleOpenTools = (): void => {
    for (const item of items) {
      if (item.kind !== 'tool' || item.done) continue;
      item.done = true;
      item.payload = { ...item.payload, status: 'aborted' };
    }
  };
  const event = (envelope: RecoveryEnvelope, at: string): void => {
    const payload = envelope.payload ?? {};
    if (envelope.type === 'error') {
      const message = envelope.error?.trim();
      if (message) items.push({ kind: 'error', message });
      runOpen = false;
      pendingApproval = null;
      settleOpenTools();
      return;
    }
    switch (envelope.event) {
      case 'run_started': {
        const timestamp = Date.parse(at);
        startedAt = Number.isFinite(timestamp) ? timestamp : null;
        // 新一轮已开始：旧中断只属于上一轮，未完成工具永久定格为中止。
        settleOpenTools();
        pendingApproval = null;
        interrupted = false;
        runOpen = true;
        break;
      }
      case 'text_delta': {
        const text = String(payload.text ?? '');
        const last = items[items.length - 1];
        if (last?.kind === 'text') last.text += text;
        else items.push({ kind: 'text', text });
        break;
      }
      case 'approval_requested':
        pendingApproval = payload;
        break;
      case 'tool_started':
      case 'tool_completed': {
        pendingApproval = null;
        const done = envelope.event === 'tool_completed';
        const id = payload.id == null ? '' : String(payload.id);
        const args = textOf(payload.arguments).trim();
        const output = textOf(payload.output).trim();
        const existing = id ? [...items].reverse().find((item) => item.kind === 'tool' && item.id === id) : undefined;
        if (existing?.kind === 'tool') {
          existing.done = done;
          if (output) {
            const progress = existing.output.split('\n').filter((line) => /^[▸●↳]\s/.test(line.trim())).join('\n');
            existing.output = progress && !/^[▸●↳]\s/m.test(output) ? `${output}\n${progress}` : output;
          }
          if (args) existing.args = args;
          existing.payload = { ...existing.payload, ...payload };
        } else items.push({ kind: 'tool', id, name: String(payload.name ?? 'tool'), args, output, done, payload });
        break;
      }
      case 'tool_output': {
        const id = payload.id == null ? '' : String(payload.id);
        const chunk = String(payload.chunk ?? '');
        const existing = id ? [...items].reverse().find((item) => item.kind === 'tool' && item.id === id) : undefined;
        if (existing?.kind === 'tool') existing.output += chunk;
        else items.push({ kind: 'tool', id, name: String(payload.name ?? 'tool'), args: '', output: chunk, done: false, payload });
        break;
      }
      case 'live_usage':
        if (isRecord(payload.contextUsage)) {
          contextUsage = payload.contextUsage;
          if (typeof payload.contextUsage.percent === 'number') usagePercent = payload.contextUsage.percent;
        }
        break;
      case 'run_completed':
        if (isRecord(payload.contextUsage)) {
          contextUsage = payload.contextUsage;
          if (typeof payload.contextUsage.percent === 'number') usagePercent = payload.contextUsage.percent;
        }
        runOpen = false;
        pendingApproval = null;
        break;
      case 'run_failed':
        items.push({ kind: 'error', message: String(payload.message ?? 'Agent run failed') });
        runOpen = false;
        pendingApproval = null;
        break;
      case 'run_aborted':
        runOpen = false;
        pendingApproval = null;
        interrupted = false;
        settleOpenTools();
        break;
      case 'host_exit':
        interrupted ||= runOpen;
        runOpen = false;
        pendingApproval = null;
        settleOpenTools();
        break;
    }
  };
  for (const entry of effective) {
    if (entry.type === 'user') items.push({ kind: 'user', text: entry.text, ...(entry.attachments?.length ? { attachments: entry.attachments } : {}) });
    else if (entry.type === 'event') event(entry.event, entry.at);
  }
  // 主进程才知道 host 是否仍活着。活动任务保留执行态；终态或崩溃只定格未完成调用，绝不重跑。
  if (!running) {
    pendingApproval = null;
    settleOpenTools();
  }
  return { items, usagePercent, contextUsage, startedAt, pendingApproval, interrupted: interrupted || runOpen };
}
