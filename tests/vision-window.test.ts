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
  stripOversizedImages,
  countOversizedImages,
  countOversizedImagePlaceholders,
  OVERSIZED_IMAGE_MIN_CHARS,
  applyImageBudget,
  applyImageTurnAging,
  IMAGE_AGED_PLACEHOLDER_PREFIX,
  IMAGE_BUDGET_PLACEHOLDER_PREFIX,
  OVERSIZED_IMAGE_PLACEHOLDER_PREFIX,
} from '../src/context/vision-window.js';
import { createStagedHistoryManager } from '../src/agent/stages/history-manager.js';
import type { HistoryManager } from '../src/agent/stages/contracts.js';
import {
  visionBatch,
  visionKeep,
  imageTurnAgingEnabled,
  DEFAULT_VISION_KEEP,
  DEFAULT_VISION_BATCH,
} from '../src/config/index.js';

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

// ── 上游请求体过大:大图摘除(不走摘要压缩)────────────────────────────────

function bigImageMessage(name = 'big.png'): ChatMessage {
  const url = `data:image/png;base64,${'A'.repeat(OVERSIZED_IMAGE_MIN_CHARS + 10)}`;
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${ATTACHMENT_PREAMBLE}${name}. Analyze the attached image content directly.` },
      { type: 'image_url', image_url: { url } },
    ],
  } as ChatMessage;
}

test('#13 stripOversizedImages: 只换大图,小图与前言原样保留,且可被计数识别', () => {
  const messages: ChatMessage[] = [bigImageMessage(), frameMessage('computer-result.png'), userPastedImageMessage()];
  assert.equal(countOversizedImages(messages), 1);
  const r = stripOversizedImages(messages);
  assert.equal(r.changed, true);
  assert.equal(r.stripped, 1);
  assert.equal(countImages(r.messages), 2, '小图保留');
  assert.equal(countOversizedImages(r.messages), 0);
  assert.equal(countOversizedImagePlaceholders(r.messages), 1, '占位可作无状态计数器');
  assert.equal(r.messages[1], messages[1], '未改动的消息保持原引用');
  const first = JSON.stringify(r.messages[0]);
  assert.ok(first.includes('The image was not seen'), '占位必须告诉模型图没被看到');
  assert.ok(first.includes(ATTACHMENT_PREAMBLE), '前言保留');
});

test('#14 stripOversizedImages: 无大图时返回入参引用且 changed=false(幂等)', () => {
  const messages: ChatMessage[] = [frameMessage('computer-result.png')];
  const r = stripOversizedImages(messages);
  assert.equal(r.changed, false);
  assert.equal(r.messages, messages);
  const once = stripOversizedImages([bigImageMessage()]);
  const twice = stripOversizedImages(once.messages);
  assert.equal(twice.changed, false);
});

test('#15 HistoryManager.stripOversizedImages: 原地替换并推进 revision,二次调用返回 0', () => {
  const backing: ChatMessage[] = [{ role: 'user', content: 'hi' } as ChatMessage, bigImageMessage()];
  const manager: HistoryManager = createStagedHistoryManager({ messages: backing });
  const before = manager.snapshot().revision;
  assert.equal(manager.stripOversizedImages(), 1);
  assert.equal(manager.snapshot().revision, before + 1);
  assert.equal(countOversizedImages(backing), 0);
  assert.equal(manager.stripOversizedImages(), 0);
});

// ── 图片总量预算(非屏幕帧图片攒多了整体越过上游请求体上限)──────────────────

function sizedImageMessage(chars: number, name = 'doc.png'): ChatMessage {
  const url = `data:image/png;base64,${'A'.repeat(chars)}`;
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${ATTACHMENT_PREAMBLE}${name}. Analyze the attached image content directly.` },
      { type: 'image_url', image_url: { url } },
    ],
  } as ChatMessage;
}

test('#16 applyImageBudget: 超预算时从最旧淘汰,保留最新,屏幕帧不动,占位不计入上游拒收计数', () => {
  const frame = frameMessage('computer-result.png');
  const messages: ChatMessage[] = [
    sizedImageMessage(100_000, 'a.png'),
    frame,
    sizedImageMessage(100_000, 'b.png'),
    sizedImageMessage(100_000, 'c.png'),
  ];
  const r = applyImageBudget(messages, { maxChars: 250_000 });
  assert.equal(r.changed, true);
  assert.equal(r.evicted, 1, '总量 300k+ > 250k:淘汰最旧一张即可');
  assert.equal(r.messages[1], frame, '屏幕帧原引用保留(归 applyVisionWindow 管)');
  assert.equal(r.messages[2], messages[2]);
  assert.equal(r.messages[3], messages[3], '最新一张保留');
  const first = JSON.stringify(r.messages[0]);
  assert.ok(first.includes(IMAGE_BUDGET_PLACEHOLDER_PREFIX));
  assert.ok(first.includes(ATTACHMENT_PREAMBLE), '附件前言保留(rollback 靠它区分真实用户轮)');
  assert.equal(countOversizedImagePlaceholders(r.messages), 0, '与上游拒收占位前缀刻意不同');
  assert.ok(!first.includes(OVERSIZED_IMAGE_PLACEHOLDER_PREFIX));
  // 幂等。
  const again = applyImageBudget(r.messages, { maxChars: 250_000 });
  assert.equal(again.changed, false);
  assert.equal(again.messages, r.messages);
});

test('#17 applyImageBudget: 只有一张时即使超预算也保留;maxChars<=0 视为关闭', () => {
  const one: ChatMessage[] = [sizedImageMessage(300_000)];
  const r = applyImageBudget(one, { maxChars: 100_000 });
  assert.equal(r.changed, false);
  assert.equal(r.messages, one);
  const many: ChatMessage[] = [sizedImageMessage(100_000), sizedImageMessage(100_000)];
  assert.equal(applyImageBudget(many, { maxChars: 0 }).changed, false);
});

test('#18 HistoryManager.enforceImageBudget: 原地替换并推进 revision,二次调用返回 0', () => {
  const backing: ChatMessage[] = [sizedImageMessage(100_000), sizedImageMessage(100_000), sizedImageMessage(100_000)];
  const manager: HistoryManager = createStagedHistoryManager({ messages: backing });
  const before = manager.snapshot().revision;
  assert.equal(manager.enforceImageBudget({ maxChars: 150_000 }), 2);
  assert.equal(manager.snapshot().revision, before + 1);
  assert.equal(countImages(backing), 1);
  assert.equal(manager.enforceImageBudget({ maxChars: 150_000 }), 0);
});

// ── 图片按轮次淘汰(下一个真实用户轮开始时,上一轮工具图换成文字卡)──────────────

function realUser(text: string): ChatMessage {
  return { role: 'user', content: text } as ChatMessage;
}

test('#20 applyImageTurnAging: 当前轮内的工具图原样保留', () => {
  const messages: ChatMessage[] = [realUser('读一下这张图'), sizedImageMessage(5_000, 'a.png')];
  const r = applyImageTurnAging(messages);
  assert.equal(r.changed, false);
  assert.equal(r.messages, messages, '无改动返回入参引用');
});

test('#21 applyImageTurnAging: 跨轮后上一轮工具图换文字卡,前言保留,当前轮图不动', () => {
  const old = sizedImageMessage(5_000, 'old.png');
  const cur = sizedImageMessage(5_000, 'cur.png');
  const messages: ChatMessage[] = [realUser('第一轮'), old, realUser('第二轮'), cur];
  const r = applyImageTurnAging(messages);
  assert.equal(r.changed, true);
  assert.equal(r.aged, 1);
  assert.equal(r.messages[3], cur, '当前轮的图保持原引用');
  const first = JSON.stringify(r.messages[1]);
  assert.ok(first.includes(IMAGE_AGED_PLACEHOLDER_PREFIX));
  assert.ok(first.includes('old.png'), '文字卡写明帧名');
  assert.ok(first.includes('read_file'), '文字卡提示可重读');
  assert.ok(first.includes(ATTACHMENT_PREAMBLE), '附件前言保留(rollback 靠它区分真实用户轮)');
  assert.equal(countImages(r.messages), 1);
  assert.equal(countOversizedImagePlaceholders(r.messages), 0, '与上游拒收占位前缀不同');
  // 幂等。
  const again = applyImageTurnAging(r.messages);
  assert.equal(again.changed, false);
  assert.equal(again.messages, r.messages);
});

test('#22 applyImageTurnAging: computer- 屏幕帧与用户粘贴图不被淘汰', () => {
  const frame = frameMessage('computer-result.png');
  const pasted = userPastedImageMessage();
  const messages: ChatMessage[] = [realUser('第一轮'), frame, pasted, realUser('第二轮')];
  const r = applyImageTurnAging(messages);
  assert.equal(r.changed, false, '屏幕帧归 applyVisionWindow 管,用户图不动');
  assert.equal(r.messages, messages);
});

test('#23 applyImageTurnAging: computer- 帧剪枝占位不被误判成真实用户轮', () => {
  const pruned = {
    role: 'user',
    content: [{ type: 'text', text: '[screenshot omitted: computer-result.png · step 3]' }],
  } as ChatMessage;
  const doc = sizedImageMessage(5_000, 'doc.png');
  // 最后一条「真实」用户消息是 realUser('第一轮'),占位在其后,不应成为轮次边界。
  const messages: ChatMessage[] = [realUser('第一轮'), doc, pruned];
  const r = applyImageTurnAging(messages);
  assert.equal(r.changed, false, '占位不算新一轮,doc 图仍属当前轮');
});

test('#24 HistoryManager.ageToolImages: 原地替换并推进 revision,二次调用返回 0', () => {
  const backing: ChatMessage[] = [
    realUser('第一轮'),
    sizedImageMessage(5_000, 'a.png'),
    realUser('第二轮'),
    sizedImageMessage(5_000, 'b.png'),
  ];
  const manager: HistoryManager = createStagedHistoryManager({ messages: backing });
  const before = manager.snapshot().revision;
  assert.equal(manager.ageToolImages(), 1);
  assert.equal(manager.snapshot().revision, before + 1);
  assert.equal(countImages(backing), 1);
  assert.equal(manager.ageToolImages(), 0);
});

test('#25 imageTurnAgingEnabled: 默认开,0/false/off/no 关闭', () => {
  const prev = process.env.MOCODE_IMAGE_AGE_TURNS;
  try {
    delete process.env.MOCODE_IMAGE_AGE_TURNS;
    assert.equal(imageTurnAgingEnabled(), true);
    process.env.MOCODE_IMAGE_AGE_TURNS = '  ';
    assert.equal(imageTurnAgingEnabled(), true);
    for (const off of ['0', 'false', 'OFF', 'no']) {
      process.env.MOCODE_IMAGE_AGE_TURNS = off;
      assert.equal(imageTurnAgingEnabled(), false, off);
    }
    process.env.MOCODE_IMAGE_AGE_TURNS = '1';
    assert.equal(imageTurnAgingEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.MOCODE_IMAGE_AGE_TURNS;
    else process.env.MOCODE_IMAGE_AGE_TURNS = prev;
  }
});
