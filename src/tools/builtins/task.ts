import type { Tool, ToolOutcome, ToolOutcomeCode } from '../types.js';
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
export const subAgentTool: Tool = {
  name: 'sub-agent',
  risk: 'dangerous',
  description: [
    'Spawn a capable worker for an isolated sub-task; only its structured result returns.',
    'Pass context with facts the main agent already knows to prevent duplicate exploration and token waste.',
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
          'Optional whitelist for deliberate specialization. Omit it to preserve the worker full capability for its mode.',
      },
      maxSteps: {
        type: 'number',
        description:
          'Optional loop-safety override. By default the worker uses the same step ceiling as the main agent; this is not a token budget.',
      },
      mode: {
        type: 'string', enum: ['read', 'write'],
        description: 'read tasks may run in parallel; write tasks use an isolated overlay and are merged by the coordinator.',
      },
      writeSet: {
        type: 'array', items: { type: 'string' },
        description: 'Known workspace-relative paths this task may write. Unknown write sets conservatively use the workspace lock.',
      },
      context: {
        type: 'string',
        description: 'Concise facts already learned by the main agent. Passing this avoids duplicate repository exploration.',
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
    const mode = args.mode === 'write' ? 'write' : 'read';
    const writeSet = Array.isArray(args.writeSet) ? args.writeSet.map(String) : undefined;
    const context = typeof args.context === 'string' ? args.context.slice(0, 4000) : undefined;

    // 透传主 agent 的 abort signal:主 Ctrl+C 树杀子 agent(chat abort + 工具 abort)。
    const result = await spawnAgent({ prompt, tools, maxSteps, signal: ctx?.signal, mode, writeSet, context });

    let output: string;
    if (!result.completed) {
      output = `[SubAgentResult status=${result.status} tokens=${result.usage.totalTokens} readSet=${JSON.stringify(result.readSet)} changeSet=${result.changeSet?.id ?? 'none'} verification=not-run]\n${result.summary ?? t('task.interrupted')}`;
    } else if (!result.summary) {
      output = t('task.noSummary');
    } else {
    // 摘要可能很长,截到 MAX_OUTPUT 保主 history 不爆。
      const summary = [
        result.summary,
        `\n[SubAgentResult status=${result.status} tokens=${result.usage.totalTokens} prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} cached=${result.usage.cachedTokens} readSet=${JSON.stringify(result.readSet)} changeSet=${result.changeSet?.id ?? 'none'} verification=deferred-to-coordinator]`,
      ].filter(Boolean).join('\n');
      output = summary.length > MAX_OUTPUT ? (
        summary.slice(0, MAX_OUTPUT) +
        `\n\n${t('task.summaryTruncated', { count: summary.length - MAX_OUTPUT })}`
      ) : summary;
    }

    const code: ToolOutcomeCode = result.status === 'aborted'
      ? 'ABORTED'
      : result.status === 'conflict'
        ? 'CHANGE_CONFLICT'
        : result.completed ? 'OK' : 'EXECUTION_ERROR';
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
