import type { Tool, ToolOutcome, ToolOutcomeCode } from '../types.js';
import { spawnAgent } from '../../agent/spawn.js';
import { MAX_OUTPUT } from '../constants.js';
import { t } from '../../i18n/index.js';
import { isSubAgentHardDisabled } from '../../config/index.js';

// ---------- task ----------
// 派生子 agent 执行独立子任务。子 agent 与主 agent 完全同源:同一份系统提示、同一份工具
// schema、同一份对话前缀(命中前缀缓存),写操作直接落在工作区并进入主 agent 当前轮次的
// 同一回滚事务。它有自己的 history 分支(子任务的工具噪声不回灌主对话),最终摘要回灌主
// history 供主 agent 继续。
//
// 适用:分而治之的复杂任务 / 隔离上下文避免子任务工具噪声撑爆主窗口。
export const subAgentTool: Tool = {
  name: 'sub-agent',
  risk: 'dangerous',
  description: [
    'Spawn a worker with your own full capability set and conversation context for an isolated sub-task; only its structured result returns.',
    'The worker sees everything you have already read and concluded, so it does not repeat exploration.',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'The sub-task instruction for the sub-agent. Be specific about what to investigate/implement and what to report back.',
      },
      maxSteps: {
        type: 'number',
        description:
          'Optional loop-safety override. By default the worker uses the same step ceiling as the main agent; this is not a token budget.',
      },
      context: {
        type: 'string',
        description:
          'Concise facts already learned by the main agent. Passing this avoids duplicate repository exploration.',
      },
    },
    required: ['prompt'],
  },
  async execute(args, ctx) {
    if (isSubAgentHardDisabled()) return t('task.disabled');
    const prompt = String(args.prompt ?? '');
    if (!prompt) return t('task.missingPrompt');

    const maxSteps = typeof args.maxSteps === 'number' && args.maxSteps > 0 ? Math.floor(args.maxSteps) : undefined;
    const context = typeof args.context === 'string' ? args.context.slice(0, 4000) : undefined;

    // 透传主 agent 的 abort signal:主 Ctrl+C 树杀子 agent(chat abort + 工具 abort)。
    // callId 透传:子 agent 实时渲染据此挂靠主侧对应批次(并行派发时各行归位)。
    // delegation 透传:子 agent 复用父 step 的系统提示/工具 schema/对话前缀,命中前缀缓存。
    const result = await spawnAgent({
      prompt,
      maxSteps,
      signal: ctx?.signal,
      context,
      callId: ctx?.callId,
      parentAllowedToolNames: ctx?.allowedToolNames,
      delegation: ctx?.delegation,
    });

    let output: string;
    if (!result.completed) {
      output = `[SubAgentResult status=${result.status} tokens=${result.usage.totalTokens}]\n${result.summary ?? t('task.interrupted')}`;
    } else if (!result.summary) {
      output = t('task.noSummary');
    } else {
      // 摘要可能很长,截到 MAX_OUTPUT 保主 history 不爆。
      const summary = [
        result.summary,
        `\n[SubAgentResult status=${result.status} tokens=${result.usage.totalTokens} prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} cached=${result.usage.cachedTokens}]`,
      ]
        .filter(Boolean)
        .join('\n');
      output =
        summary.length > MAX_OUTPUT
          ? summary.slice(0, MAX_OUTPUT) + `\n\n${t('task.summaryTruncated', { count: summary.length - MAX_OUTPUT })}`
          : summary;
    }

    const code: ToolOutcomeCode = result.status === 'aborted' ? 'ABORTED' : result.completed ? 'OK' : 'EXECUTION_ERROR';
    const outcome: ToolOutcome = {
      status: result.status === 'aborted' ? 'aborted' : result.completed ? 'success' : 'error',
      code,
      retryable: false,
      output,
      usage: result.usage,
    };
    return outcome;
  },
};
