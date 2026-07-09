import type { Tool } from '../types.js';
import { spawnAgent } from '../../agent/spawn.js';
import { MAX_OUTPUT } from '../constants.js';

// ---------- task ----------
// 派生子 agent 执行独立子任务。子 agent 有独立 history(不污染主对话),
// 可受限工具子集 + 低步数上限,最终摘要回灌主 history 供主 agent 继续。
//
// 适用:并行探查多个文件 / 分而治之的复杂任务 / 隔离上下文避免子任务工具噪声撑爆主窗口。
// 子 agent 中间过程不写主屏,只返回最终摘要;主 agent 据摘要决定下一步。
export const taskTool: Tool = {
  name: 'task',
  risk: 'dangerous',
  description: [
    'Spawn a sub-agent for an isolated sub-task (independent history; only its final summary returns to you).',
    'Use when a task splits into independent parts or its many tool calls would bloat your context.',
    'Cannot recursively spawn sub-agents.',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'The sub-task instruction for the sub-agent. Be specific about what to investigate/implement and what to report back.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional whitelist of tool names the sub-agent is allowed to use (e.g. ["read_file","glob","grep","codegraph"] for read-only investigation). Omit to allow all tools. If the sub-task needs verification/build/test (running scripts, typecheck, etc.), remember to include "run_command".',
      },
      maxSteps: {
        type: 'number',
        description:
          'Optional step limit for the sub-agent (default 50). Lower if the sub-task should be quick.',
      },
    },
    required: ['prompt'],
  },
  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '');
    if (!prompt) return '错误:缺少 prompt(子任务指令)。';

    const tools = Array.isArray(args.tools)
      ? args.tools.map((t) => String(t))
      : undefined;
    const maxSteps =
      typeof args.maxSteps === 'number' && args.maxSteps > 0
        ? Math.floor(args.maxSteps)
        : undefined;

    // 透传主 agent 的 abort signal:主 Ctrl+C 树杀子 agent(chat abort + 工具 abort)。
    const result = await spawnAgent({ prompt, tools, maxSteps, signal: ctx?.signal });

    if (!result.completed) {
      return '子 agent 被中断,未完成。';
    }
    if (!result.summary) {
      return '子 agent 完成但未返回文本摘要(可能只调了工具或达到步数上限)。';
    }
    // 摘要可能很长,截到 MAX_OUTPUT 保主 history 不爆。
    const summary = result.summary;
    if (summary.length > MAX_OUTPUT) {
      return (
        summary.slice(0, MAX_OUTPUT) +
        `\n\n…(子 agent 摘要已截断 ${summary.length - MAX_OUTPUT} 字符)`
      );
    }
    return summary;
  },
};
