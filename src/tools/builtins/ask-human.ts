import type { Tool } from '../types.js';
import { promptIntervention } from '../../ui/intervention.js';
import { sendState } from '../../pet/bridge.js';
import { t } from '../../i18n/index.js';

/** 单个选项:label 是选项本身,detail 是选它意味着什么/取舍(可选)。 */
export interface ChoiceOption {
  label: string;
  detail?: string;
}

/** 把单个选项元素安全地转成 {label, detail}。LLM 有时传对象而不是字符串,这里提取可读字段。 */
function optionToChoice(o: unknown): ChoiceOption {
  if (o === null || o === undefined) return { label: '' };
  if (typeof o === 'string') return { label: o.trim() };
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
      // 兜底:仍 stringify 原值,以便上游能看到真实内容做调试/日志;但若得到字面"{}"或"[]"
      // (说明 obj 本身就是个空对象),返回空 label 让 coerceOptions 的 length>0 filter 自然过滤掉,
      // 避免终端上显示「1. {}」这种对用户无意义的内容。
      const s = JSON.stringify(obj);
      if (s === '{}' || s === '[]') return { label: '' };
      return { label: s };
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

/**
 * 在通用 JSON Schema 校验前统一模型的常见错参。
 * - 兼容历史字符串选项和 description/detail 等别名；
 * - 丢弃 `{}` 等无可读内容的项；
 * - 少于两个有效选项时统一为 `options: []`，明确表示自由文本面板。
 */
export function normalizeAskHumanArguments(args: Record<string, unknown>): void {
  const options = coerceOptions(args.options);
  if (options.length < 2) {
    args.options = [];
    return;
  }
  args.options = options.slice(0, 4).map((option) => ({
    label: option.label,
    ...(option.detail ? { description: option.detail } : {}),
  }));
}

// ---------- ask_human ----------
export const askHumanTool: Tool = {
  name: 'ask_human',
  description: [
    'Ask the user a question and wait for their response.',
    ' CHOICES: pass 2-4 concrete options via `options`, each as { label, description? }.',
    ' FREE-TEXT: pass `options: []` when the answer cannot be reduced to choices (e.g. "paste the error message").',
    ' Every non-empty option requires a non-empty `label`; never emit [{}], omit label, or omit `options`.',
    ' DO NOT call when the task is clear and you can pick a sensible default.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: 1,
        description: 'The question to ask the user; keep it concise (shown as the panel title)',
      },
      options: {
        type: 'array',
        minItems: 0,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              minLength: 1,
              description: 'Short option title (1-5 words), shown as the choice itself.',
            },
            description: {
              type: 'string',
              description: 'What picking this option means or implies; explain the tradeoff when the label alone leaves the user unsure.',
            },
          },
          required: ['label'],
          additionalProperties: false,
        },
        description: 'Pass [] for free-text input, or 2-4 concrete choices with non-empty labels.',
      },
      context: {
        type: 'string',
        description: 'Background explanation shown under the title; may be multiline.',
      },
    },
    required: ['question', 'options'],
  },
  normalizeArguments: normalizeAskHumanArguments,
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
      return t('askHuman.cancelled');
    }
    if (result.action === 'submitted') {
      return t('askHuman.submitted', { value: result.value ?? '' });
    }
    return t('askHuman.selected', { value: result.value ?? '' });
  },
};
