import type { Tool } from '../types.js';
import { promptIntervention } from '../../ui/intervention.js';
import { sendState } from '../../pet/bridge.js';

/** 单个选项:label 是选项本身,detail 是选它意味着什么/取舍(可选)。 */
export interface ChoiceOption {
  label: string;
  detail?: string;
}

/** 把单个选项元素安全地转成 {label, detail}。LLM 有时传对象而不是字符串,这里提取可读字段。 */
function optionToChoice(o: unknown): ChoiceOption {
  if (o === null || o === undefined) return { label: '' };
  if (typeof o === 'string') return { label: o };
  if (typeof o === 'number' || typeof o === 'boolean') return { label: String(o) };
  if (typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    const pickString = (source: Record<string, unknown>, keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = source[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return undefined;
    };

    const labelKeys = ['label', 'name', 'title', 'text', 'option', 'choice', 'value', 'key'];
    let label = pickString(obj, labelKeys);

    const nestedOptions = obj.options;
    if (!label && nestedOptions && typeof nestedOptions === 'object' && !Array.isArray(nestedOptions)) {
      label = pickString(nestedOptions as Record<string, unknown>, labelKeys);
    }

    const desc = pickString(obj, ['description', 'desc', 'detail', 'details', 'reason']);
    if (label && desc && label !== desc) return { label, detail: desc };
    if (label) return { label };
    if (desc) return { label: desc };

    const nestedKeys = ['options', 'option', 'choice', 'value'];
    for (const k of nestedKeys) {
      const nested = obj[k];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const c = optionToChoice(nested);
        if (c.label && !c.label.startsWith('{')) return c;
      }
    }

    try {
      return { label: JSON.stringify(obj) };
    } catch {
      return { label: String(o) };
    }
  }
  return { label: String(o) };
}

/** 公开以便 check-ask-human-options.ts 单元测试。 */
export function coerceOptions(raw: unknown): ChoiceOption[] {
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string') {
      const t = raw[0].trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map(optionToChoice).filter((o) => o.label.length > 0);
        } catch {
          // 不是合法 JSON 数组,降级原值
        }
      }
    }
    return raw.map(optionToChoice).filter((o) => o.label.length > 0);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map(optionToChoice).filter((o) => o.label.length > 0);
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
    'Present the user with a menu of choices to pick from — not a generic "ask" tool.',
    ' DEFAULT: pass 2-6 concrete options via `options`; the user picks one and the pick comes back.',
    ' Each option may be a plain string, or an object { label, description } when the choice',
    ' involves a non-obvious tradeoff. description explains what picking that option means or',
    ' implies, so the user does not have to guess. Use plain strings when labels are self-explanatory.',
    ' FREE-TEXT (omit `options`): only when the answer truly cannot be reduced to a few choices',
    ' (e.g. "paste the error message", "enter the exact URL") — this blocks with a text input.',
    ' DO NOT call when the task is clear and you can pick a sensible default — decide and proceed.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user; keep it concise (shown as the panel title)',
      },
      options: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  description: 'Short option title (1-5 words), shown as the choice itself',
                },
                description: {
                  type: 'string',
                  description: 'What picking this option means or implies; explain the tradeoff. Fill this in whenever the label alone would leave the user unsure what they are choosing.',
                },
              },
              required: ['label'],
            },
          ],
        },
        description: '2-6 concrete choices the user can pick with one click. Required in most cases; omit only when free-form text is genuinely needed. Prefer { label, description } objects over plain strings when the tradeoff between options is not obvious from the label alone.',
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
    const options = coerceOptions(args.options);
    const context = args.context ? String(args.context) : undefined;

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
