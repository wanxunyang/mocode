/** ModelPreset 目录可选字段解析测试（#model-catalog 第 2 步）：旧文件兼容 + 新字段采纳。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreset } from '../src/config/presets.js';

const base = {
  name: 'p',
  provider: 'openai',
  baseURL: 'https://x/v1',
  apiKey: 'sk-k',
  model: 'm',
  contextWindow: 128000,
};

test('旧预设（无目录字段）解析正常，可选字段为 undefined', () => {
  const p = parsePreset(JSON.stringify(base));
  assert.equal(p.catalogProvider, undefined);
  assert.equal(p.catalogModel, undefined);
  assert.equal(p.capabilities, undefined);
  assert.equal(p.pricing, undefined);
});

test('目录字段：类型正确才采纳', () => {
  const p = parsePreset(
    JSON.stringify({
      ...base,
      catalogProvider: 'zhipuai',
      catalogModel: 'glm-5v',
      capabilities: {
        reasoning: true,
        toolCall: true,
        attachment: false,
        reasoningOptions: [{ type: 'toggle' }],
      },
      pricing: { input: 0.73, output: 3.19, cacheRead: 0.07 },
    }),
  );
  assert.equal(p.catalogProvider, 'zhipuai');
  assert.equal(p.catalogModel, 'glm-5v');
  assert.deepEqual(p.capabilities, {
    reasoning: true,
    toolCall: true,
    attachment: false,
    reasoningOptions: [{ type: 'toggle' }],
  });
  assert.deepEqual(p.pricing, { input: 0.73, output: 3.19, cacheRead: 0.07 });
});

test('maxTokens：缺省为 undefined（不下发，吃后端默认）', () => {
  const p = parsePreset(JSON.stringify(base));
  assert.equal(p.maxTokens, undefined);
});

test('maxTokens：正整数被采纳', () => {
  const p = parsePreset(JSON.stringify({ ...base, maxTokens: 32000 }));
  assert.equal(p.maxTokens, 32000);
});

test('maxTokens：非整数向下取整', () => {
  const p = parsePreset(JSON.stringify({ ...base, maxTokens: 8192.9 }));
  assert.equal(p.maxTokens, 8192);
});

test('maxTokens：非法值（0/负/字符串）抛错，坏文件由 listPresets 跳过', () => {
  for (const bad of [0, -1, '32000']) {
    assert.throws(() => parsePreset(JSON.stringify({ ...base, maxTokens: bad })), /maxTokens/);
  }
});

test('maxTokens：null 视为未设置（undefined），不抛错', () => {
  const p = parsePreset(JSON.stringify({ ...base, maxTokens: null }));
  assert.equal(p.maxTokens, undefined);
});

test('脏字段被忽略：类型错的条目不采纳，合法字段仍保留', () => {
  const p = parsePreset(
    JSON.stringify({
      ...base,
      catalogProvider: 123, // 非 string → 忽略
      capabilities: 'yes', // 非 object → 整段忽略
      pricing: { input: 'x', output: 2 }, // input 非法忽略, output 保留
    }),
  );
  assert.equal(p.catalogProvider, undefined);
  assert.equal(p.capabilities, undefined);
  assert.deepEqual(p.pricing, { output: 2 });
});
