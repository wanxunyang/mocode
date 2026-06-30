import type { Tool } from '../types.js';
import { promptIntervention } from '../../ui/intervention.js';

// ---------- ask_human ----------
export const askHumanTool: Tool = {
  name: 'ask_human',
  description: [
    'Call this tool when you hit a decision point during a task that requires human input — it pops up a question panel in the terminal for the user to choose.',
    'Use when: multiple implementation approaches need a user decision, user intent is unclear and needs clarification, or extra info is needed to proceed.',
    'Blocks until the user responds; the user can pick a preset option or choose "custom input" to answer freely; the result is returned as the tool result.',
    'Do not call frequently when the task is clear and you can decide yourself — it interrupts the user. When options is omitted or empty, it becomes free-text input instead.',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user; keep it concise (shown as the panel title)',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Options for the user to choose from (2~6). May be omitted — when omitted or empty, it becomes free-text input instead',
      },
      context: {
        type: 'string',
        description: 'Background explanation for the question (optional; helps the user understand why their decision is needed; shown under the title, may be multiline)',
      },
    },
    required: ['question'],
  },
  async execute(args) {
    const question = String(args.question ?? '');
    const options = Array.isArray(args.options)
      ? args.options.map((o) => String(o))
      : [];
    const context = args.context ? String(args.context) : undefined;

    const result = await promptIntervention({
      type: options.length > 0 ? 'choice' : 'input',
      title: question,
      options: options.length > 0 ? options : undefined,
      detail: context,
    });

    if (result.action === 'cancelled') {
      return '用户取消了选择。请考虑是否有不依赖用户输入的替代方案,或换个角度重新提问。';
    }
    if (result.action === 'submitted') {
      return `用户回答:${result.value ?? ''}`;
    }
    return `用户选择:${result.value ?? ''}`;
  },
};
