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
 * 帧被剪枝后占位行的固定前缀(见 pruneFrameMessage,完整行为 `[screenshot omitted: <帧名> · step N]`)。
 * 剪枝会把合成附件消息整个 content 换成占位(前言 ATTACHMENT_PREAMBLE 随之消失),
 * rollback 对齐真实用户轮时必须认出这个占位、不把它算成一轮——那里因循环依赖无法
 * import 本模块,故在 rollback/store.ts 内联了同一行格式(按整行正则判定),修改此串时两处必须同步。
 */
const PRUNED_FRAME_PREFIX = '[screenshot omitted: ';

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
    lines.push(`${PRUNED_FRAME_PREFIX}${names[index] ?? UNKNOWN_FRAME_NAME} · step ${step}]`);
    index++;
  }
  if (lines.length === 0) lines.push(`${PRUNED_FRAME_PREFIX}${names[0] ?? UNKNOWN_FRAME_NAME} · step ${step}]`);
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

/**
 * 上游拒收请求体时,被摘掉的大图所留下的占位行前缀。
 * 兼作「已发生过几次」的无状态计数器(数 history 里有几条占位),用来掐断跨 step 的循环。
 */
export const OVERSIZED_IMAGE_PLACEHOLDER_PREFIX = '[image removed: upstream rejected the request size';

/** 默认「大图」阈值:data URL 字符数。约 150 KB 原始字节;小图不动。 */
export const OVERSIZED_IMAGE_MIN_CHARS = 200_000;

export interface StripOversizedImagesResult {
  changed: boolean;
  /** 本次摘掉的 image_url part 数。 */
  stripped: number;
  messages: ChatMessage[];
}

function imageUrlChars(part: MaybePart): number {
  const iu = part.image_url as { url?: unknown } | string | undefined;
  const url = typeof iu === 'string' ? iu : iu && typeof iu === 'object' ? iu.url : undefined;
  return typeof url === 'string' ? url.length : 0;
}

/** history 里 data URL 超过阈值的 image_url part 数(只读)。 */
export function countOversizedImages(
  messages: readonly ChatMessage[],
  minChars: number = OVERSIZED_IMAGE_MIN_CHARS,
): number {
  let count = 0;
  if (!Array.isArray(messages)) return 0;
  for (const message of messages) {
    const parts = userContentParts(message);
    if (!parts) continue;
    for (const part of parts) if (part.type === 'image_url' && imageUrlChars(part) >= minChars) count++;
  }
  return count;
}

/** history 里已有多少条「大图被摘除」占位(无状态地得知本会话已经历过几次)。 */
export function countOversizedImagePlaceholders(messages: readonly ChatMessage[]): number {
  let count = 0;
  if (!Array.isArray(messages)) return 0;
  for (const message of messages) {
    const parts = userContentParts(message);
    if (!parts) continue;
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.startsWith(OVERSIZED_IMAGE_PLACEHOLDER_PREFIX)) count++;
    }
  }
  return count;
}

/**
 * 上游因请求体过大拒收时的外科手术:只把**大** image_url part 换成文本占位,其余 part(含附件前言)原样保留。
 * 与摘要压缩的区别:不丢任何对话信息,模型能看到「图被拒了、该降采样后重读」而不是被摘要悄悄吞掉。
 * 纯函数、永不抛错;无改动时返回入参引用。
 */
export function stripOversizedImages(
  messages: readonly ChatMessage[],
  opts: { minChars?: number } = {},
): StripOversizedImagesResult {
  try {
    if (!Array.isArray(messages)) return { changed: false, stripped: 0, messages: messages as ChatMessage[] };
    const minChars = opts.minChars ?? OVERSIZED_IMAGE_MIN_CHARS;
    let stripped = 0;
    const next = messages.map((message) => {
      const parts = userContentParts(message);
      if (!parts || !parts.some((p) => p.type === 'image_url' && imageUrlChars(p) >= minChars)) return message;
      const content = parts.map((part) => {
        if (part.type === 'image_url' && imageUrlChars(part) >= minChars) {
          stripped++;
          return {
            type: 'text',
            text:
              `${OVERSIZED_IMAGE_PLACEHOLDER_PREFIX} (~${Math.round(imageUrlChars(part) / 1024)} KB inline). ` +
              'The image was not seen. Shrink or downscale it (e.g. resize to <=1568px long edge) and read it again.]',
          };
        }
        return part;
      });
      return { role: 'user', content } as ChatMessage;
    });
    if (stripped === 0) return { changed: false, stripped: 0, messages: messages as ChatMessage[] };
    return { changed: true, stripped, messages: next };
  } catch {
    return { changed: false, stripped: 0, messages: messages as ChatMessage[] };
  }
}

/** 总量预算淘汰留下的占位前缀;与 OVERSIZED_IMAGE_PLACEHOLDER_PREFIX 刻意不同,不计入「上游拒收」循环计数。 */
export const IMAGE_BUDGET_PLACEHOLDER_PREFIX = '[image removed: over the request image budget';

export interface ApplyImageBudgetResult {
  changed: boolean;
  /** 本次淘汰的 image_url part 数。 */
  evicted: number;
  messages: ChatMessage[];
}

/**
 * 图片总量预算:history 里**非屏幕帧**图片(read_file 文档图 / screenshot / 用户粘贴图)的 data URL
 * 字符数之和超过 maxChars 时,从最旧的开始换成文本占位,**始终保留最新一张**。
 *
 * 为什么要有:上游代理限的是整个请求体字节数,而图片会随 history 每步重发、只增不减;
 * 每张图单独都合规,攒几张就整体越线。屏幕帧(`computer-`)由 applyVisionWindow 管,这里不碰,
 * 避免改变 Computer Use 既有行为。幂等:淘汰后总量 <= 预算或只剩一张,再调即 no-op。
 * 纯函数、永不抛错;无改动返回入参引用。附件前言原样保留(rollback 靠它区分真实用户轮)。
 */
export function applyImageBudget(messages: readonly ChatMessage[], opts: { maxChars: number }): ApplyImageBudgetResult {
  const noop = (): ApplyImageBudgetResult => ({ changed: false, evicted: 0, messages: messages as ChatMessage[] });
  try {
    if (!Array.isArray(messages) || !Number.isFinite(opts?.maxChars) || opts.maxChars <= 0) return noop();
    const entries: Array<{ msg: number; part: number; chars: number }> = [];
    let total = 0;
    for (let i = 0; i < messages.length; i++) {
      const parts = userContentParts(messages[i]);
      if (!parts || isFrameCarrier(messages[i])) continue;
      for (let j = 0; j < parts.length; j++) {
        if (parts[j].type !== 'image_url') continue;
        const chars = imageUrlChars(parts[j]);
        entries.push({ msg: i, part: j, chars });
        total += chars;
      }
    }
    if (total <= opts.maxChars || entries.length <= 1) return noop();

    const evict = new Set<string>();
    for (let k = 0; k < entries.length - 1 && total > opts.maxChars; k++) {
      evict.add(`${entries[k].msg}:${entries[k].part}`);
      total -= entries[k].chars;
    }
    const sizeOf = new Map(entries.map((e) => [`${e.msg}:${e.part}`, e.chars]));
    const budgetKb = Math.round(opts.maxChars / 1024);
    const next = messages.map((message, i) => {
      const parts = userContentParts(message);
      if (!parts || !parts.some((_, j) => evict.has(`${i}:${j}`))) return message;
      const content = parts.map((part, j) =>
        evict.has(`${i}:${j}`)
          ? {
              type: 'text',
              text:
                `${IMAGE_BUDGET_PLACEHOLDER_PREFIX} (~${Math.round((sizeOf.get(`${i}:${j}`) ?? 0) / 1024)} KB inline; ` +
                (budgetKb >= 1
                  ? `older images are dropped to keep the total under ~${budgetKb} KB). `
                  : 'older images are dropped to relieve context pressure; only the latest is kept). ') +
                'Not visible now; read it again with read_file if you still need it.]',
            }
          : part,
      );
      return { role: 'user', content } as ChatMessage;
    });
    return { changed: true, evicted: evict.size, messages: next };
  } catch {
    return noop();
  }
}

/** 按轮次淘汰留下的文字卡前缀;与 OVERSIZED/BUDGET 前缀刻意不同,不计入「上游拒收」循环计数。 */
export const IMAGE_AGED_PLACEHOLDER_PREFIX = '[image aged out: ';

export interface ApplyImageTurnAgingResult {
  changed: boolean;
  /** 本次换成文字卡的 image_url part 数。 */
  aged: number;
  messages: ChatMessage[];
}

/**
 * 是否为真实用户轮消息(beginTurn 记入 turns 的那条)。口径同 rollback/store.ts 的 isRealTurnUserMessage:
 * 排除工具附件载体(带 ATTACHMENT_PREAMBLE)与 computer- 帧剪枝后的 `[screenshot omitted: …]` 占位。
 * 不能 import rollback(循环依赖),故本地实现。
 */
function isRealUserTurnMessage(message: ChatMessage): boolean {
  if (!message || (message as { role?: unknown }).role !== 'user') return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return !content.startsWith(PRUNED_FRAME_PREFIX);
  if (!Array.isArray(content)) return false;
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const text = (raw as MaybePart).text;
    if (typeof text === 'string' && (text.startsWith(ATTACHMENT_PREAMBLE) || text.startsWith(PRUNED_FRAME_PREFIX))) {
      return false;
    }
  }
  return true;
}

/**
 * 图片按轮次淘汰:最后一条真实用户消息**之前**的工具附件图(read_file 文档图 / screenshot / browser 等,
 * 即帧名不以 `computer-` 开头的)换成文字卡;当前轮内的图原样保留(模型常多步引用)。
 * 用户自己粘贴的图不动(没有附件前言);屏幕帧由 applyVisionWindow 管。
 * 文字卡写明帧名与体积,提示需要时 read_file 重读。附件前言 text part 原样保留(rollback 靠它区分轮次)。
 * 幂等(淘汰后不再含 image_url);纯函数、永不抛错;无改动返回入参引用。
 */
export function applyImageTurnAging(messages: readonly ChatMessage[]): ApplyImageTurnAgingResult {
  const noop = (): ApplyImageTurnAgingResult => ({ changed: false, aged: 0, messages: messages as ChatMessage[] });
  try {
    if (!Array.isArray(messages)) return noop();
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserTurnMessage(messages[i])) {
        lastUser = i;
        break;
      }
    }
    if (lastUser <= 0) return noop();

    let aged = 0;
    const next = messages.map((message, i) => {
      if (i >= lastUser) return message;
      const parts = userContentParts(message);
      if (!parts || imagePartCount(parts) === 0) return message;
      const names = frameNames(message);
      if (!names) return message; // 无附件前言 = 用户粘贴图,不动
      let imageIndex = 0;
      let changed = false;
      const content = parts.map((part) => {
        if (part.type !== 'image_url') return part;
        const name = names[imageIndex++];
        if (name !== undefined && VISION_FRAME_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) return part;
        changed = true;
        aged++;
        return {
          type: 'text',
          text:
            `${IMAGE_AGED_PLACEHOLDER_PREFIX}${name ?? UNKNOWN_FRAME_NAME} (~${Math.round(imageUrlChars(part) / 1024)} KB inline). ` +
            'It was viewed in an earlier turn and is no longer attached; call read_file on the file again if you need to see it.]',
        };
      });
      return changed ? ({ role: 'user', content } as ChatMessage) : message;
    });
    if (aged === 0) return noop();
    return { changed: true, aged, messages: next };
  } catch {
    return noop();
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

// ───────────────────────── 请求体字节预算:图片 → 文字卡 ─────────────────────────
//
// 请求体超过字节线(request-limit.ts)而去掉图片即可达标时,由模型把图描述成文字,
// 再用「描述 + 文件路径」卡片替换原图;模型需要细节时按路径 read_file 重读。

/** 描述卡前缀;与 OVERSIZED/BUDGET/AGED 前缀刻意不同,不计入「上游拒收」循环计数。 */
export const IMAGE_CARD_PREFIX = '[image described: ';

/** 描述文字的长度上限(字符),防止一张图的描述反过来撑大请求。 */
export const IMAGE_CARD_MAX_DESCRIPTION_CHARS = 1500;

export interface ReplaceableImage {
  /** `${msg}:${part}`,applyImageCards 的寻址键。 */
  key: string;
  msg: number;
  part: number;
  /** data URL 字符数(≈ 请求体里这张图占的字节数)。 */
  chars: number;
  dataUrl: string;
  /** 附件前言里的文件名;用户粘贴图为 undefined。 */
  name?: string;
  /** 从前一个 assistant tool_call 的 path 参数反查到的原路径;查不到为 undefined。 */
  path?: string;
}

function imageUrlOf(part: MaybePart): string {
  const iu = part.image_url as { url?: unknown } | string | undefined;
  const url = typeof iu === 'string' ? iu : iu && typeof iu === 'object' ? iu.url : undefined;
  return typeof url === 'string' ? url : '';
}

function basenameOf(p: string): string {
  const segs = p.split(/[\\/]/);
  return segs[segs.length - 1] || p;
}

/** 在附件消息之前最近的一次 assistant tool_calls 里,按 path 参数的文件名反查原路径。 */
function findSourcePath(messages: readonly ChatMessage[], msgIndex: number, name: string): string | undefined {
  for (let i = msgIndex - 1; i >= 0 && i >= msgIndex - 12; i--) {
    const m = messages[i] as { role?: string; tool_calls?: Array<{ function?: { arguments?: string } }> };
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    for (const call of m.tool_calls) {
      try {
        const args = JSON.parse(call?.function?.arguments ?? '') as { path?: unknown };
        if (typeof args?.path === 'string' && basenameOf(args.path) === name) return args.path;
      } catch {
        // 参数不是合法 JSON:跳过这一条。
      }
    }
    return undefined; // 只看最近的一批
  }
  return undefined;
}

/**
 * 列出 history 里可被换成文字卡的图片(按出现顺序,旧在前):非屏幕帧的工具图与用户粘贴图。
 * `computer-` 屏幕帧由 applyVisionWindow 管,这里不碰。纯函数、永不抛错。
 */
export function listReplaceableImages(messages: readonly ChatMessage[]): ReplaceableImage[] {
  const out: ReplaceableImage[] = [];
  try {
    if (!Array.isArray(messages)) return out;
    for (let i = 0; i < messages.length; i++) {
      const parts = userContentParts(messages[i]);
      if (!parts || imagePartCount(parts) === 0 || isFrameCarrier(messages[i])) continue;
      const names = frameNames(messages[i]);
      let imageIndex = 0;
      for (let j = 0; j < parts.length; j++) {
        if (parts[j].type !== 'image_url') continue;
        const name = names ? names[imageIndex] : undefined;
        imageIndex++;
        if (name !== undefined && VISION_FRAME_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        const dataUrl = imageUrlOf(parts[j]);
        out.push({
          key: `${i}:${j}`,
          msg: i,
          part: j,
          chars: dataUrl.length,
          dataUrl,
          name,
          path: name !== undefined ? findSourcePath(messages, i, name) : undefined,
        });
      }
    }
  } catch {
    // 永不抛错:返回已收集到的部分。
  }
  return out;
}

/** 生成替换原图的文字卡。description 为 null 表示描述失败:只留名称与重读提示。 */
export function buildImageCard(img: ReplaceableImage, description: string | null): string {
  const kb = Math.round(img.chars / 1024);
  const label = img.name ?? 'pasted image';
  const reread = img.path
    ? `For details, call read_file on "${img.path}" again.`
    : img.name
      ? `For details, call read_file on the file "${img.name}" again.`
      : 'It has no file path and cannot be re-read.';
  const body = description
    ? `Summary: ${description.trim().slice(0, IMAGE_CARD_MAX_DESCRIPTION_CHARS)}`
    : 'No summary is available (the image was not seen).';
  return `${IMAGE_CARD_PREFIX}${label} (~${kb} KB inline, removed to keep the request under the upstream size limit). ${body} ${reread}]`;
}

export interface ApplyImageCardsResult {
  changed: boolean;
  replaced: number;
  messages: ChatMessage[];
}

/** 把 cards(key → 卡片文本)对应的 image_url part 换成 text part。幂等;无改动返回入参引用。 */
export function applyImageCards(
  messages: readonly ChatMessage[],
  cards: ReadonlyMap<string, string>,
): ApplyImageCardsResult {
  const noop = (): ApplyImageCardsResult => ({ changed: false, replaced: 0, messages: messages as ChatMessage[] });
  try {
    if (!Array.isArray(messages) || cards.size === 0) return noop();
    let replaced = 0;
    const next = messages.map((message, i) => {
      const parts = userContentParts(message);
      if (!parts || !parts.some((p, j) => p.type === 'image_url' && cards.has(`${i}:${j}`))) return message;
      const content = parts.map((part, j) => {
        const card = part.type === 'image_url' ? cards.get(`${i}:${j}`) : undefined;
        if (card === undefined) return part;
        replaced++;
        return { type: 'text', text: card };
      });
      return { role: 'user', content } as ChatMessage;
    });
    if (replaced === 0) return noop();
    return { changed: true, replaced, messages: next };
  } catch {
    return noop();
  }
}
