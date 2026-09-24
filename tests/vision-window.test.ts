// 视觉历史滑动窗口单测(design-notes/vision-window.md Part 6)。
// 全部纯内存构造:不依赖 GUI、不启常驻进程、不发网络请求,CI 可跑。
//
// 测试形态:TS 源码经 tsconfig.test-build.json 编译到 dist-tests/ 后用 node --test 跑。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChatMessage, ToolCallRef } from '../src/llm/index.js';
import { ATTACHMENT_PREAMBLE } from '../src/agent/tool-turn.js';
import {
  applyVisionWindow,
  isFrameCarrier,
  visionWindowStats,
  getVisionWindowTelemetry,
  resetVisionWindowTelemetry,
} from '../src/context/vision-window.js';
import { createStagedHistoryManager } from '../src/agent/stages/history-manager.js';
import type { HistoryManager } from '../src/agent/stages/contracts.js';
import { visionBatch, visionKeep, DEFAULT_VISION_KEEP, DEFAULT_VISION_BATCH } from '../src/config/index.js';

/** 1×1 PNG;imageTokens 解析不出尺寸时会走 85 兜底,不影响本文件的结构与算法断言。 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgo=';

function imagePart(): { type: 'image_url'; image_url: { url: string } } {
  return { type: 'image_url', image_url: { url: TINY_PNG } };
}

/** 复刻 tool-turn.ts:99-118 的附件消息形状(前言 + N 张图)。 */
function frameMessage(...names: string[]): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${ATTACHMENT_PREAMBLE}${names.join(', ')}. Analyze the attached image content directly.` },
      ...names.map(() => imagePart()),
    ],
  } as ChatMessage;
}

/** 用户粘贴的图:同样是 ContentPart[],但没有工具附件前言。 */
function userPastedImageMessage(): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text: '看看这张图' }, imagePart()] } as ChatMessage;
}

function hashOf(messages: readonly ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function countImages(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'image_url') n++;
    }
  }
  return n;
}

function historyFrames(messages: readonly ChatMessage[]): number {
  return visionWindowStats(messages).frames;
}

test('#1 成批淘汰时机:keep=2/batch=3 时,帧数到 keep+batch 才一次性丢 batch 条', () => {
  const messages: ChatMessage[] = [];
  // n=1..4 都不动(n - keep < batch)。
  for (let n = 1; n <= 4; n++) {
    messages.push(frameMessage(`computer-result.png`));
    const r = applyVisionWindow(messages, { keep: 2, batch: 3, step: n });
    assert.equal(r.changed, false, `n=${n} 不应触发剪枝`);
  }
  assert.equal(historyFrames(messages), 4);
  // n=5 = keep + batch → 一次丢 3 条,剩 2 条。
  messages.push(frameMessage('computer-result.png'));
  const dropped = applyVisionWindow(messages, { keep: 2, batch: 3, step: 5 });
  assert.equal(dropped.changed, true);
  assert.equal(dropped.dropped, 3);
  assert.equal(historyFrames(dropped.messages), 2);
  assert.equal(countImages(dropped.messages), 2);
});

test('#2 前缀字节稳定:12 步内只在淘汰时刻变化,两次淘汰之间哈希完全相同', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' } as ChatMessage];
  const keep = 4;
  const batch = 2;
  // 每步比对「上一步结束时就已经存在的那一段」——这才是要验证的前缀。
  // 直接哈希整个数组没有意义:每步追加新消息本来就会让整体字节变化。
  let previous: ChatMessage[] = [...messages];
  let rewrites = 0;
  for (let step = 1; step <= 12; step++) {
    const previousEnd = previous.length;
    messages.push({ role: 'tool', tool_call_id: `c${step}`, content: `res ${step}` } as ChatMessage);
    messages.push(frameMessage('computer-result.png'));
    const r = applyVisionWindow(messages, { keep, batch, step });
    if (r.changed) messages.splice(0, messages.length, ...r.messages);
    // 已追加过的字节是否被改写过 → 淘汰之外的每一步都必须完全一致。
    if (hashOf(messages.slice(0, previousEnd)) !== hashOf(previous)) rewrites++;
    previous = [...messages];
  }
  // 每攒到 keep+batch 条就丢 batch 条:淘汰次数 == floor((n - keep) / batch)。
  const expected = Math.floor((12 - keep) / batch);
  assert.equal(rewrites, expected, `前缀改写次数应等于淘汰次数 ${expected}`);
  // 落在 [keep, keep+batch-1] 区间内,不随步数线性涨。
  const frames = historyFrames(messages);
  assert.ok(frames >= keep && frames <= keep + batch - 1, `在途帧数 ${frames} 应停在 [4, 5]`);
});

test('#3 幂等:第二次调用是 no-op,且返回入参引用', () => {
  const input: ChatMessage[] = Array.from({ length: 9 }, () => frameMessage('computer-result.png'));
  const first = applyVisionWindow(input, { keep: 2, batch: 3, step: 1 });
  assert.equal(first.changed, true);
  const second = applyVisionWindow(first.messages, { keep: 2, batch: 3, step: 2 });
  assert.equal(second.changed, false, '已剪过的消息不再命中「含 image_url」规则');
  assert.equal(second.messages, first.messages, '未变化时必须返回入参引用');
  assert.equal(countImages(second.messages), countImages(first.messages));
});

test('#4 未达阈值零开销:changed=false 且原样返回入参引用', () => {
  const input: ChatMessage[] = Array.from({ length: 5 }, () => frameMessage('computer-screenshot.png'));
  const r = applyVisionWindow(input, { keep: 6, batch: 4, step: 1 });
  assert.equal(r.changed, false);
  assert.equal(r.messages, input, '不得产生不等长拷贝');
  assert.equal(r.messages.length, input.length);
});

test('#5 tool 配对不受影响:剪枝后 role 序列与 tool_call_id 一一对应', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' } as ChatMessage];
  for (let step = 1; step <= 8; step++) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'computer', arguments: '{}' } }],
    } as ChatMessage);
    messages.push({ role: 'tool', tool_call_id: `c${step}`, content: 'ok' } as ChatMessage);
    messages.push(frameMessage('computer-result.png'));
  }
  const before = messages.map((m) => (m as { role?: string }).role);
  const result = applyVisionWindow(messages, { keep: 2, batch: 4, step: 8 });
  assert.equal(result.changed, true);
  const after = result.messages.map((m) => (m as { role?: string }).role);
  assert.deepEqual(after, before, 'role 序列不得变化');
  assert.equal(result.messages.length, messages.length, '消息条数不得变化');

  const expectedIds = messages
    .filter((m) => (m as { role?: string }).role === 'tool')
    .map((m) => (m as { tool_call_id?: string }).tool_call_id);
  const actualIds = result.messages
    .filter((m) => (m as { role?: string }).role === 'tool')
    .map((m) => (m as { tool_call_id?: string }).tool_call_id);
  assert.deepEqual(actualIds, expectedIds, 'tool_call_id 必须保持一一对应');
});

test('#6 白名单:read_file 文档图 / 用户粘贴图 / 混合消息均不被剪', () => {
  const docImageAttachment = frameMessage('diagram.png');
  const userPasted = userPastedImageMessage();
  const mixed = frameMessage('computer-result.png', 'report.png');
  assert.equal(isFrameCarrier(docImageAttachment), false, 'read_file 的文档图附件不在白名单');
  assert.equal(isFrameCarrier(userPasted), false, '用户粘贴图不带附件前言');
  assert.equal(isFrameCarrier(mixed), false, '混进非屏幕帧时整条保留(剪掉是净损失)');
  assert.equal(isFrameCarrier(frameMessage('computer-zoom.png')), true);
  assert.equal(isFrameCarrier(frameMessage('computer-screenshot.png')), true);

  const messages: ChatMessage[] = [
    docImageAttachment,
    userPasted,
    mixed,
    ...Array.from({ length: 8 }, () => frameMessage('computer-result.png')),
  ];
  const result = applyVisionWindow(messages, { keep: 1, batch: 2, step: 9 });
  assert.equal(result.changed, true);
  assert.equal(countImages(result.messages.slice(0, 3)), 4, '前三条非窗口图片必须原样保留(mixed 带 2 张)');
  // 8 帧 / keep 1 / batch 2:k = floor((8-1)/2) = 3 → 一次丢 6 条,剩 2 条。
  assert.equal(historyFrames(result.messages), 2);
});

test('#7 keep=0 直接 no-op(一键回滚到现状)', () => {
  const messages: ChatMessage[] = Array.from({ length: 20 }, () => frameMessage('computer-result.png'));
  const r = applyVisionWindow(messages, { keep: 0, batch: 4, step: 1 });
  assert.equal(r.changed, false);
  assert.equal(r.messages, messages);
  assert.equal(countImages(r.messages), 20);
});

test('#8 batch 边界:batch=1 严格窗口;batch > n-keep 时不丢', () => {
  const many: ChatMessage[] = Array.from({ length: 10 }, () => frameMessage('computer-result.png'));
  const strict = applyVisionWindow(many, { keep: 4, batch: 1, step: 1 });
  assert.equal(strict.changed, true);
  assert.equal(strict.dropped, 6, 'batch=1 时丢到只剩 keep 条');
  assert.equal(historyFrames(strict.messages), 4);

  const few: ChatMessage[] = Array.from({ length: 5 }, () => frameMessage('computer-result.png'));
  const tooBig = applyVisionWindow(few, { keep: 4, batch: 10, step: 1 });
  assert.equal(tooBig.changed, false, 'batch > n-keep 时不得丢空或越界');
  assert.equal(tooBig.messages, few);
});

test('#9 配置空串语义:留空/非法值回落默认,显式 0 才是关闭', () => {
  const prevKeep = process.env.MOCODE_CU_VISION_KEEP;
  const prevBatch = process.env.MOCODE_CU_VISION_BATCH;
  try {
    process.env.MOCODE_CU_VISION_KEEP = '';
    assert.equal(visionKeep(), DEFAULT_VISION_KEEP, '空串必须回落默认,而不是 0');
    process.env.MOCODE_CU_VISION_KEEP = '0';
    assert.equal(visionKeep(), 0, '显式 0 表示关闭窗口');
    process.env.MOCODE_CU_VISION_KEEP = 'abc';
    assert.equal(visionKeep(), DEFAULT_VISION_KEEP, '非法值回落默认');
    process.env.MOCODE_CU_VISION_BATCH = '';
    assert.equal(visionBatch(), DEFAULT_VISION_BATCH);
    process.env.MOCODE_CU_VISION_BATCH = '0';
    assert.equal(visionBatch(), DEFAULT_VISION_BATCH, 'batch 必须 >=1');
  } finally {
    if (prevKeep === undefined) delete process.env.MOCODE_CU_VISION_KEEP;
    else process.env.MOCODE_CU_VISION_KEEP = prevKeep;
    if (prevBatch === undefined) delete process.env.MOCODE_CU_VISION_BATCH;
    else process.env.MOCODE_CU_VISION_BATCH = prevBatch;
  }
});

test('#10 占位文本:只有第一条带恢复提示,且保留帧名与 step', () => {
  const messages: ChatMessage[] = Array.from({ length: 8 }, () => frameMessage('computer-result.png'));
  const result = applyVisionWindow(messages, { keep: 2, batch: 4, step: 7 });
  assert.equal(result.changed, true);
  const placeholders: string[] = [];
  for (const m of result.messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; text?: string };
      if (p.type === 'text' && typeof p.text === 'string' && p.text.includes('[screenshot omitted')) {
        placeholders.push(p.text);
      }
    }
  }
  assert.equal(placeholders.length, 4, '每条被剪的帧留一行占位');
  assert.equal(placeholders[0].includes('computer-result.png'), true, '占位必须留下帧名');
  assert.equal(placeholders[0].includes('step 7'), true, '占位必须留下 step 标注');
  assert.equal(
    placeholders[0].includes('Call computer{screenshot} if you need the current screen.'),
    true,
    '第一条占位带一次性恢复提示',
  );
  for (const line of placeholders.slice(1)) {
    assert.equal(line.includes('Call computer{screenshot}'), false, '后续占位不得重复恢复提示');
  }
  // 被剪的那几条不再是帧载体(幂等的根源);窗口内保留的 4 条帧原样不动。
  assert.equal(historyFrames(result.messages), 4);
});

test('#11 统计:frames/images/imageTokens 反映在途成本', () => {
  const messages: ChatMessage[] = [
    frameMessage('computer-result.png'),
    frameMessage('diagram.png'),
    userPastedImageMessage(),
  ];
  const s = visionWindowStats(messages);
  assert.equal(s.frames, 1, '只有 computer- 帧算窗口内帧');
  assert.equal(s.images, 3, '每次请求真正重发的图数量(含非窗口图)');
  assert.ok(s.imageTokens > 0, '图像 token 必须按图片估算');
});

test('#12 HistoryManager 集成:pruneVisionWindow 原地换 backing 并推进 revision', () => {
  resetVisionWindowTelemetry();
  const backing: ChatMessage[] = [];
  const manager: HistoryManager = createStagedHistoryManager({ messages: backing });
  for (let step = 1; step <= 8; step++) {
    const call = { id: `c${step}`, name: 'computer', arguments: '{}' } as ToolCallRef;
    manager.appendAssistantTurn({ content: null, toolCalls: [call] });
    const batchTx = manager.beginToolBatch([call]);
    batchTx.workingMessages.push({ role: 'tool', tool_call_id: `c${step}`, content: 'ok' } as ChatMessage);
    batchTx.commit(frameMessage('computer-result.png'));
  }
  // 每步 assistant + tool result + attachment 三条。
  assert.equal(backing.length, 24);
  const before = manager.snapshot().revision;
  const changed = manager.pruneVisionWindow({ keep: 2, batch: 4, step: 8 });
  assert.equal(changed, true);
  assert.equal(manager.snapshot().revision, before + 1, 'revision 必须递增(下游据此重建)');
  assert.equal(backing.length, 24, 'backing 数组形状不变,只替换内容');
  // 8 帧 / keep 2 / batch 4:一次淘汰 4 条,剩 4 条(n 落在 [keep, keep+batch-1])。
  assert.equal(visionWindowStats(backing).frames, 4);
  assert.equal(getVisionWindowTelemetry().framesDropped, 4, '累积埋点记录本次淘汰帧数');
  // 已剪过后再 prune 是 no-op(幂等)。
  assert.equal(manager.pruneVisionWindow({ keep: 2, batch: 4, step: 9 }), false);
  resetVisionWindowTelemetry();
});
