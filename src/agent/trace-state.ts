import type { ChatUsage } from '../llm/index.js';
import type { AgentTraceEvent } from '../session/trace.js';
import type { HistoryCheckpoint, HistoryManager, TraceSink, UsageMeter } from './stages/contracts.js';

export interface TraceSinkInit {
  /** Trace delivery is observational only: sink failures never alter execution. */
  onTraceEvent?: (event: AgentTraceEvent) => void;
}

class CallbackTraceSink implements TraceSink {
  constructor(
    readonly implementation: 'legacy' | 'staged',
    private readonly onTraceEvent?: (event: AgentTraceEvent) => void,
  ) {}

  emit(event: AgentTraceEvent): void {
    try {
      this.onTraceEvent?.(event);
    } catch {
      // Trace is best-effort and must never alter execution.
    }
  }
}

class TurnUsageMeter implements UsageMeter {
  private usage: ChatUsage | undefined;

  constructor(readonly implementation: 'legacy' | 'staged') {}

  add(next: ChatUsage | undefined): void {
    if (!next) return;
    this.usage = this.usage
      ? {
          promptTokens: this.usage.promptTokens + next.promptTokens,
          completionTokens: this.usage.completionTokens + next.completionTokens,
          totalTokens: this.usage.totalTokens + next.totalTokens,
          cachedTokens: this.usage.cachedTokens + next.cachedTokens,
          cacheCreationTokens: (this.usage.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0),
          reasoningTokens: this.usage.reasoningTokens + next.reasoningTokens,
        }
      : next;
  }

  snapshot(): ChatUsage | undefined {
    return this.usage;
  }
}

export interface CancellationLifecycleInit {
  historyManager: HistoryManager;
  /** Emits the abort event once before any observable restore side effect. */
  onObserved: () => void;
  /** Existing hook semantics intentionally remain throwing. */
  onAbort: () => void;
  /** Rebuilds history-derived indexes after the persistent ledger is restored. */
  onHistoryRestored: () => void;
  /** Restores the mode last, after history and derived state. */
  restoreMode: () => void;
}

export class RunCancellationLifecycle {
  private savedHistory: HistoryCheckpoint | undefined;
  private observed = false;

  constructor(
    readonly implementation: 'legacy' | 'staged',
    private readonly init: CancellationLifecycleInit,
  ) {}

  checkpoint(): void {
    this.savedHistory = this.init.historyManager.createCheckpoint();
  }

  restore(): void {
    if (!this.observed) {
      this.init.onObserved();
      this.observed = true;
    }
    this.init.onAbort();
    if (!this.savedHistory) throw new Error('Cancellation restore requires an initialized history checkpoint.');
    this.init.historyManager.restore(this.savedHistory);
    this.init.onHistoryRestored();
    this.init.restoreMode();
  }
}

class LegacyTraceSink extends CallbackTraceSink {
  constructor(init: TraceSinkInit) {
    super('legacy', init.onTraceEvent);
  }
}

class StagedTraceSink extends CallbackTraceSink {
  constructor(init: TraceSinkInit) {
    super('staged', init.onTraceEvent);
  }
}

class LegacyUsageMeter extends TurnUsageMeter {
  constructor() {
    super('legacy');
  }
}

class StagedUsageMeter extends TurnUsageMeter {
  constructor() {
    super('staged');
  }
}

class LegacyCancellationLifecycle extends RunCancellationLifecycle {
  constructor(init: CancellationLifecycleInit) {
    super('legacy', init);
  }
}

class StagedCancellationLifecycle extends RunCancellationLifecycle {
  constructor(init: CancellationLifecycleInit) {
    super('staged', init);
  }
}

/** Separate factories preserve a per-stage rollback seam while sharing the frozen protocol implementation. */
export function createLegacyTraceSink(init: TraceSinkInit): TraceSink {
  return new LegacyTraceSink(init);
}

export function createStagedTraceSink(init: TraceSinkInit): TraceSink {
  return new StagedTraceSink(init);
}

export function createLegacyUsageMeter(): UsageMeter {
  return new LegacyUsageMeter();
}

export function createStagedUsageMeter(): UsageMeter {
  return new StagedUsageMeter();
}

export function createLegacyCancellationLifecycle(init: CancellationLifecycleInit): RunCancellationLifecycle {
  return new LegacyCancellationLifecycle(init);
}

export function createStagedCancellationLifecycle(init: CancellationLifecycleInit): RunCancellationLifecycle {
  return new StagedCancellationLifecycle(init);
}
