/** buildModelTree 纯函数单测：厂商分组、预设归并、合成组、去重、操作行。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelTree, type BuildPanelInput, type ModelTreeNode } from '../src/models/model-panel.js';
import type { ModelPreset } from '../src/config/presets.js';
import type { CatalogProvider } from '../src/models/types.js';
import type { CatalogEntry } from '../src/models/search.js';

function preset(p: Partial<ModelPreset> & Pick<ModelPreset, 'name'>): ModelPreset {
  return {
    provider: 'openai',
    baseURL: 'https://x/v1',
    apiKey: 'k',
    model: 'm',
    contextWindow: 128000,
    anthropicPromptCache: false,
    ...p,
  };
}

function provider(id: string, api: string, modelIds: string[]): CatalogProvider {
  const models: CatalogProvider['models'] = {};
  for (const mid of modelIds) models[mid] = { id: mid, name: mid.toUpperCase() };
  return { id, name: id, npm: '@ai-sdk/openai-compatible', api, models };
}

function entry(providerId: string, providerName: string, modelId: string): CatalogEntry {
  return { providerId, providerName, modelId, model: { id: modelId }, supported: true };
}

function input(over: Partial<BuildPanelInput>): BuildPanelInput {
  return {
    presets: [],
    providers: {},
    catalog: [],
    current: { provider: 'openai', baseURL: '', model: '', contextWindowTokens: 0 },
    ...over,
  };
}

function branches(roots: ModelTreeNode[]): ModelTreeNode[] {
  return roots.filter((n) => n.children);
}
function actionLabels(roots: ModelTreeNode[]): string[] {
  return roots.filter((n) => !n.children).map((n) => n.label);
}

test('buildModelTree: root = 厂商组 + 2 个操作行', () => {
  const tree = buildModelTree(
    input({
      providers: { z: provider('z', 'https://z.test/v1', ['a', 'b']) },
      catalog: [entry('z', 'z', 'a'), entry('z', 'z', 'b')],
    }),
  );
  const grp = branches(tree);
  assert.equal(grp.length, 1);
  assert.equal(grp[0].label, 'z');
  assert.equal(grp[0].children!.length, 2);
  assert.deepEqual(actionLabels(tree), ['＋ 自定义模型（手动填写）', '⟳ 刷新模型目录']);
});

test('buildModelTree: 预设按 baseURL 归并到目录厂商', () => {
  const tree = buildModelTree(
    input({
      providers: { z: provider('z', 'https://z.test/v1', ['a']) },
      catalog: [entry('z', 'z', 'a')],
      presets: [preset({ name: 'mine', baseURL: 'https://z.test/v1', model: 'a' })],
      current: { provider: 'openai', baseURL: 'https://z.test/v1', model: 'a', contextWindowTokens: 128000 },
    }),
  );
  const grp = branches(tree)[0];
  // 预设与目录模型同名 a → 只留预设一条（★ 置顶），不重复。
  assert.equal(grp.children!.length, 1);
  assert.equal(grp.children![0].choice?.kind, 'preset');
  assert.ok(grp.children![0].label.startsWith('★ '));
});

test('buildModelTree: 预设端点无目录厂商 → 按 host 合成组', () => {
  const tree = buildModelTree(
    input({
      providers: { z: provider('z', 'https://z.test/v1', ['a']) },
      catalog: [entry('z', 'z', 'a')],
      presets: [preset({ name: 'lonely', baseURL: 'https://other.host/v3', model: 'x' })],
    }),
  );
  const grps = branches(tree);
  assert.equal(grps.length, 2);
  const synth = grps.find((g) => g.label === 'other.host');
  assert.ok(synth, '应合成 host 组');
  assert.equal(synth!.children!.length, 1);
  assert.equal(synth!.children![0].choice?.kind, 'preset');
});

test('buildModelTree: 不支持的厂商不进树', () => {
  const bad: CatalogProvider = {
    id: 'google',
    name: 'Google',
    npm: '@ai-sdk/google',
    models: { g: { id: 'g' } },
  };
  const tree = buildModelTree(
    input({
      providers: { google: bad },
      catalog: [{ providerId: 'google', providerName: 'Google', modelId: 'g', model: { id: 'g' }, supported: false }],
    }),
  );
  assert.equal(branches(tree).length, 0);
});
