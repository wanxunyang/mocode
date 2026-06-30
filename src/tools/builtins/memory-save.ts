import type { Tool } from '../types.js';
import { saveEntry, type MemoryType } from '../../memory/store.js';

// ---------- memory_save ----------
// 存一条长期记忆(跨会话)。启动只把标题/摘要注入索引(几百 token);详情按需 memory_search 取。
// 撞库(name→id 已存在)拒绝,引导用 memory_update。
export const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    'Save a long-term memory entry (cross-session). Store only non-obvious, long-term-useful facts/decisions/pitfalls. The title goes into the startup index; retrieve full body on demand via memory_search.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short unique title (converted to id; rejected if it collides with an existing one)' },
      summary: { type: 'string', description: 'One-line summary (goes into the index; keep it short)' },
      body: { type: 'string', description: 'Full content (details/context/evidence)' },
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
        description: 'Category, default fact',
      },
      pinned: { type: 'boolean', description: 'Pin (exempt from auto-forgetting decay), default false' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Store at project level (<cwd>/.mocode/) or global (~/.mocode/), default project',
      },
    },
    required: ['name', 'summary', 'body'],
  },
  async execute(args) {
    const name = String(args.name ?? '').trim();
    const summary = String(args.summary ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!name) return '错误:缺少 name。';
    if (!summary) return '错误:缺少 summary。';
    if (!body) return '错误:缺少 body。';
    const type =
      typeof args.type === 'string' ? (args.type as MemoryType) : undefined;
    const r = saveEntry({
      name,
      summary,
      body,
      type,
      pinned: args.pinned === true,
      scope: args.scope === 'global' ? 'global' : 'project',
    });
    if (r.ok) return `已保存记忆 [${r.id}] "${name}"(下次启动进索引)。`;
    return `已存在同名记忆 [${r.exists}]。改用 memory_update(id="${r.exists}", …) 更新,或换一个 name。`;
  },
};
