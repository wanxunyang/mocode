import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_VERSION = 1;
const EWMA_ALPHA = 0.2;
const MIN_CORRECTION = 0.5;
const MAX_CORRECTION = 2;
const MAX_ENTRIES = 64;

interface CalibrationEntry {
  correction: number;
  samples: number;
  updatedAt: number;
}

interface CalibrationCache {
  version: number;
  entries: Record<string, CalibrationEntry>;
}

export interface TokenCalibration {
  correction: number;
  samples: number;
}

let cache: CalibrationCache | undefined;
const toolFingerprints = new WeakMap<object, string>();

function cachePath(): string {
  return process.env.MOCODE_TOKEN_CALIBRATION_CACHE || path.join(os.homedir(), '.mocode', 'token-calibration.json');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toolFingerprint(tools: readonly unknown[]): string {
  const objectKey = tools as object;
  const hit = toolFingerprints.get(objectKey);
  if (hit) return hit;
  const fingerprint = hash(JSON.stringify(tools));
  toolFingerprints.set(objectKey, fingerprint);
  return fingerprint;
}

function calibrationKey(baseURL: string, model: string, tools: readonly unknown[]): string {
  // 只把摘要写盘，避免 URL 中偶然携带的凭据出现在缓存文件。
  return hash(`${baseURL}\0${model}\0${toolFingerprint(tools)}`);
}

function readCache(): CalibrationCache {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as CalibrationCache;
    if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      cache = parsed;
      return cache;
    }
  } catch {
    // 不存在或损坏都从空缓存开始；校准是增强能力，不能阻断请求。
  }
  cache = { version: CACHE_VERSION, entries: {} };
  return cache;
}

function writeCache(): void {
  if (!cache) return;
  try {
    const entries = Object.entries(cache.entries)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ENTRIES);
    cache.entries = Object.fromEntries(entries);
    const target = cachePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // 只影响跨进程复用；当前进程仍继续使用内存中的校准值。
  }
}

function validEntry(entry: CalibrationEntry | undefined): entry is CalibrationEntry {
  return (
    !!entry &&
    Number.isFinite(entry.correction) &&
    entry.correction >= MIN_CORRECTION &&
    entry.correction <= MAX_CORRECTION &&
    Number.isInteger(entry.samples) &&
    entry.samples > 0
  );
}

/** 读取指定 provider/model/工具集合的历史校准；未命中时退回 1。 */
export function getTokenCalibration(baseURL: string, model: string, tools: readonly unknown[]): TokenCalibration {
  const entry = readCache().entries[calibrationKey(baseURL, model, tools)];
  return validEntry(entry) ? { correction: entry.correction, samples: entry.samples } : { correction: 1, samples: 0 };
}

/** 用一次真实 prompt usage 更新 EWMA；只落比例和样本数，不保存任何消息内容。 */
export function updateTokenCalibration(
  baseURL: string,
  model: string,
  tools: readonly unknown[],
  estimatedTokens: number,
  actualTokens: number,
): TokenCalibration {
  if (
    estimatedTokens <= 100 ||
    actualTokens <= 100 ||
    !Number.isFinite(estimatedTokens) ||
    !Number.isFinite(actualTokens)
  ) {
    return getTokenCalibration(baseURL, model, tools);
  }

  const key = calibrationKey(baseURL, model, tools);
  const store = readCache();
  const previous = store.entries[key];
  const raw = Math.max(MIN_CORRECTION, Math.min(MAX_CORRECTION, actualTokens / estimatedTokens));
  const correction = validEntry(previous) ? previous.correction * (1 - EWMA_ALPHA) + raw * EWMA_ALPHA : raw;
  const next: CalibrationEntry = {
    correction,
    samples: validEntry(previous) ? previous.samples + 1 : 1,
    updatedAt: Date.now(),
  };
  store.entries[key] = next;
  writeCache();
  return { correction: next.correction, samples: next.samples };
}
