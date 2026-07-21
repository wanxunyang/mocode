// Relevance Pruner: statically removes tool results that a newer observation supersedes.
// It never deletes messages or changes tool_call_id pairing; only tool content is stubbed.

import type { ChatMessage } from '../llm/index.js';
import {
  canonicalizePath,
  extractPath,
  isToolResultSuccess,
  lastUserIndex,
  toText,
} from './utils.js';

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
const READ_STUB_REASON = '同 path 已有新 read / 已被 mutation 覆写';

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizedInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
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
 * - read_file: a newer successful read of the same canonical path supersedes old reads.
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
        this.stubPriorReads(history, path, idx);
        const list = this.readByPath.get(path) ?? [];
        list.push(idx);
        this.readByPath.set(path, list);
        return;
      }

      const key = observationKey(call);
      if (!key) return;
      this.stubPriorObservations(history, call.name, key, idx);
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

  observeMutation(history: ChatMessage[], path: string): void {
    try {
      const canonicalPath = canonicalizePath(path);
      if (!canonicalPath) return;
      const idx = history.length - 1;
      if (idx < 1) return;
      this.stubPriorReads(history, canonicalPath, idx);
      this.readByPath.delete(canonicalPath);
    } catch {
      // Never throw from mutation cleanup.
    }
  }

  private stubPriorReads(history: ChatMessage[], path: string, beforeIdx: number): void {
    const targetPath = canonicalizePath(path);
    if (!targetPath) return;
    const protectedFrom = Math.max(0, lastUserIndex(history));

    const stubOne = (idx: number): void => {
      if (idx >= beforeIdx || (protectedFrom > 0 && idx >= protectedFrom)) return;
      const message = history[idx] as AnyMessage;
      if (!message || message.role !== 'tool') return;
      const content = toText(message.content);
      if (content.startsWith(STUB_PREFIX)) return;
      const call = this.callAt(history, idx);
      if (call?.name !== 'read_file') return;
      if (canonicalizePath(extractPath(call.argsRaw)) !== targetPath) return;
      if (!message.tool_call_id) return;
      message.content =
        `${STUB_PREFIX}${READ_STUB_REASON}] read_file(${targetPath}) ${content.length} 字符 ` +
        `→ 已被新 read / mutation 替代 · id …${message.tool_call_id.slice(-6)}⌫`;
    };

    for (const idx of this.readByPath.get(targetPath) ?? []) stubOne(idx);
    const scanEnd = Math.min(beforeIdx, protectedFrom > 0 ? protectedFrom : beforeIdx);
    for (let idx = 1; idx < scanEnd; idx++) stubOne(idx);
  }
  private stubPriorObservations(
    history: ChatMessage[],
    toolName: string,
    key: string,
    beforeIdx: number,
  ): void {
    const protectedFrom = Math.max(0, lastUserIndex(history));

    const stubOne = (idx: number): void => {
      if (idx >= beforeIdx || (protectedFrom > 0 && idx >= protectedFrom)) return;
      const message = history[idx] as AnyMessage;
      if (!message || message.role !== 'tool') return;
      const content = toText(message.content);
      if (content.startsWith(STUB_PREFIX) || !isToolResultSuccess(content)) return;
      const call = this.callAt(history, idx);
      if (!call || call.name !== toolName || observationKey(call) !== key) return;
      if (!message.tool_call_id) return;
      const reason = '相同 grep 查询已有更新结果';
      message.content =
        `${STUB_PREFIX}${reason}] ${observationLabel(call)} ${content.length} 字符 ` +
        `→ 已被更新查询替代 · id …${message.tool_call_id.slice(-6)}⌫`;
    };

    for (const idx of this.observationByKey.get(key) ?? []) stubOne(idx);
    // The fallback scan restores correctness after resume/compact when this instance
    // has no index for older messages.
    const scanEnd = Math.min(beforeIdx, protectedFrom > 0 ? protectedFrom : beforeIdx);
    for (let idx = 1; idx < scanEnd; idx++) stubOne(idx);
  }
}

export function createRelevancePruner(): RelevancePruner {
  return new RelevancePruner();
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
