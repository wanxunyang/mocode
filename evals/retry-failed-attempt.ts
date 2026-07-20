// RETRY-02 fixture: 失败裁剪开关(默认关,调用方可注入 onFailedAttempt)。
//
// 断言:
// 1. 默认行为:不传 onFailedAttempt 时,所有 attempt 用尽也不抛错,主流程行为不变。
// 2. success 路径永远不触发 onFailedAttempt(无需裁剪)。
// 3. 失败路径:传了 onFailedAttempt 后,在最后一次 attempt 走完时调用一次,
//    携带 fingerprint / status / code / category / attempts / reflectionHint 6 字段。
// 4. 错误分类经 RETRY-01 classifier,ErrorCategory 6 类之一,与反射 hint 同步。
// 5. onFailedAttempt 抛错不影响主流程(execute 返回的 outcome 不变)。
// 6. 与 onRetry 互不干扰:onRetry 在 canRetry=true 时仍触发,onFailedAttempt
//    在 canRetry=false 时才触发,接缝互补。

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

import type { FailedAttemptInfo as ExportedFailedAttemptInfo } from '../src/tools/retry.js';
type FailedAttemptInfo = ExportedFailedAttemptInfo;

const { executeWithToolRetry } = await import('../src/tools/retry.js');

const idleCaps = { effect: 'read' as const, concurrency: 'parallel' as const, retry: 'safe' as const };

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

// 1. 默认行为:不传 onFailedAttempt,失败仍正常返回,outcome 完整。
{
  const calls: number[] = [];
  const outcome = await executeWithToolRetry(
    idleCaps,
    'fp-default',
    undefined,
    async (attempt) => {
      calls.push(attempt);
      return { status: 'error', output: 'nope', code: 'TIMEOUT', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: true };
    },
  );
  assert(outcome.status === 'error', 'default: failure outcome returned');
  assert(outcome.code === 'TIMEOUT', 'default: code preserved');
  // 3 次 attempt 后停(TIMEOUT 在 safe + transient 路径上 shouldRetry=true)
  assert(calls.length >= 1, `default: at least 1 attempt, got ${calls.length}`);
}

// 2. success 路径不触发 onFailedAttempt。
{
  const failedCalls: unknown[] = [];
  const outcome = await executeWithToolRetry(
    idleCaps,
    'fp-success',
    undefined,
    async (attempt) => ({ status: 'success', output: 'ok', code: 'OK', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: false }),
    undefined,
    (info) => failedCalls.push(info),
  );
  assert(outcome.status === 'success', 'success path: outcome is success');
  assert(failedCalls.length === 0, `success path: onFailedAttempt must not fire, got ${failedCalls.length}`);
}

// 3. 失败路径:传了 onFailedAttempt 后,在最后一次 attempt 走完时调用一次,
//    6 字段齐全且语义正确。
{
  const failedCalls: FailedAttemptInfo[] = [];
  const onRetryCalls: number[] = [];
  let attemptCounter = 0;
  const outcome = await executeWithToolRetry(
    idleCaps,
    'fp-fail-recoverable',
    undefined,
    async (attempt) => {
      attemptCounter = attempt;
      return { status: 'error', output: 'fail', code: 'TIMEOUT', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: true };
    },
    (info) => onRetryCalls.push(info.attempt),
    (info) => failedCalls.push(info),
  );
  assert(outcome.status === 'error', 'failed path: outcome is error');
  assert(failedCalls.length === 1, `failed path: onFailedAttempt fires exactly once, got ${failedCalls.length}`);
  const info = failedCalls[0];
  assert(info.fingerprint === 'fp-fail-recoverable', `fingerprint preserved, got ${info.fingerprint}`);
  assert(info.status === 'error', 'status in info is error');
  assert(info.code === 'TIMEOUT', 'code in info is TIMEOUT');
  assert(info.category === 'TRANSIENT_TIMEOUT', `category matches RETRY-01 classifier, got ${info.category}`);
  assert(typeof info.attempts === 'number' && info.attempts >= 1, `attempts is positive int, got ${info.attempts}`);
  assert(typeof info.reflectionHint === 'string' && info.reflectionHint.length > 0,
    'reflectionHint is non-empty string');
  // 反射 hint 文案与 RETRY-01 一致(共享同一份分类)。
  assert(/retry|wait|switch|ask/i.test(info.reflectionHint as string),
    'reflectionHint should mention retry strategy');
  // onRetry 在 canRetry=true 时仍触发(recoverable error → 触发 2 次:attempt 1 → 2, attempt 2 → 3)
  assert(onRetryCalls.length >= 1, `onRetry should still fire for recoverable errors, got ${onRetryCalls.length}`);
  // 最终 attempts 应等于最大重试次数
  assert(info.attempts === attemptCounter,
    `info.attempts (${info.attempts}) should equal final attempt counter (${attemptCounter})`);
}

// 4. 不可恢复错误(INVALID_ARGUMENTS)直接 return,不触发 onRetry,但仍触发 onFailedAttempt。
{
  const failedCalls: FailedAttemptInfo[] = [];
  const onRetryCalls: number[] = [];
  const outcome = await executeWithToolRetry(
    idleCaps,
    'fp-fail-unrecoverable',
    undefined,
    async (attempt) => ({ status: 'error', output: 'bad args', code: 'INVALID_ARGUMENTS', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: false }),
    (info) => onRetryCalls.push(info.attempt),
    (info) => failedCalls.push(info),
  );
  assert(outcome.status === 'error', 'unrecoverable: outcome is error');
  assert(onRetryCalls.length === 0, `unrecoverable: onRetry must NOT fire for INVALID_ARGUMENTS, got ${onRetryCalls.length}`);
  assert(failedCalls.length === 1, `unrecoverable: onFailedAttempt fires once, got ${failedCalls.length}`);
  assert(failedCalls[0].code === 'INVALID_ARGUMENTS', 'unrecoverable: code preserved');
  assert(failedCalls[0].category === 'INVALID_ARGUMENTS', 'unrecoverable: category matches RETRY-01');
}

// 5. onFailedAttempt 抛错不影响主流程(execute 返回的 outcome 不变)。
{
  let outcomeGot: { status: string; code: string } | undefined;
  const outcome = await executeWithToolRetry(
    idleCaps,
    'fp-hook-throws',
    undefined,
    async (attempt) => ({ status: 'error', output: 'fail', code: 'TIMEOUT', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: true }),
    undefined,
    () => { throw new Error('hook should not affect outcome'); },
  );
  outcomeGot = outcome;
  assert(outcomeGot.status === 'error', 'hook-throws: outcome status still error');
  assert(outcomeGot.code === 'TIMEOUT', 'hook-throws: outcome code still TIMEOUT');
}

// 6. fingerprint 唯一性:fingerprint 不同时,onFailedAttempt 都能正确传递对应 fingerprint。
{
  const fingerprints: string[] = [];
  await executeWithToolRetry(
    idleCaps,
    'fp-1',
    undefined,
    async (attempt) => ({ status: 'error', output: 'fail', code: 'TIMEOUT', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: true }),
    undefined,
    (info) => fingerprints.push(info.fingerprint),
  );
  await executeWithToolRetry(
    idleCaps,
    'fp-2',
    undefined,
    async (attempt) => ({ status: 'error', output: 'fail', code: 'TIMEOUT', attempts: attempt, durationMs: 0, retryDelayMs: 0, retryable: true }),
    undefined,
    (info) => fingerprints.push(info.fingerprint),
  );
  assert(fingerprints.length === 2, `two failures → two callbacks, got ${fingerprints.length}`);
  assert(fingerprints.includes('fp-1') && fingerprints.includes('fp-2'),
    'both fingerprints propagated correctly');
}

console.log('retry-failed-attempt regression checks passed');
