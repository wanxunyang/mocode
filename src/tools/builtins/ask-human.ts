import type { Tool } from '../types.js';
import { promptIntervention } from '../../ui/intervention.js';

// ---------- ask_human ----------
export const askHumanTool: Tool = {
  name: 'ask_human',
  description: [
    '当你在执行任务中遇到需要人类做决策的岔路时调用此工具,在终端弹出问题面板让用户选择。',
    '适用:多种实现方案需要用户拍板、不确定用户意图需要澄清、需要用户提供额外信息才能继续。',
    '调用后阻塞等待用户响应;用户可挑预设选项,也可选"自定义输入"自由作答,结果作为工具返回值返回。',
    '不要在任务明确、可自行决定时频繁调用——会打断用户。options 省略或为空时改为自由文本输入。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '要问用户的问题,简明扼要(显示为面板标题)',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '供用户选择的选项(2~6 个)。可省略——省略或为空时改为自由文本输入',
      },
      context: {
        type: 'string',
        description: '问题的背景说明(可选,帮助用户理解为何需要他决策;显示在标题下,可多行)',
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
