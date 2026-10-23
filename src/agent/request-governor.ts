// 请求体字节预算的执行层(口径与上限来源见 context/request-limit.ts)。
//
// 请求体估算字节数超过「上限 × 0.8」时:
//   1. 若把图片去掉仍超线 → 病因是文本,本层不动,交给原有的摘要压缩;
//   2. 否则从最旧的图开始挑,挑到剩余字节落回线下为止;
//   3. 逐张让模型把图描述成文字(只带这一张图的小请求),描述 + 文件路径写成文字卡替换原图;
//      模型需要细节时按卡片里的路径 read_file 重读。描述失败降级为「未看过 + 重读提示」。

import type OpenAI from 'openai';
import { buildImageCard, listReplaceableImages, type ReplaceableImage } from '../context/vision-window.js';
import { estimateRequestBytes, REQUEST_BYTES_TRIGGER_RATIO } from '../context/request-limit.js';
import type { HistoryManager, ModelRunner } from './stages/contracts.js';

/** 一次最多让模型描述几张;其余的只留名称 + 重读提示,防止描述调用本身拖慢一步。 */
export const MAX_DESCRIBED_IMAGES = 4;

/** 单张图描述请求的超时。 */
const DESCRIBE_TIMEOUT_MS = 60_000;

/** 文字卡替换后每张图大约占的字节数(用于规划时的余量估算)。 */
const CARD_BYTES_ESTIMATE = 700;

/** 每个 image_url part 在请求体里除 data URL 之外的结构开销(与 estimateRequestBytes 一致)。 */
const IMAGE_PART_OVERHEAD = 40;

export type ImageReliefPlan =
  | { kind: 'under_limit' }
  | { kind: 'no_images' }
  | { kind: 'text_dominant' }
  | { kind: 'replace'; images: ReplaceableImage[]; bytesAfter: number };

/**
 * 纯函数:决定要不要动图、动哪几张。
 * 先判「去掉全部可换的图是否能达标」—— 不能就是文本问题(text_dominant),一张都不动;
 * 能就从最旧的开始挑,挑到够为止(尽量少丢图,保留最新的)。
 */
export function planImageRelief(
  images: readonly ReplaceableImage[],
  totalBytes: number,
  limitBytes: number,
): ImageReliefPlan {
  const target = limitBytes * REQUEST_BYTES_TRIGGER_RATIO;
  if (!(limitBytes > 0) || totalBytes <= target) return { kind: 'under_limit' };
  if (images.length === 0) return { kind: 'no_images' };
  const cost = (img: ReplaceableImage): number => img.chars + IMAGE_PART_OVERHEAD - CARD_BYTES_ESTIMATE;
  const all = images.reduce((sum, img) => sum + cost(img), 0);
  if (totalBytes - all > target) return { kind: 'text_dominant' };
  const picked: ReplaceableImage[] = [];
  let remaining = totalBytes;
  for (const img of images) {
    if (remaining <= target) break;
    picked.push(img);
    remaining -= cost(img);
  }
  return { kind: 'replace', images: picked, bytesAfter: Math.max(0, Math.round(remaining)) };
}

const DESCRIBE_PROMPT =
  'You are helping a coding agent that will NOT see this image again. Describe it so the agent can keep working without it: ' +
  'transcribe all visible text verbatim (error messages, code, numbers, labels), then summarize layout, UI state and anything ' +
  'notable for debugging. Be factual and concise (under 250 words). Do not add advice.';

export type ImageDescriber = (img: ReplaceableImage, signal?: AbortSignal) => Promise<string | null>;

/** 用当前模型描述一张图(独立小请求,不带工具、不写回 history)。任何失败返回 null。 */
export function createImageDescriber(modelRunner: ModelRunner): ImageDescriber {
  return async (img, signal) => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), DESCRIBE_TIMEOUT_MS);
    try {
      const result = await modelRunner.run(
        {
          history: [
            {
              role: 'user',
              content: [
                { type: 'text', text: DESCRIBE_PROMPT },
                { type: 'image_url', image_url: { url: img.dataUrl } },
              ],
            } as never,
          ],
          tools: [],
          handlers: {},
          reasoningEffort: 'low',
        },
        controller.signal,
      );
      const text = result.content?.trim();
      return text ? text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

export interface RelieveRequestBytesInput {
  historyManager: HistoryManager;
  tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  /** 请求体上限(字节);<=0 = 不限制,直接返回。 */
  limitBytes: number;
  /** history 之外会追加进请求的字节(ephemeral 注入等)。 */
  extraBytes?: number;
  signal?: AbortSignal;
  describe: ImageDescriber;
  /** 确定要换图、描述请求发出之前触发一次(给界面显示「正在压缩图片」,避免描述期间像卡住)。 */
  onStart?: (info: { images: number; bytes: number }) => void;
}

export interface RelieveRequestBytesResult {
  reason: 'no_limit' | 'under_limit' | 'no_images' | 'text_dominant' | 'replaced';
  replaced: number;
  described: number;
  bytesBefore: number;
  bytesAfter: number;
}

/** 请求体超线且去图可达标时,把图描述成文字卡替换。返回换掉的张数(0 = 未改动)。 */
export async function relieveRequestBytes(input: RelieveRequestBytesInput): Promise<RelieveRequestBytesResult> {
  const { historyManager, tools, limitBytes, signal, describe } = input;
  const messages = historyManager.snapshot().messages as Parameters<typeof estimateRequestBytes>[0];
  const bytesBefore = estimateRequestBytes(messages, tools) + (input.extraBytes ?? 0);
  const idle = (reason: RelieveRequestBytesResult['reason']): RelieveRequestBytesResult => ({
    reason,
    replaced: 0,
    described: 0,
    bytesBefore,
    bytesAfter: bytesBefore,
  });
  if (!(limitBytes > 0)) return idle('no_limit');

  const plan = planImageRelief(listReplaceableImages(messages), bytesBefore, limitBytes);
  if (plan.kind !== 'replace') return idle(plan.kind);
  try {
    input.onStart?.({ images: plan.images.length, bytes: bytesBefore });
  } catch {
    // 展示回调不能影响主流程。
  }

  // 逐张描述(串行:并发会瞬间多打几个带大图的请求,上游反而更容易拒)。
  const cards = new Map<string, string>();
  let described = 0;
  for (let i = 0; i < plan.images.length; i++) {
    const img = plan.images[i];
    let description: string | null = null;
    if (i < MAX_DESCRIBED_IMAGES && !signal?.aborted) {
      description = await describe(img, signal);
      if (description) described++;
    }
    cards.set(img.key, buildImageCard(img, description));
  }
  if (signal?.aborted) return idle('replaced');

  const replaced = historyManager.replaceImagesWithCards(cards);
  return {
    reason: 'replaced',
    replaced,
    described,
    bytesBefore,
    bytesAfter: plan.bytesAfter,
  };
}
