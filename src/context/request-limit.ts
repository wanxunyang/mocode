// 请求体字节预算:与 token 窗口并列的第二个预算。
//
// 为什么需要:上游网关(如本机 Kiro-Go,maxPayloadBytes = 900 KiB)限的是**整个请求体字节数**,
// 而 token 估算按像素算图、看不到字节;图片又随 history 每步重发。token 只用了 7% 却被 400 拒收,
// 就是这个维度没人管。
//
// 口径(只有一个系数):上限 L 的 80% 为触发线。L 的来源按优先级:
//   1. 显式配置 MOCODE_REQUEST_MAX_KB(网关硬上限,Kiro-Go 填 900);
//   2. 自动学习:上游以 context_length_exceeded 拒收、而本地 token 估算远低于窗口时,
//      把那次失败请求的估算字节数记为 L(取历史最小值,按 baseURL 持久化);
//   3. 都没有 → 0 = 不限制(直连官方 API 不会无谓丢图)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatMessage, ChatTool } from '../llm/index.js';

/** 触发线 = 上限 × 0.8。整套机制唯一的系数。 */
export const REQUEST_BYTES_TRIGGER_RATIO = 0.8;

/** 低于它的失败请求不可能是「字节上限」问题,不学习,防止误学出极小上限。 */
const MIN_LEARNABLE_BYTES = 64 * 1024;

const toolBytesCache = new WeakMap<object, number>();

function toolsBytes(tools: readonly ChatTool[]): number {
  if (tools.length === 0) return 0;
  const key = tools as object;
  const hit = toolBytesCache.get(key);
  if (hit !== undefined) return hit;
  const n = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  toolBytesCache.set(key, n);
  return n;
}

/**
 * 估算一次请求体的字节数:文本按 UTF-8 字节、图片按 data URL 长度(ASCII)、工具 schema 按 JSON 长度,
 * 每条消息加 32 字节结构开销。偏差在几个百分点内,够做 0.8 触发线的判断。纯函数、永不抛错。
 */
export function estimateRequestBytes(messages: readonly ChatMessage[], tools: readonly ChatTool[] = []): number {
  let sum = 0;
  try {
    sum += toolsBytes(tools);
    for (const m of messages) {
      sum += 32;
      const content = (m as { content?: unknown }).content;
      if (typeof content === 'string') {
        sum += Buffer.byteLength(content, 'utf8');
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const p = part as { type?: unknown; text?: unknown; image_url?: unknown };
          if (typeof p.text === 'string') sum += Buffer.byteLength(p.text, 'utf8');
          if (p.type === 'image_url') {
            const iu = p.image_url as { url?: unknown } | string | undefined;
            const url = typeof iu === 'string' ? iu : iu && typeof iu === 'object' ? iu.url : undefined;
            sum += 40 + (typeof url === 'string' ? url.length : 0);
          }
        }
      }
      const calls = (m as { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> })
        .tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          sum += 48 + (c?.id?.length ?? 0) + (c?.function?.name?.length ?? 0) + (c?.function?.arguments?.length ?? 0);
        }
      }
    }
  } catch {
    // 估算失败按已累计值返回;不能因度量阻断请求。
  }
  return sum;
}

/** 显式配置的网关硬上限(字节)。MOCODE_REQUEST_MAX_KB;未配置/空串/非法/0 → 0。 */
export function explicitRequestLimitBytes(): number {
  const raw = process.env.MOCODE_REQUEST_MAX_KB;
  if (raw === undefined || raw.trim() === '') return 0;
  const kb = Number(raw);
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : 0;
}

interface LimitCache {
  version: 1;
  entries: Record<string, { bytes: number; updatedAt: number }>;
}

let cache: LimitCache | undefined;

function cachePath(): string {
  return process.env.MOCODE_REQUEST_LIMIT_CACHE || path.join(os.homedir(), '.mocode', 'request-limits.json');
}

/** 只落 baseURL 的摘要,避免 URL 中偶然携带的凭据写盘。 */
function keyOf(baseURL: string): string {
  return createHash('sha256').update(baseURL).digest('hex');
}

function readCache(): LimitCache {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as LimitCache;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      cache = parsed;
      return cache;
    }
  } catch {
    // 不存在或损坏都从空缓存开始。
  }
  cache = { version: 1, entries: {} };
  return cache;
}

/** 测试用:丢弃内存缓存,下次读取重新走磁盘。 */
export function resetRequestLimitCache(): void {
  cache = undefined;
}

/** 当前 baseURL 的请求体上限(字节)。显式配置 > 学习值 > 0(不限制)。 */
export function requestByteLimit(baseURL: string): number {
  const explicit = explicitRequestLimitBytes();
  if (explicit > 0) return explicit;
  const entry = readCache().entries[keyOf(baseURL)];
  return entry && Number.isFinite(entry.bytes) && entry.bytes > 0 ? entry.bytes : 0;
}

/**
 * 记录一次「字节拒收」:failingBytes 是被拒请求的估算字节数。取历史最小值(只会更保守)。
 * 返回生效的学习值;样本过小(< 64 KiB)不学,返回当前值。
 */
export function learnRequestByteLimit(baseURL: string, failingBytes: number): number {
  const store = readCache();
  const key = keyOf(baseURL);
  const previous = store.entries[key]?.bytes;
  if (!Number.isFinite(failingBytes) || failingBytes < MIN_LEARNABLE_BYTES) return previous ?? 0;
  const bytes = previous && previous > 0 ? Math.min(previous, Math.round(failingBytes)) : Math.round(failingBytes);
  if (bytes === previous) return bytes;
  store.entries[key] = { bytes, updatedAt: Date.now() };
  try {
    const target = cachePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // 只影响跨进程复用;当前进程仍用内存值。
  }
  return bytes;
}
