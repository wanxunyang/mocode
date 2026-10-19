import type { Tool } from '../types.js';
import { forgetEntry } from '../../memory/store.js';
import { invalidateEdge } from '../../memory/graph.js';

// ---------- memory_forget ----------
// 遗忘两类对象:
//  - 记忆条目(默认):归档(archived,从索引/默认搜索隐藏,可复活)或 mode=delete 硬删;
//    pinned 拒删。
//  - 图谱边(kind=edge,id 形如 edge-…):时序失效(invalidAt,不删除可审计),
//    这是撤销错误画像/错误三元组的产品内出口(此前只能手改 memory-graph.json)。
export const memoryForgetTool: Tool = {
  name: 'memory_forget',
  description:
    "Forget a memory entry (kind=entry, default): archive (hidden, revivable via memory_update) or mode=delete hard-delete; pinned entries can't be deleted (unpin first). " +
    "Or invalidate a knowledge-graph edge (kind=edge, id starts with 'edge-', shown by memory_graph neighbors/path): temporally revoked, kept for audit. Use edge to correct a wrong profile fact or triple.",
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry id, or edge id (edge-…) when kind=edge' },
      mode: {
        type: 'string',
        enum: ['archive', 'delete'],
        description: 'kind=entry only: default archive',
      },
      kind: {
        type: 'string',
        enum: ['entry', 'edge', 'auto'],
        description:
          "What to forget: entry (default), edge (graph triple, id 'edge-…'), or auto (edge-* prefix → edge, else entry)",
      },
      reason: { type: 'string', description: 'Why it is forgotten/withdrawn (audit trail for edges)' },
    },
    required: ['id'],
  },
  async execute(args) {
    const id = String(args.id ?? '').trim();
    if (!id) return '错误:缺少 id。';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    const kind = args.kind === 'edge' || args.kind === 'entry' ? args.kind : 'auto';
    const wantEdge = kind === 'edge' || (kind === 'auto' && id.startsWith('edge-'));

    if (wantEdge) {
      const r = invalidateEdge(id, reason || 'manual-forget');
      if (r.ok) return `已撤销图谱边 [${id}]${reason ? `(原因:${reason})` : ''}(时序失效,可审计)。`;
      return `错误:找不到 active 图谱边 id="${id}"。`;
    }

    const mode = args.mode === 'delete' ? 'delete' : 'archive';
    const r = forgetEntry(id, mode);
    if (r.ok) return `已${mode === 'delete' ? '硬删' : '归档'}记忆 [${id}]。`;
    if ('notFound' in r) return `错误:找不到记忆 id="${id}"。(图谱边请用 kind=edge)`;
    // pinned
    return `错误:[${id}] 已钉住,拒绝遗忘。先 memory_update(id="${id}", pinned=false) 解钉。`;
  },
};
