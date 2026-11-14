import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { WorkAttachment, AttachmentResult } from './attachment-types.js';
export type { WorkAttachment, AttachmentResult } from './attachment-types.js';

/** 会话中的图片/文本 part → GUI 附件。附件正文不能混进用户消息气泡。 */
export function historyAttachments(content: unknown): WorkAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index): WorkAttachment[] => {
    if (!part) return [];
    const name = typeof part.name === 'string' && part.name ? part.name : `image-${index + 1}.png`;
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/'))
      return [{ name, dataUrl: part.image_url.url }];
    if (part.type !== 'text' || part.attachment !== true || typeof part.text !== 'string') return [];
    // host 在 session 中保存的是供模型使用的封装文本；重新生成必须还原原文，
    // 否则每回放一次就嵌套一层「用户附件…」，并可能因此突破 host 的 100k 限制。
    const header = `用户附件 ${JSON.stringify(name)} 的提取文本如下。`;
    const prefix = part.text.startsWith(`${header}（内容已截断，仅提供前 100000 字符）\n\n`)
      ? `${header}（内容已截断，仅提供前 100000 字符）\n\n`
      : part.text.startsWith(`${header}\n\n`) ? `${header}\n\n` : '';
    return [{ name, text: prefix ? part.text.slice(prefix.length) : part.text, truncated: part.truncated === true }];
  });
}

let parserRequire = createRequire(import.meta.url);
/** 打包后解析器在 resources/mocode-ai/node_modules；开发/测试默认从本包向上解析。 */
export function configureAttachmentModulePath(moduleRoot: string): void {
  parserRequire = createRequire(path.join(moduleRoot, 'noop.js'));
}

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_TEXT = 100_000;
export const TEXT_ATTACHMENT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'csv', 'tsv', 'log',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb',
  'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'swift', 'kt', 'kts', 'scala', 'lua', 'r',
  'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'ml', 'mli', 'clj', 'cljs', 'vue', 'svelte', 'astro', 'css', 'scss',
  'sass', 'less', 'ini', 'cfg', 'conf', 'env', 'properties', 'gradle', 'cmake', 'dockerfile', 'proto', 'graphql',
] as const;
export const ATTACHMENT_EXTENSIONS = [...TEXT_ATTACHMENT_EXTENSIONS, 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx'];
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const TEXT_EXTENSIONS = new Set<string>(TEXT_ATTACHMENT_EXTENSIONS);

/** 最多提取 300 页；大文档先读前 100k 字符，不能因读取上下文把主进程内存打满。 */
const MAX_PDF_PAGES = 300;
function boundedText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_ATTACHMENT_TEXT) return { text, truncated: false };
  let end = MAX_ATTACHMENT_TEXT;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

async function pdfText(data: Buffer): Promise<{ text: string; truncated: boolean }> {
  const { getDocument } = parserRequire('pdfjs-dist/legacy/build/pdf.js') as typeof import('pdfjs-dist');
  const loadingTask = getDocument({ data: new Uint8Array(data), verbosity: 0, isEvalSupported: false });
  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    const count = Math.min(document.numPages, MAX_PDF_PAGES);
    let textLength = 0;
    for (let number = 1; number <= count; number += 1) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const lines: string[] = [];
        let current = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          current += item.str;
          if (item.hasEOL) { lines.push(current); current = ''; }
        }
        if (current) lines.push(current);
        const pageText = lines.join('\n');
        pages.push(`[Page ${number}]\n${pageText}`);
        textLength += pageText.trim().length;
        if (textLength >= MAX_ATTACHMENT_TEXT) break;
      } finally { page.cleanup(); }
    }
    const text = pages.join('\n\n');
    // 页眉不算正文：扫描件/空白页必须交给调用方报 empty_text，而不是发送 "[Page 1]"。
    if (textLength === 0) return { text: '', truncated: false };
    // [Page N] 是给模型定位用的；预算检查要计入页眉，避免多页 PDF 绕过字符上限。
    const bounded = boundedText(text);
    return { ...bounded, truncated: bounded.truncated || count < document.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

export async function readAttachment(filePath: string): Promise<AttachmentResult> {
  const name = path.basename(filePath);
  const extension = path.extname(name).slice(1).toLowerCase();
  const imageMime = IMAGE_MIME[extension];
  if (!imageMime && !TEXT_EXTENSIONS.has(extension) && extension !== 'pdf' && extension !== 'docx')
    return { error: 'unsupported', name };
  let data: Buffer;
  try { data = await readFile(filePath); } catch { return { error: 'read_failed', name }; }
  if (data.byteLength > (imageMime ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES)) return { error: 'too_large', name };
  if (imageMime) return { attachment: { name, dataUrl: `data:${imageMime};base64,${data.toString('base64')}` } };
  let text: string;
  let parserTruncated = false;
  try {
    if (extension === 'pdf') {
      const parsed = await pdfText(data);
      text = parsed.text;
      parserTruncated = parsed.truncated;
    } else if (extension === 'docx') {
      const mammoth = parserRequire('mammoth') as typeof import('mammoth');
      text = (await mammoth.extractRawText({ buffer: data })).value;
    } else {
      // 非法 UTF-8 不能悄悄替换成 U+FFFD 后交给模型当作真实源码。
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    }
  } catch (error) {
    if (extension !== 'pdf' && extension !== 'docx' && error instanceof TypeError) return { error: 'invalid_utf8', name };
    return { error: 'read_failed', name };
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return { error: 'empty_text', name };
  const bounded = boundedText(text);
  return { attachment: { name, ...bounded, truncated: parserTruncated || bounded.truncated } };
}
