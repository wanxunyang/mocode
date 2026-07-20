import type { ToolCapabilities, ToolOutcome, ToolOutcomeCode } from './types.js';
import { reflectOn, type ErrorCategory } from '../agent/retry-classifier.js';

export interface ToolRetryInfo {
  attempt: number;
  nextAttempt: number;
  waitMs: number;
  code: ToolOutcomeCode;
  /** RETRY-01: 错误反思分类。 */
  category: ErrorCategory;
  /** RETRY-01: 给 LLM 看的"反思指针"短文。注入到 retry 提示尾部。 */
  reflectionHint: string;
}

export const TOOL_RETRY_MAX_ATTEMPTS = 3;
export const TOOL_RETRY_BASE_MS = 250;
export const TOOL_RETRY_MAX_MS = 1_000;
export const TOOL_RETRY_TOTAL_BUDGET_MS = 15_000;
export const TOOL_RETRY_SAME_ARGS_WINDOW_MS = 60_000;
export const TOOL_RETRY_SAME_ARGS_BUDGET = 2;

const NEVER_RETRY_CODES = new Set<ToolOutcomeCode>([
  'INVALID_JSON',
  'INVALID_ARGUMENTS',
  'INVALID_TOOL_SCHEMA',
  'UNKNOWN_TOOL',
  'SANDBOX_DENIED',
  'PERMISSION_DENIED',
  'TOOL_DISABLED',
  'MODE_DENIED',
  'ABORTED',
  'EDIT_CONFLICT',
  'POSTCONDITION_FAILED',
  'PROCESS_FAILED',
  'MCP_ERROR',
]);

interface FingerprintBudget {
  startedAt: number;
  retries: number;
}

const fingerprintBudgets = new Map<string, FingerprintBudget>();
const MAX_TRACKED_FINGERPRINTS = 512;

function reserveFingerprintRetry(fingerprint: string, now: number): boolean {
  let budget = fingerprintBudgets.get(fingerprint);
  if (!budget || now - budget.startedAt >= TOOL_RETRY_SAME_ARGS_WINDOW_MS) {
    budget = { startedAt: now, retries: 0 };
    fingerprintBudgets.set(fingerprint, budget);
  }
  if (budget.retries >= TOOL_RETRY_SAME_ARGS_BUDGET) return false;
  budget.retries++;
  if (fingerprintBudgets.size > MAX_TRACKED_FINGERPRINTS) {
    const oldest = fingerprintBudgets.keys().next().value as string | undefined;
    if (oldest) fingerprintBudgets.delete(oldest);
  }
  return true;
}

function shouldRetry(outcome: ToolOutcome, capabilities: ToolCapabilities): boolean {
  return capabilities.retry !== 'never' &&
    outcome.status === 'error' &&
    outcome.retryable === true &&
    !NEVER_RETRY_CODES.has(outcome.code);
}

function backoff(attempt: number): number {
  return Math.min(TOOL_RETRY_MAX_MS, TOOL_RETRY_BASE_MS * 2 ** (attempt - 1));
}

function abortError(): Error {
  const error = new Error('Tool retry aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry safe/idempotent transient outcomes; each execute call owns one complete lock attempt. */
export async function executeWithToolRetry(
  capabilities: ToolCapabilities,
  fingerprint: string,
  signal: AbortSignal | undefined,
  execute: (attempt: number) => Promise<ToolOutcome>,
  onRetry?: (info: ToolRetryInfo) => void,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  let retryDelayMs = 0;
  for (let attempt = 1; attempt <= TOOL_RETRY_MAX_ATTEMPTS; attempt++) {
    const outcome = await execute(attempt);
    const elapsed = Date.now() - startedAt;
    const waitMs = backoff(attempt);
    const canRetry = attempt < TOOL_RETRY_MAX_ATTEMPTS &&
      shouldRetry(outcome, capabilities) &&
      elapsed + waitMs <= TOOL_RETRY_TOTAL_BUDGET_MS &&
      !signal?.aborted &&
      reserveFingerprintRetry(fingerprint, Date.now());
    if (!canRetry) {
      return {
        ...outcome,
        durationMs: elapsed,
        attempts: attempt,
        retryDelayMs,
      };
    }

    try {
      const reflection = reflectOn(outcome.code);
      onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        waitMs,
        code: outcome.code,
        category: reflection.category,
        reflectionHint: reflection.hint,
      });
    } catch {
      // Retry telemetry is best-effort and must never change tool execution.
    }
    await sleep(waitMs, signal);
    retryDelayMs += waitMs;
  }
  throw new Error('unreachable tool retry state');
}

/** Test/session reset seam; production never needs to clear the bounded TTL map. */
export function resetToolRetryBudgets(): void {
  fingerprintBudgets.clear();
}
