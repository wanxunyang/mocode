/**
 * Jev / TypeSafe systemone 协议客户端(工具预路由的第二后端)。
 *
 * 为什么是独立文件而不是塞进 src/llm/index.ts:
 * Jev 不是 OpenAI 兼容的 /chat/completions 模型——它一次问一组「是/否」问题、每组独立
 * 返回一个 0~1 的概率(noul 原语),没有 messages/tool_calls 概念。硬套 chat() 的
 * ChatTransport 契约会污染主链路。故单独一个极薄的 HTTP 客户端,只做:
 *   构造 body → POST → 解析 answers[<group>].noul → 归一化成 {组名: 概率}。
 *
 * 失败语义:除用户取消(AbortError)外**永不抛错**,一律返回 {ok:false,error}。
 * router 侧据此走 fallbackDecision(沿用上一 turn 簇)。503/529/429 等瞬时错误内部退避重试。
 *
 * 键名陷阱:API 的 answers 键用下划线(browser_debug),而 mocode 的簇名用连字符
 * (browser-debug)。本文件用 underscoreKey() 单点转换,调用方只见连字符簇名。
 */

/** 默认官方端点;本地部署(如 0xBakeer/arbiter 兼容层)可经配置覆盖 baseUrl。 */
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';

const REQUEST_TIMEOUT_MS = 60_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;

export type JevFetchImpl = (input: string, init: RequestInit) => Promise<Response>;

let fetchImplOverride: JevFetchImpl | null = null;

/** 仅供单测注入;生产路径使用 Node 18+ 全局 fetch。 */
export function __setJevFetchImpl(impl: JevFetchImpl | null): void {
  fetchImplOverride = impl;
}

/** 簇名 → API 键:连字符转下划线(browser-debug → browser_debug)。 */
export function underscoreKey(group: string): string {
  return group.replace(/-/g, '_');
}

/** 一个 systemone 问题。type 固定 noul(是/否概率);instructions 即问题正文。 */
export interface JevQuestion {
  readonly type: 'noul';
  readonly instructions: string;
}

export interface JevAskRequest {
  /** 用户本轮原话(作为 state.task 传给模型)。 */
  readonly task: string;
  /** 键为簇名(连字符形式),值是该簇的问题。 */
  readonly questions: Readonly<Record<string, JevQuestion>>;
  /** 当前 agent 模式(AUTO/PLAN),写入 state.mode。 */
  readonly mode?: string;
  /** 上一 turn 最终簇,写入 state.previous_groups。 */
  readonly previousGroups?: readonly string[];
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** 覆盖单次请求超时(毫秒);测试用。 */
  readonly timeoutMs?: number;
  /** 覆盖重试次数上限;测试用。 */
  readonly maxAttempts?: number;
}

export type JevAskResult =
  | {
      readonly ok: true;
      /** 键为簇名(连字符形式),值为 0~1 概率;API 未回答的簇不出现。 */
      readonly probabilities: Record<string, number>;
      /** API 的 inherit_previous 答案(有则给出)。 */
      readonly inheritPrevious?: number;
      readonly latencyMs: number;
      readonly model?: string;
      readonly inputTokens?: number;
    }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number };

/** 把外部 signal 与超时合并成一个 signal;返回的 cleanup 必须调用。 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('jev request timeout')), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  return { signal: controller.signal, cleanup };
}

/**
 * 仅当**外部** signal 已 abort 才算「用户取消」。
 *
 * 不能靠 error.name === 'AbortError' 判断:内部超时也是用 AbortController 触发的,
 * 同样抛出 AbortError;而 runtime 每个 turn 都会传外部 signal,若按错误名判断,一次
 * 慢响应(超时)就会被误当用户取消而上抛,直接中止用户整轮——这与「失败降级」契约相反。
 * 故只认外部 signal 自身的 aborted 标志:超时走普通失败回报(可重试/降级)。
 */
function isExternalAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function finiteProbability(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  return undefined;
}

/**
 * 问一次 Jev。返回各组概率;失败返回 {ok:false}。
 * 用户取消(signal.aborted)会抛出 AbortError —— 与 chat() 的取消语义一致,由 router 决定
 * 是中止本轮还是降级。
 */
export async function askJev(request: JevAskRequest): Promise<JevAskResult> {
  const startedAt = Date.now();
  const base = (request.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${base}/v1/systemone`;
  const apiKey = request.apiKey ?? '';

  const questions: Record<string, JevQuestion> = {};
  for (const [group, question] of Object.entries(request.questions)) {
    questions[underscoreKey(group)] = question;
  }

  const body = {
    model: request.model || 'jev-latest',
    state: {
      mode: request.mode ?? 'AUTO',
      previous_groups: [...(request.previousGroups ?? [])],
      task: request.task,
    },
    questions,
  };

  const maxAttempts = Math.max(1, request.maxAttempts ?? MAX_ATTEMPTS);
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { signal, cleanup } = withTimeout(request.signal, request.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      const impl = fetchImplOverride ?? fetch;
      response = await impl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      cleanup();
      // 只有外部 signal 自身已 abort(用户取消)才上抛;内部超时走下方重试/降级。
      if (isExternalAbort(request.signal)) throw error;
      lastError = `request failed: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < maxAttempts) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
        continue;
      }
      return { ok: false, error: lastError, latencyMs: Date.now() - startedAt };
    }

    if (!response.ok) {
      // 非 JSON 错误页只保留前缀,避免把代理 HTML 大段带进日志。
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 180);
      } catch {
        detail = '';
      }
      cleanup();
      lastError = `HTTP ${response.status}${detail ? ` ${detail}` : ''}`;
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
        continue;
      }
      return { ok: false, error: lastError, latencyMs: Date.now() - startedAt };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      cleanup();
      lastError = `invalid JSON response: ${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, error: lastError, latencyMs: Date.now() - startedAt };
    }
    cleanup();

    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const rawAnswers = record.answers && typeof record.answers === 'object' ? (record.answers as Record<string, unknown>) : {};

    const probabilities: Record<string, number> = {};
    let inheritPrevious: number | undefined;
    for (const group of Object.keys(request.questions)) {
      const answer = rawAnswers[underscoreKey(group)];
      if (!answer || typeof answer !== 'object') continue;
      const probability = finiteProbability((answer as Record<string, unknown>).noul);
      if (probability !== undefined) probabilities[group] = probability;
    }
    const inheritAnswer = rawAnswers.inherit_previous;
    if (inheritAnswer && typeof inheritAnswer === 'object') {
      inheritPrevious = finiteProbability((inheritAnswer as Record<string, unknown>).noul);
    }

    const usage = record.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : {};
    const inputTokens =
      typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
        ? usage.input_tokens
        : undefined;

    return {
      ok: true,
      probabilities,
      inheritPrevious,
      latencyMs: Date.now() - startedAt,
      model: typeof record.model === 'string' ? record.model : undefined,
      inputTokens,
    };
  }

  return { ok: false, error: lastError, latencyMs: Date.now() - startedAt };
}

/**
 * 探测端点连通性(供 /router test 使用):用最小问题集问一次,返回是否可用 + 延迟。
 * 永不抛错(取消除外)。
 */
export async function probeJev(options: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; latencyMs: number; model?: string; error?: string }> {
  const result = await askJev({
    task: 'connectivity probe',
    questions: { probe: { type: 'noul', instructions: 'Is this a connectivity probe?' } },
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    signal: options.signal,
    timeoutMs: 20_000,
    maxAttempts: 2,
  });
  if (result.ok) return { ok: true, latencyMs: result.latencyMs, model: result.model };
  return { ok: false, latencyMs: result.latencyMs, error: result.error };
}