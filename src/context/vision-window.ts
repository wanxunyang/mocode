// 视觉历史滑动窗口(Vision Window)
//
// 截图目前**永驻 history**,而每次请求都要重发整个 history → 图像 token **二次增长**
// (1568×882 ≈1843 tk/张;20 步 ≈387k、50 步 ≈2.35M),长 GUI 任务必然中途 compact,
// compact 把视觉历史摘要成文本 → 模型忘了自己点过哪,表现为重复点击 / 点错目标。
//
// 本模块在**存储层**按「固定张数(keep)+ 成批淘汰(batch)」把旧屏幕帧换成文本占位:
//   - 图像 token 从二次增长压成线性;
//   - 只有淘汰那一刻 history 才变字节 → 两次淘汰之间**前缀完全稳定** → prompt cache 可命中。
//     (这也是必须「成批」而非「逐张老化」的唯一理由:逐张改前缀 = 缓存全废。)
//
// 契约(与 src/context/pipeline.ts optimizeToolResult 同款):纯函数、零 I/O、永不抛错。
// 被剪掉的帧**不可复原**(模型只能重新截图拿到"当前"屏幕),所以占位必须留下可读标注
// (帧名 + step),并在第一条占位里给出一次性恢复提示。
//
// 设计文档:design-notes/vision-window.md

import { contentTokens } from '../llm/index.js';
import { ATTACHMENT_PREAMBLE } from '../agent/tool-turn.js';
import type { ChatMessage } from '../llm/index.js';
import type { ContentPart } from '../agent/run-contracts.js';

/** 附件前言的后缀;与 ATTACHMENT_PREAMBLE 一起框出"帧名清单"的位置。 */
const ATTACHMENT_TAIL = '. Analyze the attached image content directly.';

/** 查不到帧名时的兜底占位名。 */
const UNKNOWN_FRAME_NAME = 'frame';

/** 恢复提示只写进**第一条**被剪占位,避免 N 条占位重复同一句话侵蚀 token。 */
const RECOVERY_HINT = ' Call computer{screenshot} if you need the current screen.';

/**
 * 白名单:参与滑动窗口的屏幕帧名前缀。
 *
 * 取值来自**实际产出点**(design-notes/vision-window.md §2.2 要求实施时读一次代码定稿,不凭猜):
 *  - ✅ `computer-`:`src/tools/builtins/computer.ts` 的 computer-result.png / computer-screenshot.png /
 *    computer-zoom.png —— 每次动作回灌的屏幕帧,会被反复收发,是二次增长的来源。
 *  - ❌ `browser`:`src/tools/builtins/browser.ts:235` 的附件名是 `${sessionId}.png`,**没有稳定前缀**,
 *    按文档 §2.2 的约定移出白名单(收益小一档但不会误剪)。
 *  - ❌ `screenshot` / `read_file`(文档图)/ 用户粘贴图:读的是"文档图"或用户意图的直接载体,剪掉是净损失。
 *
 * 新增屏幕帧产出点必须沿用 `computer-` 前缀才会自动进窗口;若前缀不同,请在白名单里显式登记
 * 并同步更新 design-notes/vision-window.md。
 */
export const VISION_FRAME_NAME_PREFIXES: readonly string[] = ['computer-'];

type MaybePart = { type?: unknown; text?: unknown; image_url?: unknown };

export interface VisionWindowOptions {
  /** 保留最近多少条帧载体。0 = 关闭窗口(回退到现状)。 */
  keep: number;
  /** 一次淘汰多少条。>=1;1 = 严格窗口(token 最省、前缀最不稳)。 */
  batch: number;
  /** 当前步号,只用于占位标注。纯函数不持有 step 计数,必须由调用方传入。 */
  step: number;
}

export interface VisionWindowResult {
  /** 是否发生了替换(决定调用方要不要 rebuildHistoryIndexes)。 */
  changed: boolean;
  /** 本次淘汰的帧载体数量。 */
  dropped: number;
  /** 结果消息数组;未变化时原样返回入参引用(便于调用方用 === 判定)。 */
  messages: ChatMessage[];
}

export interface VisionWindowStats {
  /** history 里的帧载体(可被窗口剪枝的屏幕帧消息)数量。 */
  frames: number;
  /** history 里的 image_url part 总数(= 每次请求真正重发的图数量)。 */
  images: number;
  /** 这些图片的估算 token(w*h/750 口径,复用 src/llm/index.ts)。 */
  imageTokens: number;
}

/** 累积埋点(供 `/cu status`)。上面的纯计算函数不读它,只有 record/reset 这组 add-on 会动。 */
interface VisionWindowTelemetry {
  /** 触发过的剪枝次数。 */
  prunes: number;
  /** 累计淘汰的帧载体数量。 */
  framesDropped: number;
}

const telemetry: VisionWindowTelemetry = { prunes: 0, framesDropped: 0 };

function userContentParts(message: ChatMessage): readonly MaybePart[] | null {
  if (!message || typeof message !== 'object') return null;
  if ((message as { role?: unknown }).role !== 'user') return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: MaybePart[] = [];
  for (const part of content) {
    if (part && typeof part === 'object') parts.push(part as MaybePart);
  }
  return parts;
}

function imagePartCount(parts: readonly MaybePart[]): number {
  let count = 0;
  for (const part of parts) if (part.type === 'image_url') count++;
  return count;
}

/** 从附件前言里解出帧名清单;不是前言返回 null。 */
function frameNamesFromText(text: string): string[] | null {
  if (!text.startsWith(ATTACHMENT_PREAMBLE)) return null;
  let body = text.slice(ATTACHMENT_PREAMBLE.length);
  if (body.endsWith(ATTACHMENT_TAIL)) body = body.slice(0, -ATTACHMENT_TAIL.length);
  const names = body
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : null;
}

function frameNames(message: ChatMessage): string[] | null {
  const parts = userContentParts(message);
  if (!parts) return null;
  for (const part of parts) {
    if (typeof part.text === 'string') {
      const names = frameNamesFromText(part.text);
      if (names) return names;
    }
  }
  return null;
}

/**
 * 帧载体识别(§2.2 三条规则同时满足):
 *  1. `role === 'user'` 且 content 是数组;
 *  2. 数组里至少有 1 个 `image_url` part;
 *  3. 前言以工具附件前言开头(从而排除用户粘贴图),且**所有**帧名命中白名单
 *     (混进 read_file 文档图 / screenshot / 用户图时不整条淘汰 —— 那些剪掉是净损失)。
 *
 * 已剪过的消息不再含 image_url part → 规则 2 自然失效 → 幂等。
 * **不靠自定义字段打标**:消息对象会被 OpenAI SDK 原样发出,严格兼容后端可能 400。
 */
export function isFrameCarrier(message: ChatMessage): boolean {
  try {
    const parts = userContentParts(message);
    if (!parts || imagePartCount(parts) === 0) return false;
    const names = frameNames(message);
    if (!names) return false;
    return names.every((name) => VISION_FRAME_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)));
  } catch {
    // 永不抛错契约:任何意外形状都不该让 agent 循环挂掉。
    return false;
  }
}

/** 统计 history 里的帧载体数量与在途图像 token(供 `/cu status`)。 */
export function visionWindowStats(messages: readonly ChatMessage[]): VisionWindowStats {
  const stats: VisionWindowStats = { frames: 0, images: 0, imageTokens: 0 };
  if (!Array.isArray(messages)) return stats;
  for (const message of messages) {
    const parts = userContentParts(message);
    if (!parts) continue;
    if (isFrameCarrier(message)) stats.frames++;
    for (const part of parts) {
      if (part.type !== 'image_url') continue;
      stats.images++;
      // 复用 llm/index.ts 的口径(w*h/750),不重写面积公式,避免两套估算漂移。
      stats.imageTokens += contentTokens([part]);
    }
  }
  return stats;
}

/** 把一条帧载体消息的 content 换成纯文本占位(形状不变:仍是 role:'user' + ContentPart[])。 */
function pruneFrameMessage(
  message: ChatMessage,
  names: readonly string[],
  step: number,
  withHint: boolean,
): ChatMessage {
  const parts = userContentParts(message) ?? [];
  const lines: string[] = [];
  let index = 0;
  for (const part of parts) {
    if (part.type !== 'image_url') continue;
    lines.push(`[screenshot omitted: ${names[index] ?? UNKNOWN_FRAME_NAME} · step ${step}]`);
    index++;
  }
  if (lines.length === 0) lines.push(`[screenshot omitted: ${names[0] ?? UNKNOWN_FRAME_NAME} · step ${step}]`);
  if (withHint) lines[0] = `${lines[0]}${RECOVERY_HINT}`;
  const content: ContentPart[] = [{ type: 'text', text: lines.join('\n') }];
  return { role: 'user', content } as ChatMessage;
}

function noopResult(messages: readonly ChatMessage[]): VisionWindowResult {
  // changed=false 时必须返回入参引用,调用方才能用 === 判定"零开销"。
  return { changed: false, dropped: 0, messages: messages as ChatMessage[] };
}

/**
 * 视觉滑动窗口剪枝。**幂等**;未达阈值时返回入参引用且 `changed=false`。
 *
 * 算法(淘汰单元 = 附件消息,一期不拆单张图,天然不触碰 tool_call_id 配对):
 *   frames := 时间序(旧→新)的帧载体下标,n := |frames|
 *   k      := floor((n - keep) / batch);k <= 0 → no-op
 *   drop   := frames[0 .. k*batch)
 *
 * 由此:仅在 n 涨到 keep+batch 时一次性丢 batch 条,之后 n 落在 [keep, keep+batch-1]。
 * 丢**固定批量**是关键 —— "超过 keep 就丢到剩 keep" 等于逐张老化,前缀每步都变。
 */
export function applyVisionWindow(messages: readonly ChatMessage[], opts: VisionWindowOptions): VisionWindowResult {
  try {
    if (!Array.isArray(messages)) return noopResult(messages);
    const keep = Math.floor(opts?.keep ?? 0);
    if (!Number.isFinite(keep) || keep <= 0) return noopResult(messages); // keep=0 → 完全关闭
    const requestedBatch = Math.floor(opts?.batch ?? 1);
    const batch = Number.isFinite(requestedBatch) && requestedBatch >= 1 ? requestedBatch : 1;
    const step = Number.isFinite(opts?.step) ? Math.floor(opts.step) : 0;

    const frameIndexes: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (isFrameCarrier(messages[i])) frameIndexes.push(i);
    }
    const batches = Math.floor((frameIndexes.length - keep) / batch);
    if (batches <= 0) return noopResult(messages);
    const dropCount = batches * batch;
    const dropped = new Set(frameIndexes.slice(0, dropCount));

    // 只对被淘汰的消息做浅拷贝,其余保持原引用。
    const next: ChatMessage[] = [];
    let written = 0;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!dropped.has(i)) {
        next.push(message);
        continue;
      }
      next.push(pruneFrameMessage(message, frameNames(message) ?? [], step, written === 0));
      written++;
    }
    return { changed: true, dropped: dropCount, messages: next };
  } catch {
    return noopResult(messages);
  }
}

/** 累积一次剪枝结果(由 HistoryManager 调用)。 */
export function recordVisionWindowPrune(droppedFrames: number): void {
  if (!Number.isFinite(droppedFrames) || droppedFrames <= 0) return;
  telemetry.prunes++;
  telemetry.framesDropped += Math.floor(droppedFrames);
}

/** 只读累积埋点快照。 */
export function getVisionWindowTelemetry(): Readonly<VisionWindowTelemetry> {
  return { prunes: telemetry.prunes, framesDropped: telemetry.framesDropped };
}

/** 清空累积埋点(会话切换 / 测试隔离)。 */
export function resetVisionWindowTelemetry(): void {
  telemetry.prunes = 0;
  telemetry.framesDropped = 0;
}
