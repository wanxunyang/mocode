/** 模型命令交互重做：fuzzy-picker.filterItems + model-panel.buildPanelEntries 纯函数单测。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterItems } from '../src/ui/fuzzy-picker.js';
import { buildPanelEntries, isPresetCurrent, type PanelEntryView } from '../src/models/model-panel.js';
import type { ModelPreset } from '../src/config/presets.js';
import type { CatalogProvider } from '../src/models/types.js';
import type { CatalogEntry } from '../src/models/search.js';

// ── filterItems ───────────────────────────────────────
function item(value: number, searchText: string, label = searchText, disabled = false) {
  return { value, searchText, label, disabled };
}

test('filterItems: 空 query 保持原序；有 query 模糊过滤并按分排序', () => {
  const items = [item(1, 'glm-5v'), item(2, 'gpt-5'), item(3, 'glm flash')];
  assert.deepEqual(
    filterItems('', items).map((r) => r.item.value),
    [1, 2, 3],
  );

  const glm = filterItems('glm', items);
  assert.deepEqual(glm.map((r) => r.item.value).sort(), [1, 3]);
});

test('filterItems: 禁用项沉底且保留', () => {
  const items = [item(1, 'a', 'a', true), item(2, 'b'), item(3, 'a2')];
  const r = filterItems('', items);
  assert.deepEqual(
    r.map((x) => x.item.value),
    [2, 3, 1],
  ); // 禁用 1 在末
  const en = filterItems('a', items);
  // 匹配 a 的：启用 3 在前，禁用 1 在后。
  assert.deepEqual(
    en.map((x) => x.item.value),
    [3, 1],
  );
});

// ── buildPanelEntries ─────────────────────────────────
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

const presets = [
  preset({ name: 'other', model: 'gpt-5', baseURL: 'https://o/v1' }),
  preset({ name: 'mine', model: 'doubao', baseURL: 'https://ark/v3' }),
];

const providers: Record<string, CatalogProvider> = {
  zhipuai: {
    id: 'zhipuai',
    name: 'Zhipu AI',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://open.bigmodel.cn/api/paas/v4',
    models: {},
  },
  google: { id: 'google', name: 'Google', npm: '@ai-sdk/google', models: {} },
};

function catalogEntry(e: Partial<CatalogEntry> & Pick<CatalogEntry, 'providerId' | 'modelId'>): CatalogEntry {
  return {
    providerName: e.providerId,
    model: { id: e.modelId },
    supported: true,
    ...e,
  };
}

const catalog: CatalogEntry[] = [
  catalogEntry({
    providerId: 'zhipuai',
    modelId: 'glm-5v',
    model: {
      id: 'glm-5v',
      name: 'GLM-5V',
      reasoning: true,
      tool_call: true,
      limit: { context: 200000 },
      cost: { input: 0.7, output: 3 },
    },
  }),
  // 与预设 'mine' 同 baseURL+model → 去重
  catalogEntry({ providerId: 'mine-prov', modelId: 'doubao' }),
  // 不支持的 provider → 跳过
  catalogEntry({ providerId: 'google', modelId: 'gemini-x' }),
];

test('buildPanelEntries: 当前预设置顶★；目录去重、跳过不支持；含2个操作行', () => {
  const rows: PanelEntryView[] = buildPanelEntries({
    presets,
    providers,
    catalog,
    current: { provider: 'openai', baseURL: 'https://ark/v3', model: 'doubao', contextWindowTokens: 128000 },
  });

  // 第 1 行是当前预设 mine，带 ★。
  assert.equal(rows[0].choice.kind, 'preset');
  if (rows[0].choice.kind === 'preset') assert.equal(rows[0].choice.preset.name, 'mine');
  assert.ok(rows[0].label.startsWith('★ '));

  // 预设 other 紧随。
  assert.equal(rows[1].choice.kind, 'preset');

  // 目录只保留 glm-5v（doubao 去重、gemini 跳过）。
  const catRows = rows.filter((r) => r.choice.kind === 'catalog');
  assert.equal(catRows.length, 1);
  if (catRows[0].choice.kind === 'catalog') assert.equal(catRows[0].choice.entry.modelId, 'glm-5v');

  // 3 个操作行：custom / effort / refresh。
  const actions = rows.filter((r) => r.choice.kind === 'action');
  assert.deepEqual(
    actions.map((r) => (r.choice.kind === 'action' ? r.choice.action : null)),
    ['custom', 'refresh'],
  );
});

test('isPresetCurrent: 四元组全等才 true', () => {
  const cur = { provider: 'openai', baseURL: 'b', model: 'm', contextWindowTokens: 100 };
  assert.equal(isPresetCurrent(preset({ name: 'a', baseURL: 'b', model: 'm', contextWindow: 100 }), cur), true);
  assert.equal(isPresetCurrent(preset({ name: 'a', baseURL: 'b', model: 'm', contextWindow: 99 }), cur), false);
});
