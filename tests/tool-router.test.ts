import test from 'node:test';
import assert from 'node:assert/strict';
import { __setChatCreateImpl } from '../src/llm/index.js';
import { getRoutableToolRouteGroups } from '../src/tools/policy.js';
import { DEFAULT_ROUTE_GROUPS } from '../src/config/profiles.js';
import { routeToolGroups } from '../src/tools/router.js';
import '../src/tools/builtins/index.js';

interface CapturedRequest {
  tools?: Array<{
    function: {
      name: string;
      parameters?: {
        properties?: {
          groups?: { items?: { enum?: string[] } };
        };
      };
    };
  }>;
  messages?: Array<{ role: string; content?: unknown }>;
}

function sseStream(
  chunks: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>,
): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield { choices: chunk.delta ? [{ delta: chunk.delta }] : [] };
    }
  })();
}

function selectorCall(args: unknown): AsyncIterable<unknown> {
  return sseStream([
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'route-call',
            function: { name: 'select_tool_groups', arguments: typeof args === 'string' ? args : JSON.stringify(args) },
          },
        ],
      },
    },
  ]);
}

const ROUTE_ENV_KEYS = [
  'MOCODE_ROUTER_ENABLED',
  'MOCODE_SUBAGENT_ENABLED',
  'MOCODE_FRONTEND_TOOLS_ENABLED',
  'MOCODE_COMPUTER_USE_ENABLED',
  'MOCODE_MCP_ENABLED',
  'MEMORY_ENABLED',
] as const;

function isolateRouteEnv(overrides: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string>> = {}): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ROUTE_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('routeToolGroups: 只暴露 selector schema，合法多标签决策可继承并夹紧 confidence', async () => {
  const restore = isolateRouteEnv({
    MOCODE_SUBAGENT_ENABLED: 'true',
    MOCODE_FRONTEND_TOOLS_ENABLED: 'true',
    MOCODE_COMPUTER_USE_ENABLED: 'true',
    MOCODE_MCP_ENABLED: 'true',
    MEMORY_ENABLED: 'true',
  });
  let captured: CapturedRequest | null = null;
  __setChatCreateImpl(async (body) => {
    captured = body as unknown as CapturedRequest;
    return selectorCall({
      groups: ['browser-debug', 'browser-debug', 'unknown-group'],
      inheritPrevious: true,
      confidence: 1.5,
      reason: '  web debugging continues  ',
    });
  });

  try {
    const decision = await routeToolGroups({
      input: `${'x'.repeat(12_000)}TAIL_MUST_BE_TRUNCATED`,
      previousGroups: ['memory-read'],
      planMode: true,
      attachmentNames: ['screen.png'],
    });

    assert.deepEqual(decision.groups, ['memory-read', 'browser-debug']);
    assert.equal(decision.inheritPrevious, true);
    assert.equal(decision.confidence, 1);
    assert.equal(decision.reason, 'web debugging continues');
    assert.equal(decision.fallback, false);

    assert.ok(captured);
    const request = captured as CapturedRequest;
    assert.equal(request.tools?.length, 1);
    assert.equal(request.tools?.[0]?.function.name, 'select_tool_groups');
    // 常驻组(workspace-write / shell-debug)不进路由选项:controller 已无条件激活它们。
    const enumGroups = request.tools?.[0]?.function.parameters?.properties?.groups?.items?.enum;
    const enumList: string[] = enumGroups ? [...enumGroups] : [];
    assert.deepEqual(enumList, getRoutableToolRouteGroups());
    for (const group of DEFAULT_ROUTE_GROUPS) {
      assert.ok(!enumList.includes(group), `${group} 是常驻组，不应出现在 selector enum 里`);
    }
    const userMessage = String(request.messages?.find((message) => message.role === 'user')?.content ?? '');
    assert.match(userMessage, /Current mode: PLAN/);
    assert.match(userMessage, /Previous groups: memory-read/);
    assert.match(userMessage, /Attachments: screen\.png/);
    assert.ok(!userMessage.includes('TAIL_MUST_BE_TRUNCATED'));
    assert.ok(userMessage.endsWith('x'.repeat(12_000)));
  } finally {
    __setChatCreateImpl(null);
    restore();
  }
});

test('routeToolGroups: 未知、被 gate 禁止与常驻的组都被过滤，不会借 previous 扩权', async () => {
  const restore = isolateRouteEnv({ MEMORY_ENABLED: 'false', MOCODE_COMPUTER_USE_ENABLED: 'true' });
  __setChatCreateImpl(async () =>
    selectorCall({
      groups: ['computer-control', 'workspace-write', 'not-real'],
      inheritPrevious: true,
      confidence: 0.6,
      reason: 'drive the desktop app',
    }),
  );
  try {
    const decision = await routeToolGroups({
      input: 'continue editing',
      previousGroups: ['memory-read', 'shell-debug'],
    });
    // memory-read 被 gate 禁、shell-debug 是常驻组、workspace-write 是常驻组、not-real 不存在。
    assert.deepEqual(decision.groups, ['computer-control']);
    assert.equal(decision.fallback, false);
  } finally {
    __setChatCreateImpl(null);
    restore();
  }
});

test('routeToolGroups: 缺失或损坏 selector 调用只回退 previous/common', async () => {
  const restore = isolateRouteEnv();
  let call = 0;
  __setChatCreateImpl(async () => {
    call++;
    if (call === 1) return sseStream([{ delta: { content: 'prose instead of a tool call' } }]);
    return selectorCall('{bad-json');
  });
  try {
    const noCall = await routeToolGroups({ input: 'continue', previousGroups: ['workspace-write'] });
    assert.equal(noCall.fallback, true);
    assert.deepEqual(noCall.groups, [], '常驻组不在可路由集合里，fallback 只回退真正可路由的组');
    assert.equal(noCall.confidence, 0);

    const malformed = await routeToolGroups({ input: 'continue', previousGroups: [] });
    assert.equal(malformed.fallback, true);
    assert.deepEqual(malformed.groups, []);
    assert.match(malformed.reason, /no valid select_tool_groups/);
  } finally {
    __setChatCreateImpl(null);
    restore();
  }
});

test('routeToolGroups: MOCODE_ROUTER_ENABLED=false 跳过路由调用，只保留默认簇', async () => {
  const restore = isolateRouteEnv({ MOCODE_ROUTER_ENABLED: 'false' });
  let called = false;
  __setChatCreateImpl(async () => {
    called = true;
    return selectorCall({ groups: ['browser-debug'], inheritPrevious: false, reason: 'should not run' });
  });
  try {
    const decision = await routeToolGroups({ input: 'do work', previousGroups: ['memory-read'] });
    assert.equal(called, false, '开关关闭时不应发起任何路由调用（LLM/Jev 都不该被触碰）');
    assert.equal(decision.fallback, true);
    assert.deepEqual(decision.groups, [], 'groups 置空 → controller 只保留常驻簇，不借 previous 扩权');
    assert.equal(decision.inheritPrevious, false);
    assert.match(decision.reason, /pre-routing is disabled/i);
  } finally {
    __setChatCreateImpl(null);
    restore();
  }
});

test('routeToolGroups: provider 普通错误 fallback，AbortError 必须继续抛出', async () => {
  const restore = isolateRouteEnv();
  try {
    __setChatCreateImpl(async () => {
      throw Object.assign(new Error('router boom'), { status: 400 });
    });
    const failed = await routeToolGroups({ input: 'do work', previousGroups: ['memory-read'] });
    assert.equal(failed.fallback, true);
    assert.deepEqual(failed.groups, ['memory-read']);
    assert.match(failed.reason, /Router failed \(router boom\)/);

    __setChatCreateImpl(async () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    });
    await assert.rejects(routeToolGroups({ input: 'do work' }), { name: 'AbortError' });
  } finally {
    __setChatCreateImpl(null);
    restore();
  }
});
