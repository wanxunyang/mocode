import type { Tool } from '../types.js';
import { promptWithMail } from '../../mail/index.js';
import { sendState } from '../../pet/bridge.js';
import { t } from '../../i18n/index.js';
import type { InterventionResult } from '../../ui/intervention.js';

/** 单个选项:label 是选项本身,detail 是选它意味着什么/取舍(可选)。 */
export interface ChoiceOption {
  label: string;
  detail?: string;
}

/** 宿主注入的问答通道：把问题交给上层（例如 Super Agent 控制面）去问真人。 */
export interface AskHumanRequest {
  question: string;
  options: ChoiceOption[];
  context?: string;
}
export type AskHumanHandler = (request: AskHumanRequest) => Promise<InterventionResult>;

/**
 * 进程级问答通道。缺省 null = 直接弹本地面板。
 * Supervised Host 在启动时注入一条「转成 approval_requested 事件」的通道，
 * 这样 Worker 里的 ask_human 就不是「不可用」，而是由控制面转给真人。
 */
let askHumanHandler: AskHumanHandler | null = null;

export function setAskHumanHandler(handler: AskHumanHandler | null): void {
  askHumanHandler = handler;
}

export function getAskHumanHandler(): AskHumanHandler | null {
  return askHumanHandler;
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
    ' CHOICES: pass 2-4 concrete options via `options`, each as { label, description? }; every non-empty option requires a non-empty `label`.',
    ' FREE-TEXT: pass `options: []` when the answer cannot be reduced to choices (e.g. "paste the error message").',
    ' MUST call BEFORE any decision the user has not made (multiple reasonable approaches) or any key modification (public API, schema, dependencies, file moves/deletes, architecture, security, large or irreversible changes); never decide these yourself.',
    ' Skip only for trivial details that follow repository precedent and are easily reversible.',
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
              description:
                'What picking this option means or implies; explain the tradeoff when the label alone leaves the user unsure.',
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

    // 宿主注入了通道（Supervised Host）→ 把问题交上去由控制面转给真人。
    // 没有通道又有 MOCODE_SUPERVISED_WORKER=1：说明这次派活没有能应答的人（单发 CLI），
    // 非 TTY 面板会自动选首项，等于替用户做关键决定——所以明确报不可用，让 Worker 写进 handoff risks。
    const handler = askHumanHandler;
    if (!handler && process.env.MOCODE_SUPERVISED_WORKER === '1') {
      return 'ask_human is unavailable in this supervised worker: no human can answer here. Do not guess a decision; record the open question and its options in your handoff risks and stop.';
    }

    sendState('waiting_human');
    const result = handler
      ? await handler({ question, options, ...(context ? { context } : {}) })
      : await promptWithMail({
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
