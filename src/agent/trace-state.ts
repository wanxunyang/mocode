/**
 * agent 单轮的 trace / token-usage 状态聚合(从 core.ts 提取,2.0 步骤2 深拆第一刀)。
 *
 * runAgentCore 原本把 emitTrace / addUsage / reportLive 写成函数内闭包,捕获
 * traceSessionId / traceTurnId / currentTraceStep / abortTraced / turnUsage 等一坨可变局部量。
 * 这里把这坨状态收敛进一个对象,runAgentCore 持有实例并调用方法,行为与字节级事件 payload 不变。
 *
 * 设计约束:
 *  - emit() 的 currentTraceStep 三元逻辑逐字保留——trace 事件落盘格式是观测契约,不能漂移。
 *  - addUsage() 的逐字段累加(含 cacheCreationTokens 的 ?? 0 兜底)逐字保留。
 *  - reportLive() 的 onLiveUsage 上报警文结构与 turnUsage 闭包累加口径一致(实时 chip 显示)。
 *  - turnId 类型为 number | undefined:traceTurnId 兜底链可能产出 undefined(--no-session)。
 */

import type { ChatMessage, ChatUsage } from '../llm/index.js';
import { createTraceEvent } from '../session/index.js';
import type { AgentTraceEvent, TraceEventType } from '../session/trace.js';
import type { AgentRunResult } from './core.js';
import type { AgentMode } from './mode.js';
import type { TurnMutationState } from './runtime-context.js';

/** abortRestore 所需的最小 hooks 面(只用到 onAbort)。 */
export interface AbortRestoreHooks {
  onAbort?: () => void;
}

/**
 * 中断还原入参。emitTrace 已由本对象提供,无需再传;
 * savedHistory 是 core 每步工具执行完刷新的中断快照。
 * ctx 收窄到实际用到的两个方法;AgentMode 与 runtime-context 同源(./mode.js)。
 */
export interface AbortRestoreDeps {
  hooks: AbortRestoreHooks;
  history: ChatMessage[];
  savedHistory: ChatMessage[];
  ctx: Pick<import('./runtime-context.js').AgentRuntimeContext, 'setAgentMode'>;
  savedMode: AgentMode;
}

export interface TurnTraceInit {
  /** 事件落盘的会话 id;调用方已兜底(ctx.getCurrentSessionId() ?? ephemeral-<pid>)。 */
  sessionId: string;
  turnId: number | undefined;
  /** 观测回调;抛错被吞,trace 绝不影响执行。 */
  onTraceEvent?: (event: AgentTraceEvent) => void;
}

export class TurnTraceState {
  readonly sessionId: string;
  readonly turnId: number | undefined;
  /** 当前步序号;循环每步开头赋值,finally 归 undefined。stepId 由此拼。 */
  currentTraceStep: number | undefined;
  /** abort 事件只记一次的幂等旗标。 */
  abortTraced = false;
  /** 本轮工具调用总数(turn_end 摘要用)。 */
  toolCallCount = 0;
  /** 本轮 token 累计;未开启 include_usage 或全失败时为 undefined。 */
  turnUsage: ChatUsage | undefined;

  private readonly onTraceEvent?: (event: AgentTraceEvent) => void;

  constructor(init: TurnTraceInit) {
    this.sessionId = init.sessionId;
    this.turnId = init.turnId;
    this.onTraceEvent = init.onTraceEvent;
  }

  /** 记一条 trace 事件。best-effort:回调抛错被吞,绝不改变执行路径。 */
  emit(
    type: TraceEventType,
    data: Record<string, unknown> = {},
    ids: Partial<Pick<AgentTraceEvent, 'step' | 'stepId' | 'toolCallId' | 'providerToolCallId'>> = {},
  ): void {
    const turnId = this.turnId;
    if (turnId === undefined) return; // 无会话上下文(--no-session)不产生事件,与原闭包行为一致
    try {
      this.onTraceEvent?.(
        createTraceEvent({
          sessionId: this.sessionId,
          turnId,
          type,
          ...(this.currentTraceStep === undefined
            ? {}
            : {
                step: this.currentTraceStep,
                stepId: `${turnId}:step:${this.currentTraceStep}`,
              }),
          ...ids,
          data,
        }),
      );
    } catch {
      // Trace is best-effort and must never alter execution.
    }
  }

  /** 累加一次 chat 返回的真实 usage 到本轮 turnUsage。 */
  addUsage(u: ChatUsage | undefined): void {
    if (!u) return;
    this.turnUsage = this.turnUsage
      ? {
          promptTokens: this.turnUsage.promptTokens + u.promptTokens,
          completionTokens: this.turnUsage.completionTokens + u.completionTokens,
          totalTokens: this.turnUsage.totalTokens + u.totalTokens,
          cachedTokens: this.turnUsage.cachedTokens + u.cachedTokens,
          cacheCreationTokens: (this.turnUsage.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0),
          reasoningTokens: this.turnUsage.reasoningTokens + u.reasoningTokens,
        }
      : u;
  }

  /**
   * 实时用量上报:onLiveUsage 推送「已完成步实测(turnUsage) + 当前步(prompt 估算/实测 + 流式 completion)」。
   * turnUsage 在本对象内被 addUsage 原地累加,这里每次读最新值,口径与轮末摘要一致。
   */
  reportLive(
    hooks: {
      onLiveUsage?: (u: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedTokens?: number;
      }) => void;
    },
    stepPromptEst: number,
    lastStepPromptTokens: number,
    providerCacheSeen: boolean,
    p: { completionTokens: number; promptTokens?: number; cachedTokens?: number },
  ): void {
    // 当前步 prompt:末尾 usage chunk 到达后用实测,流式期间用估算(含校准)。
    // 当前步 cache 命中同理:上报即用实测;流式期间按前缀缓存估算 ≈ 上一步实测 prompt
    // (当前 prompt 总含其为前缀),不超过当前步 prompt;后端从不报 cache 时不估算。
    // 口径与轮末摘要一致:chip ↑ 显计费 prompt(裸 - cached),↓/↻ 同。
    const curPrompt = p.promptTokens ?? stepPromptEst;
    const curCached = p.cachedTokens ?? (providerCacheSeen ? Math.min(lastStepPromptTokens, curPrompt) : 0);
    hooks.onLiveUsage?.({
      promptTokens: (this.turnUsage?.promptTokens ?? 0) + curPrompt,
      completionTokens: (this.turnUsage?.completionTokens ?? 0) + p.completionTokens,
      totalTokens: (this.turnUsage?.totalTokens ?? 0) + curPrompt + p.completionTokens,
      cachedTokens: (this.turnUsage?.cachedTokens ?? 0) + curCached,
    });
  }

  /**
   * 中断还原:记一次 abort 事件(幂等)→ onAbort 钩子 → history 回滚到快照 → 模式还原。
   * 与 core.ts 原 abortRestore 闭包逐字一致(含调用顺序);traceStatus 赋值留在 core
   * (它是 core 局部 let,turn_end 埋点还要读)。
   */
  abortRestore(deps: AbortRestoreDeps): void {
    if (!this.abortTraced) {
      this.emit('abort', { phase: 'observed', reason: 'signal' });
      this.abortTraced = true;
    }
    deps.hooks.onAbort?.();
    deps.history.length = 0;
    deps.history.push(...deps.savedHistory);
    deps.ctx.setAgentMode(deps.savedMode);
  }

  /**
   * 构造中断返回值(completed=false / terminationReason='aborted' / finalText=null)。
   * core.ts 两处 aborted-return 块逐字节相同,收敛到此处;mutation 由调用方现取
   * (ctx.getCurrentTurnMutationState()),保证读取时点与原内联代码一致。
   */
  buildAbortedResult(mutation: TurnMutationState): AgentRunResult {
    return {
      completed: false,
      terminationReason: 'aborted',
      finalText: null,
      usage: this.turnUsage,
      changedFiles: mutation.changedFiles.map((item) => item.path),
    };
  }
}
