/**
 * 统一模型面板的候选聚合（#模型命令交互）。纯函数，无 I/O。
 *
 * 一个列表里同时放：已保存预设（★ 当前）＋ 目录里可直发的模型 ＋ 操作行。
 * 去重规则：目录模型若与某个已存预设「同 baseURL + 同 model」就不再单列（预设优先），
 * 避免同一条出现两次。
 */
import type { ModelPreset } from '../config/presets.js';
import type { CatalogProvider } from './types.js';
import { classifyProvider, resolveBaseURL } from './protocol.js';
import type { CatalogEntry } from './search.js';

export type PanelChoice =
  | { kind: 'preset'; preset: ModelPreset }
  | { kind: 'catalog'; entry: CatalogEntry }
  | { kind: 'action'; action: ModelPanelAction };

export type ModelPanelAction = 'custom' | 'refresh';

export interface PanelEntryView {
  choice: PanelChoice;
  searchText: string;
  label: string;
  detail: string;
}

function fmtK(n: number | undefined): string {
  if (!n || n <= 0) return '-';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** 该预设是否与当前生效配置一致（用于标 ★）。 */
export function isPresetCurrent(
  p: ModelPreset,
  cur: { provider: string; baseURL: string; model: string; contextWindowTokens: number },
): boolean {
  return (
    p.provider === cur.provider &&
    p.baseURL === cur.baseURL &&
    p.model === cur.model &&
    p.contextWindow === cur.contextWindowTokens
  );
}

export interface BuildPanelInput {
  presets: ModelPreset[];
  providers: Record<string, CatalogProvider>;
  /** flattenCatalog 的结果（含 supported 标记）；只取 supported。 */
  catalog: CatalogEntry[];
  current: { provider: string; baseURL: string; model: string; contextWindowTokens: number };
}

/** 组装统一面板的全部行（顺序：当前预设 → 其他预设 → 目录模型 → 操作行）。 */
export function buildPanelEntries(input: BuildPanelInput): PanelEntryView[] {
  const rows: PanelEntryView[] = [];

  // 已存预设：当前的排最前。
  const withCurrent = input.presets.map((p) => ({
    p,
    cur: isPresetCurrent(p, input.current),
  }));
  withCurrent.sort((a, b) => Number(b.cur) - Number(a.cur) || a.p.name.localeCompare(b.p.name));
  for (const { p, cur } of withCurrent) {
    rows.push({
      choice: { kind: 'preset', preset: p },
      searchText: `${p.name} ${p.model} ${p.baseURL} ${p.provider}`,
      label: `${cur ? '★ ' : ''}${p.name}`,
      detail: `${p.model} · ${p.provider}`,
    });
  }

  // 目录模型：跳过不支持的、以及与某预设重复的。
  const presetKeys = new Set(input.presets.map((p) => `${p.baseURL}|${p.model}`));
  for (const e of input.catalog) {
    if (!e.supported) continue;
    const provider = input.providers[e.providerId];
    if (!provider) continue;
    if (classifyProvider(provider) === 'unsupported') continue;
    if (presetKeys.has(`${provider.api ?? ''}|${e.modelId}`)) continue;
    const c = e.model.cost;
    const caps = [e.model.reasoning ? '思考' : '', e.model.tool_call ? '工具' : '', e.model.attachment ? '多模态' : '']
      .filter(Boolean)
      .join('·');
    rows.push({
      choice: { kind: 'catalog', entry: e },
      searchText: `${e.model.name ?? ''} ${e.modelId}`,
      label: e.model.name || e.modelId,
      detail: [
        e.providerName,
        `${fmtK(e.model.limit?.context)} ctx`,
        c ? `$${c.input ?? 0}/$${c.output ?? 0}` : '',
        caps,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }

  // 操作行。
  rows.push({
    choice: { kind: 'action', action: 'custom' },
    searchText: '自定义 手动填写 custom baseURL model key',
    label: '＋ 自定义模型（手动填写）',
    detail: '',
  });
  rows.push({
    choice: { kind: 'action', action: 'refresh' },
    searchText: '刷新模型目录 refresh catalog 更新',
    label: '⟳ 刷新模型目录',
    detail: '',
  });

  return rows;
}

// ── 两级树（厂商 → 模型）────────────────────────────────

/** 树节点：分支（厂商组）与叶子（可选模型/操作行）共用同一形状。 */
export interface ModelTreeNode {
  searchText: string;
  label: string;
  detail: string;
  /** 叶子：确认后交给面板处理；分支为 undefined。 */
  choice?: PanelChoice;
  /** 分支：该厂商下的模型/预设。 */
  children?: ModelTreeNode[];
}

/** 归一化端点为归并键：小写 host + 去尾斜杠的 path，使预设 baseURL 与目录 api 对齐。 */
function endpointKey(raw: string): string {
  const v = raw.trim();
  try {
    const u = new URL(v);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return v.replace(/\/+$/, '').toLowerCase();
  }
}

/** 从 URL 取 host 作合成组名；失败回退整串。 */
function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).host;
  } catch {
    return raw.trim();
  }
}

interface GroupAcc {
  label: string;
  key: string;
  /** 目录 provider id；合成组为 null。 */
  providerId: string | null;
  presetLeaves: { node: ModelTreeNode; model: string; cur: boolean }[];
  catalogLeaves: ModelTreeNode[];
  /** 已加入的目录模型 id，组内去重。 */
  seenModels: Set<string>;
  searchText: string;
}

function presetLeaf(p: ModelPreset, cur: boolean): ModelTreeNode {
  return {
    choice: { kind: 'preset', preset: p },
    searchText: `${p.model}`,
    label: `${cur ? '★ ' : ''}${p.name}`,
    detail: `${p.model} · ${p.provider}`,
  };
}

function catalogLeaf(e: CatalogEntry): ModelTreeNode {
  const c = e.model.cost;
  const caps = [e.model.reasoning ? '思考' : '', e.model.tool_call ? '工具' : '', e.model.attachment ? '多模态' : '']
    .filter(Boolean)
    .join('·');
  return {
    choice: { kind: 'catalog', entry: e },
    searchText: `${e.model.name ?? ''} ${e.modelId}`,
    label: e.model.name || e.modelId,
    detail: [e.providerName, `${fmtK(e.model.limit?.context)} ctx`, c ? `$${c.input ?? 0}/$${c.output ?? 0}` : '', caps]
      .filter(Boolean)
      .join(' · '),
  };
}

function actionLeaf(action: ModelPanelAction): ModelTreeNode {
  if (action === 'custom') {
    return {
      choice: { kind: 'action', action },
      searchText: '自定义 手动填写 custom baseURL model key',
      label: '＋ 自定义模型（手动填写）',
      detail: '',
    };
  }
  return {
    choice: { kind: 'action', action },
    searchText: '刷新模型目录 refresh catalog 更新',
    label: '⟳ 刷新模型目录',
    detail: '',
  };
}

/**
 * 组装两级模型树：root = 厂商组 + 操作行；每个厂商组内 = 当前预设★ → 其他预设 → 目录模型。
 *
 * 归并规则：预设按 baseURL 归并到「端点相同」的目录厂商；目录里没有的端点按 URL host
 * 合成一个组。目录模型与预设同 model 名时不重复列（预设优先）。无 I/O。
 */
export function buildModelTree(input: BuildPanelInput): ModelTreeNode[] {
  const groups: GroupAcc[] = [];
  const byKey = new Map<string, GroupAcc>();

  // 1) 目录厂商：仅可直发且有模型的。
  for (const [providerId, provider] of Object.entries(input.providers)) {
    if (classifyProvider(provider) === 'unsupported') continue;
    const endpoint = resolveBaseURL(provider);
    if (!endpoint) continue;
    if (Object.keys(provider.models ?? {}).length === 0) continue;
    const label = provider.name || providerId;
    const g: GroupAcc = {
      label,
      key: endpointKey(endpoint),
      providerId,
      presetLeaves: [],
      catalogLeaves: [],
      seenModels: new Set(),
      searchText: `${label} ${providerId}`,
    };
    groups.push(g);
    if (!byKey.has(g.key)) byKey.set(g.key, g);

    for (const e of input.catalog) {
      if (!e.supported || e.providerId !== providerId) continue;
      if (g.seenModels.has(e.modelId)) continue;
      g.seenModels.add(e.modelId);
      g.catalogLeaves.push(catalogLeaf(e));
    }
  }

  // 2) 预设归并：端点命中目录厂商 → 进该组；否则进/建合成组。
  for (const p of input.presets) {
    const cur = isPresetCurrent(p, input.current);
    const key = endpointKey(p.baseURL);
    let g = byKey.get(key);
    if (!g) {
      g = {
        label: hostOf(p.baseURL) || p.baseURL,
        key,
        providerId: null,
        presetLeaves: [],
        catalogLeaves: [],
        seenModels: new Set(),
        searchText: `${hostOf(p.baseURL)}`,
      };
      groups.push(g);
      byKey.set(key, g);
    }
    g.presetLeaves.push({ node: presetLeaf(p, cur), model: p.model, cur });
  }

  // 3) 组内：当前预设 → 其他预设 → 目录模型（跳过与预设同名的）；空组不列。
  const roots: ModelTreeNode[] = [];
  for (const g of groups) {
    const presetModelNames = new Set(g.presetLeaves.map((x) => x.model));
    g.presetLeaves.sort((a, b) => Number(b.cur) - Number(a.cur));
    const children: ModelTreeNode[] = [
      ...g.presetLeaves.map((x) => x.node),
      ...g.catalogLeaves.filter((leaf) => {
        const e = leaf.choice;
        return !(e?.kind === 'catalog' && presetModelNames.has(e.entry.modelId));
      }),
    ];
    if (children.length === 0) continue;
    roots.push({
      searchText: g.searchText,
      label: g.label,
      detail: `${children.length} 个模型`,
      children,
    });
  }

  // 目录厂商在前，合成组在后；各自按名排序。
  roots.sort((a, b) => {
    const ga = groups.find((g) => g.label === a.label && g.searchText === a.searchText);
    const gb = groups.find((g) => g.label === b.label && g.searchText === b.searchText);
    const sa = ga?.providerId ? 0 : 1;
    const sb = gb?.providerId ? 0 : 1;
    return sa - sb || a.label.localeCompare(b.label);
  });

  // 4) 操作行固定在 root 末尾。
  roots.push(actionLeaf('custom'));
  roots.push(actionLeaf('refresh'));

  return roots;
}
