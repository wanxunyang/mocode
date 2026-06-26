import { MAX_OUTPUT } from '../constants.js';
import type { Tool } from '../types.js';

const FETCH_TIMEOUT_MS = 30000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------- web_fetch ----------
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    '抓取指定 URL 的网页内容并清洗成纯文本(去 HTML 标签/脚本/样式,保留正文)。用于读取搜索结果里的某个链接、或用户给出的具体 URL。注意:只能抓静态 HTML,JS 渲染的页面(正文靠脚本填充)可能拿不到内容——那种情况改用 web_search(其结果自带清洗后的 content)。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整 URL,须 http/https' },
    },
    required: ['url'],
  },
  async execute(args) {
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) return '错误:url 不能为空。';

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return `错误:URL 不合法: ${rawUrl}`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `错误:仅支持 http/https,收到 ${url.protocol}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url.href, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*',
        },
        signal: ctrl.signal,
      });
      const contentType = resp.headers.get('content-type') ?? '';
      const text = await resp.text();

      if (!resp.ok) {
        return `错误:抓取失败 HTTP ${resp.status} ${resp.statusText}\n${text.slice(0, 500)}`;
      }

      const isHtml =
        /html/i.test(contentType) ||
        /^\s*<!doctype html/i.test(text) ||
        /<html[\s>]/i.test(text.slice(0, 1000));
      const body = isHtml ? htmlToText(text) : text;

      const ct = contentType.split(';')[0].trim();
      const prefix = `${url.href} (HTTP ${resp.status}${ct ? ', ' + ct : ''})\n\n`;
      let out = prefix + body;
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + `\n...(已截断,原文 ${body.length} 字符)`;
      }
      return out;
    } catch (e) {
      if (ctrl.signal.aborted) {
        return `错误:抓取超时(${FETCH_TIMEOUT_MS}ms): ${url.href}`;
      }
      const msg = e instanceof Error ? e.message : String(e);
      return `错误:抓取失败: ${msg}`;
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * 轻量 HTML→纯文本:优先取 <main>/<article> 正文区,再去 nav/header/footer/aside/form
 * 等非正文块与脚本样式,块级/列表标签转换行,去剩余标签,解码实体,压缩空白。
 * 不求精确解析,只取可读正文。
 */
function htmlToText(html: string): string {
  let s = html;
  // 优先正文区:有 <main>/<article> 就只取其内容,避开整页 nav/header/footer 噪音
  const main = s.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
  if (main) {
    s = main[0];
  } else {
    const art = s.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
    if (art) s = art[0];
  }
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  s = s.replace(/<header[\s\S]*?<\/header>/gi, '');
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  s = s.replace(/<form[\s\S]*?<\/form>/gi, '');
  s = s.replace(
    /<\/(p|div|li|tr|h[1-6]|section|article|header|footer|nav|aside|ul|ol|table|blockquote|pre|br)>/gi,
    '\n'
  );
  s = s.replace(/<br\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n[ \t]*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => safeFromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeFromCodePoint(parseInt(h, 16)));
}

function safeFromCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}
