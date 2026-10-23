// 请求体字节预算执行层:规划(planImageRelief)与「模型描述 → 文字卡替换」(relieveRequestBytes)。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/llm/index.js';
import { ATTACHMENT_PREAMBLE } from '../src/agent/tool-turn.js';
import { createStagedHistoryManager } from '../src/agent/stages/history-manager.js';
import { planImageRelief, relieveRequestBytes, MAX_DESCRIBED_IMAGES } from '../src/agent/request-governor.js';
import {
  applyImageCards,
  buildImageCard,
  IMAGE_CARD_PREFIX,
  listReplaceableImages,
  type ReplaceableImage,
} from '../src/context/vision-window.js';
import { estimateRequestBytes } from '../src/context/request-limit.js';

const bigUrl = (chars: number): string => `data:image/png;base64,${'A'.repeat(chars)}`;

function pasted(chars: number): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: bigUrl(chars) } },
    ],
  } as ChatMessage;
}

function toolImage(name: string, chars: number): ChatMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: `${ATTACHMENT_PREAMBLE}${name}. Analyze the attached image content directly.` },
      { type: 'image_url', image_url: { url: bigUrl(chars) } },
    ],
  } as ChatMessage;
}

function img(key: string, chars: number): ReplaceableImage {
  const [msg, part] = key.split(':').map(Number);
  return { key, msg, part, chars, dataUrl: '' };
}

function countImages(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const c = (m as { content?: unknown }).content;
    if (Array.isArray(c)) for (const p of c) if ((p as { type?: string }).type === 'image_url') n++;
  }
  return n;
}

// ── planImageRelief ────────────────────────────────────────────────────────

test('planImageRelief: 未超 0.8 线 / 无上限 → under_limit', () => {
  assert.equal(planImageRelief([img('1:1', 300_000)], 400_000, 500_000).kind, 'under_limit'); // 400k == 0.8×500k
  assert.equal(planImageRelief([img('1:1', 300_000)], 900_000, 0).kind, 'under_limit');
});

test('planImageRelief: 超线但没有可换的图 → no_images', () => {
  assert.equal(planImageRelief([], 900_000, 1_000_000).kind, 'no_images');
});

test('planImageRelief: 去掉全部图仍超线 → text_dominant(病因是文本,一张都不动)', () => {
  const plan = planImageRelief([img('1:1', 10_000), img('2:1', 10_000)], 2_000_000, 1_000_000);
  assert.equal(plan.kind, 'text_dominant');
});

test('planImageRelief: 从最旧挑起,挑到落回 0.8 线为止,保留较新的图', () => {
  const images = [img('1:1', 300_000), img('2:1', 300_000), img('3:1', 300_000)];
  const plan = planImageRelief(images, 1_000_000, 1_000_000); // target 800k;去一张即 ≈ 700k
  assert.equal(plan.kind, 'replace');
  if (plan.kind !== 'replace') return;
  assert.deepEqual(
    plan.images.map((i) => i.key),
    ['1:1'],
  );
  assert.ok(plan.bytesAfter <= 800_000);
});

// ── 列出 / 卡片 / 应用 ──────────────────────────────────────────────────────

test('listReplaceableImages: 工具图与用户粘贴图可换,computer- 屏幕帧不碰,并反查原路径', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: '开始' } as ChatMessage,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"assets/foo.png"}' } },
      ],
    } as ChatMessage,
    { role: 'tool', tool_call_id: 'c1', content: 'ok' } as ChatMessage,
    toolImage('foo.png', 1000),
    toolImage('computer-result.png', 1000),
    pasted(1000),
  ];
  const list = listReplaceableImages(messages);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'foo.png');
  assert.equal(list[0].path, 'assets/foo.png');
  assert.equal(list[1].name, undefined, '用户粘贴图没有文件名');
});

test('buildImageCard: 带描述与路径;描述失败时诚实写明「未看过」;粘贴图写明无法重读', () => {
  const withPath: ReplaceableImage = {
    key: '3:1',
    msg: 3,
    part: 1,
    chars: 300_000,
    dataUrl: '',
    name: 'foo.png',
    path: 'assets/foo.png',
  };
  const ok = buildImageCard(withPath, '一个报错对话框,文字 "ECONNRESET"');
  assert.ok(ok.startsWith(IMAGE_CARD_PREFIX));
  assert.ok(ok.includes('ECONNRESET') && ok.includes('read_file') && ok.includes('assets/foo.png'));

  const failed = buildImageCard(withPath, null);
  assert.ok(failed.includes('not seen') && failed.includes('assets/foo.png'));

  const paste = buildImageCard({ key: '1:1', msg: 1, part: 1, chars: 1000, dataUrl: '' }, 'x');
  assert.ok(paste.includes('cannot be re-read'));
});

test('applyImageCards: 只换命中的 part、保留其他 part、幂等、无改动返回入参引用', () => {
  const messages: ChatMessage[] = [pasted(1000), pasted(1000)];
  const r = applyImageCards(messages, new Map([['0:1', 'CARD']]));
  assert.equal(r.replaced, 1);
  assert.equal(countImages(r.messages), 1);
  assert.equal(r.messages[1], messages[1], '未命中的消息保持原引用');
  const first = r.messages[0] as { content: Array<{ type: string; text?: string }> };
  assert.equal(first.content[0].text, '看看这张图', '同消息的文本 part 保留');
  assert.equal(first.content[1].text, 'CARD');
  const again = applyImageCards(r.messages, new Map([['0:1', 'CARD']]));
  assert.equal(again.changed, false);
  assert.equal(again.messages, r.messages);
});

// ── relieveRequestBytes ────────────────────────────────────────────────────

test('relieveRequestBytes: limit=0 不限制,什么都不做', async () => {
  const manager = createStagedHistoryManager({ messages: [pasted(300_000)] });
  const calls: string[] = [];
  const r = await relieveRequestBytes({
    historyManager: manager,
    tools: [],
    limitBytes: 0,
    describe: async () => (calls.push('x'), 'd'),
  });
  assert.equal(r.reason, 'no_limit');
  assert.equal(calls.length, 0);
});

test('relieveRequestBytes: 超线且去图可达标 → 逐张描述、换成卡片,最新图保留,字节落回线下', async () => {
  const backing: ChatMessage[] = [{ role: 'system', content: 'sys' } as ChatMessage, pasted(300_000), pasted(300_000)];
  const manager = createStagedHistoryManager({ messages: backing });
  const described: string[] = [];
  const r = await relieveRequestBytes({
    historyManager: manager,
    tools: [],
    limitBytes: 500_000, // target 400k;两张共 600k+
    describe: async (image) => {
      described.push(image.key);
      return 'SCREENSHOT OF A DIALOG';
    },
  });
  assert.equal(r.reason, 'replaced');
  assert.equal(r.replaced, 1);
  assert.equal(r.described, 1);
  assert.deepEqual(described, ['1:1'], '先动最旧的一张');
  const after = manager.snapshot().messages as ChatMessage[];
  assert.equal(countImages(after), 1, '最新一张原样保留');
  assert.ok(JSON.stringify(after[1]).includes('SCREENSHOT OF A DIALOG'));
  assert.ok(estimateRequestBytes(after, []) <= 500_000 * 0.8);
});

test('relieveRequestBytes: 文本占主导时不动图也不调模型', async () => {
  const backing: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(900_000) } as ChatMessage, pasted(50_000)];
  const manager = createStagedHistoryManager({ messages: backing });
  let called = 0;
  const r = await relieveRequestBytes({
    historyManager: manager,
    tools: [],
    limitBytes: 500_000,
    describe: async () => (called++, 'd'),
  });
  assert.equal(r.reason, 'text_dominant');
  assert.equal(called, 0);
  assert.equal(countImages(manager.snapshot().messages as ChatMessage[]), 1);
});

test('relieveRequestBytes: 描述失败(null)仍替换,卡片写明未看过', async () => {
  const manager = createStagedHistoryManager({ messages: [pasted(300_000), pasted(300_000)] });
  const r = await relieveRequestBytes({
    historyManager: manager,
    tools: [],
    limitBytes: 500_000,
    describe: async () => null,
  });
  assert.equal(r.replaced, 1);
  assert.equal(r.described, 0);
  assert.ok(JSON.stringify(manager.snapshot().messages[0]).includes('not seen'));
});

test('relieveRequestBytes: 超过 MAX_DESCRIBED_IMAGES 的部分只留名称卡,不再调模型', async () => {
  const count = MAX_DESCRIBED_IMAGES + 2;
  const backing: ChatMessage[] = Array.from({ length: count + 1 }, () => pasted(200_000));
  const manager = createStagedHistoryManager({ messages: backing });
  let called = 0;
  const r = await relieveRequestBytes({
    historyManager: manager,
    tools: [],
    limitBytes: 400_000, // target 320k:几乎全要换,只保留最新
    describe: async () => (called++, 'd'),
  });
  assert.equal(r.reason, 'replaced');
  assert.ok(r.replaced > MAX_DESCRIBED_IMAGES);
  assert.equal(called, MAX_DESCRIBED_IMAGES);
});

test('relieveRequestBytes: 已 abort 时不写回 history', async () => {
  const manager = createStagedHistoryManager({ messages: [pasted(300_000), pasted(300_000)] });
  const ac = new AbortController();
  ac.abort();
  const r = await relieveRequestBytes({
    historyManager: manager,
    tools: [],
    limitBytes: 500_000,
    signal: ac.signal,
    describe: async () => 'd',
  });
  assert.equal(r.replaced, 0);
  assert.equal(countImages(manager.snapshot().messages as ChatMessage[]), 2);
});
