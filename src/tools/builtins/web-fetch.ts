import { MAX_OUTPUT } from '../constants.js';
import type { Tool, ToolOutcome } from '../types.js';

const FETCH_TIMEOUT_MS = 30000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * 浏览器拟真头集合。
 *
 * 只带 UA 挡不住主流反爬:Cloudflare/DataDome 类盾检查 Sec-Fetch-* / Accept-Language 的
 * 组合一致性(真浏览器必带,裸 fetch 必缺)。缺头是 roman.pt / nader.substack.com 403
 * 而 flaviocopes(无盾)成功的直接原因。补全成本为零,收益是把一批「看起来像脚本」的
 * 请求拉回「看起来像浏览器」。
 */
function browserHeaders(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    // sec-ch-ua 是 Chrome 的 client hints:与 UA 里的 Chrome/120 对齐,不一致反而更可疑。
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    // 同源直访不带 Referer;跨域跳转场景由调用方语义决定,这里保持「直接导航」画像。
    'Cache-Control': 'no-cache',
  };
}

/**
 * 纯文本代理回退(opt-in,默认关)。
 *
 * MOCODE_WEB_FETCH_PROXY 设为前缀型代理(如 `https://r.jina.ai/`),直连失败且疑似被盾拦截时
 * 改走 `${PROXY}${原 URL}`。为什么默认关:把目标 URL 交给第三方是隐私/信任决策,必须由用户
 * 显式打开,agent 不能替用户把浏览足迹外包出去。
 */
function proxyPrefix(): string | null {
  const raw = (process.env.MOCODE_WEB_FETCH_PROXY ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
  } catch {
    return null;
  }
}

/** 疑似反爬拦截:这些状态码重试直连基本无望,值得走代理(若配置)。 */
function isBlockedStatus(status: number): boolean {
  return status === 403 || status === 405 || status === 406 || status === 429 || status === 451 || status === 503;
}

/** 单次 GET(直连或经代理),返回归一化结果。 */
interface FetchAttempt {
  ok: boolean;
  status: number;
  statusText: string;
  contentType: string;
  text: string;
  via: 'direct' | 'proxy';
  error?: string;
  timedOut?: boolean;
  networkError?: boolean;
}

async function attemptFetch(target: string, via: FetchAttempt['via'], signal: AbortSignal): Promise<FetchAttempt> {
  try {
    const resp = await fetch(target, { method: 'GET', headers: browserHeaders(), signal });
    const contentType = resp.headers.get('content-type') ?? '';
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, contentType, text, via };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      statusText: '',
      contentType: '',
      text: '',
      via,
      error: msg,
      timedOut: signal.aborted,
      networkError: !signal.aborted,
    };
  }
}

// ---------- web_fetch ----------
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a URL and clean HTML to body text. Use to read a link from search results or a URL given by the user.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to fetch; must be http/https' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
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
    // 外部 abort signal(用户 Ctrl+C,经 executeTool ctx.signal 透传)→ 合并到 ctrl,fetch 即时取消(不等 30s 超时)
    const onExternalAbort = (): void => ctrl.abort();
    const externalSignal = ctx?.signal;
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const attempt = await attemptFetch(url.href, 'direct', ctrl.signal);
      // abort 优先判定:用户 Ctrl+C 是终态,绝不能被当成「直连失败」去走代理或重试。
      // (放在直连结果之后、任何分支之前 —— 代理路径与 HTTP 错误路径都必须先过这道闸。)
      if (ctrl.signal.aborted) {
        if (externalSignal?.aborted) {
          return { status: 'aborted', code: 'ABORTED', retryable: false, output: `错误:已中断: ${url.href}` };
        }
        return {
          status: 'error',
          code: 'TIMEOUT',
          retryable: true,
          output: `错误:抓取超时(${FETCH_TIMEOUT_MS}ms): ${url.href}`,
        };
      }
      if (attempt.ok) return renderBody(attempt, url);

      // 直连被盾拦(403/429/503…)且用户配置了代理 → 走代理再试一次;代理失败回落原始失败,
      // 报「直连 + 代理」两段原因,让模型知道两条路都试过。
      if (isBlockedStatus(attempt.status)) {
        const prefix = proxyPrefix();
        if (prefix) {
          const proxied = await attemptFetch(`${prefix}${url.href}`, 'proxy', ctrl.signal);
          // 代理期间的 abort 同样按终态处理,不降级成「代理失败」。
          if (ctrl.signal.aborted && !proxied.ok) {
            return externalSignal?.aborted
              ? { status: 'aborted', code: 'ABORTED', retryable: false, output: `错误:已中断: ${url.href}` }
              : {
                  status: 'error',
                  code: 'TIMEOUT',
                  retryable: true,
                  output: `错误:抓取超时(${FETCH_TIMEOUT_MS}ms): ${url.href}`,
                };
          }
          if (proxied.ok) return renderBody(proxied, url);
          return blockedFailure(attempt, proxied, url);
        }
      }

      if (attempt.networkError) {
        return {
          status: 'error',
          code: 'NETWORK_ERROR',
          retryable: true,
          output: `错误:抓取失败: ${attempt.error ?? 'network error'}`,
        };
      }
      // HTTP 错误:429/5xx/408 标 retryable,registry 对幂等工具自动退避重试。
      const retryable = attempt.status === 408 || attempt.status === 429 || attempt.status >= 500;
      const hint = isBlockedStatus(attempt.status)
        ? '\n(疑似反爬拦截;可设 MOCODE_WEB_FETCH_PROXY=<前缀代理> 开启纯文本代理回退)'
        : '';
      return {
        status: 'error',
        code: 'HTTP_ERROR',
        retryable,
        output: `错误:抓取失败 HTTP ${attempt.status} ${attempt.statusText}\n${attempt.text.slice(0, 500)}${hint}`,
      };
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  },
};

/** 成功响应 → 清洗正文 + 截断(直连与代理共用)。 */
function renderBody(attempt: FetchAttempt, url: URL): string | ToolOutcome {
  const isHtml =
    /html/i.test(attempt.contentType) ||
    /^\s*<!doctype html/i.test(attempt.text) ||
    /<html[\s>]/i.test(attempt.text.slice(0, 1000));
  const body = isHtml ? htmlToText(attempt.text) : attempt.text;
  const ct = attempt.contentType.split(';')[0].trim();
  const via = attempt.via === 'proxy' ? ', via proxy' : '';
  const prefix = `${url.href} (HTTP ${attempt.status}${ct ? ', ' + ct : ''}${via})\n\n`;
  let out = prefix + body;
  if (out.length > MAX_OUTPUT) {
    out = out.slice(0, MAX_OUTPUT) + `\n...(已截断,原文 ${body.length} 字符)`;
  }
  return out;
}

/** 直连被拦 + 代理也失败:两段原因都报,不掩盖代理尝试。 */
function blockedFailure(direct: FetchAttempt, proxied: FetchAttempt, url: URL): ToolOutcome {
  const proxyDetail = proxied.networkError
    ? `代理网络错误: ${proxied.error ?? 'unknown'}`
    : proxied.timedOut
      ? '代理超时'
      : `代理返回 HTTP ${proxied.status}`;
  return {
    status: 'error',
    code: 'HTTP_ERROR',
    retryable: direct.status === 429 || direct.status >= 500,
    output:
      `错误:抓取失败(直连与代理均被拒): ${url.href}\n` +
      `直连: HTTP ${direct.status} ${direct.statusText}\n${proxyDetail}\n` +
      `直连响应片段: ${direct.text.slice(0, 300)}`,
  };
}

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
    '\n',
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
