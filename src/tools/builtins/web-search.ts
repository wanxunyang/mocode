import { MAX_OUTPUT } from '../constants.js';
import { config } from '../../config/index.js';
import type { Tool } from '../types.js';

const SEARCH_TIMEOUT_MS = 30000;
/** 每条结果的 content 截断长度(字符),避免单条正文占满整个输出。 */
const MAX_CONTENT_CHARS = 800;

// ---------- web_search ----------
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    '联网搜索(AnySearch)。返回每条结果的标题/URL/摘要/正文。可选 tag 切换子域(见 tag 参数)。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询词' },
      max_results: { type: 'integer', description: '返回条数,1-20,默认 10' },
      tag: {
        type: 'string',
        description: '子域能力标签,如 general.general / code.doc / code.snippet;不传走通用搜索',
      },
      language: { type: 'string', description: '偏好语言,如 zh-CN / en,默认 zh-CN' },
      params: {
        type: 'object',
        description: '特定 tag 的扩展参数,如 code.doc 的 {"library":"golang"};通用搜索不需要',
      },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return '错误:query 不能为空。';

    const body: Record<string, unknown> = { query, format: 'json', language: 'zh-CN' };
    const maxResults = Number(args.max_results);
    if (Number.isFinite(maxResults)) {
      body.max_results = Math.min(20, Math.max(1, Math.trunc(maxResults)));
    }
    if (args.tag) body.tag = String(args.tag);
    if (args.language) body.language = String(args.language);
    if (
      args.params &&
      typeof args.params === 'object' &&
      !Array.isArray(args.params)
    ) {
      body.params = args.params;
    }

    const base = config.searchBaseUrl.replace(/\/+$/, '');
    const url = `${base}/v1/search`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // 无 key 走匿名(按 IP 限流 + 每日免费额度);有 key 用付费额度。
    if (config.searchApiKey) {
      headers['Authorization'] = `Bearer ${config.searchApiKey}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await resp.text();

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return `错误:搜索返回非 JSON(HTTP ${resp.status}): ${text.slice(0, 500)}`;
      }

      // AnySearch 成功返回 code===0;否则把 message/request_id 喂回 LLM。
      if (!resp.ok || data?.code !== 0) {
        const code = data?.code ?? resp.status;
        const message = data?.message ?? resp.statusText ?? '未知错误';
        const rid = data?.request_id ? ` (request_id=${data.request_id})` : '';
        let hint = '';
        if (resp.status === 401 || resp.status === 403) {
          hint = ' API Key 非法/过期;可在 .env 去掉 ANYSEARCH_API_KEY 走匿名免费额度。';
        } else if (resp.status === 402) {
          hint = ' 额度用尽,可次日重试或去掉 key 走匿名额度。';
        } else if (resp.status === 429) {
          hint = ' 触发限流,请稍后重试。';
        }
        return `错误:搜索失败 [${code}] ${message}${rid}${hint}`;
      }

      const results = data?.data?.results;
      if (!Array.isArray(results) || results.length === 0) {
        return `无搜索结果(query="${query}")。`;
      }

      const lines: string[] = [];
      results.forEach((r: any, i: number) => {
        const title = String(r?.title ?? '').trim();
        const u = String(r?.url ?? '').trim();
        const snippet = String(r?.snippet ?? '').trim();
        const content = String(r?.content ?? '').trim();
        lines.push(`[${i + 1}] ${title}`);
        if (u) lines.push(`    ${u}`);
        if (snippet) lines.push(`    ${snippet}`);
        if (content) {
          const c =
            content.length > MAX_CONTENT_CHARS
              ? content.slice(0, MAX_CONTENT_CHARS) +
                ` …(共 ${content.length} 字符)`
              : content;
          lines.push(`    ${c}`);
        }
      });

      const meta = data?.data?.metadata;
      if (meta) {
        lines.push(
          `(共 ${meta.total_results ?? results.length} 条,耗时 ${
            meta.search_time_ms ?? '?'
          }ms)`
        );
      }

      let out = lines.join('\n');
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + '\n...(结果已截断)';
      }
      return out;
    } catch (e) {
      if (ctrl.signal.aborted) {
        return `错误:搜索超时(${SEARCH_TIMEOUT_MS}ms)。`;
      }
      const msg = e instanceof Error ? e.message : String(e);
      return `错误:联网搜索请求失败: ${msg}`;
    } finally {
      clearTimeout(timer);
    }
  },
};
