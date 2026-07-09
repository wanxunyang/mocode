import type { Tool } from '../types.js';
import {
  readProjectSkill,
  writeProjectSkill,
  appendProjectSkill,
} from '../../project-skill/index.js';

/**
 * 项目专属 Skill 更新工具。
 * 支持三种操作:
 *   - read: 读取当前 skill 内容
 *   - write: 全量覆盖(适合重构整个 skill)
 *   - append: 追加到末尾(适合发现新坑点/约定时增量更新)
 *
 * 使用场景:
 *   - 开发过程中发现项目特有的架构模式、命名约定
 *   - 踩坑后记录避坑指南
 *   - 总结项目关键决策和设计理由
 *   - 随着项目开发，skill 越来越了解项目，开发效率越来越高
 */
export const projectSkillUpdateTool: Tool = {
  name: 'project_skill_update',
  description:
    'Update the project-specific skill file (.mocode/project-skill.md). ' +
    'Use this to record architectural patterns, naming conventions, common pitfalls, ' +
    'and key decisions specific to this project. The skill persists across sessions and ' +
    'is injected into the system prompt when MOCODE_PROJECT_SKILL=true. ' +
    'Actions: "read" (view current content), "write" (replace all), "append" (add to end).',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'append'],
        description:
          'Action to perform: "read" to view current content, "write" to replace all, "append" to add to end',
      },
      content: {
        type: 'string',
        description:
          'Content to write or append (required for "write" and "append" actions, ignored for "read")',
      },
    },
    required: ['action'],
  },
  execute: async (args) => {
    const action = String(args.action ?? '').trim();
    const content = String(args.content ?? '');
    switch (action) {
      case 'read': {
        const current = readProjectSkill();
        if (!current) {
          return 'Project skill is empty or does not exist yet.';
        }
        return `Current project skill:\n\n${current}`;
      }

      case 'write': {
        if (!content.trim()) {
          return 'Error: "write" action requires non-empty content parameter.';
        }
        const result = writeProjectSkill(content);
        if (!result.ok) {
          return `Error: ${result.error}`;
        }
        return 'Project skill updated successfully (full replacement).';
      }

      case 'append': {
        if (!content.trim()) {
          return 'Error: "append" action requires non-empty content parameter.';
        }
        const result = appendProjectSkill(content);
        if (!result.ok) {
          return `Error: ${result.error}`;
        }
        return 'Project skill updated successfully (appended).';
      }

      default:
        return `Error: Unknown action "${action}". Use "read", "write", or "append".`;
    }
  },
};
