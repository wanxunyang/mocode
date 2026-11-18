import { createHash } from 'node:crypto';
import type { ToolOutcome } from '../tools/types.js';

const WINDOW_STEPS = 6;
const REPEATED_STEPS = 3;
const MAX_REMINDERS = 3;

interface StepObservations {
  successes: Set<string>;
  failures: Set<string>;
  observedChange: boolean;
  committed: boolean;
}

/** 每次模型决策只计一轮。观察重复的结果或错误类型，工具本身始终照常执行。 */
export class TurnProgressGuard {
  private recent: StepObservations[] = [];
  private current?: StepObservations;
  private remindersSent = 0;

  record(tool: string, argsHash: string, outcome: ToolOutcome): void {
    if (this.remindersSent >= MAX_REMINDERS || outcome.status === 'aborted') return;
    const step = (this.current ??= {
      successes: new Set(),
      failures: new Set(),
      observedChange: false,
      committed: false,
    });
    if (outcome.status !== 'success') {
      step.failures.add(`${tool} (${outcome.code})`);
    } else if (outcome.changeSet?.changedFiles.length) {
      step.committed = true;
    } else if (outcome.changedFiles?.length || outcome.modelAttachments?.length) {
      // 进程周围的文件扫描也能看到外部写入。保留本批观察，但只有明确提交的改动重置历史。
      step.observedChange = true;
    } else {
      const hash = createHash('sha256').update(outcome.output).digest('hex');
      step.successes.add(`${tool}/${argsHash}/${hash}`);
    }
  }

  /** 下一次模型请求前结算整批。并行工具的完成顺序不影响判断。 */
  takeReminder(): string | undefined {
    const step = this.current;
    if (!step) return;
    this.current = undefined;
    if (step.committed) {
      this.recent = [];
      return;
    }
    if (this.recent.length === WINDOW_STEPS) this.recent.shift();
    const previous = this.recent.slice();
    this.recent.push(step);
    if (step.observedChange || previous.length < REPEATED_STEPS - 1) return;
    if ([...step.successes].some((key) => !previous.some((s) => s.successes.has(key)))) return;

    const repeated = (key: string, kind: 'failures' | 'successes'): boolean =>
      previous.filter((s) => s[kind].has(key)).length >= REPEATED_STEPS - 1;
    const failure = [...step.failures].find((key) => repeated(key, 'failures'));
    const repeatedResult = [...step.successes].some((key) => repeated(key, 'successes'));
    if (!failure && !repeatedResult) return;

    this.remindersSent++;
    this.recent = [];
    const evidence = failure ? `${failure} recurred` : 'The same call returned the same result';
    return (
      `## Repeated tool results\n${evidence} on at least ${REPEATED_STEPS} recent model steps. ` +
      'Use the evidence already gathered. If the requested outcome is verified, finish. ' +
      'Otherwise choose a check or action that can resolve the remaining uncertainty.'
    );
  }
}

export function createTurnProgressGuard(): TurnProgressGuard {
  return new TurnProgressGuard();
}
