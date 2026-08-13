import type { Tool, ToolContext } from '../types.js';
import { runSkill } from '../../skills/runner.js';

// ---------- run_skill ----------
// 唯一新增的常驻工具(L2-①):把某个 skill 作为隔离工作流(fork 子 agent)执行并返回摘要。
// 无论装 100 个还是 1000 个 skill,常驻工具表只多这 1 个。上下文 / 工具面 / 副作用 / 中断
// 全部由 spawnAgent 现成能力承接(设计 §3.4)。

export const runSkillTool: Tool = {
  name: 'run_skill',
  description:
    'Execute a skill as an isolated workflow (forked sub-agent) and return its summary. ' +
    'Use for skills marked [fork] in the skill list. Args are rendered into the skill body.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the skill to execute (see the skill list in the system prompt).',
      },
      args: {
        type: 'object',
        description: 'Arguments rendered into the skill body ($ARGUMENTS, $1..$9). Optional.',
      },
      context: {
        type: 'string',
        description: 'Optional extra context/facts to inject into the sub-agent (authoritative; not rediscovered).',
      },
    },
    required: ['name'],
  },
  risk: 'confirm',
  capabilities: {
    effect: 'process',
    concurrency: 'serial',
    delegatesResourceLocks: true, // 与 sub-agent 一致:锁由内层工具取,避免父子自锁
    supportsAbort: true,
  },
  async execute(args, ctx?: ToolContext) {
    return runSkill(
      {
        name: String(args.name ?? ''),
        args: args.args as Record<string, unknown> | undefined,
        context: typeof args.context === 'string' ? args.context : undefined,
      },
      ctx,
    );
  },
};
