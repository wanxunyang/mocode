import type { Tool } from '../types.js';
import { forgetEntry } from '../../memory/store.js';

// ---------- memory_forget ----------
// 遗忘:默认归档(archived,从索引/默认搜索隐藏,可复活);mode=delete 硬删。pinned 拒删。
export const memoryForgetTool: Tool = {
  name: 'memory_forget',
  description:
    'Forget a memory entry: default archive (hidden, revivable via memory_update); mode=delete hard-deletes. Pinned entries can\'t be deleted (unpin first).',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      mode: {
        type: 'string',
        enum: ['archive', 'delete'],
        description: 'Default archive',
      },
    },
    required: ['id'],
  },
  async execute(args) {
    const id = String(args.id ?? '').trim();
    if (!id) return '错误:缺少 id。';
    const mode = args.mode === 'delete' ? 'delete' : 'archive';
    const r = forgetEntry(id, mode);
    if (r.ok) return `已${mode === 'delete' ? '硬删' : '归档'}记忆 [${id}]。`;
    if ('notFound' in r) return `错误:找不到记忆 id="${id}"。`;
    // pinned
    return `错误:[${id}] 已钉住,拒绝遗忘。先 memory_update(id="${id}", pinned=false) 解钉。`;
  },
};
