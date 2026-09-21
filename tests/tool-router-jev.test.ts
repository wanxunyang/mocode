/**
 * Jev 预路由后端的单测。
 *
 * 覆盖:模式分派、阈值出簇、mcp 专用阈值、下划线/连字符键名映射、503 退避重试、
 * 失败降级不抛、未配置 key 降级、用户取消透传。
 *
 * 隔离策略:显式传 `tools` 目录 + `gateAllows: () => true`,不依赖进程里真实注册的工具与
 * gate env;只注入 __setJevFetchImpl,绝不发真实网络请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeToolGroups } from '../src/tools/router.js';
import { __setJevFetchImpl } from '../src/tools/jev-client.js';
import type { Tool } from '../src/tools/types.js';

/** 覆盖全部 7 个可路由簇所需的最小工具目录(name 即分组依据)。 */
const CATALOG = [
  { name: 'browser' },
  { name: 'dev_server' },
  { name: 'screenshot' },
  { name: 'computer' },
  { name: 'memory_search' },
  { name: 'memory_list' },
  { name: 'memory_save' },
  { name: 'memory_update' },
  { name: 'memory_forget' },
  { name: 'memory_graph' },
  { name: 'sub-agent' },
  { name: 'run_skill' },
  { name: 'mcp__jira' },
] as unknown as readonly Tool[];

const allowAll = (): boolean => true;

const ROUTER_ENV_KEYS = [
  'MOCODE_ROUTER_MODE',
  'MOCODE_ROUTER_JEV_BASE_URL',
  'MOCODE_ROUTER_JEV_API_KEY',
  'MOCODE_ROUTER_JEV_MODEL',
  'MOCODE_ROUTER_CONFIDENCE_MIN',
  'MOCODE_ROUTER_CONFIDENCE_MIN_MCP',
] as const;

function withEnv(overrides: Partial<Record<(typeof ROUTER_ENV_KEYS)[number], string>>, run: () => Promise<void>) {
  return async (): Promise<void> => {
    const saved = new Map<string, string | undefined>();
    for (const key of ROUTER_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    try {
      await run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __setJevFetchImpl(null);
    }
  };
}

interface CapturedCall {
  url: string;
  body: {
    model?: string;
    state?: { mode?: string; previous_groups?: string[]; task?: string };
    questions?: Record<string, { type?: string; instructions?: string }>;
  };
}

/**
 * 构造一个假的 fetch:把 body.questions 的每个键(下划线形式)按 provided 概率作答。
 * probabilities 以**下划线键**给出,以证明客户端会把 browser_debug → browser-debug 映射回来。
 */
function fakeJev(options: {
  probabilities: Record<string, number>;
  inheritPrevious?: number;
  captured?: CapturedCall[];
  statuses?: number[];
  model?: string;
}) {
  let call = 0;
  return async (url: string, init: RequestInit): Promise<Response> => {
    call++;
    const body = JSON.parse(String(init.body)) as CapturedCall['body'];
    options.captured?.push({ url, body });

    const forcedStatus = options.statuses?.[call - 1];
    if (forcedStatus !== undefined && forcedStatus !== 200) {
      return new Response('{"error":"transient"}', { status: forcedStatus });
    }

    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(body.questions ?? {})) {
      const value = options.probabilities[key];
      if (value !== undefined) answers[key] = { noul: value };
    }
    answers.inherit_previous = { noul: options.inheritPrevious ?? 0 };
    return new Response(
      JSON.stringify({
        model: options.model ?? 'jev-test-1.0',
        answers,
        usage: { input_tokens: 42 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

test(
  'jev 模式:阈值出簇 + 下划线键名映射 + 请求体形态',
  withEnv(
    {
      MOCODE_ROUTER_MODE: 'jev',
      MOCODE_ROUTER_JEV_API_KEY: 'test-key',
      MOCODE_ROUTER_CONFIDENCE_MIN: '0.65',
      MOCODE_ROUTER_CONFIDENCE_MIN_MCP: '0.85',
    },
    async () => {
      const captured: CapturedCall[] = [];
      __setJevFetchImpl(
        fakeJev({
          // 键为下划线形式(API 形态);客户端须映射回连字符簇名。
          probabilities: { browser_debug: 0.9, memory_read: 0.8, memory_write: 0.5, mcp: 0.7 },
          captured,
        }),
      );

      const decision = await routeToolGroups({
        input: '打开 localhost:3000 看下控制台',
        tools: CATALOG,
        gateAllows: allowAll,
      });

      // memory_write=0.5 < 0.65 排除;mcp=0.7 < 0.85(mcp 专用阈值)排除。
      assert.deepEqual(decision.groups, ['browser-debug', 'memory-read']);
      assert.equal(decision.fallback, false);
      // confidence 取已选簇里最小的概率(memory-read 的 0.8)。
      assert.equal(decision.confidence, 0.8);
      assert.match(decision.reason, /jev-test-1\.0/);

      const call = captured[0];
      assert.equal(captured.length, 1);
      assert.match(call.url, /\/v1\/systemone$/);
      assert.equal(call.body.model, 'jev-latest');
      assert.equal(call.body.state?.mode, 'AUTO');
      assert.equal(call.body.state?.task, '打开 localhost:3000 看下控制台');
      // 问题键必须是下划线形式,且正文非空。
      assert.ok(call.body.questions?.browser_debug);
      assert.equal(call.body.questions?.browser_debug?.type, 'noul');
      assert.ok((call.body.questions?.browser_debug?.instructions ?? '').length > 0);
    },
  ),
);

test(
  'jev 模式:mcp 用专用阈值,同一概率在 0.85 下入选、在 0.9 下被拒',
  withEnv(
    { MOCODE_ROUTER_MODE: 'jev', MOCODE_ROUTER_JEV_API_KEY: 'k', MOCODE_ROUTER_CONFIDENCE_MIN_MCP: '0.85' },
    async () => {
      __setJevFetchImpl(fakeJev({ probabilities: { mcp: 0.86 } }));
      const pass = await routeToolGroups({ input: '在 jira 建单', tools: CATALOG, gateAllows: allowAll });
      assert.deepEqual(pass.groups, ['mcp']);

      process.env.MOCODE_ROUTER_CONFIDENCE_MIN_MCP = '0.9';
      __setJevFetchImpl(fakeJev({ probabilities: { mcp: 0.86 } }));
      const fail = await routeToolGroups({ input: '在 jira 建单', tools: CATALOG, gateAllows: allowAll });
      assert.deepEqual(fail.groups, []);
      assert.equal(fail.fallback, false, '阈值拒绝不等于降级,fetch 本身是成功的');
    },
  ),
);

test(
  'jev 模式:inherit_previous 达到 0.5 时并入上一轮簇',
  withEnv({ MOCODE_ROUTER_MODE: 'jev', MOCODE_ROUTER_JEV_API_KEY: 'k' }, async () => {
    __setJevFetchImpl(fakeJev({ probabilities: {}, inheritPrevious: 0.9 }));
    const decision = await routeToolGroups({
      input: '继续',
      previousGroups: ['memory-read'],
      tools: CATALOG,
      gateAllows: allowAll,
    });
    assert.deepEqual(decision.groups, ['memory-read']);
    assert.equal(decision.inheritPrevious, true);
  }),
);

test(
  'jev 模式:503 退避重试后成功',
  withEnv({ MOCODE_ROUTER_MODE: 'jev', MOCODE_ROUTER_JEV_API_KEY: 'k' }, async () => {
    const captured: CapturedCall[] = [];
    __setJevFetchImpl(fakeJev({ probabilities: { browser_debug: 0.95 }, captured, statuses: [503] }));
    const decision = await routeToolGroups({ input: '看页面', tools: CATALOG, gateAllows: allowAll });
    assert.deepEqual(decision.groups, ['browser-debug']);
    assert.equal(captured.length, 2, '第一次 503、第二次 200');
  }),
);

test(
  'jev 模式:不可重试错误(401)直接降级,沿用上一轮簇且不抛',
  withEnv({ MOCODE_ROUTER_MODE: 'jev', MOCODE_ROUTER_JEV_API_KEY: 'bad' }, async () => {
    const captured: CapturedCall[] = [];
    __setJevFetchImpl(fakeJev({ probabilities: {}, captured, statuses: [401] }));
    const decision = await routeToolGroups({
      input: '做点事',
      previousGroups: ['memory-read'],
      tools: CATALOG,
      gateAllows: allowAll,
    });
    assert.equal(decision.fallback, true);
    assert.deepEqual(decision.groups, ['memory-read']);
    assert.match(decision.reason, /401/);
    assert.equal(captured.length, 1, '401 不重试');
  }),
);

test(
  'jev 模式:网络异常降级,不抛',
  withEnv({ MOCODE_ROUTER_MODE: 'jev', MOCODE_ROUTER_JEV_API_KEY: 'k' }, async () => {
    __setJevFetchImpl(async () => {
      throw new TypeError('fetch failed');
    });
    const decision = await routeToolGroups({ input: '做点事', previousGroups: [], tools: CATALOG, gateAllows: allowAll });
    assert.equal(decision.fallback, true);
    assert.deepEqual(decision.groups, []);
    assert.match(decision.reason, /Jev router failed/);
  }),
);

test(
  'jev 模式:未配置 API key 时降级,且不发请求',
  withEnv({ MOCODE_ROUTER_MODE: 'jev' }, async () => {
    let called = 0;
    __setJevFetchImpl(async () => {
      called++;
      return new Response('{}', { status: 200 });
    });
    const decision = await routeToolGroups({ input: '做点事', tools: CATALOG, gateAllows: allowAll });
    assert.equal(decision.fallback, true);
    assert.match(decision.reason, /MOCODE_ROUTER_JEV_API_KEY is unset/);
    assert.equal(called, 0);
  }),
);

test(
  '默认(llm)模式不触碰 Jev 端点',
  withEnv({ MOCODE_ROUTER_JEV_API_KEY: 'k' }, async () => {
    let jevCalled = 0;
    __setJevFetchImpl(async () => {
      jevCalled++;
      return new Response('{}', { status: 200 });
    });
    // llm 路径需要唯一的 select_tool_groups 工具调用;这里只验证「不分派给 Jev」,
    // 故注入会抛错的 transport,预期它走 fallback 而 Jev fetch 一次都没被调用。
    const decision = await routeToolGroups({
      input: '做点事',
      tools: CATALOG,
      gateAllows: allowAll,
      transport: async () => {
        throw Object.assign(new Error('llm transport boom'), { status: 400 });
      },
    });
    assert.equal(jevCalled, 0, 'llm 模式下绝不能调用 Jev');
    assert.equal(decision.fallback, true);
  }),
);

test(
  'jev 模式:用户取消(abort)继续上抛,不吞成降级',
  withEnv({ MOCODE_ROUTER_MODE: 'jev', MOCODE_ROUTER_JEV_API_KEY: 'k' }, async () => {
    const controller = new AbortController();
    controller.abort();
    __setJevFetchImpl(async (_url, init) => {
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return new Response('{}', { status: 200 });
    });
    await assert.rejects(
      routeToolGroups({ input: '做点事', tools: CATALOG, gateAllows: allowAll, signal: controller.signal }),
      { name: 'AbortError' },
    );
  }),
);