/**
 * registry 级 retryable 自动重试契约 + web_fetch 反爬强化。
 *
 * 背景:ToolOutcome.retryable 此前全项目**零消费者** —— 工具诚实标了「这是瞬时失败」,
 * 却没人据此行动,模型只能再发一轮 tool call 自救(浪费一个完整 LLM 往返,且常忘记重试)。
 * 现 runtime 对 capabilities.idempotent=true 的工具在退避后自动重发。
 *
 * 关键安全边界:只有显式声明 idempotent 的工具才重试。写/进程类工具即使返回 retryable=true
 * 也绝不自动重发(重试会重复下单、重复起进程)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime } from '../src/tools/tool-runtime.js';
import { webFetchTool } from '../src/tools/builtins/web-fetch.js';
import { CAPABILITIES } from '../src/tools/builtins/index.js';
import type { Tool, ToolCapabilities, ToolOutcome } from '../src/tools/types.js';

/** 造一个可控工具:按脚本依次返回给定 outcome,并记录调用次数。 */
function scriptedTool(
  name: string,
  capabilities: ToolCapabilities,
  script: ToolOutcome[],
): { tool: Tool; calls: () => number } {
  let index = 0;
  const tool: Tool = {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    capabilities,
    async execute(): Promise<ToolOutcome> {
      const outcome = script[Math.min(index, script.length - 1)];
      index++;
      return outcome;
    },
  };
  return { tool, calls: () => index };
}

const transientFail: ToolOutcome = {
  status: 'error',
  code: 'NETWORK_ERROR',
  retryable: true,
  output: '错误:抓取失败: socket hang up',
};
const timeoutFail: ToolOutcome = {
  status: 'error',
  code: 'TIMEOUT',
  retryable: true,
  output: '错误:抓取超时(30000ms)',
};
const hardFail: ToolOutcome = {
  status: 'error',
  code: 'HTTP_ERROR',
  retryable: false,
  output: '错误:抓取失败 HTTP 404 Not Found',
};
const ok: ToolOutcome = { status: 'success', code: 'OK', retryable: false, output: 'payload' };

const NET_IDEMPOTENT: ToolCapabilities = { effect: 'network', concurrency: 'parallel', idempotent: true };
const WRITE_NON_IDEMPOTENT: ToolCapabilities = { effect: 'write', concurrency: 'serial' };

function runtimeWith(tool: Tool): ToolRuntime {
  const runtime = new ToolRuntime();
  runtime.installBuiltinTools([tool]);
  return runtime;
}

// ── 幂等工具:自动重试 ─────────────────────────────────────────────────────

test('idempotent: 瞬时失败后自动重试并成功(不再需要模型再发一轮)', async () => {
  const { tool, calls } = scriptedTool('net_ok', NET_IDEMPOTENT, [transientFail, ok]);
  const outcome = await runtimeWith(tool).executeToolOutcome('net_ok', '{}');
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.output, 'payload');
  assert.equal(calls(), 2, '首次失败 + 自动重试 1 次 = 2 次执行');
});

test('idempotent: 重试用尽(1 首次 + 2 退避)仍失败,把重试次数写进 output', async () => {
  const { tool, calls } = scriptedTool('net_fail', NET_IDEMPOTENT, [transientFail]);
  const outcome = await runtimeWith(tool).executeToolOutcome('net_fail', '{}');
  assert.equal(outcome.status, 'error');
  assert.equal(calls(), 3, '首次 + 2 次退避重试');
  assert.match(outcome.output, /已自动重试 2 次仍失败/, '模型需知道 runtime 已经试过,别再无脑重发');
  assert.match(outcome.output, /socket hang up/, '原始失败原因不能被重试提示覆盖掉');
});

test('idempotent: 不可重试的硬失败(404)立即返回,零额外重试', async () => {
  const { tool, calls } = scriptedTool('net_404', NET_IDEMPOTENT, [hardFail]);
  const outcome = await runtimeWith(tool).executeToolOutcome('net_404', '{}');
  assert.equal(outcome.status, 'error');
  assert.equal(calls(), 1, 'retryable=false 是终态,重试纯属浪费时间');
  assert.ok(!outcome.output.includes('已自动重试'));
});

test('idempotent: TIMEOUT 不自动重试(一次超时已烧掉整个窗口,再试会把单次调用拖成 90s)', async () => {
  const { tool, calls } = scriptedTool('net_timeout', NET_IDEMPOTENT, [timeoutFail, ok]);
  const outcome = await runtimeWith(tool).executeToolOutcome('net_timeout', '{}');
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'TIMEOUT');
  assert.equal(calls(), 1, '超时是「目标主机真的慢」,重试收益低、spinner 冻屏代价高');
  assert.equal(outcome.retryable, true, 'retryable 标记保留:模型仍可自行决定是否再发一轮');
  assert.ok(!outcome.output.includes('已自动重试'), '没重试过就不能声称重试了');
});

test('idempotent: 首次即成功时不多跑一次', async () => {
  const { tool, calls } = scriptedTool('net_first_ok', NET_IDEMPOTENT, [ok]);
  const outcome = await runtimeWith(tool).executeToolOutcome('net_first_ok', '{}');
  assert.equal(outcome.status, 'success');
  assert.equal(calls(), 1);
});

// ── 非幂等工具:绝不自动重试(核心安全边界)─────────────────────────────────

test('非 idempotent: 即使 retryable=true 也只执行一次(重试会重复副作用)', async () => {
  const { tool, calls } = scriptedTool('write_tool', WRITE_NON_IDEMPOTENT, [transientFail, ok]);
  const outcome = await runtimeWith(tool).executeToolOutcome('write_tool', '{}');
  assert.equal(outcome.status, 'error');
  assert.equal(calls(), 1, '写工具自动重试 = 重复下单/重复写文件,必须保持单次');
  assert.ok(!outcome.output.includes('已自动重试'));
});

test('非 idempotent: success 结果照常返回,重试外壳零行为差异', async () => {
  const { tool, calls } = scriptedTool('write_ok', WRITE_NON_IDEMPOTENT, [ok]);
  const outcome = await runtimeWith(tool).executeToolOutcome('write_ok', '{}');
  assert.equal(outcome.status, 'success');
  assert.equal(calls(), 1);
});

// ── abort 敏感 ────────────────────────────────────────────────────────────

test('idempotent: 退避等待期间用户 abort → 立即停止,不空耗重试窗口', async () => {
  const controller = new AbortController();
  let index = 0;
  const tool: Tool = {
    name: 'net_abort',
    description: 'net_abort',
    parameters: { type: 'object', properties: {} },
    capabilities: NET_IDEMPOTENT,
    async execute(): Promise<ToolOutcome> {
      index++;
      if (index === 1) {
        // 首次执行时就 abort:模拟用户在第一次失败后按 Ctrl+C。
        controller.abort();
        return transientFail;
      }
      return ok;
    },
  };
  const outcome = await runtimeWith(tool).executeToolOutcome('net_abort', '{}', controller.signal);
  assert.equal(index, 1, 'abort 后不得再发起重试');
  // aborted 是终态,不是 error
  assert.equal(outcome.status, 'aborted');
});

// ── 能力声明审计 ──────────────────────────────────────────────────────────

test('CAPABILITIES: 只有 web_fetch/web_search 声明 idempotent(网络只读),写/进程类一个都没有', () => {
  const idempotentNames = Object.entries(CAPABILITIES)
    .filter(([, caps]) => caps.idempotent)
    .map(([name]) => name);
  assert.deepEqual(idempotentNames.sort(), ['web_fetch', 'web_search']);
  // 反向审计:任何 write/process effect 的工具若被误标 idempotent,就是重复副作用事故。
  for (const [name, caps] of Object.entries(CAPABILITIES)) {
    if (caps.effect === 'write' || caps.effect === 'process') {
      assert.notEqual(caps.idempotent, true, `${name} 有副作用,绝不能标 idempotent`);
    }
  }
});

// ── web_fetch 反爬强化 ────────────────────────────────────────────────────

test('web_fetch: 请求带全套浏览器拟真头(裸 fetch 缺 Sec-Fetch-* 是反爬识别点)', async () => {
  const savedFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response('<html><body><main><p>hello world</p></main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;
  try {
    const result = await webFetchTool.execute({ url: 'https://example.com/post' });
    const output = typeof result === 'string' ? result : result.output;
    assert.match(output, /hello world/);
    const headers = capturedHeaders as Record<string, string>;
    assert.match(headers['User-Agent'], /Chrome\/120/, 'UA 伪装必须保留');
    assert.equal(headers['Sec-Fetch-Dest'], 'document');
    assert.equal(headers['Sec-Fetch-Mode'], 'navigate');
    assert.equal(headers['Sec-Fetch-Site'], 'none');
    assert.equal(headers['Sec-Fetch-User'], '?1');
    assert.match(headers['sec-ch-ua'], /Chrome";v="120"/, 'client hints 须与 UA 版本一致,否则更可疑');
    assert.ok(headers['Accept-Language'], '缺 Accept-Language 是脚本画像的典型特征');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('web_fetch: 403 默认不走代理(代理是 opt-in),但输出告知可设 MOCODE_WEB_FETCH_PROXY', async () => {
  const savedFetch = globalThis.fetch;
  const savedProxy = process.env.MOCODE_WEB_FETCH_PROXY;
  delete process.env.MOCODE_WEB_FETCH_PROXY;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response('Access denied by Cloudflare', { status: 403, statusText: 'Forbidden' });
  }) as typeof fetch;
  try {
    const result = await webFetchTool.execute({ url: 'https://shielded.example.com/' });
    assert.equal(typeof result, 'object');
    const outcome = result as ToolOutcome;
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.code, 'HTTP_ERROR');
    assert.equal(outcome.retryable, false, '403 是确定性拒绝,重试无望');
    assert.equal(callCount, 1, '未配置代理时不得把 URL 外包给第三方');
    assert.match(outcome.output, /MOCODE_WEB_FETCH_PROXY/, '必须告诉模型/用户存在这条逃生通道');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedProxy === undefined) delete process.env.MOCODE_WEB_FETCH_PROXY;
    else process.env.MOCODE_WEB_FETCH_PROXY = savedProxy;
  }
});

test('web_fetch: 配置代理后 403 走代理回退,成功结果标注 via proxy', async () => {
  const savedFetch = globalThis.fetch;
  const savedProxy = process.env.MOCODE_WEB_FETCH_PROXY;
  process.env.MOCODE_WEB_FETCH_PROXY = 'https://r.jina.ai/';
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const target = String(input);
    seenUrls.push(target);
    if (seenUrls.length === 1) {
      return new Response('blocked', { status: 403, statusText: 'Forbidden' });
    }
    return new Response('<main>proxied body text</main>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  try {
    const result = await webFetchTool.execute({ url: 'https://shielded.example.com/page' });
    const output = typeof result === 'string' ? result : result.output;
    assert.equal(seenUrls.length, 2, '直连 403 后应恰好再试一次代理');
    assert.equal(seenUrls[1], 'https://r.jina.ai/https://shielded.example.com/page', '代理必须是前缀拼接');
    assert.match(output, /proxied body text/);
    assert.match(output, /via proxy/, '来源必须透明标注,不能假装是直连拿到的');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedProxy === undefined) delete process.env.MOCODE_WEB_FETCH_PROXY;
    else process.env.MOCODE_WEB_FETCH_PROXY = savedProxy;
  }
});

test('web_fetch: 直连与代理都被拒时报两段原因,不掩盖代理尝试', async () => {
  const savedFetch = globalThis.fetch;
  const savedProxy = process.env.MOCODE_WEB_FETCH_PROXY;
  process.env.MOCODE_WEB_FETCH_PROXY = 'https://r.jina.ai/';
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    return new Response(call === 1 ? 'cf blocked' : 'proxy also blocked', {
      status: call === 1 ? 403 : 451,
      statusText: call === 1 ? 'Forbidden' : 'Unavailable For Legal Reasons',
    });
  }) as typeof fetch;
  try {
    const result = await webFetchTool.execute({ url: 'https://hard-shield.example.com/' });
    const outcome = result as ToolOutcome;
    assert.equal(outcome.status, 'error');
    assert.match(outcome.output, /直连与代理均被拒/);
    assert.match(outcome.output, /HTTP 403/);
    assert.match(outcome.output, /HTTP 451/, '代理失败原因也要报出');
    assert.match(outcome.output, /cf blocked/, '保留直连响应片段供诊断');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedProxy === undefined) delete process.env.MOCODE_WEB_FETCH_PROXY;
    else process.env.MOCODE_WEB_FETCH_PROXY = savedProxy;
  }
});

test('web_fetch: 非法代理配置(URL 解析失败 / 非 http)被忽略,回落纯直连', async () => {
  const savedFetch = globalThis.fetch;
  const savedProxy = process.env.MOCODE_WEB_FETCH_PROXY;
  process.env.MOCODE_WEB_FETCH_PROXY = 'not-a-url';
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    return new Response('blocked', { status: 403, statusText: 'Forbidden' });
  }) as typeof fetch;
  try {
    await webFetchTool.execute({ url: 'https://example.com/' });
    assert.equal(call, 1, '非法代理配置不得触发任何额外请求');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedProxy === undefined) delete process.env.MOCODE_WEB_FETCH_PROXY;
    else process.env.MOCODE_WEB_FETCH_PROXY = savedProxy;
  }
});

test('web_fetch: 429/5xx 标 retryable=true(交给 registry 自动重试),404 不标', async () => {
  const savedFetch = globalThis.fetch;
  const savedProxy = process.env.MOCODE_WEB_FETCH_PROXY;
  delete process.env.MOCODE_WEB_FETCH_PROXY;
  const cases: Array<[number, boolean]> = [
    [429, true],
    [503, true],
    [500, true],
    [408, true],
    [404, false],
    [401, false],
  ];
  try {
    for (const [status, expected] of cases) {
      globalThis.fetch = (async () => new Response('x', { status, statusText: 'S' })) as typeof fetch;
      const result = await webFetchTool.execute({ url: `https://example.com/${status}` });
      const outcome = result as ToolOutcome;
      assert.equal(outcome.status, 'error', `HTTP ${status} 必须是 error`);
      assert.equal(outcome.retryable, expected, `HTTP ${status} 的 retryable 应为 ${expected}`);
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedProxy === undefined) delete process.env.MOCODE_WEB_FETCH_PROXY;
    else process.env.MOCODE_WEB_FETCH_PROXY = savedProxy;
  }
});

test('web_fetch: 外部 abort 立即返回 aborted,不重试、不当超时', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    // 模拟请求进行中用户按 Ctrl+C
    init?.signal?.addEventListener('abort', () => {
      /* noop */
    });
    throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  }) as typeof fetch;
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await webFetchTool.execute({ url: 'https://example.com/' }, { signal: controller.signal });
    const outcome = result as ToolOutcome;
    assert.equal(outcome.status, 'aborted');
    assert.equal(outcome.code, 'ABORTED');
    assert.equal(outcome.retryable, false, '用户主动取消绝不能被当成瞬时失败去重试');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('web_fetch: 代理尝试期间用户 abort → 仍按 aborted 终态,不降级成「直连+代理均被拒」', async () => {
  const savedFetch = globalThis.fetch;
  const savedProxy = process.env.MOCODE_WEB_FETCH_PROXY;
  process.env.MOCODE_WEB_FETCH_PROXY = 'https://r.jina.ai/';
  const controller = new AbortController();
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) return new Response('blocked', { status: 403, statusText: 'Forbidden' });
    // 第二次(代理)请求进行中用户按 Ctrl+C
    controller.abort();
    throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  }) as typeof fetch;
  try {
    const result = await webFetchTool.execute({ url: 'https://shielded.example.com/' }, { signal: controller.signal });
    const outcome = result as ToolOutcome;
    assert.equal(outcome.status, 'aborted', 'abort 是终态,不能被报成 HTTP_ERROR');
    assert.equal(outcome.code, 'ABORTED');
    assert.equal(outcome.retryable, false, '用户取消绝不能触发自动重试');
    assert.ok(!outcome.output.includes('直连与代理均被拒'), 'abort 不得伪装成「两条路都被拒」');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedProxy === undefined) delete process.env.MOCODE_WEB_FETCH_PROXY;
    else process.env.MOCODE_WEB_FETCH_PROXY = savedProxy;
  }
});
