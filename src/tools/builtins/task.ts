import type { Tool } from '../types.js';
import { spawnAgent } from '../../agent/spawn.js';
import { MAX_OUTPUT } from '../constants.js';
import { t } from '../../i18n/index.js';
import { isSubAgentEnabled } from '../../config/index.js';

// ---------- task ----------
// 派生子 agent 执行独立子任务。子 agent 有独立 history(不污染主对话),
// 可受限工具子集 + 低步数上限,最终摘要回灌主 history 供主 agent 继续。
//
// 适用:分而治之的复杂任务 / 隔离上下文避免子任务工具噪声撑爆主窗口。
// 多个 task 在共享工作区期间由 capability scheduler 串行执行；隔离 workspace 落地后再开放并行写。
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
    if (!isSubAgentEnabled()) return t('task.disabled');
    const prompt = String(args.prompt ?? '');
    if (!prompt) return t('task.missingPrompt');

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
      return t('task.interrupted');
    }
    if (!result.summary) {
      return t('task.noSummary');
    }
    // 摘要可能很长,截到 MAX_OUTPUT 保主 history 不爆。
    const summary = result.summary;
    if (summary.length > MAX_OUTPUT) {
      return (
        summary.slice(0, MAX_OUTPUT) +
        `\n\n${t('task.summaryTruncated', { count: summary.length - MAX_OUTPUT })}`
      );
    }
    return summary;
  },
};
