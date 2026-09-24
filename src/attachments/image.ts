import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { jailResolve } from '../sandbox/jail.js';
import { decodePng, downscale, encodePng } from '../runtime/screen-pipeline.js';

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

/**
 * 按**魔数**判定图片类型(不看扩展名)。
 *
 * 为什么必须有这条:扩展名会说谎——`data.bin` 可能是 PNG,`notes.png` 也可能是文本。
 * read_file 要靠它决定「走文本行号分页」还是「走视觉通道」,判错的代价是把二进制
 * 当 UTF-8 解码(实测一张 42KB PNG 解码出 17862 个 U+FFFD,占 45%)灌进 history。
 */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 8) === 'PNG\r\n\x1a\n') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 6) === 'GIF87a') return 'image/gif';
  if (buf.length >= 6 && buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * 二进制嗅探:头部 4KB 含 C0 控制字符(NUL/BEL/ESC 等,放行 \t\n\r)即视为二进制。
 *
 * 与 grep 的 BINARY_PROBE_RE 同源同口径(集中在此,避免两处正则漂移):SQLite、压缩包、
 * 可执行文件、minified 数据 dump 都会命中。用途是让 read_file 明确拒绝并指路,
 * 而不是把乱码塞进上下文——那既烧 token 又让模型基于垃圾内容做判断。
 */
export const BINARY_PROBE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export function isProbablyBinary(head: Buffer | string): boolean {
  const sample = typeof head === 'string' ? head : head.toString('latin1');
  return BINARY_PROBE_RE.test(sample.slice(0, 4096));
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

/** 降采样兜底的长边上界:对齐主流视觉模型的原生分辨率(Claude 1568 / OpenAI 高分块同级)。 */
export const DOWNSCALE_MAX_EDGE = 1568;

export type LoadImageWithFallbackResult =
  | { ok: true; att: ImageAttachment; downscaledFrom?: { width: number; height: number } }
  | { ok: false; reason: string };

/**
 * 读图 + 超限自动降采样兜底。
 *
 * 为什么要兜底:4 MiB 内联上限对高 DPI 截图偏紧(一张 4K Retina PNG 轻松 5-8 MiB)。
 * 直接拒绝会逼模型去找压缩工具/改用户文件,而**服务端缩一下就能成功**。
 * screenshot 早有这条路径(screenshot.ts 的 FALLBACK_MAX_EDGE 分支),这里抽成共享 helper,
 * 让 read_file 图片通道(原 view_image,已并入)同样受益。
 *
 * 能力边界(诚实声明):`runtime/screen-pipeline.ts` 的 PNG 解码是手写的、只支持
 * **8-bit RGB/RGBA PNG**(项目刻意零原生图像依赖)。所以兜底只覆盖 PNG;
 * JPEG/WebP/GIF 超限仍然拒绝,reason 会写明这一点。
 */
export async function loadImageAttachmentWithDownscale(
  input: string,
  opts: { maxBytes: number; sniffedMime?: ImageMime | null },
): Promise<LoadImageWithFallbackResult> {
  const loaded = await loadImageAttachment(input, opts);
  if (loaded.ok) return loaded;

  // 只有「体积超限」这一种失败值得兜底:路径为空/扩展名不支持/沙箱越界/不是普通文件
  // 都是真错误,缩图解决不了,原样透出让调用方给出准确提示。
  if (!loaded.reason.startsWith('too large')) return loaded;

  const mime = detectMime(input) ?? opts.sniffedMime ?? null;
  if (mime !== 'image/png') {
    return {
      ok: false,
      reason: `${loaded.reason} — 自动降采样仅支持 PNG(零原生图像依赖);${extname(input)} 请先转成 PNG 或自行压缩后重试`,
    };
  }

  let abs: string;
  try {
    abs = jailResolve(input.trim());
  } catch (e) {
    return { ok: false, reason: `outside sandbox: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const png = decodePng(await readFile(abs));
    const { img } = downscale(png, DOWNSCALE_MAX_EDGE);
    const buf = encodePng(img);
    if (buf.length > opts.maxBytes) {
      return {
        ok: false,
        reason: `${loaded.reason} — 降采样到 ${img.width}×${img.height} 后仍有 ${formatBytes(buf.length)},超过 ${formatBytes(opts.maxBytes)}`,
      };
    }
    let st;
    try {
      st = await stat(abs);
    } catch {
      st = null;
    }
    const id = createHash('sha1')
      .update(abs)
      .update('\0downscaled')
      .update(String(img.width))
      .update('\0')
      .update(String(img.height))
      .update('\0')
      .update(String(st?.mtimeMs ?? 0))
      .digest('hex');
    return {
      ok: true,
      downscaledFrom: { width: png.width, height: png.height },
      att: {
        id,
        path: abs,
        name: basename(abs),
        bytes: buf.length,
        mime: 'image/png',
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${loaded.reason}(降采样兜底失败: ${message})` };
  }
}

export async function loadImageAttachment(
  input: string,
  opts: { maxBytes: number; sniffedMime?: ImageMime | null },
): Promise<LoadImageResult> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: '路径为空' };

  // 扩展名优先(便宜、无需读文件);不认识时用调用方给的魔数嗅探结果兜底 ——
  // read_file 读到的图片常常没有正确扩展名(截图缓存 / 构建产物 / 无扩展名 blob)。
  const mime = detectMime(trimmed) ?? opts.sniffedMime ?? null;
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
      reason: `too large: ${formatBytes(st.size)} (max ${formatBytes(opts.maxBytes)})`,
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
