/** 定时压缩(80% 压力线)的断路器:压不下去就别每步都重来一次。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatTransport } from '../../src/llm/index.js';
import { createContextState, type CompactionRuntime } from '../../src/session/compact.js';
import { createBudgetScheduler } from '../../src/session/scheduler.js';
import { appendTool, system } from '../helpers.js';

function makeRuntime(window: number, transport: ChatTransport): CompactionRuntime {
  return {
    config: {
      contextWindowTokens: window,
      autoCompact: true,
      contextBudget: true,
      contextRelprune: false,
      contextOptimize: false,
      lowPressureRatio: 0.6,
      toolClearing: true,
    },
    modelTransport: transport,
  };
}

/**
 * 构造「压缩束手无策」:唯一的内容全在热区(最近 4 个 user turn 之内),
 * 于是 compactHistory 只能给出 noop-protected,压完仍在压力线之上。
 */
function stuckHistory(): ChatMessage[] {
  const history: ChatMessage[] = [system()];
  history.push({ role: 'user', content: 'keep going' } as ChatMessage);
  appendTool(history, 'read_file', 'hot-read', { path: 'src/big.ts' }, 'x'.repeat(30_000));
  return history;
}

test('压缩后仍超阈:同一 scheduler run 内只尝试一次,后续 step 直接跳过', async () => {
  let transportCalls = 0;
  const transport: ChatTransport = async () => {
    transportCalls++;
    return { content: '## Completed\nsummary body', toolCalls: [] };
  };
  // 窗口 2000 → 压力线 1600;热区里 30k 字符的工具结果 ≈ 7.5k token,远超线。
  const history = stuckHistory();
  const scheduler = createBudgetScheduler(createContextState(), makeRuntime(2_000, transport));

  await scheduler.runStep(history, 0, []);
  const first = scheduler.lastRunLog;
  assert.ok(first);
  assert.equal(first.pressure.triggered, true, '占用超线');
  assert.equal(first.compactHistoryCalled, true, '第一次仍然尝试压缩');
  assert.equal(first.breakerOpen, true, '压完仍在线上,断路器打开');

  // 第二步:压力仍在,但不应再付一次压缩(哪怕目标只是 noop,也没有意义)。
  await scheduler.runStep(history, 1, []);
  const second = scheduler.lastRunLog;
  assert.ok(second);
  assert.equal(second.pressure.triggered, true, '占用依旧超线');
  assert.equal(second.compactHistoryCalled, false, '断路器已开:不得再次调用 maybeCompact');
  assert.equal(second.breakerOpen, true);
  assert.deepEqual(second.actions, [], '被挡下的动作不再出现在日志里');
  assert.equal(transportCalls, 0, 'noop-protected 本就不调模型,断路器也不该额外调用');
});

test('没有超线时断路器不开,正常走低压/无动作路径', async () => {
  const transport: ChatTransport = async () => ({ content: '', toolCalls: [] });
  const history: ChatMessage[] = [system(), { role: 'user', content: 'hi' } as ChatMessage];
  const scheduler = createBudgetScheduler(createContextState(), makeRuntime(100_000, transport));

  await scheduler.runStep(history, 0, []);
  const log = scheduler.lastRunLog;
  assert.ok(log);
  assert.equal(log.pressure.triggered, false);
  assert.equal(log.compactHistoryCalled, false);
  assert.equal(log.breakerOpen, false, '未压缩过的 run 不应带断路器标记');
});
