import type { Tool } from '../types.js';
import { promptIntervention } from '../../ui/intervention.js';
import { sendState } from '../../pet/bridge.js';

/** 将单个选项元素安全地转为可读字符串。
 *  LLM 有时会传对象(如 {name/label/title:"xxx", desc/description:"yyy"})而不是纯字符串,
 *  直接 String(obj) 会变成 "[object Object]"——这里智能提取可读字段。 */
function optionToString(o: unknown): string {
  if (o === null || o === undefined) return '';
  if (typeof o === 'string') return o;
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  if (typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    // 优先取常见的标签字段
    const labelKeys = ['label', 'name', 'title', 'text', 'option', 'choice', 'value', 'key'];
    for (const k of labelKeys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    // 其次尝试 "label + description" 组合
    const label = obj.label ?? obj.name ?? obj.title;
    const desc = obj.description ?? obj.desc ?? obj.detail;
    if (typeof label === 'string' && typeof desc === 'string') {
      return `${label}: ${desc}`;
    }
    // 兜底:JSON 序列化(去掉大括号让它看起来不像代码)
    try {
      const s = JSON.stringify(obj);
      // 如果是简单对象尝试美化
      return s;
    } catch {
      return String(o);
    }
  }
  return String(o);
}

/** 公开以便 check-ask-human-options.ts 单元测试。 */
export function coerceOptions(raw: unknown): string[] {
  // 路径 1:本身就是数组,map 成字符串。
  if (Array.isArray(raw)) {
    // 子路径 1a:LLM 把真数组包成字符串塞在单元素里(本次 bug 现场)
    if (raw.length === 1 && typeof raw[0] === 'string') {
      const t = raw[0].trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map(optionToString);
        } catch {
          // 不是合法 JSON 数组,降级原值
        }
      }
    }
    return raw.map(optionToString);
  }
  // 路径 2:LLM 直接把整个数组 stringify 成单字符串塞 options 字段(JSON.parse 出来是字符串)
  // 例如 GLM 系经常这么做,arg h['options']='["A","B"]' → args.options='["A","B"]'
  // 这里解开成真数组再转。
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map(optionToString);
      } catch {
        // 不是合法 JSON,保留为单元素数组(对应 input 模式)
      }
    }
  }
  return [];
}

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
    // 容错:部分 LLM(尤其 GLM 系)把数组/对象 stringify 后塞进来,这里识别「长得很像 JSON
    // 数组的单字符串元素」并解开,避免菜单只剩一行 [object Object]、逼用户手动输入。
    // 任何一步失败 / 解出非数组:降级 input,与原代码语义一致。
    const options = coerceOptions(args.options);
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
