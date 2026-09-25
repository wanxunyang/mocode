/**
 * models.dev 目录的拉取 / ETag 协商 / 快照落盘 / 离线回退（#model-catalog M1）。
 *
 * 仅在用户显式命令时调用，不随启动或每轮联网。fetch 与快照路径均可注入，便于单测
 * （不打真实 models.dev）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogProvider, CatalogSnapshot, LoadedCatalog } from './types.js';

export const CATALOG_URL = 'https://models.dev/api.json';
export const CATALOG_SNAPSHOT_PATH = path.join(os.homedir(), '.mocode', 'catalog.json');

/** 默认快照新鲜期（小时）；MOCODE_CATALOG_TTL_HOURS 可覆盖。 */
export const DEFAULT_TTL_HOURS = 24;
/** 拉取超时（毫秒）。 */
export const FETCH_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResultLike>;

export interface FetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchResultLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

function ttlHours(): number {
  const v = Number(process.env.MOCODE_CATALOG_TTL_HOURS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_HOURS;
}

/** 读本地快照；不存在/损坏返回 null。路径可注入（测试用临时 HOME）。 */
export function readSnapshot(snapshotPath = CATALOG_SNAPSHOT_PATH): CatalogSnapshot | null {
  try {
    const obj = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Partial<CatalogSnapshot>;
    if (!obj.providers || typeof obj.providers !== 'object') return null;
    return obj as CatalogSnapshot;
  } catch {
    return null;
  }
}

/** 写快照（原子：tmp + rename）。 */
export function writeSnapshot(snapshot: CatalogSnapshot, snapshotPath = CATALOG_SNAPSHOT_PATH): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const tmp = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
  fs.renameSync(tmp, snapshotPath);
}

/** 快照是否仍在 TTL 内。 */
export function isFresh(snapshot: CatalogSnapshot, now: Date = new Date()): boolean {
  const fetched = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  return now.getTime() - fetched < ttlHours() * 3600 * 1000;
}

function fetchWithTimeout(fetchImpl: FetchLike, init: FetchInit): Promise<FetchResultLike> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetchImpl(CATALOG_URL, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

function emptyCatalog(source: 'empty' | 'cache', snapshot?: CatalogSnapshot | null): LoadedCatalog {
  return {
    providers: snapshot?.providers ?? {},
    source,
    fetchedAt: snapshot?.fetchedAt,
    etag: snapshot?.etag,
  };
}

export interface RefreshOptions {
  fetch?: FetchLike;
  snapshotPath?: string;
}

/**
 * 强制拉取最新目录。
 * - 200：解析 + 落盘，source='live'
 * - 304：复用本地快照（仅刷新 fetchedAt/etag 不强制），source='cache'
 * - 网络/解析失败：有快照回退快照(source='cache')，否则 source='empty'
 */
export async function refreshCatalog(opts: RefreshOptions = {}): Promise<LoadedCatalog> {
  const fetchImpl: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike).bind(globalThis);
  const snapshotPath = opts.snapshotPath ?? CATALOG_SNAPSHOT_PATH;
  const cached = readSnapshot(snapshotPath);

  let res: FetchResultLike;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    res = await fetchWithTimeout(fetchImpl, { headers });
  } catch {
    return cached ? emptyCatalog('cache', cached) : emptyCatalog('empty');
  }

  if (res.status === 304 && cached) {
    // 内容未变：更新 fetchedAt 表示「刚确认仍最新」，保留原 providers。
    const renewed: CatalogSnapshot = { ...cached, fetchedAt: new Date().toISOString() };
    writeSnapshot(renewed, snapshotPath);
    return {
      providers: renewed.providers,
      source: 'cache',
      fetchedAt: renewed.fetchedAt,
      etag: renewed.etag,
    };
  }

  if (res.status >= 200 && res.status < 300) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return cached ? emptyCatalog('cache', cached) : emptyCatalog('empty');
    }
    const providers = (body as { providers?: Record<string, CatalogProvider> }).providers;
    // models.dev 直接以 provider id 为顶层键（无外层 providers 包裹）；兼容两种形态。
    const record: Record<string, CatalogProvider> =
      providers && typeof providers === 'object' ? providers : (body as Record<string, CatalogProvider>);
    if (!record || typeof record !== 'object') {
      return cached ? emptyCatalog('cache', cached) : emptyCatalog('empty');
    }
    const etag = res.headers.get('etag') ?? cached?.etag ?? undefined;
    const snapshot: CatalogSnapshot = {
      fetchedAt: new Date().toISOString(),
      ...(etag ? { etag } : {}),
      providers: record,
    };
    writeSnapshot(snapshot, snapshotPath);
    return {
      providers: record,
      source: 'live',
      fetchedAt: snapshot.fetchedAt,
      ...(etag ? { etag } : {}),
    };
  }

  return cached ? emptyCatalog('cache', cached) : emptyCatalog('empty');
}

export interface LoadOptions extends RefreshOptions {
  /** true = 跳过 TTL，强制拉取（等价 refreshCatalog）。 */
  force?: boolean;
  now?: Date;
}

/**
 * 命令入口：快照新鲜直接用快照（不联网）；过期或 force 才拉取。
 */
export async function loadCatalog(opts: LoadOptions = {}): Promise<LoadedCatalog> {
  const snapshotPath = opts.snapshotPath ?? CATALOG_SNAPSHOT_PATH;
  const cached = readSnapshot(snapshotPath);
  if (!opts.force && cached && isFresh(cached, opts.now)) {
    return { providers: cached.providers, source: 'cache', fetchedAt: cached.fetchedAt, etag: cached.etag };
  }
  return refreshCatalog({ fetch: opts.fetch, snapshotPath });
}
