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
