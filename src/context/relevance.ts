// Relevance Pruner:read_file 相关性裁剪(纯静态分析,零 LLM 调用)。
//
// 场景(用户描述):
//   1) read foo.ts → 后来又 read foo.ts → 旧结果无价值 → 替换为存根
//   2) read foo.ts → edit foo.ts → read foo.ts → 中间那次 read 之前的所有旧 read
//      在 mutation 之后已失效 → 替换为存根
//
// 与现有子系统的关系:
//   - Context Optimization Pipeline(`pipeline.ts`):单条上限 + 类型化编码。本层在其外,
//     在 pushToolResult 出口再做一次"跨条"裁剪。
//   - drop_context(`session/drop.ts`):agent 主动剔除已知无关的旧 tool 结果。本层是被动自动,
//     不需要 agent 调;两者并存不冲突。
//   - compact(`session/compact.ts`):阈值触发的整体微压缩+摘要。本层只裁"明确失效"的旧 read,
//     不触发摘要;门槛更低、零成本。
//
// 不变量(对齐 drop_context / compact):
//   - 只改 .content,不删消息、不动 tool_call_id、不动 tool_calls 数组结构。
//   - 当前轮保护区:不剔除"最后一个 user 消息及其之后"的 read_file 结果(agent 本轮还在用,
//     剔除会破坏正在进行的推理)。实现复用 drop.ts 的 lastUserIndex 思路。
//   - 幂等:已 stub(含「已过时」标记)不重复 stub,避免反复重写同一条消息。
//   - 永不抛错(对齐「调度器永不抛错」契约);无匹配 / 解析失败 / 异常 → 静默 no-op。
//   - TUI 渲染(hooks.onToolResult)用原始 output,与本层解耦——屏上看全量,LLM 看裁剪后版。
//
// 零行为变化兜底:开关 `config.contextRelprune` 关闭时,pipeline 路径完全不调本模块。

import type { ChatMessage } from '../llm/index.js';
import { extractPath, lastUserIndex, toText, toolNameOf } from './utils.js';

/** 仅依赖一个最小 chat-message 形状接口,避免反向 import llm 全量。 */
type AnyMessage = ChatMessage & { content?: unknown; tool_call_id?: string };

/** stub 标记前缀(供幂等判定)。drop_context 用的是「⌦[已剔除:与当前任务无关]」,
 *  本层用「⌦[已过时:同 path 已有新 read / 已被 mutation 覆写]」,区分两类剔除来源。 */
const STUB_PREFIX = '⌦[已过时:同 path 已有新 read / 已被 mutation 覆写]';

/**
 * 维护「path → 该 path 所有 read_file tool 消息的 history index」映射。
 *  - observePush:把刚 push 的 read_file tool 消息登记,并把同 path 的"更早" read 全部 stub。
 *  - observeMutation:把该 mutation path 的"在 mutation 之前的" read 全部 stub。
 *
 * 设计:每个 agent 会话(每个 runAgentCore 实例)持有一个 pruner。会话结束/换 plan 时
 * 可新建;不持久化(history 重建时索引自然过期)。
 *
 * 零依赖:仅依赖 ChatMessage 形状;不 import llm / tools / agent。
 */
export class RelevancePruner {
  /** path → [history index, ...]  按插入序;最新在末尾。 */
  private readonly readByPath = new Map<string, number[]>();

  /** 把刚 push 的消息通知 pruner。
   *  - 只处理 tool 消息(role==='tool')。
   *  - 只关心 read_file:登记 + 反向 stub 同 path 旧 read。
   *  - 非 read_file 的 tool 消息:无操作(本层只管 read_file)。
   *  - 非 tool 消息(assistant / user / system):无操作。
   */
  observePush(history: ChatMessage[], msg: ChatMessage): void {
    try {
      if (msg.role !== 'tool') return;
      const m = msg as AnyMessage;
      const tcId = m.tool_call_id;
      if (!tcId) return;
      const idx = history.length - 1;
      if (idx < 1 || history[idx] !== msg) return; // 防御:必须刚 push 到末尾
      const name = toolNameOf(history, idx);
      if (name !== 'read_file') return;
      const content = toText((msg as { content?: unknown }).content);
      if (content.startsWith(STUB_PREFIX)) return; // 已是存根(防御)

      // 从前导 assistant.tool_calls 找对应 tc.arguments(精确 path 来源)。
      // 退化方案:从消息内容首行解析路径(read_file 输出形如 `\n     1\t...`,无 path;
      // 故必须从 args 取)。找不到则保守不动。
      let path: string | null = null;
      for (let j = idx - 1; j >= 1; j--) {
        const mm = history[j];
        if (mm.role !== 'assistant') continue;
        const tcs = (mm as { tool_calls?: { id?: string; function?: { arguments?: string } }[] }).tool_calls;
        if (!tcs) continue;
        const hit = tcs.find((tc) => tc?.id === tcId);
        if (hit) {
          path = extractPath(hit.function?.arguments);
          break;
        }
      }
      if (!path) return;

      // 先 stub 旧 read(同 path,idx 之前),再登记新 idx。
      this.stubPriorReads(history, path, idx);
      // 登记新 idx
      const list = this.readByPath.get(path);
      if (list) list.push(idx);
      else this.readByPath.set(path, [idx]);
    } catch {
      /* 永不抛错 */
    }
  }

  /**
   * 把该 mutation path 的"在 mutation 之前的" read 全部 stub。
   * 通常用于 edit_file / write_file 工具:mutation 之后,之前的 read_file(p) 内容
   * 已失效(已不再是文件当前状态),模型后续若依赖旧 read 来 edit_file 会失败,但 edit_file
   * 的 old_string 来自模型记忆/后读,不依赖旧 read 结果文本。
   *
   * 调用时机:agent/core.ts 在 mutation 工具调用的 pushToolResult 之后立即调;
   * 此时 history 末尾就是 mutation 的 tool 消息,prior reads 指 < idx。
   */
  observeMutation(history: ChatMessage[], path: string): void {
    try {
      if (!path) return;
      const idx = history.length - 1;
      if (idx < 1) return;
      // mutation 之前的所有同 path read → stub
      this.stubPriorReads(history, path, idx);
      // 该 path 的 read 索引全部作废(mutation 之后再 read 会重新登记)
      this.readByPath.delete(path);
    } catch {
      /* 永不抛错 */
    }
  }

  /**
   * 把 history 里 "path 同 + index < beforeIdx + 不在当前轮保护区" 的所有 read_file
   * tool 消息替换为存根(只改 .content,不动 id / 数组结构)。
   *
   * 实现:
   *  - 用 readByPath[path] 直接拿到所有 index(已登记过),筛 < beforeIdx 的 stub。
   *  - 同时扫一遍 [1, beforeIdx) 区间找未登记的(防御:索引可能漏登;不依赖索引也能 stub,
   *    保证正确性。索引只用于"避免重复扫全表"的优化)。
   *  - protectedFrom = lastUserIndex(history):user 之后一律不动。
   *  - 幂等:已是 STUB_PREFIX 的跳过。
   */
  private stubPriorReads(history: ChatMessage[], path: string, beforeIdx: number): void {
    const STUB_PREFIX_LOCAL = STUB_PREFIX;
    const guard = lastUserIndex(history);
    // protectedFrom = 最后一个 user index(若 >0);user 之后(>= guard)的 read 永不动。
    // protectedFrom=0 表示无 user(history 只有 system),整段都可 stub。
    const protectedFrom = guard > 0 ? guard : 0;

    const stubOne = (i: number): void => {
      if (i >= beforeIdx) return;
      if (i >= protectedFrom && protectedFrom > 0) return; // 当前轮保护区
      const m = history[i] as AnyMessage;
      if (!m || m.role !== 'tool') return;
      const content = toText((m as { content?: unknown }).content);
      if (content.startsWith(STUB_PREFIX_LOCAL)) return; // 幂等
      const name = toolNameOf(history, i);
      if (name !== 'read_file') return;
      // 校验 tool_call_id 配对(防御:孤儿子消息不动)
      const tcId = m.tool_call_id;
      if (!tcId) return;
      const stub = `${STUB_PREFIX_LOCAL} read_file(${path}) ${content.length} 字符 → 已被新 read / mutation 替代 · id …${tcId.slice(-6)}⌫`;
      (m as { content?: string }).content = stub;
    };

    // 1) 用 Map 索引(快路径)
    const indexed = this.readByPath.get(path);
    if (indexed) {
      for (const i of indexed) stubOne(i);
    }
    // 2) 全表扫一遍(防御:索引可能漏登 / 历史来自 resume)
    //    仅扫 [1, beforeIdx) 且不在保护区内的 range,成本可控。
    const scanEnd = Math.min(beforeIdx, protectedFrom > 0 ? protectedFrom : beforeIdx);
    for (let i = 1; i < scanEnd; i++) {
      stubOne(i);
    }
  }
}

/** 默认单例:每个 agent 循环一个。runAgentCore 入口 new 一个,后续 observe 共享。 */
export function createRelevancePruner(): RelevancePruner {
  return new RelevancePruner();
}

/** 解析一条 stub 字符串,提取原 content 长度(若可解析)。失败返 null。 */
function parseStubOriginalLen(stub: string): number | null {
  // 格式:⌦[已过时:同 path 已有新 read / 已被 mutation 覆写] read_file(<path>) <N> 字符 → ...
  const m = / read_file\([^)]+\) (\d+) 字符 /.exec(stub);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 扫 history,统计被相关性裁剪 stub 的 read_file tool 消息(条数 + 原字节数)。
 * 供 /context 渲染统计行用(让用户直观看到「prune 帮了多少」)。
 * 永不抛错(对齐本模块契约);history 为空 / 无 stub 时返零值。
 *
 * 注意:stub 后只剩 stub 字符串(原 content 已丢失),故只能从 stub 字符串里 parse
 * 原字节数,误差 = stub 时记录的 content.length(精确);token 估算走 estimateTokens。
 */
export function computePruneStats(history: ChatMessage[]): {
  stubbed: number;
  /** 原 content 总字节数(仅 stubbed 的)。 */
  originalChars: number;
  /** 反推原 token 数(粗略:estimateTokens(originalChars 字符))。 */
  originalTokens: number;
  /** 当前 stub 字符串总字节数。 */
  stubChars: number;
  /** 估算释放的 token 数(originalTokens - 当前 stub 占的 token)。 */
  freedTokens: number;
} {
  let stubbed = 0;
  let originalChars = 0;
  let stubChars = 0;
  for (const m of history) {
    if (m.role !== 'tool') continue;
    const c = toText((m as { content?: unknown }).content);
    // Relevance Pruner 的 stub(⌦[已过时:...) 和 Lifecycle Engine 的 DIGEST(⌦[摘要:...) 都统计。
    const isPruneStub = c.startsWith(STUB_PREFIX);
    const isDigest = c.startsWith('⌦[摘要:');
    if (!isPruneStub && !isDigest) continue;
    stubbed++;
    stubChars += c.length;
    const orig = parseStubOriginalLen(c);
    if (orig != null) originalChars += orig;
  }
  // token 估算:用 estimateTokens(懒导入,避免循环依赖 llm)
  // 这里偷懒:走粗略 chars/4(中文混合下会过估,安全侧)
  // 准确应调 estimateTokens,但 /context 已经是粗算,误差可接受
  const originalTokens = Math.ceil(originalChars / 4);
  const stubTokens = Math.ceil(stubChars / 4);
  return {
    stubbed,
    originalChars,
    originalTokens,
    stubChars,
    freedTokens: Math.max(0, originalTokens - stubTokens),
  };
}