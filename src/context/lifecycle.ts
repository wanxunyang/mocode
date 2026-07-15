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
// 观察类工具两阶段衰减(避免误伤):
//   - grep/glob/codegraph/web_search/web_fetch 等「观察/检索类」工具两阶段衰减:
//     Phase 1(8 步):LIVE → REFERENCED,保留完整内容(返回多个候选,剩余候选可能后续被消费)。
//     Phase 2(+5 步):REFERENCED → DIGEST,替换为摘要存根(保留文件列表+命中数+参数,丢弃详情),
//     释放 ~90% token。states 仍为 REFERENCED,不引入新状态。
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
import {
  canonicalizePath,
  extractPath,
  isToolResultSuccess,
  lastUserIndex,
  toText,
  toolNameOf,
} from './utils.js';

type AnyMessage = ChatMessage & { content?: unknown; tool_call_id?: string };

/** 工具消息的观察者生命周期状态。 */
export type LifeState = 'LIVE' | 'REFERENCED' | 'OBSOLETE' | 'STUB';

/** 观察类工具(LIVE → REFERENCED → DIGEST 两阶段衰减,永不自动 STUB)。 */
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

/** 观察类工具摘要前缀(DIGEST 状态标记)。 */
const DIGEST_PREFIX = '⌦[摘要:';

/** 老化阈值:某条工具消息自 push 以来经历的「消费者 push」次数。
 *  ≥ 这个值且仍为 LIVE 且非观察类 → 视为 OBSOLETE → STUB。
 *  默认 2:等价于「跨过两个消费者 push 仍无人引用」= 跨过整轮最末尾的工具调用。 */
const DEFAULT_AGE_THRESHOLD = 2;

/** 观察类工具 Phase 1:LIVE → REFERENCED 的老化阈值(普通工具用 DEFAULT_AGE_THRESHOLD=2)。
 *  10 步后才降为 REFERENCED,保留完整内容;理由:返回多个候选(grep 10 文件但只读 1 个),
 *  剩余候选可能后续被消费,给足够时间窗口。 */
const OBSERVER_REFERENCED_AGE = 10;

/** 观察类工具 Phase 2:REFERENCED → DIGEST 的老化阈值(从 REFERENCED 起再累积)。
 *  +5 步后替换为摘要存根,保留文件列表+命中数+参数,丢弃详情;释放 ~90% token。 */
const OBSERVER_DIGEST_AGE = 5;

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
  const addPath = (raw: string): void => {
    const canonical = canonicalizePath(raw);
    if (canonical) out.add(canonical);
  };
  try {
    if (toolName === 'grep') {
      // grep 内置工具的结构化输出是 `path: N 处匹配,行号 [...]`；旧格式也可能是
      // `path:line: content`。两者都必须建立 producer 索引，供后续 read_file 关联。
      const rawLine = /^(.+?\.[A-Za-z0-9]+):\d+:/gm;
      const summaryHeader = /^(.+?\.[A-Za-z0-9]+):\s*\d+\s*(?:处匹配|matches?)[,，]/gmi;
      let m: RegExpExecArray | null;
      while ((m = rawLine.exec(content))) addPath(m[1]);
      while ((m = summaryHeader.exec(content))) addPath(m[1]);
    } else if (toolName === 'glob') {
      // glob 输出一般是「paths:」+ 换行 + 多路径;每行一个绝对或相对路径。
      // 简化:按行切,跳过含空格的(避免命中 prose),取看起来像路径的行。
      for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.includes(' ')) continue;
        // 含扩展名或含路径分隔符
        if (/\.[A-Za-z0-9]+$/.test(t) || t.includes('/') || t.includes('\\')) addPath(t);
      }
    } else if (toolName === 'codegraph') {
      // codegraph 输出通常 `path\to\file.ts:line:col  symbol` 或类似;按行 + 冒号分隔。
      for (const line of content.split(/\r?\n/)) {
        const m = /^([^\s:][^:]*?\.[A-Za-z0-9]+):(\d+):/.exec(line);
        if (m) addPath(m[1]);
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
  /** 已被 DIGEST 的 tool 消息 idx 集合(避免重复检查;states 保持 REFERENCED)。 */
  private readonly digestedIdxs = new Set<number>();
  /** 摘要不比原文短而保留原文的 idx；仅抑制当前 run 内的重复计算。 */
  private readonly digestRetainedIdxs = new Set<number>();
  /** 当前步序号(用于 age 老化:每次 pushTool 自增,对比 age 阈值)。 */
  private step = 0;
  /** 最后 user 索引缓存(pushTool 时重算;pushMutation 时也重算,因为 mutation 可能跟 user 同行)。 */
  private lastUser = -1;

  constructor(private readonly ageThreshold: number = DEFAULT_AGE_THRESHOLD, history?: ChatMessage[]) {
    if (history) this.rehydrate(history);
  }

  /**
   * 从会话历史恢复生命周期状态。
   *
   * 旧轮只恢复 observer，使检索结果能跨轮继续老化；最后一个 user 之后则恢复全部成功、
   * 未归档的工具结果，保证同一 runAgentCore 内 compact 重建 history 后不丢当前轮状态。
   */
  private rehydrate(history: ChatMessage[]): void {
    try {
      const currentTurnStart = lastUserIndex(history);
      let replayLastUser = -1;
      const pendingDigests = new Set<number>();

      for (let idx = 1; idx < history.length; idx++) {
        const m = history[idx] as AnyMessage;
        if (m.role === 'user') {
          replayLastUser = idx;
          continue;
        }
        if (m.role !== 'tool') continue;
        const toolName = toolNameOf(history, idx);
        if (!toolName) continue;

        const content = toText(m.content);
        const isObserver = OBSERVER_TOOLS.has(toolName);
        const isDigest = content.startsWith(DIGEST_PREFIX);
        const isCurrentTurnTool = currentTurnStart >= 0 && idx > currentTurnStart;
        const shouldRestoreLive =
          isToolResultSuccess(content) &&
          !content.startsWith('⌦[') &&
          (isObserver || isCurrentTurnTool);

        if (shouldRestoreLive) {
          this.states.set(idx, 'LIVE');
          this.consumerCount.set(idx, 0);
          this.age.set(idx, 0);
          // 只有 observer 是 producer；当前轮普通工具只恢复自身状态。
          if (isObserver) {
            for (const path of extractProducerPaths(toolName, content)) {
              const producers = this.producersByPath.get(path) ?? [];
              producers.push(idx);
              this.producersByPath.set(path, producers);
            }
          }
        } else if (isObserver && isDigest) {
          this.states.set(idx, 'REFERENCED');
          this.consumerCount.set(idx, 0);
          this.age.set(idx, 0);
          this.digestedIdxs.add(idx);
        }

        if (isToolResultSuccess(content) && CONSUMER_TOOLS.has(toolName)) {
          const path = canonicalizePath(extractPath(this.findToolArgs(history, idx)));
          if (path) {
            for (const producerIdx of this.producersByPath.get(path) ?? []) {
              if (this.states.get(producerIdx) === 'LIVE') {
                this.states.set(producerIdx, 'REFERENCED');
              }
              this.consumerCount.set(producerIdx, (this.consumerCount.get(producerIdx) ?? 0) + 1);
            }
          }
        }

        for (const key of this.states.keys()) this.age.set(key, (this.age.get(key) ?? 0) + 1);
        this.step++;

        // 和 pushTool 一致：本轮 user 及之后的结果不处理；旧轮结果可以推进。
        for (const [observerIdx, state] of this.states) {
          if (observerIdx >= replayLastUser || this.isDigestFinalized(observerIdx)) continue;
          const observerName = toolNameOf(history, observerIdx);
          if (!observerName || !OBSERVER_TOOLS.has(observerName)) continue;
          const age = this.age.get(observerIdx) ?? 0;
          if (state === 'LIVE' && age >= OBSERVER_REFERENCED_AGE) {
            this.states.set(observerIdx, 'REFERENCED');
          } else if (state === 'REFERENCED'
            && age >= OBSERVER_REFERENCED_AGE + OBSERVER_DIGEST_AGE) {
            pendingDigests.add(observerIdx);
          }
        }
      }

      this.lastUser = lastUserIndex(history);
      // 回放期间只计算状态；最后统一落盘，避免迭代时破坏 path 提取。
      for (const idx of pendingDigests) {
        const toolName = toolNameOf(history, idx);
        if (toolName && idx < Math.max(0, this.lastUser)) this.digestOne(history, idx, toolName);
      }
    } catch {
      // 历史中出现非标准消息时降级为本轮行为，不能影响 agent 主循环。
    }
  }

  /** 新工具结果 push 进 history 时调;idx = history.length - 1。
   *  mutation 工具(edit_file/write_file)的 push 跳过本轮的 autoStubOrphans(由调用方在
   *  pushMutation 标完 read REFERENCED 之后再触发),避免刚被 mutation 消费的 read 被提前 STUB。 */
  pushTool(history: ChatMessage[], idx: number, succeeded = true): void {
    try {
      const m = history[idx] as AnyMessage;
      if (!m || m.role !== 'tool') return;
      const toolName = toolNameOf(history, idx);
      if (!toolName) return;
      // 失败工具结果只保留给模型诊断，不登记为 observation、不会推动老化或污染统计。
      if (!succeeded) return;

      // 已 stub 的不重复登记(幂等)。
      const c = toText(m.content);
      if (c.startsWith('⌦[')) return;

      // 登记为 LIVE。
      this.states.set(idx, 'LIVE');
      this.consumerCount.set(idx, 0);
      this.age.set(idx, 0);

      // 成功的 producer 才建立路径索引；失败结果仍可进入生命周期，但不能成为证据来源。
      if (succeeded && OBSERVER_TOOLS.has(toolName)) {
        const paths = extractProducerPaths(toolName, c);
        for (const p of paths) {
          const arr = this.producersByPath.get(p) ?? [];
          if (!arr.includes(idx)) arr.push(idx);
          this.producersByPath.set(p, arr);
        }
      }

      // 只有成功 consumer 才能消费上游；失败 read/edit/write 不改变旧数据状态。
      if (succeeded && CONSUMER_TOOLS.has(toolName)) {
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
        const path = canonicalizePath(extractPath(argsRaw));
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

      // 成功 mutation 跳过本轮 autoStubOrphans；调用方会在 pushMutation 标完旧 read 后统一检查。
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
      const mutationPath = canonicalizePath(path);
      if (!mutationPath) {
        this.autoStubOrphans(history);
        return;
      }
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
        if (canonicalizePath(extractPath(argsRaw)) === mutationPath) {
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

  /** 老化自动处理:
   *  - 非观察类 LIVE 且 age ≥ 阈值 → OBSOLETE → STUB(完全丢弃)。
   *  - 观察类工具两阶段衰减:
   *    Phase 1: LIVE → REFERENCED(age ≥ OBSERVER_REFERENCED_AGE,保留完整内容)。
   *    Phase 2: REFERENCED → DIGEST(增量 age ≥ OBSERVER_DIGEST_AGE,替换为摘要存根)。
   *  - 当前轮保护区(最后一个 user 之后)完全不动。
   */
  private autoStubOrphans(history: ChatMessage[]): void {
    try {
      const protectedFrom = Math.max(0, this.lastUser);
      for (const [idx, state] of this.states) {
        if (idx >= protectedFrom) continue; // 当前轮保护区
        const age = this.age.get(idx) ?? 0;
        const tn = toolNameOf(history, idx);
        if (!tn) continue;

        if (OBSERVER_TOOLS.has(tn)) {
          // Phase 1: LIVE → REFERENCED(保留完整内容)。
          if (state === 'LIVE' && age >= OBSERVER_REFERENCED_AGE) {
            this.states.set(idx, 'REFERENCED');
            continue;
          }
          // Phase 2: REFERENCED → DIGEST(替换为摘要存根,状态不变)。
          if (state === 'REFERENCED' && !this.isDigestFinalized(idx)) {
            // read_file 可能在很早时就把 producer 标成 REFERENCED；不能因此跳过
            // Phase 1 的保留窗口。摘要始终以 observer 自身的总 age 为准。
            if (age >= OBSERVER_REFERENCED_AGE + OBSERVER_DIGEST_AGE) {
              this.digestOne(history, idx, tn);
            }
          }
          continue;
        }

        // 非观察类:只在 LIVE 状态下老化 STUB。
        if (state !== 'LIVE') continue;
        if (age < this.ageThreshold) continue;
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

  /** 观察类工具 Phase 2:替换为摘要存根,保留文件列表+命中数+参数,丢弃详情。
   *  幂等:已是 ⌦[ 前缀的跳过。states 保持 REFERENCED,只替换 content。 */
  private digestOne(history: ChatMessage[], idx: number, toolName: string): void {
    try {
      const m = history[idx] as AnyMessage;
      if (!m) return;
      const c = toText(m.content);
      if (c.startsWith('⌦[')) return; // 幂等(已 STUB/DIGEST)
      const origLen = c.length;
      const argsRaw = this.findToolArgs(history, idx);
      const summary = this.buildDigestSummary(toolName, c, argsRaw, origLen, extractProducerPaths(toolName, c));
      // 摘要的唯一目标是降低上下文成本。短结果（如“未命中”）不能被固定文案放大。
      if (summary.length >= origLen) {
        this.digestRetainedIdxs.add(idx);
        return;
      }
      (m as { content: string }).content = summary;
      // states 保持 REFERENCED;digestedIdxs 由 stats() 扣除显示。
      this.digestedIdxs.add(idx);
    } catch {
      // 永不抛错。
    }
  }

  /** 为各观察类工具生成摘要字符串。只保留统计 + 参数,不保留详情(文件列表/URL/正文),
   *  明确标注"这是历史摘要,需要最新信息请重新调用"。 */
  private buildDigestSummary(toolName: string, content: string, argsRaw: string, origLen: number, paths: string[]): string {
    const files = this.formatDigestPaths(paths);
    switch (toolName) {
      case 'grep': {
        // 命中行数:content 里形如 `file:line:` 的行数
        let lineCount = 0;
        const re = /^[^\s:][^:]*?\.[A-Za-z0-9]+:\d+:/gm;
        while (re.exec(content)) lineCount++;
        const args = (() => { try { const a = JSON.parse(argsRaw); let s = `"${a.pattern ?? ''}"`; if (a.glob) s += `, glob="${a.glob}"`; return s; } catch { return '...'; } })();
        return `${DIGEST_PREFIX}grep(${args}) — 历史结果 ${lineCount} 行命中，文件 ${files}，${origLen}→摘要]\n如需完整详情或最新信息请重新调用 grep`;
      }
      case 'glob': {
        const args = (() => { try { return `"${JSON.parse(argsRaw).pattern ?? ''}"`; } catch { return '...'; } })();
        return `${DIGEST_PREFIX}glob(${args}) — 历史结果文件 ${files}，${origLen}→摘要]\n如需完整列表或最新信息请重新调用 glob`;
      }
      case 'codegraph': {
        const args = (() => { try { const a = JSON.parse(argsRaw); return `"${a.query ?? ''}"`; } catch { return '...'; } })();
        return `${DIGEST_PREFIX}codegraph(${args}) — 历史结果文件 ${files}，${origLen}→摘要]\n如需完整详情或最新信息请重新调用 codegraph`;
      }
      case 'web_search': {
        // 统计结果数
        let resultCount = 0;
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          if (/^\[\d+\]\s*.+/.test(line)) resultCount++;
        }
        const query = (() => { try { return JSON.parse(argsRaw).query ?? ''; } catch { return ''; } })();
        return `${DIGEST_PREFIX}web_search("${query}") — 历史结果 ${resultCount} 条, ${origLen}→摘要]\n如需最新信息请重新调用 web_search`;
      }
      case 'web_fetch': {
        const url = (() => { try { return JSON.parse(argsRaw).url ?? ''; } catch { return ''; } })();
        return `${DIGEST_PREFIX}web_fetch(${url}) — 历史结果已归档, ${origLen}→摘要]\n如需最新信息请重新调用 web_fetch`;
      }
      default:
        return `${DIGEST_PREFIX}${toolName} — 历史结果已归档, ${origLen}→摘要]\n如需最新信息请重新调用 ${toolName}`;
    }
  }

  private isDigestFinalized(idx: number): boolean {
    return this.digestedIdxs.has(idx) || this.digestRetainedIdxs.has(idx);
  }

  /** 文件候选是摘要的关键可用信息；限量且去重，避免摘要本身重新膨胀。 */
  private formatDigestPaths(paths: string[]): string {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return '0 个（未能从输出解析路径）';
    const limit = 12;
    const shown = unique.slice(0, limit).join(', ');
    return unique.length > limit ? `${unique.length} 个 [${shown}, …]` : `${unique.length} 个 [${shown}]`;
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

  /** 拿当前各状态计数。供 /context 显示「live=N, referenced=M, digest=K, obsolete=J, stubbed=S」。
   *  digested:已被摘要的观察类工具(states 仍为 REFERENCED,但 content 已替换为摘要)。 */
  stats(): { live: number; referenced: number; digested: number; obsolete: number; stubbed: number } {
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
    // digested 的 states 仍为 REFERENCED,从总 referenced 中扣除得到纯 REFERENCED 数。
    return { live, referenced: referenced - this.digestedIdxs.size, digested: this.digestedIdxs.size, obsolete, stubbed };
  }
}

/** 默认单例工厂。runAgentCore 入口 new 一个,后续 pushTool / pushMutation 共享。 */
export function createLifecycleEngine(history?: ChatMessage[], ageThreshold?: number): LifecycleEngine;
/** 向后兼容旧的 createLifecycleEngine(ageThreshold) 调用。 */
export function createLifecycleEngine(ageThreshold?: number): LifecycleEngine;
export function createLifecycleEngine(historyOrThreshold?: ChatMessage[] | number, ageThreshold?: number): LifecycleEngine {
  const history = Array.isArray(historyOrThreshold) ? historyOrThreshold : undefined;
  const threshold = typeof historyOrThreshold === 'number' ? historyOrThreshold : ageThreshold;
  return new LifecycleEngine(threshold, history);
}
