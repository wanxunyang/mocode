import type { Tool } from '../types.js';
import { updateEntry, type UpdatePatch } from '../../memory/store.js';
import type { AnchorInput } from '../../memory/anchor.js';

/**
 * anchors 参数归一(同 memory_save):只取 path/symbol,hash 由 store 现算。
 * 传空数组表示**清空**锚点,传 undefined 表示不动。
 */
function parseAnchorInputs(raw: unknown): AnchorInput[] {
  if (!Array.isArray(raw)) return [];
  const out: AnchorInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as { path?: unknown; symbol?: unknown };
    const p = typeof a.path === 'string' ? a.path.trim() : '';
    if (!p) continue;
    const s = typeof a.symbol === 'string' ? a.symbol.trim() : '';
    out.push({ path: p, ...(s ? { symbol: s } : {}) });
  }
  return out;
}

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
      trigger: {
        type: 'string',
        description:
          'R1.5 WHEN this memory applies. Use this to fill in a missing trigger after the situation actually recurred — that is the expected flow, do not invent a vague one up front. Pass "" to clear.',
      },
      action: {
        type: 'string',
        description: 'R1.5 WHAT to do when the trigger holds. Pass "" to clear.',
      },
      anchors: {
        type: 'array',
        description:
          'R2 code anchors — REPLACES the whole set (pass [] to clear). Only paths/symbols; the content hash is recomputed at write time. Use this when the memory is about a specific file/function and you want a later edit to surface it as stale instead of silently serving an outdated fact.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/memory/store.ts"' },
            symbol: {
              type: 'string',
              description: 'Optional function/class/const name; prefers a fragment over the whole file',
            },
          },
          required: ['path'],
        },
      },
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
    // trigger/action 无真值判断:空串是「清空」这个明确意图(见 updateEntry)。
    if (typeof args.trigger === 'string') patch.trigger = args.trigger;
    if (typeof args.action === 'string') patch.action = args.action;
    // anchors 同理:空数组是「清空锚点」,不传才是「不动」。
    if (args.anchors !== undefined) patch.anchors = parseAnchorInputs(args.anchors);
    if (Object.keys(patch).length === 0)
      return '错误:至少传一个要改的字段(summary/body/name/pinned/reason/trigger/action/anchors)。';
    const r = updateEntry(id, patch);
    if (r.ok) return `已更新记忆 [${id}]。`;
    return `错误:找不到记忆 id="${id}"。用 memory_list 查可用 id。`;
  },
};
