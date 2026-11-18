import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeWorkPresetDraft,
  readWorkPreset,
  reasoningCapabilityForPreset,
  writeWorkPreset,
  type WorkPresetDraft,
} from '../../packages/work-app/src/model-config.js';
import { buildCatalogPick, type CatalogProviderInfo } from '../../packages/work-app/src/catalog.js';

function preset(overrides: Partial<WorkPresetDraft>): WorkPresetDraft {
  return {
    provider: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'test-only',
    model: 'deepseek-v4.1-flash',
    contextWindow: 256000,
    ...overrides,
  };
}

test('DeepSeek 官方四档；Alibaba 无预算只开关，OpenRouter 不被型号映射误导', () => {
  const official = reasoningCapabilityForPreset(preset({ catalogProvider: 'deepseek' }));
  assert.deepEqual(official.supportedEfforts, ['off', 'low', 'medium', 'high']);
  assert.equal(official.effortMap.medium, 'high');

  const alibaba = reasoningCapabilityForPreset(
    preset({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      catalogProvider: 'alibaba',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
    }),
  );
  assert.deepEqual(alibaba.supportedEfforts, ['off', 'high']);
  assert.equal(alibaba.effortMap.medium, undefined);

  const alibabaBudget = reasoningCapabilityForPreset(
    preset({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      catalogProvider: 'alibaba',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'toggle' }, { type: 'budget_tokens' }] },
    }),
  );
  assert.deepEqual(alibabaBudget.supportedEfforts, ['off', 'low', 'medium', 'high']);

  const openrouter = reasoningCapabilityForPreset(
    preset({
      baseURL: 'https://openrouter.ai/api/v1',
      catalogProvider: 'openrouter',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
    }),
  );
  assert.equal(openrouter.effortMap.medium, 'low');
  assert.equal(openrouter.effortMap.off, undefined);

  const openAiNone = reasoningCapabilityForPreset(
    preset({
      model: 'gpt-5.6',
      catalogProvider: 'openai',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'effort', values: ['low', 'none', 'high'] }] },
    }),
  );
  assert.equal(openAiNone.effortMap.off, 'none');
  assert.ok(openAiNone.supportedEfforts.includes('off'));
});

test('目录 effort values 限制 OpenAI 可选档位；off 不伪装成关闭', () => {
  const capability = reasoningCapabilityForPreset(
    preset({
      model: 'gpt-5.4-pro',
      catalogProvider: 'openai',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'effort', values: ['medium', 'high', 'xhigh'] }] },
    }),
  );
  assert.equal(capability.supportedEfforts.includes('off'), false);
  assert.equal(capability.supportedEfforts.includes('low'), true);
  assert.equal(capability.effortMap.low, 'medium');
  assert.equal(capability.effortMap.high, 'high');
});

test('开关方言即使有目录 effort 元数据，也只开放关/开，不展示虚假中低档', () => {
  for (const [catalogProvider, model] of [
    ['volcengine', 'doubao-seed-1-6'],
    ['zhipuai', 'glm-5.2'],
  ] as const) {
    const capability = reasoningCapabilityForPreset(
      preset({
        model,
        catalogProvider,
        capabilities: {
          reasoning: true,
          reasoningOptions: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high'] }],
        },
      }),
    );
    assert.deepEqual(capability.supportedEfforts, ['off', 'high'], catalogProvider);
    assert.equal(capability.mode, 'toggle');
  }
});

test('Anthropic 旧协议输出上限不足时禁用思考；新版不受该预算限制', () => {
  const legacy = (maxTokens?: number) =>
    reasoningCapabilityForPreset(
      preset({
        provider: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        maxTokens,
      }),
    );
  assert.deepEqual(legacy(1024).supportedEfforts, ['off']);
  assert.equal(legacy(1024).requiresLargerOutput, true);
  assert.deepEqual(legacy(1025).supportedEfforts, ['off', 'low', 'medium', 'high']);
  assert.equal(legacy().requiresLargerOutput, undefined);

  const adaptive = reasoningCapabilityForPreset(
    preset({
      provider: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
    }),
  );
  assert.deepEqual(adaptive.supportedEfforts, ['off', 'low', 'medium', 'high']);
  assert.equal(adaptive.requiresLargerOutput, undefined);
});

test('未知端点未知模型不伪造档位；显式无思考能力也不可调', () => {
  const unknown = reasoningCapabilityForPreset(
    preset({
      model: 'mystery-model',
      catalogProvider: 'mystery',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
    }),
  );
  assert.deepEqual(unknown.supportedEfforts, []);
  assert.equal(unknown.mode, 'unknown');

  const unsupported = reasoningCapabilityForPreset(
    preset({
      model: 'mystery-model',
      capabilities: { reasoning: false },
    }),
  );
  assert.deepEqual(unsupported.supportedEfforts, []);
  assert.equal(unsupported.mode, 'unsupported');
});

test('预设读写保留目录元数据及未来字段，显式清空 maxTokens', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mocode-model-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'deepseek.json');
  writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ unused: true }));
  const normalized = normalizeWorkPresetDraft(
    preset({
      maxTokens: 32768,
      reasoningEffort: 'medium',
      catalogProvider: 'deepseek',
      catalogModel: 'deepseek-v4.1-flash',
      capabilities: { reasoning: true, reasoningOptions: [{ type: 'toggle' }] },
    }),
  );
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  writeWorkPreset(file, { name: 'deepseek', anthropicPromptCache: false, ...normalized.value });

  // 模拟同文件已有后续版本字段，编辑不能把它抹掉。
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw.futureField = { keep: true };
  writeFileSync(file, JSON.stringify(raw));
  const loaded = readWorkPreset(file);
  assert.ok(loaded);
  assert.equal(loaded.catalogProvider, 'deepseek');
  assert.equal(loaded.capabilities?.reasoning, true);
  assert.equal(loaded.maxTokens, 32768);
  writeWorkPreset(file, { ...loaded, maxTokens: undefined });
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(saved.futureField, { keep: true });
  assert.equal('maxTokens' in saved, false);
  assert.equal(saved.reasoningEffort, 'medium');
});

test('目录 prefill 携带上下文、输出上限、来源与 reasoning_options', () => {
  const providers: Record<string, CatalogProviderInfo> = {
    deepseek: {
      name: 'DeepSeek',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://api.deepseek.com/v1',
      env: [],
      models: {
        'deepseek-v4-flash': {
          reasoning: true,
          tool_call: true,
          reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
          limit: { context: 256000, output: 65536 },
        },
      },
    },
  };
  const result = buildCatalogPick(providers, 'deepseek', 'deepseek-v4-flash', {});
  assert.equal(result.ok, true);
  assert.equal(result.prefill?.contextWindow, 256000);
  assert.equal(result.prefill?.maxTokens, 65536);
  assert.equal(result.prefill?.catalogProvider, 'deepseek');
  assert.equal(result.prefill?.capabilities.reasoningOptions?.length, 2);
});
