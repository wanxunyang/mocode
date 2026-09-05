import { maybeCompact } from '../../session/index.js';
import type { ContextState } from '../../session/compact.js';
import type { BudgetScheduler } from '../../session/scheduler.js';
import type { ContextTrimRequest, ContextTrimResult, ContextTrimmer, HistoryManager, TrimStats } from './contracts.js';

export interface ContextTrimmerInit {
  historyManager: HistoryManager;
  scheduler: BudgetScheduler | null;
  contextState: ContextState;
}

class LegacyCompatibleContextTrimmer implements ContextTrimmer {
  constructor(
    readonly implementation: 'legacy' | 'staged',
    private readonly init: ContextTrimmerInit,
  ) {}

  async trim(request: ContextTrimRequest): Promise<ContextTrimResult> {
    if (request.mode === 'scheduled') return this.trimScheduled(request);

    const result = await this.init.historyManager.withLegacyMutableHistory((history) =>
      maybeCompact(
        history,
        undefined,
        request.mode === 'overflow' ? { manual: true, force: true } : undefined,
        this.init.contextState,
        request.tools,
        request.signal,
      ),
    );
    if (!result) return { kind: 'none', stats: {} };

    const stats: TrimStats = {
      reason: result.reason,
      compacted: result.compacted,
      estimateBefore: result.estimateBefore,
      estimateAfter: result.estimateAfter,
    };
    if (result.historyRebuilt) {
      return { kind: 'rebuild', history: this.compactedHistory(), stats };
    }
    return { kind: result.compacted ? 'content' : 'none', stats };
  }

  private async trimScheduled(request: ContextTrimRequest): Promise<ContextTrimResult> {
    const scheduler = this.init.scheduler;
    if (!scheduler) throw new Error('Scheduled context trim requires a budget scheduler.');
    await this.init.historyManager.withLegacyMutableHistory((history) =>
      scheduler.runStep(history, request.step, request.tools, request.ephemeralTokens, request.signal),
    );
    const log = scheduler.lastRunLog;
    const stats: TrimStats = {
      reason: log?.compactHistoryCalled ? 'scheduled' : undefined,
      compactHistoryCalled: log?.compactHistoryCalled,
      estimateBefore: log?.report.total,
      estimateAfter: log?.pressure.after,
    };
    if (log?.historyMutation === 'rebuild') {
      return { kind: 'rebuild', history: this.compactedHistory(), stats };
    }
    return { kind: log?.historyMutation === 'content' ? 'content' : 'none', stats };
  }

  private compactedHistory() {
    return { messages: this.init.historyManager.snapshot().messages };
  }
}

class LegacyContextTrimmer extends LegacyCompatibleContextTrimmer {
  constructor(init: ContextTrimmerInit) {
    super('legacy', init);
  }
}

class StagedContextTrimmer extends LegacyCompatibleContextTrimmer {
  constructor(init: ContextTrimmerInit) {
    super('staged', init);
  }
}

export function createLegacyContextTrimmer(init: ContextTrimmerInit): ContextTrimmer {
  return new LegacyContextTrimmer(init);
}

export function createStagedContextTrimmer(init: ContextTrimmerInit): ContextTrimmer {
  return new StagedContextTrimmer(init);
}
