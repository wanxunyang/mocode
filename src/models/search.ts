/**
 * 目录浏览的搜索 / 过滤 / 分组（#model-catalog M2）。纯函数，无 I/O。
 *
 * 上游有 8000+ 模型，浏览层只暴露 mocode 能直发的（classifyProvider 非 unsupported），
 * 不支持的项不进列表（而不是放进列表再置灰），减少干扰；需要时可显式 includeUnsupported。
 */
import type { CatalogModel, CatalogProvider } from './types.js';
import { classifyProvider } from './protocol.js';

export interface CatalogEntry {
  providerId: string;
  providerName: string;
  modelId: string;
  model: CatalogModel;
  supported: boolean;
}

export interface SearchFilters {
  /** 关键字：匹配 provider 名 / model id / model name / family（不区分大小写）。 */
  query?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
  /** true 时连 unsupported 也返回（默认只返回可直发）。 */
  includeUnsupported?: boolean;
}

/** 把目录拍平成条目列表。 */
export function flattenCatalog(providers: Record<string, CatalogProvider>): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    const supported = classifyProvider(provider) !== 'unsupported';
    const providerName = provider.name || providerId;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      out.push({ providerId, providerName, modelId, model, supported });
    }
  }
  return out;
}

/** 关键字过滤 + 能力过滤。 */
export function searchModels(providers: Record<string, CatalogProvider>, filters: SearchFilters = {}): CatalogEntry[] {
  const q = filters.query?.trim().toLowerCase();
  return flattenCatalog(providers)
    .filter((e) => {
      if (!filters.includeUnsupported && !e.supported) return false;
      if (filters.reasoning && !e.model.reasoning) return false;
      if (filters.toolCall && !e.model.tool_call) return false;
      if (filters.attachment && !e.model.attachment) return false;
      if (q) {
        const hay = [e.providerName, e.providerId, e.modelId, e.model.name ?? '', e.model.family ?? '']
          .join(' ')
          .toLowerCase();
        // 支持多关键字（空格分隔），全部命中才算。
        if (!q.split(/\s+/).every((tok) => hay.includes(tok))) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // 可直发优先；其次厂商名；再模型名（按发布时间倒序更适合挑新模型，但纯函数保持确定性）。
      if (a.supported !== b.supported) return a.supported ? -1 : 1;
      const p = a.providerName.localeCompare(b.providerName);
      if (p !== 0) return p;
      return (b.model.release_date ?? '').localeCompare(a.model.release_date ?? '');
    });
}

/** 按 provider 分组（保持组内顺序），供 UI 分区渲染。 */
export function groupByProvider(entries: CatalogEntry[]): Map<string, CatalogEntry[]> {
  const map = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.providerId);
    if (arr) arr.push(e);
    else map.set(e.providerId, [e]);
  }
  return map;
}
