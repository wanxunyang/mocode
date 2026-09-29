/**
 * 模型目录（models.dev）主进程侧支持 —— 与 core 的 src/models/catalog.ts / protocol.ts /
 * search.ts / map-preset.ts 同源同快照：
 *   - 共用同一个快照文件 ~/.mocode/catalog.json（mocode 终端 /model catalog refresh 写的
 *     就是它，work-app 刷新也会写它，两边互相受益）；
 *   - 协议判定 / baseURL 解析 / 预设名规整逻辑逐行对齐 core，保证 work-app 存出的预设
 *     与 mocode 终端存出的完全一致。
 * 仅在用户显式打开目录弹窗时联网，不随启动拉取。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CATALOG_URL = 'https://models.dev/api.json';
export const CATALOG_FETCH_TIMEOUT_MS = 10_000;

/** 上下文窗口缺失时的保守默认（与 core 的 FALLBACK_CONTEXT_WINDOW 一致）。 */
export const FALLBACK_CONTEXT_WINDOW = 128000;

// ── 目录数据模型（core types.ts 的子集，按字段名原样对齐 models.dev 上游）──

export interface CatalogModelInfo {
  id?: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  release_date?: string;
}

export interface CatalogProviderInfo {
  id?: string;
  name?: string;
  npm?: string;
  api?: string;
  env?: string[];
  doc?: string;
  models?: Record<string, CatalogModelInfo>;
}

export interface CatalogSnapshotInfo {
  fetchedAt: string;
  etag?: string;
  providers: Record<string, CatalogProviderInfo>;
}

export function catalogSnapshotPath(): string {
  return path.join(os.homedir(), '.mocode', 'catalog.json');
}

/** 读本地快照；不存在/损坏返回 null。 */
export function readCatalogSnapshot(snapshotPath = catalogSnapshotPath()): CatalogSnapshotInfo | null {
  try {
    const obj = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Partial<CatalogSnapshotInfo>;
    if (!obj.providers || typeof obj.providers !== 'object') return null;
    return obj as CatalogSnapshotInfo;
  } catch {
    return null;
  }
}

/** 原子写快照（tmp + rename），与 core 的 writeSnapshot 同策略。 */
function writeCatalogSnapshot(snapshot: CatalogSnapshotInfo, snapshotPath: string): void {
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const tmp = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
  renameSync(tmp, snapshotPath);
}

export type CatalogSource = 'live' | 'cache' | 'empty';

export interface CatalogRefreshResult {
  ok: boolean;
  source: CatalogSource;
  fetchedAt?: string;
  providers: Record<string, CatalogProviderInfo>;
  message?: string;
}

/**
 * 强制拉取最新目录。200 → live；304 → 复用快照；网络/解析失败 → 有快照用快照，否则 empty。
 * 与 core 的 refreshCatalog 行为一致（含 ETag 协商），快照互相通用。
 */
export async function refreshCatalog(snapshotPath = catalogSnapshotPath()): Promise<CatalogRefreshResult> {
  const cached = readCatalogSnapshot(snapshotPath);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  let res: Response;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CATALOG_FETCH_TIMEOUT_MS);
    res = await fetch(CATALOG_URL, { headers, signal: ac.signal }).finally(() => clearTimeout(timer));
  } catch {
    return cached
      ? { ok: true, source: 'cache', fetchedAt: cached.fetchedAt, providers: cached.providers }
      : { ok: false, source: 'empty', providers: {}, message: 'network unreachable' };
  }

  if (res.status === 304 && cached) {
    // 内容未变：仅续期 fetchedAt，providers 原样保留（与 core 一致）。
    const renewed: CatalogSnapshotInfo = { ...cached, fetchedAt: new Date().toISOString() };
    try { writeCatalogSnapshot(renewed, snapshotPath); } catch { /* 落盘失败不阻断 */ }
    return { ok: true, source: 'cache', fetchedAt: renewed.fetchedAt, providers: renewed.providers };
  }

  if (res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch {
      return cached
        ? { ok: true, source: 'cache', fetchedAt: cached.fetchedAt, providers: cached.providers }
        : { ok: false, source: 'empty', providers: {}, message: 'invalid json' };
    }
    // models.dev 直接以 provider id 为顶层键（无外层 providers 包裹）；兼容两种形态。
    const wrapped = (body as { providers?: unknown }).providers;
    const record: Record<string, CatalogProviderInfo> | null =
      wrapped && typeof wrapped === 'object'
        ? (wrapped as Record<string, CatalogProviderInfo>)
        : body && typeof body === 'object'
          ? (body as Record<string, CatalogProviderInfo>)
          : null;
    if (!record || !Object.keys(record).length) {
      return cached
        ? { ok: true, source: 'cache', fetchedAt: cached.fetchedAt, providers: cached.providers }
        : { ok: false, source: 'empty', providers: {}, message: 'unexpected payload' };
    }
    const etag = res.headers.get('etag') ?? cached?.etag ?? undefined;
    const snapshot: CatalogSnapshotInfo = {
      fetchedAt: new Date().toISOString(),
      ...(etag ? { etag } : {}),
      providers: record,
    };
    try { writeCatalogSnapshot(snapshot, snapshotPath); } catch { /* 落盘失败不阻断 */ }
    return { ok: true, source: 'live', fetchedAt: snapshot.fetchedAt, providers: record };
  }

  return cached
    ? { ok: true, source: 'cache', fetchedAt: cached.fetchedAt, providers: cached.providers }
    : { ok: false, source: 'empty', providers: {}, message: `http ${res.status}` };
}

// ── 协议判定（core src/models/protocol.ts 的移植）──

export type WorkProtocol = 'openai-chat' | 'anthropic-messages' | 'unsupported';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** 上游用 npm（Vercel AI SDK 包名）表达协议；只映射 work-app/host 支持的两条直发路径。 */
export function classifyProvider(provider: CatalogProviderInfo): WorkProtocol {
  switch (provider.npm) {
    case '@ai-sdk/anthropic':
      return 'anthropic-messages';
    case '@ai-sdk/openai-compatible':
      return provider.api && provider.api.trim() ? 'openai-chat' : 'unsupported';
    case '@ai-sdk/openai':
      return 'openai-chat';
    default:
      return 'unsupported';
  }
}

export function resolveBaseURL(provider: CatalogProviderInfo): string {
  if (provider.api && provider.api.trim()) return provider.api.trim();
  if (provider.npm === '@ai-sdk/openai') return OPENAI_DEFAULT_BASE_URL;
  if (provider.npm === '@ai-sdk/anthropic') return ANTHROPIC_DEFAULT_BASE_URL;
  return '';
}

function toPresetProvider(proto: WorkProtocol): 'openai' | 'anthropic' | null {
  if (proto === 'openai-chat') return 'openai';
  if (proto === 'anthropic-messages') return 'anthropic';
  return null;
}

// ── 浏览条目（core src/models/search.ts 的移植，只暴露可直发的）──

export interface CatalogEntryView {
  providerId: string;
  providerName: string;
  modelId: string;
  /** 目录里的展示名（可能缺省，回退 modelId）。 */
  name?: string;
  contextWindow: number;
  reasoning: boolean;
  toolCall: boolean;
  attachment: boolean;
  releaseDate?: string;
}

/** 拍平目录 → 只保留可直发条目，按厂商名 + 发布时间倒序（与 core 的排序一致）。 */
export function flattenSupportedEntries(providers: Record<string, CatalogProviderInfo>): CatalogEntryView[] {
  const out: CatalogEntryView[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (classifyProvider(provider) === 'unsupported') continue;
    const providerName = provider.name || providerId;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      out.push({
        providerId,
        providerName,
        modelId,
        ...(model.name ? { name: model.name } : {}),
        contextWindow:
          typeof model.limit?.context === 'number' && model.limit.context > 0
            ? Math.floor(model.limit.context)
            : FALLBACK_CONTEXT_WINDOW,
        reasoning: model.reasoning === true,
        toolCall: model.tool_call === true,
        attachment: model.attachment === true,
        ...(model.release_date ? { releaseDate: model.release_date } : {}),
      });
    }
  }
  return out.sort((a, b) => {
    const p = a.providerName.localeCompare(b.providerName);
    if (p !== 0) return p;
    return (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '');
  });
}

/** 多关键字（空格分隔）过滤：厂商名 / 厂商 id / 模型 id / 模型名 / family 全命中才算。 */
export function filterEntries(entries: CatalogEntryView[], query: string, providers: Record<string, CatalogProviderInfo>): CatalogEntryView[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const tokens = q.split(/\s+/);
  return entries.filter((e) => {
    const family = providers[e.providerId]?.models?.[e.modelId]?.family ?? '';
    const hay = [e.providerName, e.providerId, e.modelId, e.name ?? '', family].join(' ').toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

// ── 选中条目 → 预设草稿预填（core src/models/map-preset.ts 的移植）──

export interface CatalogPrefill {
  provider: 'openai' | 'anthropic';
  baseURL: string;
  model: string;
  contextWindow: number;
  anthropicPromptCache: boolean;
}

/** 目录来源拼合法预设名：`<provider>-<model>` 去非法字符（与 core 的 defaultPresetName 一致）。 */
export function defaultPresetName(providerId: string, modelId: string): string {
  const raw = `${providerId}-${modelId}`;
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'preset';
}

/** 按 provider.env 声明的变量名顺序找一个已设置的 key；都没有返回空串。 */
export function resolveApiKeySeed(provider: CatalogProviderInfo, env: NodeJS.ProcessEnv = process.env): string {
  for (const keyName of provider.env ?? []) {
    const v = env[keyName];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export interface CatalogPickResult {
  ok: boolean;
  message?: string;
  prefill?: CatalogPrefill;
  suggestedName?: string;
  providerName?: string;
  envKeys: string[];
  apiKeySeed: string;
}

/** 把目录 (providerId, modelId) 变成模型表单的预填草稿；协议不支持时 ok=false。 */
export function buildCatalogPick(
  providers: Record<string, CatalogProviderInfo>,
  providerId: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): CatalogPickResult {
  const provider = providers[providerId];
  const model = provider?.models?.[modelId];
  if (!provider || !model) {
    return { ok: false, message: 'not-found', envKeys: [], apiKeySeed: '' };
  }
  const presetProvider = toPresetProvider(classifyProvider(provider));
  const baseURL = resolveBaseURL(provider);
  if (!presetProvider || !baseURL) {
    return { ok: false, message: 'unsupported', envKeys: provider.env ?? [], apiKeySeed: '' };
  }
  const contextWindow =
    typeof model.limit?.context === 'number' && model.limit.context > 0
      ? Math.floor(model.limit.context)
      : FALLBACK_CONTEXT_WINDOW;
  return {
    ok: true,
    prefill: {
      provider: presetProvider,
      baseURL,
      model: modelId,
      contextWindow,
      anthropicPromptCache: presetProvider === 'anthropic',
    },
    suggestedName: defaultPresetName(providerId, modelId),
    providerName: provider.name || providerId,
    envKeys: provider.env ?? [],
    apiKeySeed: resolveApiKeySeed(provider, env),
  };
}

/** 目录是否已在本地就绪（有快照文件）。 */
export function hasCatalogSnapshot(): boolean {
  return existsSync(catalogSnapshotPath());
}
