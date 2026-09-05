import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { chat, type ChatResult, type StreamHandlers } from '../src/llm/index.js';
import { registerModelProvider, getModelProvider, listModelProviders } from '../src/llm/provider.js';

/**
 * 步骤3 Provider 抽象的单测:
 *  - chat() 不再硬编码 if(config.provider==='anthropic'),而是查注册表;
 *  - 自定义 provider 注册后即可被 chat() 选用(框架可扩展性的直接证据);
 *  - 未注册 provider 报清晰错误并带可用名单。
 * 测试直接改 config.provider 字段并在 finally 还原——不用 updateModelConfig,
 * 后者会同步 process.env.LLM_PROVIDER,污染共享进程(--experimental-test-isolation=none)。
 */

test('provider: 默认注册 openai 与 anthropic', () => {
  const names = listModelProviders();
  assert.ok(names.includes('openai'), 'openai 应已注册');
  assert.ok(names.includes('anthropic'), 'anthropic 应已注册');
});

test('provider: 自定义 provider 注册后被 chat() 选用', async () => {
  const calls: string[] = [];
  const fake: ChatResult = { content: 'custom-provider-reply', toolCalls: [] };
  registerModelProvider({
    name: 'acme-custom',
    chatOnce: (messages, handlers, _signal, _tools) => {
      calls.push('invoked');
      handlers.onText?.('custom-provider-reply');
      return Promise.resolve(fake);
    },
  });

  const saved = config.provider;
  const streamed: string[] = [];
  const handlers: StreamHandlers = { onText: (d) => streamed.push(d) };
  try {
    // registerModelProvider 接受任意 provider 名;此处把 config.provider 指向它。
    (config as { provider: string }).provider = 'acme-custom';
    const result = await chat([{ role: 'user', content: 'hi' }], handlers);
    assert.deepEqual(calls, ['invoked'], 'chat() 应调用自定义 provider 而非 openai/anthropic 实现');
    assert.equal(result.content, 'custom-provider-reply');
    assert.deepEqual(streamed, ['custom-provider-reply'], '流式 onText 应透传 provider 输出');
  } finally {
    (config as { provider: string }).provider = saved;
  }
});

test('provider: 未注册 provider 报清晰错误并列出可用名单', async () => {
  const saved = config.provider;
  try {
    (config as { provider: string }).provider = 'no-such-provider';
    await assert.rejects(
      () => chat([{ role: 'user', content: 'hi' }]),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /no-such-provider/, '错误应包含未知 provider 名');
        assert.match(msg, /openai/, '错误应列出已注册 provider(openai)');
        assert.match(msg, /anthropic/, '错误应列出已注册 provider(anthropic)');
        return true;
      },
    );
  } finally {
    (config as { provider: string }).provider = saved;
  }
});

test('provider: getModelProvider 未知名返回 undefined', () => {
  assert.equal(getModelProvider('definitely-not-registered'), undefined);
  assert.ok(getModelProvider('openai'), 'openai 应可取到');
});
