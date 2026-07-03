import type { Tool } from '../types.js';
import { promptIntervention } from '../../ui/intervention.js';
import { sendState } from '../../pet/bridge.js';

// ---------- ask_human ----------
export const askHumanTool: Tool = {
  name: 'ask_human',
  description: [
    'Ask the user for input at a decision point (blocks until they respond).',
    ' Use when: multiple approaches need a user decision, intent is unclear, or extra info is needed.',
    ' Don\'t call when the task is clear and you can decide — it interrupts the user.',
    ' Options (2-6) let the user pick; omit/empty for free-text input. Their answer is returned as the result.',
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

    // 桌宠:面板弹出期间广播 waiting_human(红灯闪烁,提示需要人工介入);拿到响应后 sendState 会被
    // 下一个 hook 事件(如 onToolDone→tool_call)覆盖,这里不用手动切回——与其它工具状态转移逻辑一致。
    sendState('waiting_human');
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
