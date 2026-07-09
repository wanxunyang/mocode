import type { Tool } from '../types.js';
import { updateEntry, type UpdatePatch } from '../../memory/store.js';

// ---------- memory_update ----------
// 原地改一条记忆(id 不变)。反思的弱意义:干活时发现事实变了/过时即纠正。
export const memoryUpdateTool: Tool = {
  name: 'memory_update',
  description:
    'Update a memory entry in place (id unchanged). Use when facts changed / correcting outdated info / toggling pinned. Get id from memory_list or memory_search.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      summary: { type: 'string', description: 'New summary (only pass fields to change)' },
      body: { type: 'string', description: 'New body (only pass fields to change)' },
      name: { type: 'string', description: 'New title (id does not change with name)' },
      pinned: { type: 'boolean', description: 'Toggle pin status (true pins and exempts decay / false unpins)' },
      reason: { type: 'string', description: 'Update reason (recorded in lastUpdateReason for traceability)' },
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
