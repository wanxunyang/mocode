import type { Tool } from '../types.js';
import { config } from '../../config/index.js';
import { searchArchiveIndex } from '../../session/retention.js';

// ---------- session_search ----------
// episodic 层入口:跨会话搜索已归档会话(首条用户消息 + 摘要,BM25)。
// 已 purge(正文已删)的会话同样可命中——meta+摘要永久保留。需要整段恢复时,
// 未 purge 的会话仍可用 --resume <id> 从 archive 取回(见 retention loadArchivedSession)。

export const sessionSearchTool: Tool = {
  name: 'session_search',
  description:
    'Search archived past sessions in this workspace by keyword (BM25 over the first user message and the session summary). Returns session id, date, and summary. Use to recall what was decided or done in earlier conversations.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords describing the past session' },
      limit: { type: 'integer', description: 'Number of sessions to return, default 10' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return '错误:缺少 query。';
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const hits = searchArchiveIndex(config.sessionDir, query, limit);
    if (hits.length === 0) return `(无匹配的归档会话:query="${query}")`;
    return hits
      .map((h) => {
        const status = h.purgedAt ? ' [正文已清除,仅摘要]' : '';
        return `# ${h.id} · ${h.createdAt}${status}\n${h.summary || h.firstUser}`;
      })
      .join('\n\n---\n\n');
  },
};
