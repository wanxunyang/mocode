import type { Tool } from '../types.js';
import { saveEntry, type MemoryType } from '../../memory/store.js';

// ---------- memory_save ----------
// 存一条长期记忆(跨会话)。启动只把标题/摘要注入索引(几百 token);详情按需 memory_search 取。
// 撞库(name→id 已存在)拒绝,引导用 memory_update。
export const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    '保存一条长期记忆(跨会话)。只存非显然、长期有用的事实/决策/坑。启动时标题进索引,详情按需 memory_search 取。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '简短唯一标题(转成 id,撞库会拒绝)' },
      summary: { type: 'string', description: '一句话摘要(进索引,尽量短)' },
      body: { type: 'string', description: '完整内容(细节/上下文/证据)' },
      type: {
        type: 'string',
        enum: ['decision', 'fact', 'pitfall', 'reference', 'feedback'],
        description: '分类,默认 fact',
      },
      pinned: { type: 'boolean', description: '钉住(豁免自动遗忘衰减),默认 false' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: '存到项目级(<cwd>/.mocode/)还是全局(~/.mocode/),默认 project',
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
