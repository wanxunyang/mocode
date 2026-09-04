import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { jailResolve } from '../sandbox/jail.js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageAttachment {
  id: string;
  path: string;
  name: string;
  bytes: number;
  mime: ImageMime;
  dataUrl: string;
}

export const MAX_INLINE_BYTES_DEFAULT = 4 * 1024 * 1024;

const MIME_BY_EXT: Record<string, ImageMime> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function detectMime(p: string): ImageMime | null {
  return MIME_BY_EXT[extname(p).toLowerCase()] ?? null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderChip(att: ImageAttachment): string {
  return `📷 ${att.name} (${formatBytes(att.bytes)})`;
}

export type LoadImageResult = { ok: true; att: ImageAttachment } | { ok: false; reason: string };

export async function loadImageAttachment(input: string, opts: { maxBytes: number }): Promise<LoadImageResult> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: '路径为空' };

  const mime = detectMime(trimmed);
  if (!mime) {
    return { ok: false, reason: `unsupported: ${extname(trimmed) || '(无扩展名)'} — 仅支持 png/jpg/jpeg/gif/webp` };
  }

  let abs: string;
  try {
    abs = jailResolve(trimmed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `outside sandbox: ${msg}` };
  }

  let st;
  try {
    st = await stat(abs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `无法访问文件: ${msg}` };
  }
  if (!st.isFile()) return { ok: false, reason: '不是普通文件' };

  if (st.size > opts.maxBytes) {
    return {
      ok: false,
      reason: `too large: ${formatBytes(st.size)} (max ${formatBytes(opts.maxBytes)}) — TODO: URL upload not yet supported`,
    };
  }

  const buf = await readFile(abs);
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const id = createHash('sha1')
    .update(abs)
    .update('\0')
    .update(String(st.size))
    .update('\0')
    .update(String(st.mtimeMs))
    .digest('hex');

  return {
    ok: true,
    att: {
      id,
      path: abs,
      name: basename(abs),
      bytes: st.size,
      mime,
      dataUrl,
    },
  };
}
