import type { Tool, ToolContext } from '../types.js';
import { findSkill } from '../../skills/index.js';
import { renderSkillBody, readSkillFile } from '../../skills/runner.js';
import { activateSkill } from '../../skills/activation.js';

// ---------- use_skill ----------
// 模型按需加载某 skill 的 SKILL.md 正文(渐进式披露第②层)。
// 系统提示里已列出可用 skill 的 name + description(何时用),模型据此决定调用。
//
// 设计 §3.3 升级:
//  - args:渲染 $ARGUMENTS / $1..$9 / ${SKILL_DIR}
//  - file:读 skill 目录内附属文件(L2 披露,jail 约束)
//  - context: fork 的 skill 不返回正文,改为引导调 run_skill(隔离白做才是真隔离)
//  - inline skill 成功加载后激活会话级工具面约束(allowed/disallowed-tools)

const MAX_SKILL_FILE = 200_000;

export const useSkillTool: Tool = {
  name: 'use_skill',
  description:
    'Load the full SKILL.md instructions for a given skill. See the skill list in the system prompt for when to use each. ' +
    'Supports args (renders $ARGUMENTS / $1.. / ${SKILL_DIR}) and file (reads a bundled reference file). ' +
    'For skills marked [fork], this returns a guide to call run_skill instead of loading the body inline.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the skill to load (see the skill list in the system prompt, or the /skills command)',
      },
      args: {
        type: 'object',
        description: 'Arguments rendered into the skill body ($ARGUMENTS, $1..$9). Optional.',
      },
      file: {
        type: 'string',
        description: 'Optional bundled file inside the skill directory to read (e.g. references/api.md). Subject to jail bounds.',
      },
    },
    required: ['name'],
  },
  async execute(args, ctx?: ToolContext) {
    const name = String(args.name ?? '').trim();
    if (!name) return '错误:缺少 skill 名。用 /skills 查看可用 skill 列表。';
    const skill = findSkill(name);
    if (!skill)
      return `错误:未找到 skill "${name}"。用 /skills 查看可用 skill 列表。`;

    // fork skill:不把正文读进主上下文,引导走 run_skill。
    if (skill.context === 'fork') {
      return (
        `# Skill: ${name}\n\n` +
        `该 skill 以隔离工作流(fork)形式执行。请勿在此加载其正文——调用 ` +
        `\`run_skill({ name: "${name}"${Object.keys(args.args ?? {}).length ? ', args: {...}' : ''} })\` ` +
        `即可在隔离子 agent 中执行并返回摘要。`
      );
    }

    // file 优先:L2 渐进式披露
    if (typeof args.file === 'string' && args.file.trim()) {
      const content = readSkillFile(skill, args.file.trim(), MAX_SKILL_FILE);
      if (content === null)
        return `错误:无法读取 skill "${name}" 的文件 "${args.file}"(不存在 / 越界 / 过大)。`;
      return `# Skill: ${name} · ${args.file}\n\n${content}`;
    }

    const body = await renderSkillBody(skill, args.args as Record<string, unknown> | undefined, ctx?.signal);
    if (body === null)
      return `错误:未找到 skill "${name}" 的正文。用 /skills 查看可用 skill 列表。`;

    // 激活 inline skill 的工具面约束(allowed/disallowed),本轮内生效。
    activateSkill(skill);
    return `# Skill: ${name}\n\n${body}`;
  },
};
