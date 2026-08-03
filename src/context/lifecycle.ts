// Observation Lifecycle Engine: provenance metadata only.
//
// Tool-call count is not context pressure, so this module never ages, digests,
// stubs, or otherwise rewrites history. It only records producer/consumer
// relationships for diagnostics and future pressure-aware decisions.

import type { ChatMessage } from '../llm/index.js';
import {
  canonicalizePath,
  extractPath,
  isToolResultSuccess,
  toText,
  toolNameOf,
} from './utils.js';

type AnyMessage = ChatMessage & { content?: unknown; tool_call_id?: string };

/** OBSOLETE/STUB remain in the public shape for resumed legacy histories. */
export type LifeState = 'LIVE' | 'REFERENCED' | 'OBSOLETE' | 'STUB';

const OBSERVER_TOOLS = new Set(['grep', 'glob', 'web_search', 'web_fetch']);
const CONSUMER_TOOLS = new Set(['read_file', 'edit_file', 'write_file']);
const DIGEST_PREFIX = '⌦[摘要:';

function extractProducerPaths(toolName: string, content: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    const normalized = canonicalizePath(raw);
    if (normalized) paths.add(normalized);
  };
  try {
    if (toolName === 'grep') {
      const rawLine = /^(.+?\.[A-Za-z0-9]+):\d+:/gm;
      const summary = /^(.+?\.[A-Za-z0-9]+):\s*\d+\s*(?:处匹配|matches?)[,，]/gmi;
      let match: RegExpExecArray | null;
      while ((match = rawLine.exec(content))) add(match[1]);
      while ((match = summary.exec(content))) add(match[1]);
    } else if (toolName === 'glob') {
      for (const line of content.split(/\r?\n/)) {
        const value = line.trim();
        if (value && !value.includes(' ') && (/\.[A-Za-z0-9]+$/.test(value) || value.includes('/') || value.includes('\\'))) add(value);
      }
    }
  } catch {
    // Metadata extraction is best-effort and must never block the agent.
  }
  return [...paths];
}

export class LifecycleEngine {
  private readonly states = new Map<number, LifeState>();
  private readonly consumerCount = new Map<number, number>();
  private readonly producersByPath = new Map<string, number[]>();
  private readonly digestedIdxs = new Set<number>();

  constructor(history?: ChatMessage[]) {
    if (history) this.rehydrate(history);
  }

  private callArgs(history: ChatMessage[], idx: number): string {
    try {
      const toolCallId = (history[idx] as AnyMessage)?.tool_call_id;
      if (!toolCallId) return '';
      for (let cursor = idx - 1; cursor >= 1; cursor--) {
        const message = history[cursor];
        if (message.role !== 'assistant') continue;
        const calls = (message as {
          tool_calls?: Array<{ id?: string; function?: { arguments?: string } }>;
        }).tool_calls;
        const hit = calls?.find((call) => call.id === toolCallId);
        if (hit) return hit.function?.arguments ?? '';
      }
    } catch {
      // Ignore malformed resumed history.
    }
    return '';
  }

  private registerProducer(history: ChatMessage[], idx: number, toolName: string, content: string): void {
    if (!OBSERVER_TOOLS.has(toolName)) return;
    for (const path of extractProducerPaths(toolName, content)) {
      const producers = this.producersByPath.get(path) ?? [];
      if (!producers.includes(idx)) producers.push(idx);
      this.producersByPath.set(path, producers);
    }
  }

  private markProducerConsumers(history: ChatMessage[], idx: number, toolName: string): void {
    if (!CONSUMER_TOOLS.has(toolName)) return;
    const path = canonicalizePath(extractPath(this.callArgs(history, idx)));
    if (!path) return;
    for (const producerIdx of this.producersByPath.get(path) ?? []) {
      if (producerIdx >= idx) continue;
      if (this.states.get(producerIdx) === 'LIVE') this.states.set(producerIdx, 'REFERENCED');
      this.consumerCount.set(producerIdx, (this.consumerCount.get(producerIdx) ?? 0) + 1);
    }
  }

  private rehydrate(history: ChatMessage[]): void {
    try {
      for (let idx = 1; idx < history.length; idx++) {
        const message = history[idx] as AnyMessage;
        if (message.role !== 'tool') continue;
        const toolName = toolNameOf(history, idx);
        if (!toolName) continue;
        const content = toText(message.content);
        if (content.startsWith(DIGEST_PREFIX)) {
          this.states.set(idx, 'REFERENCED');
          this.consumerCount.set(idx, 0);
          this.digestedIdxs.add(idx);
          continue;
        }
        if (content.startsWith('⌦[')) {
          this.states.set(idx, 'STUB');
          this.consumerCount.set(idx, 0);
          continue;
        }
        if (!isToolResultSuccess(content)) continue;
        this.states.set(idx, 'LIVE');
        this.consumerCount.set(idx, 0);
        this.registerProducer(history, idx, toolName, content);
        this.markProducerConsumers(history, idx, toolName);
      }
    } catch {
      // A partial graph is safer than altering execution.
    }
  }

  /** Register a result without changing message content. */
  pushTool(history: ChatMessage[], idx: number, succeeded = true): void {
    try {
      const message = history[idx] as AnyMessage;
      if (!succeeded || message?.role !== 'tool') return;
      const toolName = toolNameOf(history, idx);
      const content = toText(message.content);
      if (!toolName || content.startsWith('⌦[')) return;
      this.states.set(idx, 'LIVE');
      this.consumerCount.set(idx, 0);
      this.registerProducer(history, idx, toolName, content);
      this.markProducerConsumers(history, idx, toolName);
    } catch {
      // Lifecycle metadata must never block tool-result insertion.
    }
  }

  /** Record exact-path mutation consumption without stubbing old reads. */
  pushMutation(history: ChatMessage[], mutationIdx: number, path: string): void {
    try {
      const mutationPath = canonicalizePath(path);
      if (!mutationPath) return;
      for (let idx = 1; idx < mutationIdx; idx++) {
        const message = history[idx] as AnyMessage;
        if (message?.role !== 'tool' || toolNameOf(history, idx) !== 'read_file') continue;
        if (canonicalizePath(extractPath(this.callArgs(history, idx))) !== mutationPath) continue;
        if (this.states.get(idx) === 'LIVE') this.states.set(idx, 'REFERENCED');
        this.consumerCount.set(idx, (this.consumerCount.get(idx) ?? 0) + 1);
      }
    } catch {
      // Provenance tracking is best-effort.
    }
  }

  getState(idx: number): LifeState | null {
    return this.states.get(idx) ?? null;
  }

  stats(): { live: number; referenced: number; digested: number; obsolete: number; stubbed: number } {
    let live = 0;
    let referenced = 0;
    let obsolete = 0;
    let stubbed = 0;
    for (const state of this.states.values()) {
      if (state === 'LIVE') live++;
      else if (state === 'REFERENCED') referenced++;
      else if (state === 'OBSOLETE') obsolete++;
      else if (state === 'STUB') stubbed++;
    }
    return {
      live,
      referenced: Math.max(0, referenced - this.digestedIdxs.size),
      digested: this.digestedIdxs.size,
      obsolete,
      stubbed,
    };
  }
}

export function createLifecycleEngine(history?: ChatMessage[]): LifecycleEngine {
  return new LifecycleEngine(history);
}
