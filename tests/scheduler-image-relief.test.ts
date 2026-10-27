/** 压力线触发时「先剥图再决定是否摘要」(scheduler.runStep 的图片先行逻辑)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatTransport } from '../src/llm/index.js';
import { createContextState, type CompactionRuntime } from '../src/session/compact.js';
import { createBudgetScheduler } from '../src/session/scheduler.js';
import { appendTool, system } from './helpers.js';

/** 只有头 33 字节的假 PNG:imageSizeFromDataUrl 只解 IHDR,token 按声明的像素面积估(w*h/750)。 */
function fakePngDataUrl(width: number, height: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
}

/** 用户粘贴图(无工具附件前言,不属于 computer- 屏幕帧)。每张约 21k token。 */
function bigImageMessage(label: string): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: label },
      { type: 'image_url', image_url: { url: fakePngDataUrl(4000, 4000) } },
    ],
  } as ChatMessage;
}

function countImages(history: ChatMessage[]): number {
  let n = 0;
  for (const m of history) {
    const c = (m as { content?: unknown }).content;
    if (!Array.isArray(c)) continue;
    for (const p of c) if ((p as { type?: string }).type === 'image_url') n++;
  }
  return n;
}

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

test('压力线由图撑起时:先剥图(留最新一张),剥后低于线则不摘要、不调 LLM', async () => {
  let transportCalls = 0;
  const transport: ChatTransport = async () => {
    transportCalls++;
    return { content: '## Completed\nshould not be called', toolCalls: [] };
  };
  // 窗口 100k,压力线 80k;5 张图 ≈ 106k 超线,剥到 1 张 ≈ 21k 远低于线。
  const history: ChatMessage[] = [system()];
  for (let i = 0; i < 5; i++) history.push(bigImageMessage(`img-${i}`));
  history.push({ role: 'user', content: 'please continue' } as ChatMessage);

  const scheduler = createBudgetScheduler(createContextState(), makeRuntime(100_000, transport));
  const rebuilt = await scheduler.runStep(history, 0, []);

  const log = scheduler.lastRunLog;
  assert.ok(log);
  assert.equal(rebuilt, false);
  assert.equal(log.pressure.imagesRelieved, 4, '5 张里剥掉 4 张,保留最新一张');
  assert.equal(countImages(history), 1);
  assert.equal(log.pressure.triggered, false, '剥图后占用已低于压力线');
  assert.equal(log.compactHistoryCalled, false, '图片压力不得拉起摘要');
  assert.equal(transportCalls, 0);
  assert.equal(log.historyMutation, 'content', '剥图本身算内容变更,调用方需重建索引');
});

test('文本本身超线时:剥图后仍照常摘要(图片先行不吞掉真正的文本压力)', async () => {
  let transportCalls = 0;
  const transport: ChatTransport = async () => {
    transportCalls++;
    return { content: '## Completed\nsummary body', toolCalls: [] };
  };
  // 窗口 2000,压力线 1600;大工具结果 + 两张图,剥图后文本仍然超线。
  const history: ChatMessage[] = [system()];
  appendTool(history, 'read_file', 'old-read', { path: 'src/old.ts' }, 'x'.repeat(30_000));
  history.push(bigImageMessage('img-a'));
  history.push(bigImageMessage('img-b'));
  history.push({ role: 'user', content: 'continue' } as ChatMessage);
  appendTool(history, 'run_command', 'latest', { command: 'echo ok' }, 'ok');

  const scheduler = createBudgetScheduler(createContextState(), makeRuntime(2_000, transport));
  await scheduler.runStep(history, 0, []);

  const log = scheduler.lastRunLog;
  assert.ok(log);
  assert.equal(log.pressure.imagesRelieved, 1);
  assert.equal(log.pressure.triggered, true, '文本仍超线');
  assert.equal(log.compactHistoryCalled, true, '文本超线仍要摘要');
  assert.equal(transportCalls, 1, '摘要确实走了一次模型调用');
});

test('没有图片时不改动 history,imagesRelieved 为 0', async () => {
  const transport: ChatTransport = async () => ({ content: '', toolCalls: [] });
  const history: ChatMessage[] = [system(), { role: 'user', content: 'hi' } as ChatMessage];
  const before = history.slice();
  const scheduler = createBudgetScheduler(createContextState(), makeRuntime(100_000, transport));
  await scheduler.runStep(history, 0, []);
  assert.equal(scheduler.lastRunLog?.pressure.imagesRelieved, 0);
  assert.deepEqual(history, before);
});
