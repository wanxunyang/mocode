// Observation Lifecycle Engine:tool 消息的「观察者生命周期」状态机。
//
// 在 Relevance Pruner 之上的第二层被动裁剪。Relevance Pruner 只管 read_file 的「同 path 新旧替换 +
// mutation 覆写」,本层补足「grep/glob/codegraph 这类观察类工具」的引用追踪。
//
// 四态机(LIVE → REFERENCED → OBSOLETE → STUB):
//   - LIVE:刚 push 进 history 的工具结果,尚未被任何下游工具消费。
//   - REFERENCED:被某个下游 read_file/edit_file/write_file 引用过(基于 path 字符串匹配)。
//   - OBSOLETE:无任何消费者引用,且距离当前 push 已老化 N 步(默认 2)。
//   - STUB:已被替换为存根(物理上 content 变成「⌦[无消费者:...]」)。
//
// 用户拍板的激进风险护栏(避免误伤):
//   - grep/glob/codegraph/web_search/web_fetch 等「观察/检索类」工具,**永远只到 REFERENCED**,
//     不参与自动 STUB。理由:返回多个候选(grep 10 文件但你只读 1 个),剩余候选可能后续被消费。
//   - 当前轮保护区(最后一个 user 之后的工具结果)完全不动。
//   - 已 STUB(含「⌦[已过时:...]」或「⌦[已剔除:...]」或本层的「⌦[无消费者:...]」)不重复处理。
//   - 永不抛错(对齐上下文管道的「调度器永不抛错」契约)。
//   - 只改 .content,不动 tool_call_id / 不删消息 / 不动 tool_calls 数组。
//
// 与 Relevance Pruner 的分工(不重复):
//   - Relevance Pruner:管 read_file 同 path 旧 read + mutation 覆写 → 直接 STUB。
//   - 本层:管「无消费者的观察类工具老化后 → STUB」 + 「被消费的工具 → REFERENCED 标记(可视)」。
//
// 触发点(agent/core.ts):
//   - pushToolResult 出口,新 message idx = history.length - 1。
//   - mutation 分支额外调 pushMutation 通知(也走 observeMutation 同语义)。
//
// 开关:`config.contextLifecycle`(默认 true;MOCODE_LIFECYCLE=false 回退)。

import type { ChatMessage } from '../llm/index.js';
import { extractPath, lastUserIndex, toText, toolNameOf } from './utils.js';

type AnyMessage = ChatMessage & { content?: unknown; tool_call_id?: string };

/** 工具消息的观察者生命周期状态。 */
export type LifeState = 'LIVE' | 'REFERENCED' | 'OBSOLETE' | 'STUB';

/** 观察类工具(永远只到 REFERENCED,不参与自动 STUB)。 */
const OBSERVER_TOOLS = new Set<string>([
  'grep',
  'glob',
  'codegraph',
  'web_search',
  'web_fetch',
]);

/** 消费者工具(这些工具的 push 会触发「上游被消费」标记)。
 *  只列能基于 path 静态判定消费的;run_command/memory_* 等不参与(避免误伤)。 */
const CONSUMER_TOOLS = new Set<string>(['read_file', 'edit_file', 'write_file']);

/** mutation 工具:pushTool 跳过 autoStubOrphans(让 pushMutation 标完 read REFERENCED 再统一老化)。 */
const MUTATION_TOOLS = new Set<string>(['edit_file', 'write_file']);

/** 存根前缀(区分 Relevance Pruner 与 drop_context)。 */
const STUB_PREFIX_NO_CONSUMER = '⌦[无消费者:观察结果已无引用价值]';

/** 老化阈值:某条工具消息自 push 以来经历的「消费者 push」次数。
 *  ≥ 这个值且仍为 LIVE 且非观察类 → 视为 OBSOLETE → STUB。
 *  默认 2:等价于「跨过两个消费者 push 仍无人引用」= 跨过整轮最末尾的工具调用。 */
const DEFAULT_AGE_THRESHOLD = 2;

/** 从 tool 结果的 content 中提取「生产者命中过的 path 列表」。
 *  - read_file:没有 path 列表(本身就是单 path 消费者,无需再追生产者)。
 *  - grep:content 是 `file:line: ...` 行,提取每行的 file 段(只保留绝对路径形态或与 pattern 匹配的)。
 *    简化:把所有看起来像「相对路径 + 文件名」的 token 抽出,留 narrow。
 *  - glob:content 是路径列表,按行 / 空格拆。
 *  - codegraph:content 里通常含 `path/to/file.ts:line`,按行拆,提 file 段。
 *
 *  返回值:命中过的 path 字符串集合(已 dedup)。失败返空集。 */
function extractProducerPaths(toolName: string, content: string): string[] {
  if (!content) return [];
  const out = new Set<string>();
  try {
    if (toolName === 'grep') {
      // 典型行:`src/foo.ts:42: hello world` 或 `path\to\file.ts:42: ...`
      // 取冒号前段(冒号必须跟在数字前面避免切到路径里的冒号)。
      const re = /^([^\s:][^:]*?\.[A-Za-z0-9]+):(\d+):/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) out.add(m[1]);
    } else if (toolName === 'glob') {
      // glob 输出一般是「paths:」+ 换行 + 多路径;每行一个绝对或相对路径。
      // 简化:按行切,跳过含空格的(避免命中 prose),取看起来像路径的行。
      for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.includes(' ')) continue;
        // 含扩展名或含路径分隔符
        if (/\.[A-Za-z0-9]+$/.test(t) || t.includes('/') || t.includes('\\')) out.add(t);
      }
    } else if (toolName === 'codegraph') {
      // codegraph 输出通常 `path\to\file.ts:line:col  symbol` 或类似;按行 + 冒号分隔。
      for (const line of content.split(/\r?\n/)) {
        const m = /^([^\s:][^:]*?\.[A-Za-z0-9]+):(\d+):/.exec(line);
        if (m) out.add(m[1]);
      }
    } else if (toolName === 'web_search' || toolName === 'web_fetch') {
      // 网络结果不在文件系统路径范畴;不参与 producer 路径索引(避免误匹配)。
    }
  } catch {
    // 永不抛错:任何解析失败返当前累积。
  }
  return [...out];
}

/**
 * Observation Lifecycle Engine。
 * 每个 runAgentCore 实例持一个;pushToolResult 出口调 pushTool、mutation 分支调 pushMutation。
 * 内部 try/catch 兜底,对外永不抛错。
 */
export class LifecycleEngine {
  /** 工具消息 idx → 状态。 */
  private readonly states = new Map<number, LifeState>();
  /** 工具消息 idx → 被消费的次数(同一上游被多次消费也只算 REFERENCED,不计并发)。 */
  private readonly consumerCount = new Map<number, number>();
  /** 工具消息 idx → 自 push 以来的「消费者 push」次数(用于老化判定)。
   * 每次 pushTool 触发,所有 LIVE 工具消息 age++。 */
  private readonly age = new Map<number, number>();
  /** producer 路径 → 生产者工具消息 idx 列表(逆查用:某个 path 被消费时,反查上游 producer)。
   * 注意:不存 read_file,因为 read 自身就是消费者不充当 producer。 */
  private readonly producersByPath = new Map<string, number[]>();
  /** 当前步序号(用于 age 老化:每次 pushTool 自增,对比 age 阈值)。 */
  private step = 0;
  /** 最后 user 索引缓存(pushTool 时重算;pushMutation 时也重算,因为 mutation 可能跟 user 同行)。 */
  private lastUser = -1;

  constructor(private readonly ageThreshold: number = DEFAULT_AGE_THRESHOLD) {}

  /** 新工具结果 push 进 history 时调;idx = history.length - 1。
   *  mutation 工具(edit_file/write_file)的 push 跳过本轮的 autoStubOrphans(由调用方在
   *  pushMutation 标完 read REFERENCED 之后再触发),避免刚被 mutation 消费的 read 被提前 STUB。 */
  pushTool(history: ChatMessage[], idx: number): void {
    try {
      const m = history[idx] as AnyMessage;
      if (!m || m.role !== 'tool') return;
      const toolName = toolNameOf(history, idx);
      if (!toolName) return;

      // 已 stub 的不重复登记(幂等)。
      const c = toText(m.content);
      if (c.startsWith('⌦[')) return;

      // 登记为 LIVE。
      this.states.set(idx, 'LIVE');
      this.consumerCount.set(idx, 0);
      this.age.set(idx, 0);

      // 如果是 producer 类工具(grep/glob/codegraph),登记其命中的路径。
      if (OBSERVER_TOOLS.has(toolName)) {
        const paths = extractProducerPaths(toolName, c);
        for (const p of paths) {
          const arr = this.producersByPath.get(p) ?? [];
          if (!arr.includes(idx)) arr.push(idx);
          this.producersByPath.set(p, arr);
        }
      }

      // 如果是 consumer 类工具(read/edit/write),找出上游「被消费的 producer」,标 REFERENCED。
      if (CONSUMER_TOOLS.has(toolName)) {
        const argsRaw = (() => {
          // tool 消息本身没有 args;args 在前导 assistant.tool_calls 里;直接走同 idx 前的 assistant。
          const tcId = m.tool_call_id;
          for (let j = idx - 1; j >= 1; j--) {
            const mm = history[j];
            if (mm.role !== 'assistant') continue;
            const tcs = (mm as { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }).tool_calls;
            const hit = tcs?.find((tc) => tc?.id === tcId);
            if (hit) return hit.function?.arguments ?? '';
          }
          return '';
        })();
        const path = extractPath(argsRaw);
        if (path) {
          // 1) 找该 path 的所有上游 producer(grep/glob/codegraph)→ 标 REFERENCED。
          const producers = this.producersByPath.get(path);
          if (producers) {
            for (const pidx of producers) {
              if (this.states.get(pidx) === 'LIVE') {
                this.states.set(pidx, 'REFERENCED');
              }
              this.consumerCount.set(pidx, (this.consumerCount.get(pidx) ?? 0) + 1);
            }
          }
          // 2) 同 path 的旧 read_file(被本 read「替代」)→ 也标 REFERENCED(由 Relevance Pruner 已 stub)。
          //    这里不重复操作,Relevance Pruner 那边管「内容已被新 read 替代」的语义。
        }
      }

      // 所有 LIVE 工具消息 age++(本次 push 算一步)。stale 的 READ 消息也涨 age,直到 ≥ 阈值才可能 STUB。
      for (const k of this.states.keys()) {
        this.age.set(k, (this.age.get(k) ?? 0) + 1);
      }
      this.step++;
      this.lastUser = lastUserIndex(history);

      // mutation 工具跳过本轮 autoStubOrphans:调用方会调 pushMutation 标完 read REFERENCED 后,
      // 再调 flushAutoStub 触发老化检查,避免 read 在被标 REFERENCED 之前被提前 STUB。
      if (MUTATION_TOOLS.has(toolName)) return;

      // 老化检查:本次 push 完,扫描 LIVE(且非观察类)的工具消息,age ≥ 阈值 → 标 OBSOLETE → STUB。
      this.autoStubOrphans(history);
    } catch {
      // 永不抛错。
    }
  }

  /** mutation 工具(edit_file/write_file)push 后调。语义与 pushTool 一致,但额外标记「被 mutation 消费」的 read。
   *  注意:本层不直接 stub read(那是 Relevance Pruner 的职责);本层只更新状态图。
   *  注意:puhToolResult 出口已经登记过 mutation 本身,这里不再调 pushTool(避免 age 翻倍)。 */
  pushMutation(history: ChatMessage[], mutationIdx: number, path: string): void {
    try {
      // mutation 自身已在 pushToolResult 出口登记(若 lifecycle 存在);此处仅做「mutation 是
      // path 的消费者」语义:把该 path 在 mutation 之前的所有 read_file(未被 stub 的 LIVE/REFERENCED)
      // 标 REFERENCED。
      const protectedFrom = Math.max(0, this.lastUser);
      for (let i = 1; i < mutationIdx; i++) {
        if (i >= protectedFrom) continue;
        const m = history[i] as AnyMessage;
        if (m?.role !== 'tool') continue;
        const tn = toolNameOf(history, i);
        if (tn !== 'read_file') continue;
        const c = toText(m.content);
        if (c.startsWith('⌦[')) continue;
        const argsRaw = this.findToolArgs(history, i);
        if (extractPath(argsRaw) === path) {
          if (this.states.get(i) === 'LIVE') this.states.set(i, 'REFERENCED');
          this.consumerCount.set(i, (this.consumerCount.get(i) ?? 0) + 1);
        }
      }
      // 标完 read REFERENCED 后,统一跑老化检查(本次 mutation push 之前 pushTool 已跳过)。
      this.autoStubOrphans(history);
    } catch {
      // 永不抛错。
    }
  }

  /** 老化自动 STUB:扫描所有 LIVE(且非观察类)且 age ≥ 阈值且不在保护区的工具消息 → OBSOLETE → STUB。 */
  private autoStubOrphans(history: ChatMessage[]): void {
    try {
      const protectedFrom = Math.max(0, this.lastUser);
      for (const [idx, state] of this.states) {
        if (state !== 'LIVE') continue;
        if (idx >= protectedFrom) continue; // 当前轮保护区
        const age = this.age.get(idx) ?? 0;
        if (age < this.ageThreshold) continue;
        const tn = toolNameOf(history, idx);
        if (!tn) continue;
        // 观察类工具永远只到 REFERENCED,不自动 STUB(用户拍板)。
        if (OBSERVER_TOOLS.has(tn)) {
          this.states.set(idx, 'REFERENCED');
          continue;
        }
        // 执行 STUB。
        this.stubOne(history, idx, tn);
      }
    } catch {
      // 永不抛错。
    }
  }

  /** 实际替换 content 为存根。 */
  private stubOne(history: ChatMessage[], idx: number, toolName: string): void {
    try {
      const m = history[idx] as AnyMessage;
      if (!m) return;
      const c = toText(m.content);
      if (c.startsWith('⌦[')) return; // 幂等
      const origLen = c.length;
      const stub = `${STUB_PREFIX_NO_CONSUMER} ${toolName} ${origLen} 字符 → 老化无消费者,自动归档`;
      (m as { content: string }).content = stub;
      this.states.set(idx, 'STUB');
    } catch {
      // 永不抛错。
    }
  }

  /** 找某条 tool 消息对应的 assistant.tool_calls.arguments。 */
  private findToolArgs(history: ChatMessage[], idx: number): string {
    try {
      const tcId = (history[idx] as { tool_call_id?: string }).tool_call_id;
      if (!tcId) return '';
      for (let j = idx - 1; j >= 1; j--) {
        const mm = history[j];
        if (mm.role !== 'assistant') continue;
        const tcs = (mm as { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }).tool_calls;
        const hit = tcs?.find((tc) => tc?.id === tcId);
        if (hit) return hit.function?.arguments ?? '';
      }
    } catch {
      // 永不抛错。
    }
    return '';
  }

  // ── 观测 API(供 /context 面板、调试脚本用) ─────────────────────────────

  /** 拿某 idx 的当前状态;不在图里返 null。 */
  getState(idx: number): LifeState | null {
    return this.states.get(idx) ?? null;
  }

  /** 拿当前各状态计数。供 /context 显示「live=N, referenced=M, obsolete=K, stubbed=S」。 */
  stats(): { live: number; referenced: number; obsolete: number; stubbed: number } {
    let live = 0;
    let referenced = 0;
    let obsolete = 0;
    let stubbed = 0;
    for (const s of this.states.values()) {
      if (s === 'LIVE') live++;
      else if (s === 'REFERENCED') referenced++;
      else if (s === 'OBSOLETE') obsolete++;
      else if (s === 'STUB') stubbed++;
    }
    return { live, referenced, obsolete, stubbed };
  }
}

/** 默认单例工厂。runAgentCore 入口 new 一个,后续 pushTool / pushMutation 共享。 */
export function createLifecycleEngine(ageThreshold?: number): LifecycleEngine {
  return new LifecycleEngine(ageThreshold);
}