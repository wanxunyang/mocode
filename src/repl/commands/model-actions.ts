/**
 * 模型命令的共享动作（#模型命令交互）：应用预设、添加目录模型、刷新目录。
 *
 * 从 model-catalog.ts 抽出，供「统一模型面板」与旧 /model browse 复用，避免第三处重复。
 * 纯编排：UI 走 promptIntervention，落盘走 presets/file，运行时切 config。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { config, updateModelConfig } from '../../config/index.js';
import { writeConfigKeys } from '../../config/file.js';
import { savePreset, setActivePresetName, type ModelPreset } from '../../config/presets.js';
import { reconfigureClient } from '../../llm/index.js';
import { promptIntervention } from '../../ui/intervention.js';
import { renderHistory } from '../message-format.js';
import { refreshCatalog } from '../../models/catalog.js';
import type { CatalogEntry } from '../../models/search.js';
import { buildPreset, defaultPresetName, resolveApiKey } from '../../models/map-preset.js';
import type { CommandContext } from './types.js';

/** 应用预设到 config + 落 config 文件 + 重建 client + 重显。 */
export function applyPresetConfig(ctx: CommandContext, p: ModelPreset): void {
  updateModelConfig({
    provider: p.provider,
    model: p.model,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    contextWindowTokens: p.contextWindow,
    anthropicPromptCache: p.anthropicPromptCache,
    ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
  });
  writeConfigKeys({
    LLM_PROVIDER: p.provider,
    LLM_BASE_URL: p.baseURL,
    LLM_API_KEY: p.apiKey,
    LLM_MODEL: p.model,
    CONTEXT_WINDOW_TOKENS: String(p.contextWindow),
    ANTHROPIC_PROMPT_CACHE: p.anthropicPromptCache ? 'true' : 'false',
  });
  reconfigureClient();
  ctx.refreshStatusBase(ctx.history);
  layout.clearContent();
  if (ctx.history.some((m) => m.role === 'user')) renderHistory(ctx.history);
  else layout.writeBanner(bannerLines(ctx.banner()));
}

/**
 * 把一个目录模型添加为预设并激活。
 * @returns 'added' 已切换；'cancelled' 用户中途取消。
 */
export async function addCatalogModel(
  ctx: CommandContext,
  entry: CatalogEntry,
  providers: Record<string, import('../../models/types.js').CatalogProvider>,
): Promise<'added' | 'cancelled'> {
  const catalogProvider = providers[entry.providerId];
  if (!catalogProvider) return 'cancelled';

  // key：无论环境变量是否找到，都弹一次确认——回车沿用预填值、粘贴即覆盖。
  const envName = catalogProvider.env?.[0] ?? 'API_KEY';
  const detectedKey = resolveApiKey(catalogProvider);
  const kres = await promptIntervention({
    type: 'input',
    title: `${envName}`,
    detail: detectedKey
      ? `已从环境变量 ${envName} 预填 key；回车沿用，或粘贴新 key 覆盖（仅存入本预设与配置文件）。`
      : `未在环境变量 ${envName} 找到 key；粘贴该厂商 key（仅存入本预设与配置文件）。`,
    seed: detectedKey ?? '',
  });
  if (kres.action === 'cancelled') return 'cancelled';
  const apiKey = (kres.value ?? '').trim();
  if (!apiKey) {
    layout.contentWrite(`${ui.yellow}未提供 key，已取消。${ui.reset}\n`);
    return 'cancelled';
  }

  const built = buildPreset({ provider: catalogProvider, model: entry.model, apiKey });
  if (!built) {
    layout.contentWrite(`${ui.yellow}该模型当前协议不支持直发。${ui.reset}\n`);
    return 'cancelled';
  }

  const nres = await promptIntervention({
    type: 'input',
    title: '预设名',
    detail: '回车用默认名；可改名。',
    seed: defaultPresetName(entry.providerId, entry.modelId),
  });
  if (nres.action === 'cancelled') return 'cancelled';
  built.name = (nres.value ?? '').trim() || built.name;

  const mres = await promptIntervention({
    type: 'input',
    title: '下发模型名',
    detail: `端点 ${built.baseURL}\n一般保持默认；厂商要求专用 ID（如火山 endpoint id）时在此修改。`,
    seed: built.model,
  });
  if (mres.action === 'cancelled') return 'cancelled';
  built.model = (mres.value ?? '').trim() || built.model;

  const preset: ModelPreset = {
    ...built,
    catalogProvider: entry.providerId,
    catalogModel: entry.modelId,
    capabilities: {
      ...(typeof entry.model.reasoning === 'boolean' ? { reasoning: entry.model.reasoning } : {}),
      ...(entry.model.reasoning_options ? { reasoningOptions: entry.model.reasoning_options } : {}),
      ...(typeof entry.model.tool_call === 'boolean' ? { toolCall: entry.model.tool_call } : {}),
      ...(typeof entry.model.attachment === 'boolean' ? { attachment: entry.model.attachment } : {}),
    },
    ...(entry.model.cost
      ? {
          pricing: {
            ...(typeof entry.model.cost.input === 'number' ? { input: entry.model.cost.input } : {}),
            ...(typeof entry.model.cost.output === 'number' ? { output: entry.model.cost.output } : {}),
            ...(typeof entry.model.cost.cache_read === 'number' ? { cacheRead: entry.model.cost.cache_read } : {}),
          },
        }
      : {}),
  };

  savePreset(preset);
  try {
    setActivePresetName(preset.name);
  } catch {
    /* 指针失败不阻断 */
  }
  applyPresetConfig(ctx, preset);

  layout.contentWrite(
    `${ui.dim}(已添加并切换 → ${preset.model} · ${preset.provider} @ ${preset.baseURL})${ui.reset}\n`,
  );
  layout.contentWrite(`${ui.dim}(已存为预设 “${preset.name}”)${ui.reset}\n`);
  return 'added';
}

/** 强制刷新目录并打印统计。 */
export async function refreshAndReport(): Promise<void> {
  const r = await refreshCatalog();
  const n = Object.values(r.providers).reduce((acc, p) => acc + Object.keys(p.models ?? {}).length, 0);
  if (r.source === 'empty') {
    layout.contentWrite(`${ui.yellow}刷新失败且无本地快照。${ui.reset}\n`);
  } else {
    const tag = r.source === 'live' ? '已更新' : '离线，使用快照';
    layout.contentWrite(
      `${ui.dim}模型目录${tag}：${Object.keys(r.providers).length} 厂商 / ${n} 模型（${r.fetchedAt?.slice(0, 10)}）${ui.reset}\n`,
    );
  }
}

export { config };
