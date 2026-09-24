// Relevance Pruner: statically removes tool results that a newer observation supersedes.
// It never deletes messages or changes tool_call_id pairing; only tool content is stubbed.

import type { ChatMessage } from '../llm/index.js';
import { canonicalizePath, extractPath, isToolResultSuccess, toText } from './utils.js';

type AnyMessage = ChatMessage & { content?: unknown; tool_call_id?: string };

interface ToolCallInfo {
  name: string;
  argsRaw: string;
  args: Record<string, unknown> | null;
}

interface ToolCallShape {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Shared prefix lets /context count read and observation supersession together. */
const STUB_PREFIX = '⌦[已过时:';
/** read→read:仅同 path 同区间(offset+limit)的更新 read 才淘汰旧页。 */
const READ_RANGE_STUB_REASON = '同 path 同区间已有新 read';
/** mutation→read:文件被改写,该 path 旧 read 全区间淘汰。 */
const READ_MUTATION_STUB_REASON = '同 path 已被 mutation 覆写';
/** read_file 默认分页(对齐 tools/builtins/read-file.ts 的 DEFAULT_READ_LIMIT)。 */
const READ_DEFAULT_LIMIT = 300;
/** read_file 单次硬上限(对齐 MAX_FILE_LINES),把超传 limit 归一化到真实拿到的区间。 */
const READ_LIMIT_CAP = 2000;

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizedInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** read_file 实际拿到的行区间:offset 默认 1;limit 默认 300 且钳到 2000(同工具 execute 的归一化)。
 *  无法解析参数时返 null(调用方保守跳过,不做区间淘汰)。 */
function readRange(argsRaw: string): { offset: number; limit: number } | null {
  const args = parseArgs(argsRaw);
  if (!args) return null;
  const offset = Math.max(1, normalizedInteger(args.offset, 1));
  const limit = Math.max(1, Math.min(normalizedInteger(args.limit, READ_DEFAULT_LIMIT), READ_LIMIT_CAP));
  return { offset, limit };
}

/** Only complete semantic-query equality is safe for whole-message replacement. */
function observationKey(call: ToolCallInfo): string | null {
  const args = call.args;
  if (!args) return null;
  if (call.name === 'grep') {
    if (typeof args.pattern !== 'string') return null;
    const rawMax = normalizedInteger(args.max_per_file, 15);
    return JSON.stringify({
      tool: 'grep',
      pattern: args.pattern,
      glob: typeof args.glob === 'string' ? args.glob : '**/*',
      maxPerFile: Math.min(Math.max(rawMax, 1), 50),
    });
  }
  return null;
}

function observationLabel(call: ToolCallInfo): string {
  const args = call.args ?? {};
  if (call.name === 'grep') {
    const pattern = JSON.stringify(String(args.pattern ?? '')).slice(0, 80);
    const glob = JSON.stringify(String(args.glob ?? '**/*')).slice(0, 80);
    return `grep(pattern=${pattern}, glob=${glob})`;
  }
  return call.name;
}

/**
 * Cross-message relevance pruning:
 * - read_file: a newer successful read of the same canonical path AND the same
 *   line range (offset+limit) supersedes old reads; different pages of one file
 *   are distinct and never prune each other.
 * - edit_file/write_file: a mutation of a path supersedes that path's old reads
 *   across ALL ranges (the whole file changed).
 * - grep: a newer successful call with the exact same semantic arguments
 *   supersedes old results. Partial file overlap is intentionally not enough.
 */
export class RelevancePruner {
  private readonly readByPath = new Map<string, number[]>();
  private readonly observationByKey = new Map<string, number[]>();

  observePush(history: ChatMessage[], msg: ChatMessage, succeeded = true): void {
    try {
      if (!succeeded || msg.role !== 'tool') return;
      const idx = history.length - 1;
      if (idx < 1 || history[idx] !== msg) return;
      const content = toText((msg as { content?: unknown }).content);
      if (content.startsWith(STUB_PREFIX)) return;

      const call = this.callAt(history, idx);
      if (!call) return;

      if (call.name === 'read_file') {
        const path = canonicalizePath(extractPath(call.argsRaw));
        if (!path) return;
        const list = this.readByPath.get(path) ?? [];
        list.push(idx);
        this.readByPath.set(path, list);
        return;
      }

      const key = observationKey(call);
      if (!key) return;
      const list = this.observationByKey.get(key) ?? [];
      list.push(idx);
      this.observationByKey.set(key, list);
    } catch {
      // Relevance pruning must never block tool-result insertion.
    }
  }
  private callAt(history: ChatMessage[], idx: number): ToolCallInfo | null {
    const tcId = (history[idx] as AnyMessage)?.tool_call_id;
    if (!tcId) return null;
    for (let j = idx - 1; j >= 1; j--) {
      const message = history[j];
      if (message.role !== 'assistant') continue;
      const calls = (message as { tool_calls?: ToolCallShape[] }).tool_calls;
      const hit = calls?.find((tc) => tc?.id === tcId);
      if (!hit?.function?.name) continue;
      const argsRaw = hit.function.arguments ?? '';
      return { name: hit.function.name, argsRaw, args: parseArgs(argsRaw) };
    }
    return null;
  }

  observeMutation(_history: ChatMessage[], _path: string): void {
    // Mutations are retained as provenance. pruneSuperseded() derives their
    // impact only when the scheduler enters real context pressure.
  }

  /**
   * Pressure-only cleanup. Scan the complete history to identify evidence that
   * has an exact newer replacement, but only rewrite messages before the Cold
   * boundary. This keeps the latest four user turns and current work intact.
   */
  pruneSuperseded(history: ChatMessage[], coldBoundary: number): number {
    try {
      // read→read:键 = path + 区间(offset+limit),只淘汰真正重复的同区间旧 read。
      const latestRead = new Map<string, { path: string; range: { offset: number; limit: number }; index: number }>();
      const latestObservation = new Map<string, { tool: string; index: number }>();
      // mutation→read:按 path 记录,稍后淘汰该文件所有区间旧 read。
      const mutations: Array<{ path: string; index: number }> = [];
      for (let idx = 1; idx < history.length; idx++) {
        const message = history[idx] as AnyMessage;
        const content = toText(message.content);
        if (message.role !== 'tool' || content.startsWith('⌦[') || !isToolResultSuccess(content)) continue;
        const call = this.callAt(history, idx);
        if (!call) continue;
        if (call.name === 'read_file') {
          const path = canonicalizePath(extractPath(call.argsRaw));
          const range = readRange(call.argsRaw);
          // path 或区间无法确定 → 保守跳过,不做 read→read 淘汰。
          if (path && range) latestRead.set(`${path}|${range.offset}|${range.limit}`, { path, range, index: idx });
        } else if (call.name === 'edit_file' || call.name === 'write_file') {
          const path = canonicalizePath(extractPath(call.argsRaw));
          if (path) mutations.push({ path, index: idx });
        }
        const key = observationKey(call);
        if (key) latestObservation.set(key, { tool: call.name, index: idx });
      }

      let pruned = 0;
      for (const entry of latestRead.values()) {
        pruned += this.stubPriorReads(history, entry, coldBoundary, 'range');
      }
      for (const mutation of mutations) {
        pruned += this.stubPriorReads(
          history,
          { path: mutation.path, index: mutation.index },
          coldBoundary,
          'mutation',
        );
      }
      for (const [key, latest] of latestObservation) {
        pruned += this.stubPriorObservations(history, latest.tool, key, latest.index, coldBoundary);
      }
      return pruned;
    } catch {
      return 0;
    }
  }

  /**
   * @param mode 'range'(read→read:仅同区间淘汰) | 'mutation'(文件被改:该 path 全区间淘汰)
   */
  private stubPriorReads(
    history: ChatMessage[],
    target: { path: string; range?: { offset: number; limit: number }; index: number },
    coldBoundary: number,
    mode: 'range' | 'mutation',
  ): number {
    const targetPath = canonicalizePath(target.path);
    if (!targetPath) return 0;
    const reason = mode === 'range' ? READ_RANGE_STUB_REASON : READ_MUTATION_STUB_REASON;
    let pruned = 0;
    for (let idx = 1; idx < Math.min(target.index, coldBoundary); idx++) {
      const message = history[idx] as AnyMessage;
      if (!message || message.role !== 'tool') continue;
      const content = toText(message.content);
      if (content.startsWith('⌦[')) continue;
      const call = this.callAt(history, idx);
      if (call?.name !== 'read_file' || !message.tool_call_id) continue;
      if (canonicalizePath(extractPath(call.argsRaw)) !== targetPath) continue;
      // read→read 必须同区间;mutation→read 不看区间(整文件已变)。
      if (mode === 'range') {
        const priorRange = readRange(call.argsRaw);
        if (
          !priorRange ||
          !target.range ||
          priorRange.offset !== target.range.offset ||
          priorRange.limit !== target.range.limit
        ) {
          continue;
        }
      }
      message.content =
        `${STUB_PREFIX}${reason}] read_file(${targetPath}) ${content.length} 字符 ` +
        `→ 已被新 read / mutation 替代 · id …${message.tool_call_id.slice(-6)}⌫`;
      pruned++;
    }
    return pruned;
  }

  private stubPriorObservations(
    history: ChatMessage[],
    toolName: string,
    key: string,
    beforeIdx: number,
    coldBoundary: number,
  ): number {
    let pruned = 0;
    for (let idx = 1; idx < Math.min(beforeIdx, coldBoundary); idx++) {
      const message = history[idx] as AnyMessage;
      if (!message || message.role !== 'tool') continue;
      const content = toText(message.content);
      if (content.startsWith('⌦[') || !isToolResultSuccess(content)) continue;
      const call = this.callAt(history, idx);
      if (!call || call.name !== toolName || observationKey(call) !== key || !message.tool_call_id) continue;
      message.content =
        `${STUB_PREFIX}相同 grep 查询已有更新结果] ${observationLabel(call)} ${content.length} 字符 ` +
        `→ 已被更新查询替代 · id …${message.tool_call_id.slice(-6)}⌫`;
      pruned++;
    }
    return pruned;
  }
}

export function createRelevancePruner(): RelevancePruner {
  return new RelevancePruner();
}

/** Pressure-only convenience entry point for scheduler-owned pruning. */
export function pruneSuperseded(history: ChatMessage[], coldBoundary: number): number {
  return new RelevancePruner().pruneSuperseded(history, coldBoundary);
}

/** Parse the original content length recorded by any relevance stub. */
function parseStubOriginalLen(stub: string): number | null {
  const match = /\) (\d+) 字符 →/.exec(stub);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Aggregate relevance/lifecycle compression for the /context panel. */
export function computePruneStats(history: ChatMessage[]): {
  stubbed: number;
  originalChars: number;
  originalTokens: number;
  stubChars: number;
  freedTokens: number;
} {
  let stubbed = 0;
  let originalChars = 0;
  let stubChars = 0;
  for (const message of history) {
    if (message.role !== 'tool') continue;
    const content = toText((message as { content?: unknown }).content);
    const isPruneStub = content.startsWith(STUB_PREFIX);
    const isDigest = content.startsWith('⌦[摘要:');
    if (!isPruneStub && !isDigest) continue;
    stubbed++;
    stubChars += content.length;
    const original = parseStubOriginalLen(content);
    if (original != null) originalChars += original;
  }
  const originalTokens = Math.ceil(originalChars / 4);
  const stubTokens = Math.ceil(stubChars / 4);
  return {
    stubbed,
    originalChars,
    originalTokens,
    stubChars,
    freedTokens: Math.max(0, originalTokens - stubTokens),
  };
}
