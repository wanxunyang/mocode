import type { Tool } from '../types.js';
import { updateEntry, type UpdatePatch } from '../../memory/store.js';

// ---------- memory_update ----------
// 原地改一条记忆(id 不变)。反思的弱意义:干活时发现事实变了/过时即纠正。
export const memoryUpdateTool: Tool = {
  name: 'memory_update',
  description:
    '更新一条记忆(id 不变)。用于事实变了/纠正过时/补 summary 或 body/切换 pinned。id 从 memory_list 或 memory_search 拿。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      summary: { type: 'string', description: '新摘要(只传要改的字段)' },
      body: { type: 'string', description: '新正文(只传要改的字段)' },
      name: { type: 'string', description: '新标题(id 不随 name 变)' },
      pinned: { type: 'boolean', description: '切换钉住状态(true 钉住豁免衰减 / false 解钉)' },
      reason: { type: 'string', description: '更新理由(记入 lastUpdateReason,便于追溯)' },
    },
    required: ['id'],
  },
  async execute(args) {
    const id = String(args.id ?? '').trim();
    if (!id) return '错误:缺少 id。';
    const patch: UpdatePatch = {};
    if (typeof args.summary === 'string') patch.summary = args.summary;
    if (typeof args.body === 'string') patch.body = args.body;
    if (typeof args.name === 'string') patch.name = args.name;
    if (typeof args.reason === 'string') patch.reason = args.reason;
    if (typeof args.pinned === 'boolean') patch.pinned = args.pinned;
    if (Object.keys(patch).length === 0)
      return '错误:至少传一个要改的字段(summary/body/name/pinned/reason)。';
    const r = updateEntry(id, patch);
    if (r.ok) return `已更新记忆 [${id}]。`;
    return `错误:找不到记忆 id="${id}"。用 memory_list 查可用 id。`;
  },
};
