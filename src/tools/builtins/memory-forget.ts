import type { Tool } from '../types.js';
import { forgetEntry } from '../../memory/store.js';

// ---------- memory_forget ----------
// 遗忘:默认归档(archived,从索引/默认搜索隐藏,可复活);mode=delete 硬删。pinned 拒删。
export const memoryForgetTool: Tool = {
  name: 'memory_forget',
  description:
    '遗忘一条记忆:默认归档(archived,从索引/默认搜索隐藏,可经 memory_update 复活);mode=delete 硬删。pinned 条目拒删(先 memory_update pinned=false 解钉)。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      mode: {
        type: 'string',
        enum: ['archive', 'delete'],
        description: '默认 archive',
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
