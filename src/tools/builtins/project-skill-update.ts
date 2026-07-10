import type { Tool } from '../types.js';
import {
  readProjectSkill,
  writeProjectSkillWithCompression,
  appendProjectSkillWithCompression,
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
    'Actions: "read" (view current content), "write" (replace all), "append" (add to end). ' +
    '\n\n' +
    '## Skill 维护指南\n' +
    'Skill 专注 Snapshot 无法自动提供的洞察知识（why/how/gotchas）。Snapshot 已提供文件结构和静态文件内容——Skill 不要重复这些信息。\n' +
    '\n' +
    '**Skill 该写什么（Snapshot 不能替代的）**：\n' +
    '- 设计决策的 why（为什么这样设计、取舍是什么）\n' +
    '- 模块行为和职责描述（怎么工作、数据流、调用链）\n' +
    '- 常见坑点和解决方案（踩过的坑、非直觉行为、边界条件）\n' +
    '- 项目约定（命名规范、代码风格、测试策略）\n' +
    '- 开发流程（构建/测试/部署命令及注意事项）\n' +
    '- 关键 API 的使用限制和特殊行为\n' +
    '\n' +
    '**Skill 不该写什么（交给 Snapshot）**：\n' +
    '- 文件列表和目录结构（Snapshot 自动扫描 src 树）\n' +
    '- 静态文件内容摘要（依赖、编译器选项等 → package.json / tsconfig.json）\n' +
    '\n' +
    '**何时更新**：发现新架构模式、踩坑后总结、学到新约定、完成重要重构、用户纠正理解时。\n' +
    '\n' +
    '**注意事项**：\n' +
    '- 保持精简，硬上限 4000 字符（约 1000 token）\n' +
    '- 写可操作的内容，避免空泛描述\n' +
    '- 用具体路径和例子（不要写"有多个模块"，要写"src/agent 负责 agent 循环"）\n' +
    '- 定期整理，删除过时信息\n' +
    '- 更新前建议先 `read` 看一下现有内容，避免重复\n' +
    '\n' +
    '**自动压缩**：内容超限时会自动调用 LLM 压缩（最多 3 次），无需手动精简。',
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
  execute: async (args, ctx) => {
    const action = String(args.action ?? '').trim();
    const content = String(args.content ?? '');
    const signal = ctx?.signal;
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
        const result = await writeProjectSkillWithCompression(content, 3, signal);
        if (!result.ok) {
          return `Error: ${result.error}`;
        }
        return result.compressed
          ? 'Project skill updated successfully (full replacement, auto-compressed to fit limit).'
          : 'Project skill updated successfully (full replacement).';
      }

      case 'append': {
        if (!content.trim()) {
          return 'Error: "append" action requires non-empty content parameter.';
        }
        const result = await appendProjectSkillWithCompression(content, 3, signal);
        if (!result.ok) {
          return `Error: ${result.error}`;
        }
        return result.compressed
          ? 'Project skill updated successfully (appended, auto-compressed to fit limit).'
          : 'Project skill updated successfully (appended).';
      }

      default:
        return `Error: Unknown action "${action}". Use "read", "write", or "append".`;
    }
  },
};
