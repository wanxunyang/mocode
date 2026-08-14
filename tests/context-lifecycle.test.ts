/** LifecycleEngine 单元测试(从 scripts/core-tests/lifecycle.test.ts 迁移到 node:test)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/llm/index.js';
import { LifecycleEngine } from '../src/context/lifecycle.js';
import { appendTool, contentAt, system } from './helpers.js';

test('LifecycleEngine 不按成功工具调用次数老化或归档正文', () => {
  const history: ChatMessage[] = [system()];
  const orphanIdx = appendTool(history, 'run_command', 'orphan', { command: 'echo old' }, 'old output');
  const engine = new LifecycleEngine();
  engine.pushTool(history, orphanIdx, true);
  history.push({ role: 'user', content: 'next' } as ChatMessage);
  for (let index = 0; index < 20; index++) {
    const nextIdx = appendTool(history, 'run_command', `next-${index}`, {}, 'ok');
    engine.pushTool(history, nextIdx, true);
  }
  assert.equal(engine.getState(orphanIdx), 'LIVE');
  assert.equal(contentAt(history, orphanIdx), 'old output');
  assert.equal(engine.stats().obsolete, 0);
  assert.equal(engine.stats().stubbed, 0);
});

test('LifecycleEngine 将同路径 observer 标为 REFERENCED', () => {
  const history: ChatMessage[] = [system()];
  const grepIdx = appendTool(history, 'grep', 'grep-1', { pattern: 'x' }, 'src/a.ts:1: x');
  const engine = new LifecycleEngine();
  engine.pushTool(history, grepIdx, true);
  const readIdx = appendTool(history, 'read_file', 'read-1', { path: 'src/a.ts' }, 'contents');
  engine.pushTool(history, readIdx, true);
  assert.equal(engine.getState(grepIdx), 'REFERENCED');
  assert.equal(engine.stats().referenced, 1);
  assert.equal(contentAt(history, grepIdx), 'src/a.ts:1: x');
});

test('LifecycleEngine mutation 只更新 read provenance', () => {
  const history: ChatMessage[] = [system()];
  const readIdx = appendTool(history, 'read_file', 'read-1', { path: 'src/a.ts' }, 'old contents');
  const engine = new LifecycleEngine();
  engine.pushTool(history, readIdx, true);
  const writeIdx = appendTool(history, 'write_file', 'write-1', { path: 'src/a.ts' }, 'written');
  engine.pushTool(history, writeIdx, true);
  engine.pushMutation(history, writeIdx, 'src/a.ts');
  assert.equal(engine.getState(readIdx), 'REFERENCED');
  assert.equal(contentAt(history, readIdx), 'old contents');
});
