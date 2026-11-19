import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { WorkAttachment } from './attachment-types.js';
import { changeFilesFrom, completedChangeSnapshot, updateChangeSnapshot, type ChangeSnapshot } from './change-snapshot.js';
import { hasSubAgentProgressLine, isSubAgentProgressLine } from './sub-agent-progress.js';
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
  | { kind: 'error'; message: string }
  /** 系统提示行（如「上下文已压缩」）：既不是错误也不是模型输出，但必须在会话流里留痕，
   *  否则切走再回来就只剩「百分比莫名掉了一截」。文案不落盘 —— 存结构，渲染层按当前语言生成。 */
  | { kind: 'notice'; notice: StreamNotice }
  /**
   * 这一轮改过的文件（挂在对应那条助手消息的尾部）。
   *
   * 为什么统计要跟着事件走、而不是恢复时现算：`git diff HEAD` 算的是「此刻 vs HEAD」，
   * 对历史轮次会变成累计差异（甚至因后续提交而归零）。所以每轮结束时由主进程算一次、
   * 落进日志 —— 回放看到的 +N/-N 就是那一轮当时的数字。
   */
  | ChangeSnapshot;
/** 结构化系统提示：字段是数据，不是译文（恢复日志会跨语言切换存续）。 */
export type StreamNotice =
  | { type: 'contextCompacted'; beforeTokens?: number; afterTokens?: number; windowTokens?: number; manual?: boolean; summarized?: boolean };
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
  /**
   * 恢复 seq 与「尾行是否完整」。
   *
   * ⚠️ 这里**不能**readFileSync 整份文件：真机上有 107MB 的恢复日志，一次同步读 = 235ms
   * 锁死 Electron 主线程，而这发生在任务的**第一次写日志**时（也就是点开会话后的第一秒）——
   * 看起来就是「点了会话之后整界面顿一下」。日志是 append-only，最后一个完整行的 seq 就是最大值，
   * 所以只读尾部一小段即可。
   */
  const TAIL_BYTES = 64 * 1024;
  /**
   * 从文件尾部往前找最大 seq。
   *
   * ⚠ 窗口必须能扩张：一次 tool_completed 的大输出可能自身就超过 64KB，此时尾窗里
   * **一行完整的记录都切不出来**，seq 会停在 0 —— 之后新写的 seq 1、2… 会被
   * parseRecovery 的「seq <= 已见最大 seq」判成陈旧而**静默丢弃**（会话看起来卡死不动）。
   * 所以窗口里一条 seq 都没解析出来时就翻倍往前读，直到拿到值或读完整个文件。
   * 常态走第一次（64KB 足够覆盖普通记录），异常才付更多 IO，最坏也只是退回原来的整份读。
   */
  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    let fd = -1;
    try {
      fd = openSync(file, 'r');
      const size = fstatSync(fd).size;
      let length = Math.min(size, TAIL_BYTES);
      for (;;) {
        const start = size - length;
        const buffer = Buffer.allocUnsafe(length);
        readSync(fd, buffer, 0, length, start);
        const tail = buffer.toString('utf8');
        needsSeparator = size > 0 && !tail.endsWith('\n');
        // 从中间截断时第一行可能是半截 —— 只有在 start > 0（确实从中间开始）时才丢它。
        const lines = tail.split('\n');
        if (start > 0) lines.shift();
        let found = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let value = NaN;
          try { value = Number((JSON.parse(line) as { seq?: unknown }).seq); } catch { /* 坏行只影响它自己 */ }
          if (Number.isFinite(value)) { seq = Math.max(seq, value); found = true; }
        }
        if (found || start === 0) break;
        length = Math.min(size, length * 4);
      }
    } catch { /* 文件不存在 / 读失败：首个事件会创建它，seq 保持 0 */ }
    finally { if (fd >= 0) try { closeSync(fd); } catch { /* 关闭失败无需处理 */ } }
  };
  type LogEntryInput = LogEntry extends infer Entry
    ? Entry extends LogEntry ? Omit<Entry, 'seq' | 'at'> : never
    : never;
  /**
   * live_usage 的去重闸：它只是「上下文用量」的流式进度，同一轮里每秒可来上百条
   * （实测一条 107MB 的恢复日志里 25 万行 / 101MB 全是它，占 95%）。
   * 只保留**百分比真的变了**的那几条 —— 恢复时百分比从最后一条 live_usage 或
   * run_completed 的快照读回，中间过程值没有任何用途。
   */
  let lastLivePercent: number | null = null;
  const isRedundantLiveUsage = (entry: LogEntryInput): boolean => {
    if (entry.type !== 'event' || entry.event.event !== 'live_usage') return false;
    const usage = entry.event.payload?.contextUsage;
    const percent = usage && typeof usage === 'object' ? Number((usage as { percent?: unknown }).percent) : NaN;
    if (!Number.isFinite(percent)) return false;
    const changed = lastLivePercent === null || Math.round(percent) !== lastLivePercent;
    lastLivePercent = Math.round(percent);
    return !changed;
  };
  const append = (entry: LogEntryInput): void => {
    try {
      if (isRedundantLiveUsage(entry)) return;
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

/**
 * live_usage 行的固定前缀（本模块 writer 的键序：先 `{type,event}`，再追加 seq/at）。
 *
 * 为什么按前缀短路：live_usage 只是「上下文用量」的流式进度，在真实用户的一份日志里占到
 * 95%（25 万行 / 101MB）。恢复时中间过程值毫无用途，却要逐行 JSON.parse —— 这正是
 * 打开会话让主进程卡 300ms 的主因。命中前缀就整行跳过，不解析。
 * 前缀必须写全（含 payload 之前的那一段），否则一段普通文本里恰好出现 live_usage 字样
 * 的内容也会被误丢。
 */
const LIVE_USAGE_LINE_PREFIX = '{"type":"event","event":{"type":"event","event":"live_usage"';

/**
 * 判断一行是不是 live_usage 事件。
 *
 * 快路：命中 writer 的固定键序前缀，直接返回 —— 真实日志里 95% 的行都走这条。
 * 慢路：键序被改过 / 旧版本写下的行（`seq`、`at` 在前）。只对**含 live_usage 字样**的行
 * 做一次 JSON.parse 确认，既不逐行解析 25 万行，也不会把正文里恰好出现这个词的对话误删。
 */
function isLiveUsageLine(line: string): boolean {
  if (line.startsWith(LIVE_USAGE_LINE_PREFIX)) return true;
  if (!line.includes('"live_usage"')) return false;
  try {
    const entry = JSON.parse(line) as { type?: unknown; event?: { event?: unknown } };
    return entry.type === 'event' && entry.event?.event === 'live_usage';
  } catch {
    // 崩溃留下的半行：既不是 live_usage，也不该被当成 live_usage 丢掉。
    return false;
  }
}

/**
 * 剥掉工具项 payload 里与顶层字段重复的三个键：`arguments` / `output` / `chunk`。
 *
 * `payload` 是整个事件的原始 payload 拷贝，而 `arguments`/`output` 已经提到了
 * `RecoveryStreamItem` 的顶层（args/output）—— 实测真实会话 905/910 个工具项两处内容
 * 逐字相同，占一份 6.54MB 快照的 47%（3.1MB）。这份重复要 stringify、过 IPC、再 parse
 * 一遍，全部发生在点会话那一瞬间。
 *
 * 安全性：渲染层回放时显式传 `arguments: item.args, output: item.output`（覆盖顺序不依赖
 * payload），`chunk` 只在实时 tool_output 事件里用、不走快照。其余只有 payload 才有的
 * 结构化字段（status / code / changedFiles / editStartLine / preWriteOld / multiHunks…）全部保留。
 */
function stripRedundantToolPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return payload;
  if (payload.arguments === undefined && payload.output === undefined && payload.chunk === undefined) return payload;
  const trimmed = { ...payload };
  delete trimmed.arguments;
  delete trimmed.output;
  delete trimmed.chunk;
  return trimmed;
}

/** 纯函数：JSONL 正文 → 现场快照；running 表示主进程确认 host 仍活着（由调用方判断）。 */
function parseRecovery(source: string, running = false): RecoverySnapshot | null {
  const entries: LogEntry[] = [];
  let lastSeq = 0;
  // 跳过 live_usage 后仍要能还原上下文用量：记下最后一条原始行，仅在没有任何
  // run_completed 快照时兜底解析它（崩溃/被中止的那一轮只有这里有值）。
  let lastLiveUsageLine: string | null = null;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    if (isLiveUsageLine(line)) { lastLiveUsageLine = line; continue; }
    try {
      const entry: unknown = JSON.parse(line);
      if (!validEntry(entry) || entry.seq <= lastSeq) continue;
      entries.push(entry); lastSeq = entry.seq;
    } catch {
      // 只忽略损坏行；已成功落盘的前序输出仍可恢复。
    }
  }
  let effective: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'truncate' || entry.type === 'regenerate') {
      const cut = cutAtUser(effective, entry.userIndex, entry.type === 'regenerate');
      // 直接赋值而不是 `splice(0, len, ...cut)`：展开传参的实参个数上限约 125k，
      // 超过就 RangeError: Maximum call stack size exceeded —— 长会话的日志（实测 25 万条）
      // 只要有一次回滚就会在打开时抛异常，work:select-task 整条 IPC reject，界面表现为「点了没反应」。
      if (cut) effective = cut;
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
  let legacyChangesPending = false;
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
        legacyChangesPending = false;
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
            // 子 agent 的进度行（tool_output 累积）不能被最终结论盖掉：`▸` 行是「它做过什么」，
            // `[sub-tool]{…}` 机器行还带每次内部调用的入参与输出——丢了就再也展开不出来。
            const progress = existing.output.split('\n').filter(isSubAgentProgressLine).join('\n');
            existing.output = progress && !hasSubAgentProgressLine(output) ? `${output}\n${progress}` : output;
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
      case 'context_compacted':
        // 压缩是这轮对话里发生过的事实：恢复现场时和实时一样，在会话流里留一条系统行。
        if (isRecord(payload.contextUsage)) {
          contextUsage = payload.contextUsage;
          if (typeof payload.contextUsage.percent === 'number') usagePercent = payload.contextUsage.percent;
        }
        items.push({
          kind: 'notice',
          notice: {
            type: 'contextCompacted',
            ...(typeof payload.beforeTokens === 'number' ? { beforeTokens: payload.beforeTokens } : {}),
            ...(typeof payload.afterTokens === 'number' ? { afterTokens: payload.afterTokens } : {}),
            ...(typeof payload.contextWindow === 'number' ? { windowTokens: payload.contextWindow } : {}),
            ...(payload.manual === true ? { manual: true } : {}),
            ...(payload.summarized === true ? { summarized: true } : {}),
          },
        });
        break;
      case 'run_completed': {
        if (isRecord(payload.contextUsage)) {
          contextUsage = payload.contextUsage;
          if (typeof payload.contextUsage.percent === 'number') usagePercent = payload.contextUsage.percent;
        }
        runOpen = false;
        pendingApproval = null;
        const snapshot = completedChangeSnapshot(payload);
        if (snapshot) items.push(snapshot);
        legacyChangesPending = !snapshot && typeof payload.changeSnapshotId !== 'string';
        break;
      }
      case 'run_changed_files': {
        const files = changeFilesFrom(payload.files);
        if (typeof payload.changeSnapshotId === 'string') {
          updateChangeSnapshot(items, payload.changeSnapshotId, files);
        } else if (legacyChangesPending && files.length) {
          items.push({ kind: 'changes', files });
          legacyChangesPending = false;
        }
        break;
      }
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
    if (entry.type === 'user') {
      legacyChangesPending = false;
      items.push({ kind: 'user', text: entry.text, ...(entry.attachments?.length ? { attachments: entry.attachments } : {}) });
    }
    else if (entry.type === 'event') event(entry.event, entry.at);
  }
  // 上面整段跳过了 live_usage 行；若这一轮没有走到 run_completed（崩溃 / 被中止），
  // 上下文百分比的最后一次值只能从被跳过的那条里捞。只解析一条，成本可忽略。
  if (contextUsage === null && lastLiveUsageLine) {
    try {
      const skipped = JSON.parse(lastLiveUsageLine) as { event?: RecoveryEnvelope };
      const snapshot = skipped.event?.payload?.contextUsage;
      if (isRecord(snapshot)) {
        contextUsage = snapshot;
        if (typeof snapshot.percent === 'number') usagePercent = snapshot.percent;
      }
    } catch { /* 坏行就当没有快照，界面上显示 -- */ }
  }
  // 主进程才知道 host 是否仍活着。活动任务保留执行态；终态或崩溃只定格未完成调用，绝不重跑。
  if (!running) {
    pendingApproval = null;
    settleOpenTools();
  }
  for (const item of items) {
    if (item.kind === 'tool') item.payload = stripRedundantToolPayload(item.payload);
  }
  return { items, usagePercent, contextUsage, startedAt, pendingApproval, interrupted: interrupted || runOpen };
}

/**
 * 同步读（测试 / 无事件循环压力的小路径）。
 *
 * 主进程**不要**用这个：它会在 Electron 主线程上同步读完整个 JSONL（实测 32MB 日志 = 240ms），
 * 这期间所有 IPC（点击、输入、切会话）全部排队 —— 那正是「agent 跑着的时候点哪都卡」的一半原因。
 */
export function readRecovery(root: string, taskId: string, running = false): RecoverySnapshot | null {
  let source: string;
  try { source = readFileSync(recoveryFile(root, taskId), 'utf8'); } catch { return null; }
  return parseRecovery(source, running);
}

/** 异步读：IO 交给 libuv 线程池，主线程不再被落盘日志卡住。主进程走这个。 */
export async function readRecoveryAsync(root: string, taskId: string, running = false): Promise<RecoverySnapshot | null> {
  let source: string;
  try { source = await readFile(recoveryFile(root, taskId), 'utf8'); } catch { return null; }
  return parseRecovery(source, running);
}

/** 超过这个体积的恢复日志才值得重写一次（小文件重写的 IO 比省下的解析更贵）。 */
const COMPACT_THRESHOLD_BYTES = 2 * 1024 * 1024;

/**
 * 把历史上写臃肿的恢复日志就地瘦身：只丢掉 live_usage 行，仅保留**最后一条**。
 *
 * 语义安全性：live_usage 不承载任何对话内容，恢复时它的唯一用途是「崩溃那一轮的
 * 上下文百分比」（run_completed / compact_done 各自带快照），所以留最后一条即可。
 * 其余行（user / text_delta / tool_* / truncate / regenerate / 终态事件）全部原样保留，
 * 顺序不变 —— 回滚、重生成、崩溃现场都不受影响。
 *
 * 为什么要做：真机上一份日志被 25 万条 live_usage 撑到 107MB（占 95%），每次点会话
 * 都要同步读它；不清理的话，writer 端的节流只能防未来、救不了已经写坏的文件。
 */
export async function compactRecoveryLog(root: string, taskId: string): Promise<boolean> {
  let file: string;
  try { file = recoveryFile(root, taskId); } catch { return false; }
  let size = 0;
  try { size = (await stat(file)).size; } catch { return false; }
  if (size < COMPACT_THRESHOLD_BYTES) return false;
  let source: string;
  try { source = await readFile(file, 'utf8'); } catch { return false; }
  const lines = source.split('\n');
  const kept: string[] = [];
  let lastLiveIndex = -1;
  let liveCount = 0;
  for (const line of lines) {
    if (isLiveUsageLine(line)) { lastLiveIndex = kept.length; kept.push(line); liveCount += 1; continue; }
    kept.push(line);
  }
  // 只删到只剩一条；其余 live_usage 行整段丢弃。
  if (liveCount <= 1) return false;
  const compacted: string[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i]!;
    if (!isLiveUsageLine(line)) { compacted.push(line); continue; }
    if (i === lastLiveIndex) compacted.push(line);
  }
  const body = compacted.join('\n');
  try {
    const tmp = `${file}.compact-tmp`;
    await writeFile(tmp, body, 'utf8');
    renameSync(tmp, file);
  } catch { return false; }
  return true;
}

/**
 * 启动后的一次性存量清理：扫描 task-recovery 目录，把历史上被 live_usage 撑大的日志全部瘦身。
 *
 * 必须放在首屏之后异步跑（调用方 fire-and-forget）：它是维护动作，绝不能挡住启动，
 * 也不能和正在写的任务日志抢同一个文件 —— 只处理体积超阈值的老文件，且用「临时文件 + 改名」
 * 原子替换，写日志的一方最多在窗口期内追加到已被替换的旧 inode（下一轮 start 会重新 init）。
 */
export async function compactRecoveryLogs(root: string): Promise<number> {
  let files: string[] = [];
  // ⚠️ 传 root 而不是 task-recovery 目录：compactRecoveryLog 自己会拼 `<root>/task-recovery`，
  // 早先这里把已拼好的目录又传下去（结果变成 task-recovery/task-recovery），stat 必然 ENOENT，
  // 瘦身静默返回 0 —— 实机验证时表现为「清扫跑过了但文件一个字节都没少」。
  try { files = (await readdir(path.resolve(root, 'task-recovery'))).filter((name) => name.endsWith('.jsonl')); } catch { return 0; }
  let compacted = 0;
  for (const name of files) {
    if (await compactRecoveryLog(root, name.slice(0, -'.jsonl'.length))) compacted += 1;
  }
  return compacted;
}
