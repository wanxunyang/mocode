import assert from 'node:assert/strict';
import test from 'node:test';
import { compactOverlappingReads } from '../../src/context/overlapping-reads.js';
import { measureContextUsage } from '../../src/context/usage-snapshot.js';
import { estimateMessagesTokens, type ChatMessage } from '../../src/llm/index.js';
import { createContextState } from '../../src/session/compact.js';

function page(start: number, end: number, version = 'a'): ChatMessage {
  const header = `[artifact source=read_file path=/workspace/some file.ts hash=sha256:${version.repeat(64)}]`;
  const lines = Array.from({ length: end - start + 1 }, (_, index) => {
    const line = start + index;
    return `${String(line).padStart(6)}\texport const item${line} = "${'text '.repeat(16)}";`;
  });
  return { role: 'tool', tool_call_id: `${start}-${end}`, content: [header, ...lines].join('\n') };
}

test('模型请求只省略更早已出现的同行原文，保留连续页的新行和完整历史', () => {
  const first = page(1, 60);
  const second = page(30, 90);
  const history: ChatMessage[] = [{ role: 'user', content: 'Compare both pages' }, first, second];
  const sent = compactOverlappingReads(history);
  assert.equal(sent[1], first);
  assert.match(String(sent[2].content), /Lines 30–60 already shown/);
  assert.doesNotMatch(String(sent[2].content), /\t.*item60/);
  assert.match(String(sent[2].content), /\t.*item61/);
  assert.equal(history[2], second);
  assert.match(String(history[2].content), /\t.*item60/);
  // 追加一轮不能让上一轮已折叠的请求前缀膨胀，也不能借用跨轮原文。
  const next: ChatMessage[] = [...history, { role: 'user', content: 'Read again' }, page(30, 90)];
  const sentNext = compactOverlappingReads(next);
  assert.deepEqual(sentNext.slice(0, 3), sent);
  assert.equal(sentNext[4], next[4]);
  const state = createContextState();
  state.activeTools = [];
  assert.equal(measureContextUsage(history, 100_000, state).tokens, estimateMessagesTokens(sent));
});

test('版本变化、旧页被压缩或原文不再可见时保留完整分页', () => {
  const old = page(1, 60);
  const versions = [old, page(30, 90, 'b')];
  assert.equal(compactOverlappingReads(versions), versions);
  const capped: ChatMessage = { ...old, content: String(old.content) + '\n…[已截断 1024 字符]…' };
  const afterCap = [capped, page(30, 90)];
  assert.equal(compactOverlappingReads(afterCap), afterCap);
  const afterSummary = [page(30, 90)];
  assert.equal(compactOverlappingReads(afterSummary), afterSummary);
});
