/** RelevancePruner 单元测试(从 scripts/core-tests/relevance.test.ts 迁移到 node:test)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/llm/index.js';
import { computePruneStats, RelevancePruner } from '../src/context/relevance.js';
import { appendTool, contentAt, system } from './helpers.js';

test('RelevancePruner 常态只记录，pressure pass 才裁剪 Cold 同路径 read', () => {
  const history: ChatMessage[] = [system()];
  const oldIdx = appendTool(history, 'read_file', 'read-old', { path: 'src\\same.ts' }, 'old contents');
  history.push({ role: 'user', content: 'next turn' } as ChatMessage);
  const newIdx = appendTool(history, 'read_file', 'read-new', { path: './src/same.ts' }, 'new contents');
  const pruner = new RelevancePruner();
  pruner.observePush(history, history[newIdx], true);
  assert.equal(contentAt(history, oldIdx), 'old contents');
  assert.equal(pruner.pruneSuperseded(history, newIdx), 1);
  assert.match(contentAt(history, oldIdx), /^⌦\[已过时:/);
  assert.equal(contentAt(history, newIdx), 'new contents');
  assert.equal((history[oldIdx] as { tool_call_id?: string }).tool_call_id, 'read-old');
  const stats = computePruneStats(history);
  assert.equal(stats.stubbed, 1);
  assert.equal(stats.originalChars, 'old contents'.length);
});

test('RelevancePruner 不裁剪 Hot/current evidence，失败 read 不参与', () => {
  const history: ChatMessage[] = [system(), { role: 'user', content: 'current' } as ChatMessage];
  const oldIdx = appendTool(history, 'read_file', 'old', { path: 'src/a.ts' }, 'still needed');
  const failedIdx = appendTool(history, 'read_file', 'failed', { path: 'src/a.ts' }, '错误: missing');
  const pruner = new RelevancePruner();
  pruner.observePush(history, history[failedIdx], false);
  assert.equal(pruner.pruneSuperseded(history, oldIdx), 0);
  assert.equal(contentAt(history, oldIdx), 'still needed');
});

test('RelevancePruner mutation 通知不改正文，pressure 才裁精确路径', () => {
  const history: ChatMessage[] = [system()];
  const sameIdx = appendTool(history, 'read_file', 'same', { path: 'src/a.ts' }, 'same old');
  const otherIdx = appendTool(history, 'read_file', 'other', { path: 'src/b.ts' }, 'other old');
  const mutationIdx = appendTool(history, 'edit_file', 'edit', { path: 'src/a.ts' }, 'ok');
  const pruner = new RelevancePruner();
  pruner.observeMutation(history, '.\\src\\a.ts');
  assert.equal(contentAt(history, sameIdx), 'same old');
  assert.equal(pruner.pruneSuperseded(history, mutationIdx), 1);
  assert.match(contentAt(history, sameIdx), /^⌦\[已过时:/);
  assert.equal(contentAt(history, otherIdx), 'other old');
});
