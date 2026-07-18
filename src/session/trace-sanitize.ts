import { createHash } from 'node:crypto';

export interface SafeArgumentSummary {
  sha256: string;
  byteLength: number;
  keys: string[];
  parseable: boolean;
}

export function hashTraceValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Never persists argument values: only shape, size, and a one-way fingerprint. */
export function summarizeToolArguments(raw: string): SafeArgumentSummary {
  let keys: string[] = [];
  let parseable = false;
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    parseable = true;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      keys = Object.keys(parsed as Record<string, unknown>).sort();
    }
  } catch {
    // Invalid arguments are still fingerprinted without retaining their contents.
  }
  return {
    sha256: hashTraceValue(raw),
    byteLength: Buffer.byteLength(raw, 'utf8'),
    keys,
    parseable,
  };
}

/** Provider identity is deliberately reduced to a hostname; credentials/path/query are discarded. */
export function safeProviderId(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.toLowerCase() || 'custom';
  } catch {
    return 'custom';
  }
}
