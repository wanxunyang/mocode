import type { Tool } from '../types.js';
import { getSkillBody } from '../../skills/index.js';

// ---------- use_skill ----------
// 模型按需加载某 skill 的 SKILL.md 正文(渐进式披露第②层)。
// 系统提示里已列出可用 skill 的 name + description(何时用),模型据此决定调用。
export const useSkillTool: Tool = {
  name: 'use_skill',
  description:
    '加载并返回某个 skill 的完整 SKILL.md 指令。系统提示里列出了可用 skill(name + 何时用的 description)。只在任务相关时调用本工具传 skill 的 name,拿到完整指令后据此行动;不要无脑批量加载。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '要加载的 skill 名(见系统提示里的 skill 列表,或 /skills 命令)',
      },
    },
    required: ['name'],
  },
  async execute(args) {
    const name = String(args.name ?? '').trim();
    if (!name) return '错误:缺少 skill 名。用 /skills 查看可用 skill 列表。';
    const body = getSkillBody(name);
    if (body === null)
      return `错误:未找到 skill "${name}"。用 /skills 查看可用 skill 列表。`;
    return `# Skill: ${name}\n\n${body}`;
  },
};
