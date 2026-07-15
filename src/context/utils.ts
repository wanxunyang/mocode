// 跨上下文模块共享的小工具函数。
//
// 目的:消除 `relevance.ts` / `lifecycle.ts` / `budget.ts` / `compact.ts` / `session/drop.ts`
//      之间的 copy-paste。这些函数逻辑完全一致,统一维护于此,避免行为漂移。
//
// 不变量:
//  - 永不抛错(对齐「调度器永不抛错」契约)。
//  - 仅依赖 `ChatMessage` 的最小形状,不反向 import agent / session / tools。

import path from 'node:path';
import type { ChatMessage } from '../llm/index.js';

/** 将文件路径统一成可用于跨工具关联的绝对 key。
 * Windows 路径不区分大小写，并统一使用 `/`，避免相对/绝对路径及分隔符差异导致漏配。 */
export function canonicalizePath(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  try {
    const normalized = path.resolve(input.trim()).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}

/** 工具层以 `错误:` 作为统一失败前缀；失败结果不得消费或淘汰已有观察数据。 */
export function isToolResultSuccess(output: string): boolean {
  return !output.trimStart().startsWith('错误:');
}

/** 把消息 content 拍平成字符串(OpenAI 可能 string / null / 多模态数组)。
 *  用于估算 token、内容匹配、stub 拼接等场景。 */
export function toText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 从 history 末尾向前找最后一个 user 消息的索引;无 user 返 -1。
 *  用于划定「当前轮保护区」——该 user 及其之后的消息(agent 本轮还在用)不动。
 *  注:history[0] 是 system,故下界为 1。 */
export function lastUserIndex(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === 'user') return i;
  }
  return -1;
}

/** 取 tool 消息对应的工具名(从紧邻的前导 assistant.tool_calls 按 tool_call_id 配对找)。
 *  返回 null 表示找不到(孤儿 tool 消息,极少见),调用方保守跳过。 */
export function toolNameOf(history: ChatMessage[], idx: number): string | null {
  const tcId = (history[idx] as { tool_call_id?: string }).tool_call_id;
  if (!tcId) return null;
  for (let j = idx - 1; j >= 1; j--) {
    const m = history[j];
    if (m.role !== 'assistant') continue;
    const tcs = (m as { tool_calls?: { id?: string; function?: { name?: string } }[] }).tool_calls;
    if (!tcs) continue;
    const hit = tcs.find((tc) => tc?.id === tcId);
    if (hit) return hit.function?.name ?? null;
  }
  return null;
}

/** 解析工具 arguments JSON,只取 `path` 字段;非法 / 无 path 返 null。
 *  用于 read_file / edit_file / write_file 等以 path 为关键字的工具,供跨消息关联使用。 */
export function extractPath(argsRaw: string | undefined): string | null {
  if (!argsRaw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = (parsed as Record<string, unknown>).path;
  return typeof p === 'string' && p ? p : null;
}
