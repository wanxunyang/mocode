import { ui } from '../ui/theme.js';
import { t } from '../i18n/index.js';
import type { SlashCommand } from '../ui/prompt.js';
import type { TranslationKey } from '../i18n/index.js';
import type { ChatErrorKind } from '../llm/index.js';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../config/index.js';

export const PROMPT = '❯ ';

/**
 * 斜杠命令树(仅用于输入菜单；分发仍走下方 if 链)。
 * 分支节点只负责导航，叶子的 value 保持现有命令文本，因此不破坏命令兼容性。
 */
export function buildSlashCommands(): SlashCommand[] {
  const d = (key: TranslationKey): string => t(key);
  return [
    { name: '/help', desc: d('commands.help') },
    { name: '/exit', desc: d('commands.exit') },
    { name: '/clear', desc: d('commands.clear') },
    { name: '/context', desc: d('commands.context') },
    { name: '/skills', desc: d('commands.skills') },
    { name: '/skill', desc: '执行某个 skill(/skill <name> [args-json])' },
    { name: '/compact', desc: d('commands.compact') },
    { name: '/resume', desc: d('commands.sessionResume') },
    { name: '/sessions', desc: d('commands.sessionBrowse') },
    { name: '/rollback', desc: d('commands.sessionRollback') },
    {
      name: '/memory',
      desc: d('commands.memory'),
      children: [
        { name: 'overview', value: '/memory', desc: d('commands.memoryOverview') },
        { name: 'toggle', value: '/memory_switch', desc: d('commands.memoryToggle') },
        { name: 'on', value: '/memory_switch on', desc: d('commands.memoryOn') },
        { name: 'off', value: '/memory_switch off', desc: d('commands.memoryOff') },
        { name: 'status', value: '/memory_status', desc: d('commands.memoryStatus') },
        { name: 'reflect', value: '/reflect', desc: d('commands.memoryReflect') },
      ],
    },
    { name: '/init', desc: d('commands.memoryInit') },
    {
      name: '/subagent',
      desc: d('commands.subagent'),
      children: [
        { name: 'on', value: '/subagent on', desc: d('commands.subagentOn') },
        { name: 'off', value: '/subagent off', desc: d('commands.subagentOff') },
        { name: 'status', value: '/subagent status', desc: d('commands.subagentStatus') },
      ],
    },
    {
      name: '/fe',
      desc: d('commands.fe'),
      children: [
        { name: 'on', value: '/fe on', desc: d('commands.feOn') },
        { name: 'off', value: '/fe off', desc: d('commands.feOff') },
        { name: 'status', value: '/fe status', desc: d('commands.feStatus') },
      ],
    },
    {
      name: '/cu',
      desc: d('commands.cu'),
      children: [
        { name: 'on', value: '/cu on', desc: d('commands.cuOn') },
        { name: 'off', value: '/cu off', desc: d('commands.cuOff') },
        { name: 'status', value: '/cu status', desc: d('commands.cuStatus') },
      ],
    },
    {
      name: '/mcp',
      desc: d('commands.mcp'),
      children: [
        { name: 'on', value: '/mcp on', desc: d('commands.mcpOn') },
        { name: 'off', value: '/mcp off', desc: d('commands.mcpOff') },
        { name: 'status', value: '/mcp status', desc: d('commands.mcpStatus') },
      ],
    },
    { name: '/theme', desc: d('commands.theme') },
    {
      name: '/model',
      desc: d('commands.model'),
      children: [
        { name: 'configure', value: '/model', desc: d('commands.modelConfigure') },
        { name: 'switch', value: '/model switch', desc: d('commands.modelSwitch') },
        { name: 'list', value: '/model list', desc: d('commands.modelList') },
        { name: 'show', value: '/model show', desc: d('commands.modelShow') },
        { name: 'use <name>', value: '/model use ', submit: false, desc: d('commands.modelUse') },
        { name: 'delete <name>', value: '/model delete ', submit: false, desc: d('commands.modelDelete') },
      ],
    },
    {
      name: '/mode',
      desc: d('commands.mode'),
      children: [
        { name: 'plan', value: '/plan', desc: d('commands.modePlan') },
        { name: 'auto', value: '/auto', desc: d('commands.modeAuto') },
      ],
    },
    {
      name: '/pet',
      desc: d('commands.pet'),
      children: [
        { name: 'toggle', value: '/pet', desc: d('commands.petToggle') },
        { name: 'skin', value: '/pet skin', desc: d('commands.petSkin') },
        { name: 'quit', value: '/pet quit', desc: d('commands.petQuit') },
      ],
    },
    {
      name: '/image',
      desc: d('commands.image'),
      children: [
        { name: 'attach <path>', value: '/image ', submit: false, desc: d('commands.imageAttach') },
        { name: 'list', value: '/image list', desc: d('commands.imageList') },
        { name: 'clear', value: '/image clear', desc: d('commands.imageClear') },
      ],
    },
    {
      name: '/language',
      desc: d('commands.language'),
      children: [
        { name: 'zh-CN', value: '/language zh-CN', desc: d('commands.languageZh') },
        { name: 'en', value: '/language en', desc: d('commands.languageEn') },
      ],
    },
    {
      name: '/upgrade',
      desc: d('commands.upgrade'),
      children: [
        { name: 'now', value: '/upgrade', desc: d('commands.upgradeNow') },
        { name: 'check', value: '/upgrade check', desc: d('commands.upgradeCheck') },
        { name: 'status', value: '/upgrade status', desc: d('commands.upgradeStatus') },
      ],
    },
  ];
}

/** 从菜单树递归生成 /help 内容；叶子 value 与菜单路径不同则同时展示真实命令。 */
export function slashHelpLines(nodes: SlashCommand[] = buildSlashCommands(), parentPath = '', depth = 0): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const menuPath = parentPath ? `${parentPath} ${node.name}` : node.name;
    const isBranch = Boolean(node.children?.length);
    const actual = node.value?.trimEnd();
    const mapping = actual && actual !== menuPath ? ` ${ui.dim}→ ${actual}${ui.reset}` : '';
    const marker = isBranch ? ` ${ui.dim}›${ui.reset}` : '';
    lines.push(
      `${'  '.repeat(depth)}${ui.accent}${menuPath}${ui.reset}${marker}${mapping}  ${ui.dim}${node.desc}${ui.reset}`,
    );
    if (node.children?.length) lines.push(...slashHelpLines(node.children, menuPath, depth + 1));
  }
  return lines;
}

/** chat 常见错误类别 → 中文引导文案的 i18n 键(识别不出的错误不走这张表,保留原始诊断)。 */
export const LLM_ERROR_HINT_KEYS: Record<ChatErrorKind, TranslationKey> = {
  auth: 'repl.llmAuthError',
  quota: 'repl.llmQuotaError',
  timeout: 'repl.llmTimeoutError',
  network: 'repl.llmNetworkError',
  context: 'repl.llmContextError',
};

/** /help 的分组:按使用场景归组,组内保持菜单树顺序。未列入的顶层命令兜底进「其他」。 */
export const HELP_GROUPS: { key: TranslationKey; names: string[] }[] = [
  { key: 'help.groupFrequent', names: ['/help', '/clear', '/context', '/compact', '/resume', '/model'] },
  { key: 'help.groupSession', names: ['/sessions', '/rollback', '/memory', '/skills', '/skill', '/init'] },
  {
    key: 'help.groupConfig',
    names: ['/mode', '/subagent', '/fe', '/mcp', '/theme', '/pet', '/image', '/language', '/upgrade'],
  },
];

/**
 * 菜单树里全部可用命令名(含分支路径与叶子的真实命令),供未知命令纠错建议用。
 * /quit、/frontend 确实可用但没登记进菜单树,单独补上——否则用户照提示打了却仍被判未知。
 */
export function knownCommandNames(): string[] {
  const out: string[] = [];
  const walk = (nodes: SlashCommand[], parent: string): void => {
    for (const node of nodes) {
      const path = parent ? `${parent} ${node.name}` : node.name;
      out.push(path);
      const actual = node.value?.trim();
      if (actual) out.push(actual.split(/\s+/)[0]);
      if (node.children?.length) walk(node.children, path);
    }
  };
  walk(buildSlashCommands(), '');
  out.push('/quit', '/frontend');
  return [...new Set(out)];
}

/**
 * 是否"长得像一条斜杠命令":单个前导 / + 词字符(字母开头,可含数字/下划线/连字符)。
 * 用来把 /hepl 这类拼写错误与 /tmp/foo、/src/index.ts:12:5 这类路径区分开——
 * 后者在编码 agent 里很常见,同样以 / 开头,绝不能被当成命令拦下。
 */
export function isCommandShape(cmd: string): boolean {
  return /^\/[A-Za-z][\w-]*$/.test(cmd);
}

/** Levenshtein 距离(标准 DP)。短命令字符串,直接两行数组滚动即可。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1, // 删
        cur[j - 1] + 1, // 插
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // 替换/相同
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 未知命令的纠错建议:返回编辑距离最近且在阈值内的命令名,没有则 null(不要瞎猜)。 */
export function suggestCommand(input: string): string | null {
  // 阈值随长度放宽,但对短命令保持严格:/hepl(5) vs /help 距离 2 → 命中;
  // /x(2) 不该被建议成任何东西。
  const threshold = Math.max(1, Math.ceil(input.length / 3));
  let best: string | null = null;
  let bestDist = Infinity;
  for (const name of knownCommandNames()) {
    if (name === input) continue; // 别建议"你自己"(分支节点如 /mode 也在候选里)
    const d = editDistance(input, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return bestDist <= threshold ? best : null;
}

/** 主题名 → 本地化描述。 */
export function themeDescription(name: string): string {
  const key = `theme.${name}` as TranslationKey;
  return name in
    {
      default: 1,
      light: 1,
      solarized: 1,
      gruvbox: 1,
      nord: 1,
      orange: 1,
      rose: 1,
      emerald: 1,
      amber: 1,
      lavender: 1,
      sunset: 1,
    }
    ? t(key)
    : '';
}

/** /model 预设后端：同时声明原生协议；旧服务继续走 OpenAI-compatible。 */
export const MODEL_PRESETS: {
  label: string;
  provider: 'openai' | 'anthropic';
  baseURL: string;
  model: string;
  window: number;
  anthropicPromptCache: boolean;
}[] = [
  {
    label: 'Anthropic Claude',
    provider: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    window: 200000,
    anthropicPromptCache: true,
  },
  {
    label: 'GLM(智谱)',
    provider: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/v3',
    model: 'glm-4.6',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
  {
    label: 'DeepSeek',
    provider: 'openai',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
  {
    label: 'Qwen(阿里)',
    provider: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
  // MiniMax OpenAI 兼容端点(https://platform.minimax.io/docs/api-reference/text-openai-api)。
  // MiniMax-M3 为唯一支持图片/视频输入的模型;M2 系列纯文本(见 llm/capabilities.ts KNOWN_TEXT_ONLY_PREFIXES)。
  {
    label: 'MiniMax',
    provider: 'openai',
    baseURL: 'https://api.minimax.io/v1',
    model: 'MiniMax-M3',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
  {
    label: '本地 Ollama',
    provider: 'openai',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
  {
    label: '本地 vLLM',
    provider: 'openai',
    baseURL: 'http://localhost:8000/v1',
    model: 'default',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
  {
    label: '自定义 base_url',
    provider: 'openai',
    baseURL: '',
    model: '',
    window: DEFAULT_CONTEXT_WINDOW_TOKENS,
    anthropicPromptCache: false,
  },
];

/** apiKey 脱敏:只露末 4 位,前面打星号(显示用,绝不把明文 key 写进内容区)。 */
export function maskKey(k: string): string {
  if (!k) return '(未设置)';
  if (k.length <= 8) return '****';
  return `${'='.repeat(Math.min(k.length - 4, 20))}${k.slice(-4)}`;
}
