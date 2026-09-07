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

/**
 * 从 dataUrl 里读出图片宽高(只解头部,不做完整解码)。
 *
 * 用途:视觉 token 估算 —— 图片 token 是按**像素面积**计费的(Claude 口径 ≈ w*h/750,
 * OpenAI 系按 512 tile 分块,同量级),不是每图 85。按 85 估会把一张 1568×878 的截图
 * (≈1835 token)低估 20 倍,后果是上下文压力线长期不触发、prompt 实际早就超了才 compact。
 */
export function imageSizeFromDataUrl(dataUrl: string): { width: number; height: number } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const isPng = meta.startsWith('image/png');
  const isJpeg = meta.startsWith('image/jpeg') || meta.startsWith('image/jpg');
  const isGif = meta.startsWith('image/gif');
  const isWebp = meta.startsWith('image/webp');
  if (!isPng && !isJpeg && !isGif && !isWebp) return null;
  // PNG IHDR 在头 33 字节内;JPEG 的 SOF 位置不定,gif/webp 头很小 —— 取 64KB 上界足够。
  const b64 = dataUrl.slice(comma + 1, comma + 1 + 65536);
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (isPng) {
    if (buf.length < 24) return null;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w && h ? { width: w, height: h } : null;
  }
  if (isGif) {
    if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
    const w = buf.readUInt16LE(6);
    const h = buf.readUInt16LE(8);
    return w && h ? { width: w, height: h } : null;
  }
  if (isWebp) {
    // VP8X(扩展)/VP8(无损外)/VP8L 三种容器,只解析最常见且便宜的两种,其余兜底。
    if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (buf.readUIntLE(24, 3) as number);
      const h = 1 + (buf.readUIntLE(27, 3) as number);
      return w > 1 && h > 1 ? { width: w, height: h } : null;
    }
    if (fourcc === 'VP8 ') {
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return w && h ? { width: w, height: h } : null;
    }
    return null;
  }
  // JPEG:扫 SOF0-SOF3/SOF5-SOF7/SOF9-SOF11/SOF13-SOF15
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return w && h ? { width: w, height: h } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
