/**
 * 统一模型面板的交互编排（#模型命令交互）：openModelPanel。
 *
 * 两级浏览：先列厂商，进入某厂商后再列其下模型/预设；搜索栏为作用域内过滤——
 * 顶层只按厂商名、厂商内只按模型名，不跨层混搜。思考强度统一在 /effort 设置，
 * 不放进模型面板。动作复用 model-actions.ts。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { promptHierarchicalPicker, type HPNode } from '../../ui/hierarchical-picker.js';
import { promptIntervention } from '../../ui/intervention.js';
import { loadCatalog } from '../../models/catalog.js';
import { flattenCatalog } from '../../models/search.js';
import { buildModelTree, type ModelTreeNode, type PanelChoice } from '../../models/model-panel.js';
import { config } from '../../config/index.js';
import { savePreset, type ModelPreset } from '../../config/presets.js';
import { applyPresetConfig, addCatalogModel, refreshAndReport } from './model-actions.js';
import type { CommandContext } from './types.js';

export type PanelOutcome = 'handled' | 'custom';

/**
 * 选中已存预设时确认 API key：回车沿用当前 key；粘贴新值则更新并写回预设文件。
 * 修复「预设里存着失效 key、重选同一模型又静默套用 → 401 死循环」——套用任何预设前
 * 都给一次改 key 的机会。取消返回 null。
 */
async function confirmPresetKey(preset: ModelPreset): Promise<ModelPreset | null> {
  const res = await promptIntervention({
    type: 'input',
    title: 'API Key',
    detail: `端点：${preset.baseURL}\n` + `回车沿用当前 key；认证失败时粘贴新 key（会一并写回预设 “${preset.name}”）。`,
    seed: preset.apiKey,
  });
  if (res.action === 'cancelled') return null;
  const v = (res.value ?? '').trim();
  if (!v || v === preset.apiKey) return preset;
  const updated: ModelPreset = { ...preset, apiKey: v };
  savePreset(updated);
  return updated;
}

/** 域模型树 → 层级选择器节点（叶子 value 为 PanelChoice）。 */
function toHPNode(node: ModelTreeNode): HPNode<PanelChoice> {
  const base: HPNode<PanelChoice> = {
    searchText: node.searchText,
    label: node.label,
    detail: node.detail,
  };
  if (node.children && node.children.length) {
    base.children = node.children.map(toHPNode);
  } else if (node.choice) {
    base.value = node.choice;
  }
  return base;
}

/**
 * 打开统一模型面板。
 * @returns 'custom' 表示用户选了「手动填写」，调用方回落到手填向导；其余均已处理。
 */
export async function openModelPanel(ctx: CommandContext): Promise<PanelOutcome> {
  // 目录：新鲜快照不联网；离线/无快照仍能列已存预设与操作行。
  const cat = await loadCatalog();
  const catalog = flattenCatalog(cat.providers);

  const tree = buildModelTree({
    presets: listAllPresets(),
    providers: cat.providers,
    catalog,
    current: {
      provider: config.provider,
      baseURL: config.baseURL,
      model: config.model,
      contextWindowTokens: config.contextWindowTokens,
    },
  });

  const srcTag = cat.source === 'empty' ? '无目录' : cat.source === 'live' ? '在线目录' : '目录快照';
  const picked = await promptHierarchicalPicker({
    title: `选择模型（${srcTag}）`,
    roots: tree.map(toHPNode),
    maxVisible: 12,
  });

  if (!picked) return 'handled'; // Esc：什么都不做

  switch (picked.kind) {
    case 'preset': {
      const confirmed = await confirmPresetKey(picked.preset);
      if (!confirmed) return 'handled';
      applyPresetConfig(ctx, confirmed);
      layout.contentWrite(`${ui.dim}(已切换 → ${confirmed.model})${ui.reset}\n`);
      return 'handled';
    }
    case 'catalog':
      await addCatalogModel(ctx, picked.entry, cat.providers);
      return 'handled';
    case 'action':
      if (picked.action === 'custom') return 'custom';
      if (picked.action === 'refresh') {
        await refreshAndReport();
        return 'handled';
      }
      return 'handled';
  }
}

// 延迟取预设列表，避免在模块顶部引入多余耦合。
import { listPresets } from '../../config/presets.js';
function listAllPresets() {
  return listPresets();
}
