/** isContextLengthError:后端实测拒绝 prompt 的识别(agent/core 据此强压一轮再重试)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isContextLengthError } from '../src/llm/index.js';

test('识别各家 provider 的上下文超长报错', () => {
  const cases: Array<{ name: string; err: unknown }> = [
    {
      name: 'OpenAI 标准 code',
      err: {
        status: 400,
        code: 'context_length_exceeded',
        message: "This model's maximum context length is 128000 tokens.",
      },
    },
    {
      name: 'OpenAI 无 code,靠 message',
      err: {
        status: 400,
        message: "This model's maximum context length is 8192 tokens, however you requested 10000 tokens.",
      },
    },
    {
      name: 'Anthropic 措辞',
      err: { status: 400, message: 'prompt is too long: 210000 tokens > 200000 maximum' },
    },
    {
      name: '通义/智谱中文措辞',
      err: { status: 400, message: '请求长度超过模型上限' },
    },
    {
      name: '413 网关',
      err: { status: 413, message: 'payload too large' },
    },
    {
      name: 'status 缺失(代理折叠成普通 Error)',
      err: new Error('context length exceeded'),
    },
    {
      name: 'Moonshot 风格 code',
      err: { status: 400, code: 'string_above_max_length' },
    },
  ];
  for (const c of cases) {
    assert.equal(isContextLengthError(c.err), true, `${c.name} 应判定为上下文超长`);
  }
});

test('不把无关错误误判成超长(误判会白压一次上下文)', () => {
  const cases: Array<{ name: string; err: unknown }> = [
    { name: '鉴权失败', err: { status: 401, message: 'invalid api key' } },
    { name: '限流', err: { status: 429, message: 'rate limit reached' } },
    { name: '服务端错', err: { status: 500, message: 'context length exceeded (server side)' } },
    { name: '参数校验', err: { status: 400, message: 'invalid type for messages' } },
    { name: '非对象', err: 'boom' },
    { name: '空', err: undefined },
    { name: '用户中断', err: { name: 'AbortError', message: 'aborted' } },
  ];
  for (const c of cases) {
    assert.equal(isContextLengthError(c.err), false, `${c.name} 不应判定为上下文超长`);
  }
});
