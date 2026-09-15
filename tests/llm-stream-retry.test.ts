/**
 * 流中途故障的重试语义(两种成因,同一处置)。
 *
 * ① **SSE error chunk**(DashScope compatible-mode 实测):响应流**内部**回
 *    `code=ClientError` + `message="Backend buffer overflow."`;openai SDK 据此构造
 *    `new APIError(undefined, data.error, …)`,status 为 undefined → 既不命中 isRetryableError
 *    的 status 规则,也没有 Node errno → 旧实现「一次即抛」把用户整轮打断
 *    (trace 佐证:model_end code=ClientError,全 trace 无 model_retry)。
 * ② **传输层断流**:HTTP 200 建连后连接被掐(网关超时/NAT 回收/推理进程被杀)。
 *    实测抛 `Error: Premature close`(code ERR_STREAM_PREMATURE_CLOSE),同样无 status。
 *    下文的 errno 用例、cause 链用例与 Anthropic 流内 error 用例覆盖这一类。
 * ③ **建连阶段失败**:DNS / 连接被拒 / TLS / 半路断,SDK 包成 `APIConnectionError`
 *    (默认文案 'Connection error.',status 与 code 均 undefined)。线上实测(trace:
 *    model_end code="Error"、全 trace 无 model_retry)发现它同样被漏判 —— 因为
 *    `isRetryableError` 写的是 `err.name === 'APIConnectionError'`,而 SDK 的 APIError 家族
 *    **从不设 this.name**(`err.name` 恒为 'Error')→ 该分支是死代码,一次即抛、整轮终止。
 *    文件末尾两个用例锁住这条路径。
 *
 * 未覆盖(已知取舍,非本文件的 bug):零 chunk 的空响应体被 SSE 解析器静默丢弃,按「模型无回复」
 * 收尾;见最后一个用例的说明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import {
  __setChatCreateImpl,
  chat,
  classifyChatError,
  isRetryableError,
  isStreamInterruptedError,
  type ChatMessage,
} from '../src/llm/index.js';
import { __setAnthropicFetchImpl } from '../src/llm/providers/anthropic.js';
import { config } from '../src/config/index.js';

/** 构造 SDK 流内错误:与 streaming.mjs 的 `new APIError(undefined, data.error, …)` 完全同构。 */
function sseError(message: string, code = 'ClientError'): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(undefined, { code, message }, undefined, undefined);
}

/** 实测形态:服务端 destroy socket → `Error: Premature close`(ERR_STREAM_PREMATURE_CLOSE)。 */
function prematureClose(): Error {
  const err = new Error('Premature close');
  (err as Error & { code?: string }).code = 'ERR_STREAM_PREMATURE_CLOSE';
  return err;
}

/** undici 把 errno 藏在 cause 里的形态:`TypeError: fetch failed` → cause `read ECONNRESET`。 */
function fetchFailedCause(): Error {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/**
 * 建连失败的实测形态:SDK 的 `core.mjs` 在 fetch 失败后抛
 * `new APIConnectionError({ cause })` → 默认文案 'Connection error.'、
 * `name === 'Error'`(SDK 从不设 this.name)、status/code 均 undefined。
 */
function connectionError(cause?: Error): InstanceType<typeof OpenAI.APIConnectionError> {
  return new OpenAI.APIConnectionError({ message: undefined, cause });
}

/** undici 多层包装:DNS 解析失败时真实 errno 在最内层。 */
function dnsCause(): Error {
  const inner = Object.assign(new Error('getaddrinfo ENOTFOUND dashscope.aliyuncs.com'), { code: 'ENOTFOUND' });
  return Object.assign(new TypeError('fetch failed'), { cause: inner });
}

/** 空流(`create()` 成功建连、第一个 chunk 就失败——即 SDK 的流内抛错形态)。 */
function throwingStream(err: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return { next: (): Promise<IteratorResult<unknown>> => Promise.reject(err) };
    },
  };
}

/** 建连成功但一个 chunk 都没有 → 空流(网关把 HTML 错误页当流回时就是这个形态)。 */
function emptyStream(): AsyncIterable<unknown> {
  return (async function* () {
    // 故意不 yield:合规后端至少会给一个 finish_reason / usage chunk。
  })();
}

/** 先吐一段可见文本再抛错(模拟生成到一半后端挂掉)。 */
function partialThenThrow(err: unknown, text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
    throw err;
  })();
}

function okStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };
  })();
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

test('isStreamInterruptedError:只认「无 status 的 SDK APIError」', () => {
  assert.equal(isStreamInterruptedError(sseError('Backend buffer overflow.')), true, '流内 APIError 应识别');
  assert.equal(
    isStreamInterruptedError(new OpenAI.APIError(400, { message: 'bad request' }, undefined, undefined)),
    false,
    '有 HTTP 状态码的交给 isRetryableError',
  );
  assert.equal(
    isStreamInterruptedError(new OpenAI.APIConnectionError({ message: 'x' })),
    false,
    'APIConnectionError 是建连失败,归 isRetryableError 的构造器名分支,不靠流中断判据',
  );
  assert.equal(isStreamInterruptedError(new OpenAI.APIUserAbortError()), false, '用户中断绝不重试');
  assert.equal(isStreamInterruptedError(new Error('messages must contain at least one non-empty user message')), false);
  assert.equal(isStreamInterruptedError(new DOMException('aborted', 'AbortError')), false);
  assert.equal(isStreamInterruptedError(undefined), false);
  assert.equal(isStreamInterruptedError('boom'), false);
  // 传输层断流:实测形态 + undici 把 errno 藏在 cause 的形态。
  assert.equal(isStreamInterruptedError(prematureClose()), true, 'Premature close 属流中断');
  assert.equal(isStreamInterruptedError(fetchFailedCause()), true, 'cause 链里的 ECONNRESET 要能穿透');
  assert.equal(isStreamInterruptedError({ message: 'socket hang up' }), true, '文案兜底');
  // AbortError 即使带断流痕迹也绝不重试(name 检查在前)。DOMException.code 是只读 getter,用 defineProperty。
  const aborted = new DOMException('aborted', 'AbortError');
  Object.defineProperty(aborted, 'code', { value: 'ERR_STREAM_PREMATURE_CLOSE' });
  assert.equal(isStreamInterruptedError(aborted), false, '用户中断优先级最高');
});

test('传输层断流(ERR_STREAM_PREMATURE_CLOSE):零产出自动重试,第二次成功', async () => {
  let createCalls = 0;
  __setChatCreateImpl(async () => {
    createCalls++;
    if (createCalls === 1) return throwingStream(prematureClose());
    return okStream('recovered');
  });
  try {
    const result = await chat(messages, {});
    assert.equal(result.content, 'recovered', '连接被掐后重发应拿到完整回复');
    assert.equal(createCalls, 2, '应重发一次');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('传输层断流:已流出文本后不重试;用户中断(abort)也不重试', async () => {
  let createCalls = 0;
  __setChatCreateImpl(async () => {
    createCalls++;
    return partialThenThrow(prematureClose(), '半截输出');
  });
  try {
    await assert.rejects(() => chat(messages, {}), /Premature close/);
    assert.equal(createCalls, 1, '已产出内容时断流不重试');
  } finally {
    __setChatCreateImpl(null);
  }

  // signal 已 abort 时,即便错误形态是「断流」也必须一次即抛(undici 在 abort 时也会抛这种形态)。
  const controller = new AbortController();
  let abortedCalls = 0;
  __setChatCreateImpl(async () => {
    abortedCalls++;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            controller.abort(); // 模拟用户按 Ctrl+C:先中断再抛
            return Promise.reject(prematureClose());
          },
        };
      },
    };
  });
  try {
    await assert.rejects(() => chat(messages, {}, controller.signal));
    assert.equal(abortedCalls, 1, '用户中断不得触发重试');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('空流(建连成功但一个 chunk 都没有)仍按「模型无回复」收尾——已知取舍,见文件头', async () => {
  // 现状:零 chunk 的响应体(网关把 HTML 错误页当流回 / 200+空 body)被 SSE 解析器静默丢弃,
  // chatOnce 返回空结果 → run-coordinator 判定 completed 并触发 onNoReply(`(无回复)`)。
  // 这是 tests/agent-core.test.ts「空模型回复保持 completed 与 onNoReply 语义」锁定的既有语义,
  // 本文件不动它;要不要把「零 chunk」额外判成可重试的流中断,留给设计决策。
  let createCalls = 0;
  __setChatCreateImpl(async () => {
    createCalls++;
    return emptyStream();
  });
  try {
    const result = await chat(messages, {});
    assert.equal(result.content, null);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(createCalls, 1, '当前不重试:一次即返回空结果');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('Anthropic 流内 event: error 也走「零产出可重试」窗口', async () => {
  const prevProvider = config.provider;
  config.provider = 'anthropic';
  let calls = 0;
  const sse = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  __setAnthropicFetchImpl(async () => {
    calls++;
    if (calls === 1) {
      return sse('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
    }
    return sse(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
    );
  });
  try {
    const result = await chat(messages, {});
    assert.equal(result.content, 'ok', 'overloaded_error 重发后应拿到回复');
    assert.equal(calls, 2, 'Anthropic 流内 error 应重发一次');
  } finally {
    __setAnthropicFetchImpl(null);
    config.provider = prevProvider;
  }
});

test('classifyChatError:流中断文案都归类到 server 引导', () => {
  assert.equal(classifyChatError('Backend buffer overflow.'), 'server');
  assert.equal(classifyChatError('Premature close'), 'server');
  assert.equal(classifyChatError('other side closed'), 'server');
  // 不能因为出现 server/buffer 字样就把真正的限流/上下文超长判错类。
  assert.equal(classifyChatError('429 rate limit exceeded'), 'quota');
  assert.equal(classifyChatError("This model's maximum context length is 8192 tokens"), 'context');
});

test('零产出时流中途故障自动重试,第二次成功', async () => {
  let createCalls = 0;
  const retries: Array<{ attempt: number; code: string }> = [];
  __setChatCreateImpl(async () => {
    createCalls++;
    if (createCalls === 1) return throwingStream(sseError('Backend buffer overflow.'));
    return okStream('recovered');
  });
  try {
    const result = await chat(messages, { onRetry: (r) => retries.push({ attempt: r.attempt, code: r.code }) });
    assert.equal(result.content, 'recovered', '重试后应拿到完整回复');
    assert.equal(createCalls, 2, '应重发一次');
    assert.equal(retries.length, 1, '应告知宿主一次重试');
    assert.equal(retries[0]?.code, 'ClientError', '重试码取自 SSE 负载');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('已流出可见文本后不重试(避免内容区重放半截文本)', async () => {
  let createCalls = 0;
  __setChatCreateImpl(async () => {
    createCalls++;
    return partialThenThrow(sseError('Backend buffer overflow.'), '半截输出');
  });
  try {
    await assert.rejects(
      () => chat(messages, {}),
      (err: unknown) => err instanceof OpenAI.APIError && err.message === 'Backend buffer overflow.',
    );
    assert.equal(createCalls, 1, 'hasOutput 的流中途故障必须一次即抛');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('流中途故障的重试预算独立且有限(不会白等满 10 次指数退避)', async () => {
  let createCalls = 0;
  __setChatCreateImpl(async () => {
    createCalls++;
    return throwingStream(sseError('Backend buffer overflow.'));
  });
  try {
    await assert.rejects(() => chat(messages, {}));
    // 初始 1 次 + STREAM_RETRY_MAX_ATTEMPTS(2) 次重试 = 3 次后放弃。
    assert.equal(createCalls, 3, `流中途故障应重试 2 次后放弃,实际 ${createCalls}`);
  } finally {
    __setChatCreateImpl(null);
  }
});

test('本地校验错误(普通 Error)不会被误当服务端故障重试', async () => {
  let createCalls = 0;
  __setChatCreateImpl(async () => {
    createCalls++;
    return throwingStream(new Error('boom'));
  });
  try {
    await assert.rejects(() => chat(messages, {}));
    assert.equal(createCalls, 1, '普通 Error 不重试');
  } finally {
    __setChatCreateImpl(null);
  }
});

test('isRetryableError:建连失败(APIConnectionError)必须可重试', () => {
  const err = connectionError(dnsCause());
  // 证词:SDK 的 APIError 家族不设 this.name —— 旧代码的 `e.name === 'APIConnectionError'`
  // 分支永远为假,于是这类错误被当成「不可重试」一次即抛。
  assert.equal(err.name, 'Error');
  assert.equal(err.status, undefined);
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'Connection error.');

  assert.equal(isRetryableError(err), true, '建连失败属瞬时网络故障');
  assert.equal(isRetryableError(new OpenAI.APIConnectionTimeoutError()), true, '请求超时同样可重试');
  assert.equal(
    isRetryableError(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      }),
    ),
    true,
    'errno 藏在 cause 里(旧实现只看顶层 e.code,必然是 undefined)',
  );
  assert.equal(isRetryableError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableError(new TypeError('fetch failed')), true, 'fetch failed 文案兜底');

  // 不能因为「加宽网络错判定」把该判死的也捞进来。
  assert.equal(isRetryableError(new OpenAI.APIError(400, { message: 'bad' }, undefined, undefined)), false, '4xx');
  assert.equal(isRetryableError(new OpenAI.APIUserAbortError()), false, '用户中断');
  const controller = new AbortController();
  controller.abort();
  assert.equal(isRetryableError(connectionError(), controller.signal), false, 'signal 已中断一律不重试');

  // 证书 / 协议不匹配是永久故障:必须判死,否则新加的宽兜底会让它白等满 10 次退避(≈两分钟)。
  assert.equal(
    isRetryableError(
      connectionError(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('unable to verify the first certificate'), {
            code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          }),
        }),
      ),
    ),
    false,
  );
  assert.equal(isRetryableError(connectionError(new Error('wrong version number'))), false);
});

test('建连失败:零产出自动重试,第二次成功(trace code="Error" 那次的形态)', async () => {
  let createCalls = 0;
  const retries: Array<{ attempt: number; code: string }> = [];
  __setChatCreateImpl(async () => {
    createCalls++;
    if (createCalls === 1) throw connectionError(dnsCause());
    return okStream('recovered');
  });
  try {
    const result = await chat(messages, { onRetry: (r) => retries.push({ attempt: r.attempt, code: r.code }) });
    assert.equal(result.content, 'recovered', '建连失败后重发应拿到完整回复');
    assert.equal(createCalls, 2, '应重发一次');
    assert.equal(retries.length, 1, '应告知宿主一次重试');
    assert.equal(retries[0]?.code, 'APIConnectionError', '重试码报构造器名,而不是无信息量的 Error');
  } finally {
    __setChatCreateImpl(null);
  }
});
