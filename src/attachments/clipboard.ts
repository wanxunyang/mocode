/**
 * 剪贴板截图 → 待发附件的共享通道(Ctrl+Y 快捷键与 /image clip 命令共用)。
 *
 * 这里只负责"系统剪贴板字节 → ImageAttachment(含 4MiB 上限 / PNG 降采样)";
 * 入队去重、视觉能力警告、上屏反馈由调用方各自处理。
 */
import { config } from '../config/index.js';
import { readClipboardImage } from '../ui/clipboard.js';
import { buildImageAttachmentFromBuffer, MAX_INLINE_BYTES_DEFAULT, type ImageAttachment } from './image.js';

export type ClipboardImageResult =
  | { ok: true; att: ImageAttachment; downscaledFrom?: { width: number; height: number } }
  | { ok: false; reason: string }
  | { ok: false; empty: true };

export async function readClipboardAsAttachment(): Promise<ClipboardImageResult> {
  const buf = await readClipboardImage();
  if (!buf) return { ok: false, empty: true };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `clipboard-${ts}.png`;
  const r = buildImageAttachmentFromBuffer(buf, `clipboard:${ts}`, name, {
    maxBytes: config.maxImageBytes ?? MAX_INLINE_BYTES_DEFAULT,
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, att: r.att, downscaledFrom: r.downscaledFrom };
}
