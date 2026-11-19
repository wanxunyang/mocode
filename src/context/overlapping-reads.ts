import type { ChatMessage } from '../llm/index.js';

const READ_HEADER = /^\[artifact source=read_file path=.+ hash=sha256:[a-f0-9]{64}\]$/;
const NUMBERED_LINE = /^ *([1-9]\d*)\t/;
const MIN_RESULT_CHARS = 4_000;
const MIN_SAVED_CHARS = 800;

/** 从实际会发出的同轮工具结果中复用原文。持久化历史和工具界面仍持有完整结果。 */
export function compactOverlappingReads(history: ChatMessage[]): ChatMessage[] {
  const earlierVersions = new Map<string, string | Set<string>>();
  let result = history;
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === 'user') earlierVersions.clear();
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const content = message.content;
    const headerEnd = content.indexOf('\n');
    if (headerEnd < 0 || !READ_HEADER.test(content.slice(0, headerEnd))) continue;
    if (content.includes('…[已截断')) continue;
    const header = content.slice(0, headerEnd);
    const previous = earlierVersions.get(header);
    if (previous === undefined) {
      earlierVersions.set(header, content);
      continue;
    }
    const prior =
      typeof previous === 'string'
        ? new Set(previous.split('\n').filter((line) => NUMBERED_LINE.test(line)))
        : previous;
    earlierVersions.set(header, prior);
    const output: string[] = [header];
    let start = 0;
    let end = 0;
    const flush = (): void => {
      if (!start) return;
      output.push(`[Lines ${start}–${end} already shown above for this file version.]`);
      start = 0;
    };
    for (const line of content.slice(headerEnd + 1).split('\n')) {
      const match = NUMBERED_LINE.exec(line);
      const number = Number(match?.[1]);
      if (match && content.length >= MIN_RESULT_CHARS && prior.has(line)) {
        if (start && number !== end + 1) flush();
        if (!start) start = number;
        end = number;
      } else {
        flush();
        output.push(line);
      }
      if (match) prior.add(line);
    }
    flush();
    const compacted = output.join('\n');
    if (content.length - compacted.length < MIN_SAVED_CHARS) continue;
    if (result === history) result = history.slice();
    result[i] = { ...message, content: compacted };
  }
  return result;
}
