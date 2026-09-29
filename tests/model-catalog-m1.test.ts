/** 模型目录 M1 单测：protocol / map-preset / catalog（注入假 fetch，不打真实网络）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyProvider,
  classifyModel,
  resolveBaseURL,
  resolveModelBaseURL,
  toPresetProvider,
  OPENAI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_BASE_URL,
  VERTEX_DEFAULT_BASE_URL,
} from '../src/models/protocol.js';
import { buildPreset, resolveApiKey, defaultPresetName, FALLBACK_CONTEXT_WINDOW } from '../src/models/map-preset.js';
import { loadCatalog, refreshCatalog, readSnapshot, isFresh, type FetchLike } from '../src/models/catalog.js';
import type { CatalogProvider } from '../src/models/types.js';

function provider(partial: Partial<CatalogProvider> & Pick<CatalogProvider, 'id'>): CatalogProvider {
  return { models: {}, ...partial };
}

// ── classifyProvider ──────────────────────────────────
test('classifyProvider: 四类协议判定', () => {
  assert.equal(classifyProvider(provider({ id: 'anthropic', npm: '@ai-sdk/anthropic' })), 'anthropic-messages');
  assert.equal(
    classifyProvider(provider({ id: 'zhipuai', npm: '@ai-sdk/openai-compatible', api: 'https://x/v1' })),
    'openai-chat',
  );
  assert.equal(classifyProvider(provider({ id: 'p', npm: '@ai-sdk/openai-compatible' })), 'unsupported');
  assert.equal(classifyProvider(provider({ id: 'openai', npm: '@ai-sdk/openai' })), 'openai-chat');
  assert.equal(classifyProvider(provider({ id: 'google', npm: '@ai-sdk/google' })), 'gemini-contents');
  assert.equal(classifyProvider(provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' })), 'gemini-contents');
});

test('classifyModel: 模型级覆盖优先于 provider 顶层协议', () => {
  const vertex = provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' });
  assert.equal(classifyModel(vertex, { id: 'gemini-x' }), 'gemini-contents');
  assert.equal(
    classifyModel(vertex, { id: 'claude', provider: { npm: '@ai-sdk/google-vertex/anthropic' } }),
    'unsupported',
  );
  assert.equal(
    classifyModel(vertex, {
      id: 'llama',
      provider: { npm: '@ai-sdk/openai-compatible', api: 'https://example.com/v1' },
    }),
    'openai-chat',
  );
  // models.dev 的 Vertex MaaS 模板含未展开变量，需要 project/ADC，不能按 Express API key 直发。
  assert.equal(
    classifyModel(vertex, {
      id: 'llama',
      provider: { npm: '@ai-sdk/openai-compatible', api: 'https://${GOOGLE_VERTEX_ENDPOINT}/v1' },
    }),
    'unsupported',
  );
});

test('resolveBaseURL / resolveModelBaseURL / toPresetProvider', () => {
  assert.equal(resolveBaseURL(provider({ id: 'openai', npm: '@ai-sdk/openai' })), OPENAI_DEFAULT_BASE_URL);
  assert.equal(
    resolveBaseURL(provider({ id: 'z', npm: '@ai-sdk/openai-compatible', api: ' https://a ' })),
    'https://a',
  );
  assert.equal(resolveBaseURL(provider({ id: 'google', npm: '@ai-sdk/google' })), GEMINI_DEFAULT_BASE_URL);
  assert.equal(
    resolveBaseURL(provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' })),
    VERTEX_DEFAULT_BASE_URL,
  );
  assert.equal(
    resolveBaseURL(provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' }), {
      GOOGLE_VERTEX_LOCATION: 'us-central1',
    } as NodeJS.ProcessEnv),
    'https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models',
  );
  // 未设置 GOOGLE_VERTEX_LOCATION → 全局 Express 端点（而非日本区域端点）。
  assert.equal(
    resolveBaseURL(provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' }), {}),
    VERTEX_DEFAULT_BASE_URL,
  );
  assert.equal(VERTEX_DEFAULT_BASE_URL, 'https://aiplatform.googleapis.com/v1/publishers/google/models');
  assert.equal(
    resolveModelBaseURL(provider({ id: 'p', npm: '@ai-sdk/openai-compatible' }), {
      provider: { api: 'https://m/v1' },
    }),
    'https://m/v1',
  );
  assert.equal(toPresetProvider('openai-chat'), 'openai');
  assert.equal(toPresetProvider('anthropic-messages'), 'anthropic');
  assert.equal(toPresetProvider('gemini-contents'), 'google');
  assert.equal(toPresetProvider('unsupported'), null);
});

// ── map-preset ────────────────────────────────────────
test('resolveApiKey: 按声明顺序取；Google 额外识别 API key 变量', () => {
  const p = provider({ id: 'z', env: ['ZHIPU_API_KEY', 'BACKUP_KEY'] });
  assert.equal(resolveApiKey(p, { BACKUP_KEY: 'sk-b' }), 'sk-b');
  assert.equal(resolveApiKey(p, {}), null);

  const vertex = provider({
    id: 'google-vertex',
    npm: '@ai-sdk/google-vertex',
    env: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'],
  });
  assert.equal(
    resolveApiKey(vertex, { GOOGLE_VERTEX_PROJECT: 'project', GOOGLE_CLOUD_API_KEY: 'google-key' }),
    'google-key',
  );
  assert.equal(resolveApiKey(vertex, { GOOGLE_VERTEX_PROJECT: 'project' }), null);
});

test('defaultPresetName: 去非法字符、截断', () => {
  assert.equal(defaultPresetName('zhipuai', 'glm-5v'), 'zhipuai-glm-5v');
  assert.equal(defaultPresetName('a.b/c', 'x y'), 'a-b-c-x-y');
  assert.ok(defaultPresetName('z', 'x').length <= 32);
});

test('buildPreset: 字段映射；窗口缺失回落；Google 端点正确', () => {
  const p = provider({
    id: 'zhipuai',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://open.bigmodel.cn/api/paas/v4',
  });
  const preset = buildPreset({
    provider: p,
    model: { id: 'glm-5v-turbo', limit: { context: 200000 } },
    apiKey: 'sk-z',
  });
  assert.deepEqual(preset, {
    name: 'zhipuai-glm-5v-turbo',
    provider: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'sk-z',
    model: 'glm-5v-turbo',
    contextWindow: 200000,
    anthropicPromptCache: false,
  });

  const fb = buildPreset({ provider: p, model: { id: 'm' }, apiKey: 'k' });
  assert.equal(fb?.contextWindow, FALLBACK_CONTEXT_WINDOW);

  const ov = buildPreset({ provider: p, model: { id: 'm' }, apiKey: 'k', modelOverride: 'ep-123' });
  assert.equal(ov?.model, 'ep-123');

  const ap = buildPreset({
    provider: provider({ id: 'anthropic', npm: '@ai-sdk/anthropic' }),
    model: { id: 'claude-x', limit: { context: 200000 } },
    apiKey: 'k',
  });
  assert.equal(ap?.provider, 'anthropic');
  assert.equal(ap?.anthropicPromptCache, true);

  const google = buildPreset({
    provider: provider({ id: 'google', npm: '@ai-sdk/google' }),
    model: { id: 'gemini-x', limit: { context: 1000000 } },
    apiKey: 'k',
  });
  assert.equal(google?.provider, 'google');
  assert.equal(google?.baseURL, GEMINI_DEFAULT_BASE_URL);

  const vertex = buildPreset({
    provider: provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' }),
    model: { id: 'gemini-x', limit: { context: 1000000 } },
    apiKey: 'k',
  });
  assert.equal(vertex?.baseURL, VERTEX_DEFAULT_BASE_URL);

  assert.equal(
    buildPreset({
      provider: provider({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' }),
      model: { id: 'claude', provider: { npm: '@ai-sdk/google-vertex/anthropic' } },
      apiKey: 'k',
    }),
    null,
  );
});

// ── catalog ───────────────────────────────────────────
function tmpSnapshotPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocat-'));
  return path.join(dir, 'catalog.json');
}

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}): FetchLike {
  return async () => ({
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  });
}

test('refreshCatalog: 200 解析落盘 (顶层键形态) + 记录 etag', async () => {
  const sp = tmpSnapshotPath();
  const body = { zhipuai: { id: 'zhipuai', npm: '@ai-sdk/openai-compatible', api: 'https://x/v1', models: {} } };
  const r = await refreshCatalog({ fetch: fakeFetch(200, body, { etag: '"v1"' }), snapshotPath: sp });
  assert.equal(r.source, 'live');
  assert.equal(r.etag, '"v1"');
  assert.ok(r.providers.zhipuai);
  const saved = readSnapshot(sp);
  assert.equal(saved?.etag, '"v1"');
});

test('refreshCatalog: 304 复用快照；网络失败回退快照；无快照 empty', async () => {
  const sp = tmpSnapshotPath();
  const body = { p: { id: 'p', npm: '@ai-sdk/openai-compatible', api: 'https://x', models: {} } };
  await refreshCatalog({ fetch: fakeFetch(200, body), snapshotPath: sp });

  const r304 = await refreshCatalog({ fetch: fakeFetch(304, {}), snapshotPath: sp });
  assert.equal(r304.source, 'cache');
  assert.ok(r304.providers.p);

  const boom: FetchLike = async () => {
    throw new Error('network down');
  };
  const rFail = await refreshCatalog({ fetch: boom, snapshotPath: sp });
  assert.equal(rFail.source, 'cache');
  assert.ok(rFail.providers.p);

  const rEmpty = await refreshCatalog({ fetch: boom, snapshotPath: tmpSnapshotPath() });
  assert.equal(rEmpty.source, 'empty');
});

test('loadCatalog: 快照新鲜不联网；过期才拉取；force 强拉', async () => {
  const sp = tmpSnapshotPath();
  const body = { p: { id: 'p', npm: '@ai-sdk/openai-compatible', api: 'https://x', models: {} } };
  await refreshCatalog({ fetch: fakeFetch(200, body), snapshotPath: sp });

  const boom: FetchLike = async () => {
    throw new Error('should not be called');
  };
  const r1 = await loadCatalog({ fetch: boom, snapshotPath: sp });
  assert.equal(r1.source, 'cache');

  const r2 = await loadCatalog({ fetch: fakeFetch(200, body), snapshotPath: sp, force: true });
  assert.equal(r2.source, 'live');
});

test('isFresh: TTL 判定', () => {
  const snap = { fetchedAt: new Date().toISOString(), providers: {} };
  assert.equal(isFresh(snap), true);
  const old = { fetchedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(), providers: {} };
  assert.equal(isFresh(old), false);
});
