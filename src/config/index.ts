import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { getCurrentSessionId } from '../session/state.js';
import { getNotesFilePath, extractActiveNotesSections } from '../session/notes.js';
import { buildGuiActionsSection } from '../session/gui-actions.js';
import { buildWorkDisciplineSection, inferModelFamily } from '../agent/work-discipline.js';
import { buildValidationCommandsSection } from '../verification/prompt.js';
import { getActivePresetName, readPreset } from './presets.js';
import { detectLanguage, setLanguage, t, type Language } from '../i18n/index.js';
import { isProfileName, profileHasGroup, type ProfileName } from './profiles.js';
// 端点常量归协议实现方(jev-client.ts,纯叶子无 import,不引入环);此处只引用不重定义。
import { DEFAULT_JEV_BASE_URL } from '../tools/jev-client.js';
// shell.ts 是纯叶子(只 import node 内置):PLATFORM_NOTE 的措辞必须跟 run_command/dev_server
// 实际 spawn 的默认 shell 一致,单一事实源,防「文案说 cmd、实际跑 bash」漂移。
import { defaultShellKind } from '../runtime/shell.js';

/**
 * 按优先级加载配置文件并回填 process.env:
 *   候选(后者覆盖前者,优先级升序):<cwd>/.env(兼容旧用法,最低)→ ~/.mocode/config(全局)→ <cwd>/.mocode/config(项目级覆盖,最高)。
 *   合并后只回填 process.env 里**尚未设置**的键——shell 里 export 的环境变量永远优先。
 * 故 `mocode` 可在任意目录 / 任意终端启动:全局配置(~/.mocode/config)兜底(/model 与 mocode config 写此),
 *   项目级 .mocode/config 按需覆盖全局;旧用法 .env 优先级最低,不再盖过全局 config——
 *   否则 /model 写入 ~/.mocode/config 的 LLM 键会被项目 .env 里的同名旧值盖回。
 */
function loadEnvFiles(): void {
  const candidates = [
    path.join(process.cwd(), '.env'), // 兼容旧用法,优先级最低
    path.join(os.homedir(), '.mocode', 'config'), // 全局(/model 与 mocode config 写此)
    path.join(process.cwd(), '.mocode', 'config'), // 项目级覆盖,优先级最高
  ];
  const fromFiles: Record<string, string> = {};
  for (const p of candidates) {
    try {
      Object.assign(fromFiles, dotenv.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      // 文件不存在或不可读:跳过
    }
  }
  for (const [k, v] of Object.entries(fromFiles)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// 在 loadEnvFiles 回填前捕获:MOCODE_THEME / MOCODE_LANGUAGE 是否由 shell 设置。
const themeFromShell = process.env.MOCODE_THEME !== undefined;
export const languageFromShell = process.env.MOCODE_LANGUAGE !== undefined;
// 在 loadEnvFiles 回填前捕获:哪些 LLM 键由 shell 设置(决定 /model 写文件是否下次启动生效)。
// 仿 themeFromShell 模式:shell export 的环境变量在 loadEnvFiles 中不被回填(优先级最高),
// 故 /model 写入 ~/.mocode/config 的同名键下次启动会被 shell 值覆盖——据此给 dim 警告。
const LLM_ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'CONTEXT_WINDOW_TOKENS',
  'ANTHROPIC_PROMPT_CACHE',
] as const;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;
const llmKeysFromShell = LLM_ENV_KEYS.filter((k) => process.env[k] !== undefined);
loadEnvFiles();

/**
 * 旧 profile 兼容状态：仅供未传 ToolPolicy 的嵌入调用与迁移测试。官方 TUI/stdio
 * 每个真实用户 turn 都使用 LLM route，且不再提供 /profile 用户命令。
 */
let activeProfile: ProfileName = isProfileName(process.env.MOCODE_MODE) ? process.env.MOCODE_MODE : 'coding';
if (process.env.MOCODE_MODE !== undefined && !isProfileName(process.env.MOCODE_MODE)) {
  console.warn(
    `[mocode] 未知 MOCODE_MODE="${process.env.MOCODE_MODE}",回退 coding(可选: coding|frontend|computer-use|research|full)`,
  );
}

/**
 * 激活预设覆盖:若用户曾用 /model 激活过预设,启动时让上下文窗口等配置**跟随该预设文件**,
 * 而不是只信 config 文件里上一组裸 LLM 键——这正是"切换后窗口不再退回 256k"的关键。
 * 逐字段覆盖,且 shell 已显式设置的键**不覆盖**(保持 shell 环境变量最高优先级)。
 * 不 import repl,无副作用;读失败(指针失效/文件坏)静默回退到 config 文件裸键。
 */
const __activePreset = (() => {
  const n = getActivePresetName();
  return n ? readPreset(n) : null;
})();
setLanguage(detectLanguage(process.env.MOCODE_LANGUAGE));

export type LlmProvider = 'openai' | 'anthropic';

export function normalizeLlmProvider(value: unknown): LlmProvider {
  return typeof value === 'string' && value.toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

export interface Config {
  /** 上游原生协议。缺省为 openai，保持旧配置与 OpenAI-compatible 网关兼容。 */
  provider: LlmProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
  /** 模型上下文窗口(token)。全局默认 256000，可通过环境变量或 /model 覆盖。 */
  contextWindowTokens: number;
  /** 流式请求里带 stream_options.include_usage 拿真实 usage。后端不认 stream_options 时关掉。 */
  includeUsage: boolean;
  /** Anthropic Prompt Caching。开启时在稳定 system/tools 前缀设置 ephemeral cache breakpoint。 */
  anthropicPromptCache: boolean;
  /** 自动压缩总开关。关掉则只靠手动 /compact。 */
  autoCompact: boolean;
  /** Typed context encoding for old logs/searches during real pressure only.
   * Normal tool results remain raw (apart from the hard per-result safety cap).
   * Default true; set MOCODE_CONTEXT_OPTIMIZE=false to disable this stage. */
  contextOptimize: boolean;
  /** Exact supersession pruning during real pressure only. Normal history is never
   * rewritten outside pressure. Default true; set MOCODE_CONTEXT_RELPRUNE=false to disable it. */
  contextRelprune: boolean;
  /** Lifecycle provenance tracking only. It no longer ages or stubs history by
   * tool-call count. Default true; set MOCODE_LIFECYCLE=false to disable tracking. */
  contextLifecycle: boolean;
  /** Context Budget Scheduler 总开关(五区分账 + 统一 80% pressure 调度)。
   *  关掉仍由 maybeCompact(history) 使用同一 80% 基础保护线。
   *  默认 true;设 MOCODE_BUDGET_SCHEDULER=false 全局回退。 */
  contextBudget: boolean;
  /** 后台反思 pass 总开关。关掉则只靠手动 /reflect + 机会主义 memory_update。 */
  autoReflect: boolean;
  /**
   * Memory Index / 后台反思开关。`true` 时把紧凑索引注入 prompt；`false` 时不注入。
   * memory 工具是否可被自动路由由 MEMORY_ENABLED capability gate 单独判定：仅显式
   * `false` 才禁止，unset 仍可按需路由。/memory_switch 同时设置两者。
   */
  memoryEnabled: boolean;
  /** 每 N 个轮次触发一次后台反思 pass(与 agent 并发,不阻塞)。默认 5。 */
  reflectEveryN: number;
  /** 每轮 agent 循环最大步数(防无限循环)。默认 25。 */
  maxSteps: number;
  /** orchestration 的兼容配置镜像；官方主路径以 MOCODE_SUBAGENT_ENABLED capability gate + ToolPolicy 为准。 */
  subAgentEnabled: boolean;
  /** browser-debug / desktop-observe 的兼容配置镜像；不会让工具常驻 schema。 */
  frontendToolsEnabled: boolean;
  /** computer-control 的兼容配置镜像；不会让高危工具常驻 schema。 */
  computerUseEnabled: boolean;
  /** MCP 总开关。默认开启；关闭时启动不读取 MCP 配置、不连接服务。/mcp on|off 改写下次启动状态。 */
  mcpEnabled: boolean;
  /** 子 Agent 默认步数上限，只防止无限循环；调用方可按任务提高。 */
  subAgentMaxSteps: number;
  /** 同一轮内派发的多个子 agent 的并发上限(≥1)；1 即退化为逐个串行。 */
  subAgentConcurrency: number;
  /** 会话落盘目录(cwd 下)。 */
  sessionDir: string;
  /** AnySearch 联网搜索 API key(可选)。不配则走匿名免费额度(按 IP 限流)。 */
  searchApiKey?: string;
  /** 沙箱根目录(文件操作边界,可选)。未配则 startRepl 用 process.cwd() 兜底。优先级:--sandbox-root > 本项 > cwd。 */
  sandboxRoot?: string;
  /** AnySearch API base,默认官方端点。 */
  searchBaseUrl: string;
  /** 单张图片内联字节上限(base64 前的原始字节);超此大小拒绝并提示 TODO 走 URL 上传。默认 4MB。 */
  maxImageBytes?: number;
  /** 主题名(对应 src/ui/theme.ts 的 THEMES 表键)。默认 default;shell env MOCODE_THEME 覆盖文件。 */
  theme: string;
  /** MOCODE_THEME 是否由 shell 环境变量设置(非文件回填)。若是,/theme 写文件下次启动仍被 shell 盖。 */
  themeFromShell: boolean;
  /** 由 shell 环境变量设置的 LLM 键名列表(非文件回填)。若含某键,/model 写该键下次启动仍被 shell 盖。 */
  llmKeysFromShell: string[];
  /** 工具权限系统总开关:基于 Tool.risk 字段(safe/confirm/dangerous)在执行前弹确认面板。
   *  关闭则所有工具直接放行(零交互,向后兼容旧行为)。默认 true。
   *  设 MOCODE_PERMISSION=false 全局回退。 */
  permissionEnabled: boolean;
  /** Allow confirmation-requiring tools without a TTY. Defaults false (fail closed). */
  permissionNonInteractiveAllow: boolean;
}

/**
 * 取环境变量;缺则返回空字符串(不退出)。
 * 历史上缺 LLM_BASE_URL/LLM_API_KEY 会 process.exit(1),但 /model 命令已能在 REPL 内配置模型,
 * 故首次未配置也应让 REPL 起来,由开场提示引导用户跑 /model。发消息时 chat() 会抛错被 runTurn catch,不崩。
 */
function requireEnv(key: string): string {
  return process.env[key] || '';
}

/**
 * 模型是否已配置(baseURL + apiKey 非空)。REPL 开场据此决定是否提示 /model。
 * 未配置时 config.model 仍回退 'gpt-4o-mini',但发消息会因 baseURL/apiKey 空而失败——由 runTurn catch 友好提示。
 */
export function isModelConfigured(): boolean {
  return !!config.baseURL && !!config.apiKey;
}

const PLATFORM_NOTE = (() => {
  const shell = defaultShellKind();
  if (process.platform === 'win32' && shell === 'cmd') {
    return `- This is Windows: \`run_command\`/\`dev_server\` default to \`cmd.exe /c\` — use cmd syntax and \`%VAR%\`; Unix builtins and command substitution are unavailable.
- Non-interactive cmd cannot run \`timeout /t\` (it errors out); pass \`shell: "powershell"\` with \`Start-Sleep\`, or \`shell: "bash"\` with \`sleep\`, when a wait is needed.
- Prefer read_file/glob/grep for file discovery and reading. When a POSIX shell fits better, pass \`shell: "bash"\` (Git Bash, auto-detected) or \`shell: "powershell"\`; never mix syntaxes within one command.`;
  }
  if (process.platform === 'win32') {
    // MOCODE_SHELL 翻转了默认:措辞必须跟着变,否则模型按文案写 cmd 语法却落进 bash。
    return `- This is Windows: \`run_command\`/\`dev_server\` default to ${shell} (MOCODE_SHELL override) — use ${
      shell === 'bash' ? 'POSIX syntax ($VAR, &&, forward-slash paths)' : 'PowerShell syntax ($VAR, Start-Sleep)'
    }.
- cmd-only syntax (\`%VAR%\`, \`start /b\`, \`dir\`) needs an explicit \`shell: "cmd"\`; do not mix syntaxes within one command.
- Prefer read_file/glob/grep for file discovery and reading; reach for the shell only when a dedicated tool does not fit.`;
  }
  if (process.platform === 'darwin') {
    return `- This is macOS: \`run_command\` uses bash with BSD utilities. Prefer read_file/glob/grep; account for BSD/GNU differences when shell commands are necessary.`;
  }
  return `- This is Linux/Unix: \`run_command\` uses bash. Prefer read_file/glob/grep when they fit; otherwise use standard POSIX/GNU syntax.`;
})();

/**
 * 默认「声音」(Voice):给 mocode 一点人情味与性格,贴近 ChatGPT / 豆包的语感——
 * 简洁但有温度、有观点、不谄媚、不啰嗦。这是性格的"底座"。
 * 性格主要来自**身段/语气约束**,而非长篇指令,所以这段文字很短,不撑爆系统提示。
 * 用户可用下列方式整段替换(自定义品牌声音):
 *   1. `<cwd>/.mocode/persona.md`(项目级,最高)或 `~/.mocode/persona.md`(全局)
 *   2. 环境变量 `MOCODE_PERSONA`(整段覆盖)
 * 两者皆无则用本默认底座。
 *
 * 注意:本段会被 persona 整段替换,只放语气/性格描述;行为硬约束(如 Silent
 * Execution、ask_human 白名单)必须放在 staticBody 其他段,不能落在这里。
 */
const DEFAULT_VOICE = `## Voice
- Act as a skilled engineering partner: clear, concise, practical. Avoid generic chatbot behavior.
- Give technical recommendations with brief trade-off reasoning when choices exist.
- Focus on useful information. Avoid unnecessary greetings, apologies, repetition, or filler.
- Match the user's style and language while staying task-focused.
- Disclose assumptions; ask only when the choice is user-owned (see When to ask instead of guess).`;

/** 解析用户自定义声音:persona.md 文件优先(项目级 > 全局),其次 env MOCODE_PERSONA。无则返回 ''。 */
function readPersonaFile(): string {
  const candidates = [
    path.join(process.cwd(), '.mocode', 'persona.md'),
    path.join(os.homedir(), '.mocode', 'persona.md'),
  ];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8').trim();
      if (txt) return txt;
    } catch {
      // 不存在/不可读:跳过
    }
  }
  return process.env.MOCODE_PERSONA?.trim() ?? '';
}

/** 解析最终注入的 Voice 段:用户自定义优先,否则用默认底座。 */
function buildVoiceSection(): string {
  return readPersonaFile() || DEFAULT_VOICE;
}

/**
 * Session notepad 段落：读取 .mocode/sessions/<sessionId>/notes.md，只注入 ## 标题行作为目录摘要。
 * Agent 用 write_file/edit_file/read_file 维护此文件，抗 compact（在 context window 之外）。
 * 文件不存在或为空时返空串（零开销）。
 *
 * 输出按"活跃 / 已完成"两栏分桶，让 agent 一眼看到还有未结的工作：
 *   - Active: ## Plan: ...   ## Open Questions   ## <其它正在用的 topic>
 *   - Done:   ## Done: ...   (agent 在完成时把 topic 重命名为 "## Done: ...")
 * 这样比纯目录列表更显眼，降低 agent 在长上下文里扫过去就忘了的概率。
 */
export function buildNotepadSection(sessionId = getCurrentSessionId()): string {
  const p = getNotesFilePath(sessionId);
  if (!p || !fs.existsSync(p)) return '';
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    if (!content) return '';

    // 1) 提取 ## 标题行（最多 15 个，按文件出现顺序保留）
    const headers = content
      .split('\n')
      .filter((l) => /^##\s/.test(l))
      .slice(0, 15);

    // 2) 分桶：Done: 开头 → archived；其余 → active
    //    "## Plan:" 和 "## Open Questions" 视为永久 active（不需要改名为 Done）。
    const archived: string[] = [];
    const active: string[] = [];
    for (const h of headers) {
      if (/^##\s+Done:\s/.test(h)) archived.push(h);
      else active.push(h);
    }

    if (active.length === 0 && archived.length === 0) return '';

    const totalCount = active.length + archived.length;
    const lines: string[] = [
      '',
      `## Session Notepad index (${totalCount} section${totalCount === 1 ? '' : 's'} — read \`.mocode/sessions/${sessionId}/notes.md\` to recover full context; surviving compact is the whole point of this file)`,
      `Active (${active.length}):`,
      ...(active.length ? active.map((h) => `  - ${h.replace(/^##\s+/, '')}`) : ['  - (none)']),
    ];
    if (archived.length) {
      lines.push(`Done (${archived.length}):`);
      lines.push(...archived.map((h) => `  - ${h.replace(/^##\s+/, '')}`));
    }
    lines.push('');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 抽取 notes.md 中**唯一活跃**的 `## Plan:` 段原文（含标题行到下一个 `## ` 之前）。
 * 用于 compact 后把计划重注入系统提示，避免 agent 因上下文压缩丢失执行计划。
 * 已结算（`## Done:`）或无 plan 时返回 null。
 */
export function extractActivePlanSection(sessionId = getCurrentSessionId()): string | null {
  const p = getNotesFilePath(sessionId);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const normalized = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const start = lines.findIndex((l) => /^## Plan:\s*.+$/.test(l));
    if (start < 0) return null;
    const endOffset = lines.slice(start + 1).findIndex((l) => /^##\s/.test(l));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    return lines.slice(start, end).join('\n').trimEnd();
  } catch {
    return null;
  }
}

/** compact 重注入用的幂等标记：history[0] 中夹住活跃 plan 块，重复注入只替换不累积。 */
const ACTIVE_PLAN_MARKER = '\n\n<!-- mocode:active-plan -->\n';

/**
 * 把活跃 `## Plan:` 段重注入系统提示（history[0]）。compact 后调用：
 * 若 notes.md 有活跃 plan，则覆盖旧标记块写入最新内容；若无，则清掉残留标记块。
 * 直接改 history[0].content（compact 不破坏 index 0），幂等，返回是否改动。
 */
export function reinjectActivePlanIntoSystem(history: { role: string; content?: unknown }[]): boolean {
  const sys = history[0];
  if (!sys || sys.role !== 'system' || typeof sys.content !== 'string') return false;
  let content = sys.content;
  const markerIdx = content.indexOf(ACTIVE_PLAN_MARKER);
  if (markerIdx >= 0) {
    content = content.slice(0, markerIdx).replace(/\s+$/, '');
  }
  const plan = extractActivePlanSection();
  if (!plan) {
    if (markerIdx < 0) return false;
    sys.content = content;
    return true;
  }
  sys.content = `${content}${ACTIVE_PLAN_MARKER}${plan}\n`;
  return true;
}

/** compact 重注入用的幂等标记:history[0] 中夹住会话笔记段正文(Findings/Decisions/Open Questions/Risks),
 *  重复注入只替换不累积。与 ACTIVE_PLAN_MARKER 独立,互不干扰。 */
const NOTES_BODY_MARKER = '\n\n<!-- mocode:session-notes -->\n';

/**
 * 把会话笔记段正文重注入系统提示(history[0])。compact 后或本步改了 notes.md 时调用:
 * 若 notes.md 有活跃笔记段(extractActiveNotesSections 返回非空,已按 5k token 预算裁剪),
 * 则覆盖旧标记块写入最新内容;若无,则清掉残留标记块。直接改 history[0].content,
 * 幂等,返回是否改动。与 reinjectActivePlanIntoSystem 独立:plan 段由后者管,笔记段由本函数管。
 */
export function reinjectSessionNotesIntoSystem(history: { role: string; content?: unknown }[]): boolean {
  const sys = history[0];
  if (!sys || sys.role !== 'system' || typeof sys.content !== 'string') return false;
  let content = sys.content;
  const markerIdx = content.indexOf(NOTES_BODY_MARKER);
  if (markerIdx >= 0) {
    content = content.slice(0, markerIdx).replace(/\s+$/, '');
  }
  const notes = extractActiveNotesSections();
  if (!notes) {
    if (markerIdx < 0) return false;
    sys.content = content;
    return true;
  }
  sys.content = `${content}${NOTES_BODY_MARKER}${notes}\n`;
  return true;
}

/**
 * 一次性重注入会话状态(plan 段 + 笔记段)到系统提示。返回任一 marker 是否改动。
 *
 * @deprecated 热路径已不再调用(#prompt-cache):往 history[0] 追加 plan/笔记会让
 *   系统提示每次 plan_update / note_append 后变字节,前缀缓存整段失效(系统提示 6-8k token,
 *   本轮后续每步全价重算)。现由 agent/core 每步在 requestHistory **末尾**注入
 *   {@link buildSessionStateReminder} 的 ephemeral system 消息:模型看到的信息等价,
 *   但变动落在前缀末端。本函数仅留给外部集成 / 旧测试,新增调用点请勿使用。
 */
export function reinjectSessionStateIntoSystem(history: { role: string; content?: unknown }[]): boolean {
  const planChanged = reinjectActivePlanIntoSystem(history);
  const notesChanged = reinjectSessionNotesIntoSystem(history);
  return planChanged || notesChanged;
}

/**
 * 构造"会话状态提醒"正文(活跃 `## Plan:` 段 + 活跃笔记段 + GUI 动作台账),供 agent/core
 * 每步拼进 requestHistory **末尾**的 ephemeral system 消息。
 *
 * 为什么在尾部而不是 history[0](prompt 缓存):plan_update / note_append 是设计上鼓励
 * 高频调用的工具,一旦它们改写系统提示,支持自动前缀缓存的后端(OpenAI / DeepSeek /
 * GLM / Qwen)就会从第一个 token 起全部 miss。放到历史末尾后,前面整段(系统提示 + 全部
 * 已有对话)保持逐字节稳定,只有尾部这一小条随来源文件变化。
 *
 * 台账段同样在尾部 → 抖动免费(anthropic provider 明确"动态 session reminder 不参与缓存
 * 断点"),所以它可以每步都重写一遍,不需要像图片窗口那样成批淘汰。
 *
 * 纯读函数:不改 history,也不写文件。三者皆空时返回 ''(零开销)。
 */
export function buildSessionStateReminder(sessionId = getCurrentSessionId()): string {
  const plan = extractActivePlanSection(sessionId);
  const notes = extractActiveNotesSections(undefined, sessionId);
  const guiActions = buildGuiActionsSection(sessionId);
  if (!plan && !notes && !guiActions) return '';
  const sources = [notes || plan ? 'notes.md' : '', guiActions ? 'gui-actions.log' : ''].filter(Boolean).join(' + ');
  const parts = [
    `## Session state (current, from ${sources})`,
    'Mirrors live session state, refreshed every step; authoritative — ignore older copies earlier in this conversation.',
    ...(plan ? [plan] : []),
    ...(notes ? [notes] : []),
    ...(guiActions ? [guiActions] : []),
  ];
  return parts.join('\n\n');
}

/** AGENTS.md 自动导入正文上限:system 位于 history[0] 且 compactHistory 不压缩 system,超长需截断防占窗口(见 memory/README.md)。 */
const MAX_AGENTS_IMPORT_CHARS = 20000;

/**
 * 不常驻注入的章节(压成指针行,read_file 按需取全文):
 * - 目录结构 / Directory structure / Project layout —— 架构探索任务用 codegraph/探查工具现查更准;
 * - 扩展点 / Extension points —— 只在「加新工具/命令/模块」类任务才需要,恰好是 skill 的定义。
 * 常驻价值密度最高的「项目/命令/约定」(市场实证 arXiv 2511.12884:build/run 62.3%、conventions 主流)全文保留。
 * 章节标题大小写不敏感,兼容英文写法的 AGENTS.md。
 */
const AGENTS_INJECTION_INDEX_SECTIONS = [
  '目录结构',
  '扩展点',
  'directory structure',
  'project layout',
  'extension points',
];

/**
 * AGENTS.md 按章节过滤注入:命中 {@link AGENTS_INJECTION_INDEX_SECTIONS} 的 H2 章节整段压缩成一行指针,
 * 其余章节(preamble、## 项目、## 命令、## 约定及未知章节)逐字保留。
 * H1 及更深层级不动;空文件/无章节文件原样返回。导出供单测直接断言。
 */
export function filterAgentsSectionsForInjection(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inIndexedSection = false;
  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      const title = h2[1].trim().toLowerCase();
      // 前缀匹配容忍「目录结构(monorepo)」「Directory Structure — monorepo」等后缀写法;
      // 仅当后缀紧邻(空格/括号/冒号/破折号)时命中,避免误伤「约定与目录结构习惯」这类反向词序。
      inIndexedSection = AGENTS_INJECTION_INDEX_SECTIONS.some(
        (s) => title === s || new RegExp(`^${s}[\\s(:\\u2014\\uff08\\(]`).test(title),
      );
      if (inIndexedSection) {
        out.push(`- ${h2[1].trim()}: (not injected — read_file AGENTS.md on demand)`);
        continue;
      }
    }
    if (!inIndexedSection) out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 工作区根 AGENTS.md 自动导入段:与 memory 开关完全无关——
 * 只要 <cwd>/AGENTS.md 存在就把正文直接拼进 prompt(超 {@link MAX_AGENTS_IMPORT_CHARS} 截断+末尾提示),
 * 不再只指路让模型按需 read_file。读失败静默跳过(返空串)。
 *
 * 瘦身(方案A):目录结构/扩展点两章节不常驻,压成指针行——模型真做架构/扩展任务时
 * 一次 read_file 取全文(渐进披露,与 Skills 清单同构);截断上限作用于过滤后的正文。
 */
function buildAgentsImportSection(): string {
  try {
    const projectAgents = path.join(process.cwd(), 'AGENTS.md');
    if (!fs.existsSync(projectAgents)) return '';
    const raw = fs.readFileSync(projectAgents, 'utf8').trim();
    if (!raw) return '';
    const filtered = filterAgentsSectionsForInjection(raw);
    const body =
      filtered.length > MAX_AGENTS_IMPORT_CHARS
        ? `${filtered.slice(0, MAX_AGENTS_IMPORT_CHARS)}\n…[AGENTS.md truncated: first ${MAX_AGENTS_IMPORT_CHARS} characters injected]`
        : filtered;
    return (
      `\n## Project memory (AGENTS.md, auto-imported)\n${body}\n` +
      '- AGENTS.md may be stale: current code and the user request override stale memory.\n' +
      '- Discovered a stable, non-obvious project fact worth persisting? write_file(append=true) one line to `.mocode/agents-draft.md`; the user merges drafts into AGENTS.md via /init.'
    );
  } catch {
    return ''; // 读失败静默跳过:不让导入破坏 prompt 构建
  }
}

/** 日期段构建:给模型当前日期与时区,供 freshness/时效判断。失败静默返 ''。 */
function buildTodaySection(): string {
  try {
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(
      2,
      '0',
    )}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local timezone';
    return `## Now\nToday is ${iso} (${tz}).`;
  } catch {
    return '';
  }
}

/**
 * plan 模式追加到系统提示末尾的指令(切到 plan 模式时由 repl 拼进 history[0])。
 * 与 SYSTEM_PROMPT 同语种(英文),指示:只读探查、产出步骤化计划、不执行、审批后回 auto。
 *
 * 工具名不在这里静态枚举；plan snapshot 会从当前自动路由结果中剔除所有写入/执行能力。
 *
 * .codegraph/ 存在性动态决定是否提示 codegraph skill。
 */
function buildPlanResearchRules(): string {
  const cg = hasCodegraphIndex() ? ' Prefer the available codegraph skill for call paths and blast radius.' : '';
  return `
- Locate relevant code and conventions without repeating retrieved work.${cg}
- Return an actionable plan with affected files, ordered steps, edge cases, and verification.
- When ready, call \`ask_human\` with exactly: "${t('plan.approveOption')}", "${t('plan.refineOption')}", and "${t('plan.cancelOption')}". Approval requires the user to switch to /auto; never execute or switch modes silently.`;
}

function buildPlanModeSuffix(): string {
  return `

## ⛯ PLAN MODE (active now)
Investigate and design only. Use only the read-only tools currently exposed; do not execute commands or change files.
${buildPlanResearchRules()}`;
}

/** 兼容旧名字:repl 的 buildSystemMessage 仍引 PLAN_MODE_SUFFIX(变量)。运行时按需现拼。 */
export function buildBasePrompt(sessionId = getCurrentSessionId()): string {
  const agentsImportSection = buildAgentsImportSection();
  const notepadSection = buildNotepadSection(sessionId);

  // 静态主体:稳定段落集中在前,让支持 prompt caching 的后端能命中前缀缓存(#12)。
  // 约束:staticBody 的前缀段(尤其 ## Identity 第一行)必须是纯静态文本,
  // 不得嵌入会话级可变函数调用(如 config.model)。否则 /model 切换会让最敏感的
  // 前缀变化,破坏自动前缀缓存命中。
  // 回复语言不写入提示词:模型按用户当轮提问语言自动识别(Voice 段的
  // "Match the user's style and language" 已覆盖),/language 只切换终端 UI 文案。
  const staticBody = `## Identity
You are mocode, a terminal coding agent created by Wan Engineer.

## Core behavior
Complete programming tasks through an "analyze → call tool → observe result → decide next step" loop until solved.

## Modes
- AUTO (default): complete tasks with the tools currently exposed.
- PLAN: read-only design; no changes until the user approves and switches back.

## Workflow
- Understand: use existing conversation and tool evidence before gathering more.
- Plan: for tasks with 3+ steps or context-loss risk, record the plan with the \`plan_update\` tool (see Session state).
- Implement: edit against a fresh read (see Tool policy); change scope follows Engineering principles.
- Verify: whether and what to run follows Engineering principles; use Validation commands for exact commands.
- Report: stop when done and give honest conclusions with path:line references (see Reporting).
- Use web search only when freshness materially affects the answer.
${buildCodegraphSection()}
${buildValidationCommandsSection()}

## Engineering principles
${buildWorkDisciplineSection(inferModelFamily(config.model))}

## Tool policy
- Silent Execution: invoke tools directly without preamble. Output visible text ONLY for the final answer and critical mid-task findings. Strictly no step-by-step narration (no "let me…", "让我先…", "now checking…" between calls).
- Go directly to a known path or symbol; use discovery tools only when the location is unknown.
- Edit against a FRESH read: before any edit_file or a replacing write_file, call read_file on the exact path and copy both its latest hash and the exact target text. Never reconstruct old_string from a grep/summary/diff — those lose whitespace and indentation and cause edit failures. (write_file with append=true is the exception: it reads and hashes the file itself, so no prior read_file and no expected_hash are needed.)
- A read_file hash from before a compaction, session resume, edit conflict, or external change is STALE and will be rejected — re-read rather than reuse an old hash.
- Emit multiple independent tool calls in ONE assistant message so they run concurrently — e.g. several read_file regions, a grep plus a glob, or several web_fetch calls. One lookup per message wastes a full model round-trip each time. Place parallel-safe calls consecutively; keep any call that depends on their results (e.g. an edit) for the next message.
- Never batch a read with an edit that depends on it; do not repeat overlapping reads or unchanged failed calls.
- On failure, inspect the full error, change the approach, and retry only with a reason. Drop stale tool output when it no longer supports the task.
- For generated content over roughly 200 lines or 5K tokens, write it in stages: first write_file the initial chunk, then extend it with write_file(append=true, content=<next chunk>) — each call stays small and the file grows transactionally. Appends are VERBATIM: if the file does not already end with a newline, begin your chunk with "\\n" so lines do not merge.

## Environment
${PLATFORM_NOTE}

## Safety
- Get confirmation before irreversible or outward-facing actions such as deletion, push, production changes, or external requests, unless explicitly authorized.
- Stay within the authorized workspace and disclose anything skipped or unverifiable.

${buildVoiceSection()}

## Reporting
- Stop immediately when no more tools are needed; give conclusions directly.
- **Do not stop prematurely during exploration**: if you started investigating but haven't gathered enough information to answer the user's question, keep calling tools. Only stop when you have sufficient evidence or hit a dead end.
- **No flattery / no preamble in conclusions**: skip "Sure", "好的", "我已经完成了" and similar no-information prefixes — jump straight to substance.
- Report honestly: say success when successful, say where you're stuck when failing, and mention anything skipped. Reference code in "path:line" format (e.g., src/index.ts:42). Keep it concise.`;

  // 动态段(置于末尾):AGENTS.md 项目记忆 + notepad 索引/说明。工具簇特定指导由
  // ToolPolicyController.reminder() 按当前 turn 的 route 注入，避免旧全局 profile 与真实 schema 分裂。
  // 按需注入(#13):有内容的索引才拼对应标题,避免空标题噪声。
  const dynamicParts: string[] = [];

  // 会话级私有尾段(子 agent 切片会丢弃):Session state 说明无条件注入在前,Project context 按需在后。
  dynamicParts.push(
    `## Session state (\`.mocode/sessions/${sessionId ?? '<id>'}/notes.md\`)\n` +
      'Persistent working surface for tasks with 3+ steps or context-loss risk; skip it for simple work. It survives compaction.\n\n' +
      'Record and update the execution plan with the `plan_update` tool (not by hand-editing checkboxes); it keeps at most one active plan:\n' +
      '```\n' +
      '## Plan: <title>\n' +
      'Goal: <outcome>\n' +
      '### Steps\n' +
      '- [ ] 1. **<short label, ≤20 chars>** — <self-contained step: target file/symbol, the change, and how to verify>\n' +
      '### Progress\n' +
      '- <completed/total>\n' +
      '```\n' +
      'Each step: short `title` (≤20 chars, e.g. "编写测试" / "修 status bar", shown in the status bar) + self-contained `content` (target file/symbol, exact change, verification — readable cold, without this conversation). ' +
      'Keep at most one step in_progress; mark a step completed as soon as its work is done, not batched to the end of the turn. ' +
      'plan_update creates notes.md on demand and settles the plan to `## Done:` when all steps complete; run read_file on the full notes.md to recover context after compaction. ' +
      'Keep other notes concise and session-specific; use memory for stable cross-session facts.\n' +
      '## Session notes (resident memory)\n' +
      'For lasting-value discoveries — subtle constraints, decisions with downstream impact, open questions, or risks — call `note_append` IMMEDIATELY when you make the discovery. Notes land in the same notes.md and are re-injected into the prompt automatically (5k-token budget), surviving compaction. Do NOT use for routine progress (that is the plan) or stable cross-session facts (that is memory_save). Each call appends one item.',
  );

  // 日期段:模型需要知道今天才能判断 freshness(web 搜索、版本时效)。只随天变化,
  // 不破坏会话内前缀缓存;置于 '## Session state' 之前,子 agent 切片仍保留(无害且有用)。
  const todaySection = buildTodaySection();
  if (todaySection) dynamicParts.unshift(todaySection);

  const ctxContent = `${agentsImportSection}${notepadSection}`.trimEnd();
  if (ctxContent) {
    dynamicParts.push(`## Project context\n${ctxContent}`);
  }

  return `${staticBody}\n\n${dynamicParts.join('\n\n')}`;
}

/** 静态主体结束 + 会话私有段起点标记,供 buildMocodeCorePrompt 稳健切片(#17)。 */
const MARKER_STATIC_END = '## Reporting';
const MARKER_DYNAMIC_SECTION = '## Project context';
const MARKER_DROPPABLE_SECTION = '## Session state';

/**
 * Stable, production-grade behavior shared by main and sub agents.
 * It intentionally excludes the trailing session-specific payload (notepad
 * instructions + dynamic Project context block), while retaining the exact
 * editing, verification, recovery, safety, and reporting rules.
 *
 * 用显式 marker 截取,而非依赖 '## Project context' 字符串的绝对位置——
 * 该标题现在位于 prompt 末尾,且可能缺省(无 memory/无 notepad 时整段不拼,#13),
 * 故以 report 段之后第一个会话私有段标记(memory 索引或 notepad 说明)为切片点,
 * 比旧实现更稳健(#17)。
 */
export function buildMocodeCorePrompt(): string {
  const full = buildBasePrompt();
  const reportingStart = full.indexOf(MARKER_STATIC_END);
  if (reportingStart < 0) return full;
  const candidateIndices = [MARKER_DYNAMIC_SECTION, MARKER_DROPPABLE_SECTION]
    .map((m) => full.indexOf(m))
    .filter((i) => i > reportingStart);
  if (candidateIndices.length === 0) return full; // 无会话私有尾段,整段即静态
  const dropStart = Math.min(...candidateIndices);
  return full.slice(0, dropStart).trimEnd();
}

/**
 * plan 模式追加到系统提示末尾的指令。真实工具集合由当前 ToolPolicy snapshot 与
 * PLAN_DISABLED_TOOLS 求交；本 getter 只描述只读行为，不枚举可能不存在的工具名。
 */
export function getPlanModeSuffix(): string {
  return buildPlanModeSuffix();
}

export const config: Config = {
  provider: llmKeysFromShell.includes('LLM_PROVIDER')
    ? normalizeLlmProvider(process.env.LLM_PROVIDER)
    : (__activePreset?.provider ?? normalizeLlmProvider(process.env.LLM_PROVIDER)),
  baseURL: llmKeysFromShell.includes('LLM_BASE_URL')
    ? requireEnv('LLM_BASE_URL')
    : (__activePreset?.baseURL ?? requireEnv('LLM_BASE_URL')),
  apiKey: llmKeysFromShell.includes('LLM_API_KEY')
    ? requireEnv('LLM_API_KEY')
    : (__activePreset?.apiKey ?? requireEnv('LLM_API_KEY')),
  model: llmKeysFromShell.includes('LLM_MODEL')
    ? process.env.LLM_MODEL || 'gpt-4o-mini'
    : (__activePreset?.model ?? process.env.LLM_MODEL ?? 'gpt-4o-mini'),
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
  // 用 getter 而非 buildBasePrompt() 立即求值：对象字面量初始化期间 buildBasePrompt 会读取
  // config.model 等字段，直接调用会触发 TDZ。Getter 也让语言、persona 等运行时变化在下一轮生效。
  get systemPrompt(): string {
    return buildBasePrompt();
  },
  contextWindowTokens: llmKeysFromShell.includes('CONTEXT_WINDOW_TOKENS')
    ? Number(process.env.CONTEXT_WINDOW_TOKENS) || DEFAULT_CONTEXT_WINDOW_TOKENS
    : __activePreset?.contextWindow ||
      // 必须用 ||:Number() 永不返回 null/undefined,?? 的右支是死代码;
      // 且环境变量写成非数字时 Number() 得 NaN,?? 会把 NaN 直接放行到 contextWindow。
      Number(process.env.CONTEXT_WINDOW_TOKENS) ||
      DEFAULT_CONTEXT_WINDOW_TOKENS,
  includeUsage: process.env.LLM_STREAM_USAGE !== 'false',
  anthropicPromptCache: llmKeysFromShell.includes('ANTHROPIC_PROMPT_CACHE')
    ? process.env.ANTHROPIC_PROMPT_CACHE !== 'false'
    : (__activePreset?.anthropicPromptCache ?? process.env.ANTHROPIC_PROMPT_CACHE !== 'false'),
  autoCompact: process.env.AUTO_COMPACT !== 'false',
  contextOptimize: process.env.MOCODE_CONTEXT_OPTIMIZE !== 'false',
  contextRelprune: process.env.MOCODE_CONTEXT_RELPRUNE !== 'false',
  contextLifecycle: process.env.MOCODE_LIFECYCLE !== 'false',
  contextBudget: process.env.MOCODE_BUDGET_SCHEDULER !== 'false',
  autoReflect: process.env.AUTO_REFLECT === 'true',
  memoryEnabled: process.env.MEMORY_ENABLED === 'true',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  maxSteps: Number(process.env.MAX_STEPS) || 1000,
  subAgentEnabled: process.env.MOCODE_SUBAGENT_ENABLED === 'true',
  subAgentMaxSteps: Number(process.env.SUB_AGENT_MAX_STEPS) || Number(process.env.MAX_STEPS) || 1000,
  subAgentConcurrency: Math.max(1, Number(process.env.SUB_AGENT_CONCURRENCY) || 5),
  frontendToolsEnabled: process.env.MOCODE_FRONTEND_TOOLS_ENABLED === 'true',
  computerUseEnabled: process.env.MOCODE_COMPUTER_USE_ENABLED === 'true',
  mcpEnabled: process.env.MOCODE_MCP_ENABLED !== 'false',
  sessionDir: path.join(process.cwd(), '.mocode', 'sessions'),
  searchApiKey: process.env.ANYSEARCH_API_KEY,
  sandboxRoot: process.env.SANDBOX_ROOT || undefined,
  searchBaseUrl: process.env.ANYSEARCH_BASE_URL || 'https://api.anysearch.com',
  maxImageBytes: process.env.MOCODE_MAX_IMAGE_BYTES ? Number(process.env.MOCODE_MAX_IMAGE_BYTES) : undefined,
  theme: process.env.MOCODE_THEME || 'default',
  themeFromShell,
  llmKeysFromShell,
  permissionEnabled: process.env.MOCODE_PERMISSION !== 'false',
  permissionNonInteractiveAllow: process.env.MOCODE_PERMISSION_NON_INTERACTIVE_ALLOW === 'true',
};

/**
 * 创建一份独立 Config 快照，不重新读取环境变量、配置文件或 preset。
 *
 * `source.systemPrompt` 若是 getter（全局 config 即如此）会在创建时求值并物化为字符串，
 * 使快照不会继续隐式依赖全局 config；调用方也可通过 overrides 显式替换它。
 * 当前 Config 的可变容器字段 llmKeysFromShell 始终复制，避免 runtime 间共享数组引用。
 */
export function createConfigSnapshot(overrides: Partial<Config> = {}, source: Config = config): Config {
  const snapshot = { ...source, ...overrides };
  return {
    ...snapshot,
    llmKeysFromShell: [...snapshot.llmKeysFromShell],
  };
}

/**
 * 会话钉死模型：窗口/会话启动时由 pinSessionModel() 捕获一次。
 * 运行中 agent 一律经 getActiveModel() 取模型，而非热切的 config.model——
 * 这样某窗口 /model switch 改写全局 config 后，其它【已经打开】的窗口的
 * 运行 agent 仍用各自启动时的模型，不会被影响；只有重启/新开窗口才会读全局 config。
 */
let sessionModel: string | null = null;

/** 在 REPL 启动时调用一次，把当前模型钉成本会话的活跃模型。 */
export function pinSessionModel(): void {
  sessionModel = config.model;
}

/** 运行中 agent 实际使用的模型：优先钉死值，未钉(极早路径)则回退 config.model。 */
export function getActiveModel(): string {
  return sessionModel ?? config.model;
}

/**
 * 运行时更新模型相关配置(/model 命令调)。
 * - 更新 config 对象字段(即时生效:chat() 读 config.model,reconfigureClient 读 config.baseURL/apiKey)。
 * - 同步 process.env(保持内存一致:其他读 process.env 的路径也拿到新值;且使新值在下次启动的
 *   loadEnvFiles 中被视为"已设",不被文件回填覆盖——即"优先拿这里的")。
 * 持久化(写 ~/.mocode/config)由调用方走 writeConfigKeys,此处只管内存 + env。
 * 重建 OpenAI 客户端(baseURL/apiKey 是构造时固化的实例字段)由调用方走 reconfigureClient。
 */
export function updateModelConfig(opts: {
  provider?: LlmProvider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  contextWindowTokens?: number;
  anthropicPromptCache?: boolean;
}): void {
  if (opts.provider !== undefined) {
    config.provider = opts.provider;
    process.env.LLM_PROVIDER = opts.provider;
  }
  if (opts.model !== undefined) {
    config.model = opts.model;
    // 钉死值同步更新：本窗口显式 /model switch 立即对本窗口运行 agent 生效；
    // 其它已开窗口的 sessionModel 不受影响（各自启动时钉死）。
    if (sessionModel !== null) sessionModel = opts.model;
    process.env.LLM_MODEL = opts.model;
  }
  if (opts.baseURL !== undefined) {
    config.baseURL = opts.baseURL;
    process.env.LLM_BASE_URL = opts.baseURL;
  }
  if (opts.apiKey !== undefined) {
    config.apiKey = opts.apiKey;
    process.env.LLM_API_KEY = opts.apiKey;
  }
  if (opts.contextWindowTokens !== undefined) {
    config.contextWindowTokens = opts.contextWindowTokens;
    process.env.CONTEXT_WINDOW_TOKENS = String(opts.contextWindowTokens);
  }
  if (opts.anthropicPromptCache !== undefined) {
    config.anthropicPromptCache = opts.anthropicPromptCache;
    process.env.ANTHROPIC_PROMPT_CACHE = opts.anthropicPromptCache ? 'true' : 'false';
  }
}

/** legacy 嵌入路径的 profile 查询；官方主 Agent 不读取。 */
export function getActiveProfile(): ProfileName {
  return activeProfile;
}

/** legacy 嵌入/测试用 profile setter；不再暴露对应 REPL 命令。 */
export function setActiveProfile(p: ProfileName): void {
  if (!isProfileName(p)) throw new Error(`unknown profile: ${String(p)}`);
  activeProfile = p;
}

/** 自动路由 capability gate：只有显式字符串 false 才是硬否决；unset/true 均允许按需选择。 */
function isRouteCapabilityAllowed(envName: string): boolean {
  return process.env[envName] !== 'false';
}

export function isSubAgentRouteAllowed(): boolean {
  return isRouteCapabilityAllowed('MOCODE_SUBAGENT_ENABLED');
}

export function isFrontendRouteAllowed(): boolean {
  return isRouteCapabilityAllowed('MOCODE_FRONTEND_TOOLS_ENABLED');
}

export function isComputerUseRouteAllowed(): boolean {
  return isRouteCapabilityAllowed('MOCODE_COMPUTER_USE_ENABLED');
}

/** memory-read / memory-write 的自动路由 gate；与 Memory Index 是否注入分开显示。 */
export function isMemoryRouteAllowed(): boolean {
  return isRouteCapabilityAllowed('MEMORY_ENABLED');
}

/**
 * 子 Agent legacy 可见性：仅供没有 ToolPolicy 的兼容路径。官方 TUI/stdio 使用
 * isSubAgentRouteAllowed() + 每 turn ToolPolicy，不再由 activeProfile 决定。
 */
export function isSubAgentEnabled(): boolean {
  if (process.env.MOCODE_SUBAGENT_ENABLED !== undefined) return process.env.MOCODE_SUBAGENT_ENABLED === 'true';
  return profileHasGroup(activeProfile, 'subagent');
}

/** 自动工具路由执行面的硬否决；未设置或 true 时由当前 ToolPolicy 决定是否暴露 orchestration。 */
export function isSubAgentHardDisabled(): boolean {
  return !isSubAgentRouteAllowed();
}

/** /subagent 的持久化写入口：更新兼容字段与 capability gate；不会把 orchestration 常驻 schema。 */
export function updateSubAgentConfig(enabled: boolean): void {
  config.subAgentEnabled = enabled;
  process.env.MOCODE_SUBAGENT_ENABLED = enabled ? 'true' : 'false';
}

/** 前端工具簇的 legacy 可见性；官方自动路由使用 isFrontendRouteAllowed()。 */
export function isFrontendToolsEnabled(): boolean {
  if (process.env.MOCODE_FRONTEND_TOOLS_ENABLED !== undefined)
    return process.env.MOCODE_FRONTEND_TOOLS_ENABLED === 'true';
  return profileHasGroup(activeProfile, 'frontend');
}

/** /fe 的持久化写入口；官方路径把 false 当硬否决，true 仅允许按需路由。 */
export function updateFrontendToolsConfig(enabled: boolean): void {
  config.frontendToolsEnabled = enabled;
  process.env.MOCODE_FRONTEND_TOOLS_ENABLED = enabled ? 'true' : 'false';
}

/** Computer Use 的 legacy 可见性；官方自动路由使用 isComputerUseRouteAllowed()。 */
export function isComputerUseEnabled(): boolean {
  if (process.env.MOCODE_COMPUTER_USE_ENABLED !== undefined) return process.env.MOCODE_COMPUTER_USE_ENABLED === 'true';
  return profileHasGroup(activeProfile, 'computer');
}

/** /cu 的持久化写入口；官方路径把 false 当硬否决，true 仅允许按需路由。 */
export function updateComputerUseConfig(enabled: boolean): void {
  config.computerUseEnabled = enabled;
  process.env.MOCODE_COMPUTER_USE_ENABLED = enabled ? 'true' : 'false';
}

// ── 视觉历史滑动窗口(Computer Use)───────────────────────────────────────
//
// 屏幕帧永驻 history 会让图像 token 二次增长(每次请求都要重发整个 history):
// 20 步 ≈387k tk、50 步 ≈2.35M tk,长 GUI 任务必然中途 compact 并丢掉视觉 grounding。
// 滑动窗口按「最近 keep 条 + 成批淘汰 batch 条」把旧帧换成文本占位。详见
// design-notes/vision-window.md。
//
// 这里是 process.env 直读而非 Config 单例:与其它 CU 调优项(MOCODE_CU_MAX_EDGE 等)同款,
// 每步都在调用点求值,改 .env 后立即生效,不需要重启 REPL。

/** 窗口保留的屏幕帧条数默认值。 */
export const DEFAULT_VISION_KEEP = 6;
/** 单次淘汰条数默认值。1 = 严格窗口(token 最省 / 前缀最不稳)。 */
export const DEFAULT_VISION_BATCH = 4;

/**
 * 保留最近多少条屏幕帧。**0 = 完全关闭窗口**(回退到现状,一键回滚)。
 *
 * 空串语义与 `MOCODE_CU_DIFF_THRESHOLD`(src/tools/builtins/computer.ts:49)一致:
 * **未配置 / 空串 → 回落默认**;显式写 0 才是 0。`Number('') === 0`,直接 Number 判数值
 * 会让"注释掉这个变量"静默变成关闭窗口。
 */
export function visionKeep(): number {
  const raw = process.env.MOCODE_CU_VISION_KEEP;
  if (raw === undefined || raw.trim() === '') return DEFAULT_VISION_KEEP;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_VISION_KEEP;
  return Math.round(parsed);
}

/**
 * 一次淘汰多少条。>=1;非法值回落默认。
 *
 * batch 是 **token 与 prompt cache 的权衡**:batch 越大,"两次淘汰之间 history 前缀字节不变"
 * 的窗口越长,前缀命中率越高,代价是在途多留几张图。判据见文档 §7.2:
 * 显式 prompt cache(Anthropic 断点)取 6-8;隐式前缀缓存取 4;无缓存取 1。
 */
export function visionBatch(): number {
  const raw = process.env.MOCODE_CU_VISION_BATCH;
  if (raw === undefined || raw.trim() === '') return DEFAULT_VISION_BATCH;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_VISION_BATCH;
  return Math.round(parsed);
}

/** MCP 总开关；关闭时下次启动跳过 MCP 配置读取与服务连接。 */
export function isMcpEnabled(): boolean {
  return config.mcpEnabled;
}

/** 运行时更新 MCP 开关；连接建立或释放、工具表刷新由 REPL 调用方执行。 */
export function updateMcpConfig(enabled: boolean): void {
  config.mcpEnabled = enabled;
  process.env.MOCODE_MCP_ENABLED = enabled ? 'true' : 'false';
}

/**
 * Memory Index / 反思开关。它不等于自动路由 gate：官方 ToolPolicy 通过
 * isMemoryRouteAllowed() 判定 memory-read / memory-write 是否可选；这里决定索引和反思是否启用。
 * legacy profile fallback 仍保留给未传 ToolPolicy 的嵌入调用。
 */
export function isMemoryEnabled(): boolean {
  if (process.env.MEMORY_ENABLED !== undefined) return process.env.MEMORY_ENABLED === 'true';
  return profileHasGroup(activeProfile, 'memory');
}

/**
 * .codegraph/ 索引存在性:仅查 cwd 顶层 .codegraph(目录或文件均可,codegraph CLI
 * 自己会处理内部布局)。用于动态决定是否在系统提示里注入 codegraph skill 用法段——
 * 没有索引的项目不应被提示「用 codegraph」以免 LLM 调出失败。失败静默返 false。
 */
export function hasCodegraphIndex(): boolean {
  try {
    return fs.existsSync(path.join(process.cwd(), '.codegraph'));
  } catch {
    return false;
  }
}

/**
 * 当 .codegraph/ 存在时拼进 auto 模式系统提示的 codegraph 段;否则返空串(零成本)。
 * 单一来源:被 buildBasePrompt 注入,确保 basePrompt 不含死字符串。
 */
export function buildCodegraphSection(): string {
  if (!hasCodegraphIndex()) return '';
  return [
    '',
    '## Codegraph (project has .codegraph/ index)',
    '- For unfamiliar code questions, prefer loading the `codegraph` skill (via use_skill) and querying it with run_command (`codegraph explore <entry>`, `codegraph node <symbol>`). Falls back to read_file / glob / grep when not applicable.',
  ].join('\n');
}

/**
 * /memory_switch 的写入口：同步 Memory Index 状态与自动路由 capability gate。
 * 内置 memory_* 工具始终注册但默认不暴露；当前已发出的 immutable policy snapshot 不变，
 * 下一真实用户 turn 会按新 gate 重路由并重建系统提示。持久化由调用方写 MEMORY_ENABLED。
 */
export function updateMemoryConfig(enabled: boolean): void {
  config.memoryEnabled = enabled;
  process.env.MEMORY_ENABLED = enabled ? 'true' : 'false';
}

/** 切换终端界面语言(回复语言不写入提示词,由模型按用户提问自动识别)；持久化由 REPL 调用 config/file.ts 完成。 */
export function updateLanguageConfig(language: Language): void {
  setLanguage(language);
  process.env.MOCODE_LANGUAGE = language;
}

// ── 工具预路由:后端模式(llm | jev)───────────────────────────────────────────
//
// 为什么直接读 process.env 而不进 Config 接口:
// 与 isRouteCapabilityAllowed(见上)同一理由——路由模式可在 REPL 内用 /router 即时切换,
// 且 loadEnvFiles 已把配置文件回填进 process.env。读取发生在每 turn 的 routeToolGroups
// 调用点(非模块初始化),故改后下一真实用户 turn 立即生效,无需重启。
// 若进 Config 单例,const config 在模块初始化时求值,反而拿不到 /router 的运行时切换。

/** 工具预路由后端模式。llm = 与主 Agent 同一后端(默认,零额外依赖)；jev = TypeSafe systemone API。 */
export type RouterMode = 'llm' | 'jev';

/** 当前路由模式;未知值一律回退 llm(保守:保证有可用的路由后端)。 */
export function getRouterMode(): RouterMode {
  return process.env.MOCODE_ROUTER_MODE === 'jev' ? 'jev' : 'llm';
}

/** /router 的写入口;持久化由调用方写 MOCODE_ROUTER_MODE(见 config/file.ts)。 */
export function updateRouterMode(mode: RouterMode): void {
  process.env.MOCODE_ROUTER_MODE = mode;
}

/**
 * 工具预路由总开关。关闭 = 每个 turn 跳过路由调用,只保留常驻簇
 * (controller 无条件激活的 DEFAULT_ROUTE_GROUPS)+ 通用工具,不选任何额外簇;默认开启。
 * 与 RouterMode 同一理由直接读写 process.env:支持 /router on|off 即时切换,
 * routeToolGroups 在每 turn 调用点实时读,改后下一真实用户 turn 生效。
 */
export function isToolRoutingEnabled(): boolean {
  return process.env.MOCODE_ROUTER_ENABLED !== 'false';
}

/** /router 的写入口;持久化由调用方写 MOCODE_ROUTER_ENABLED(见 config/file.ts)。 */
export function updateToolRoutingEnabled(enabled: boolean): void {
  process.env.MOCODE_ROUTER_ENABLED = enabled ? 'true' : 'false';
}

export interface JevRouterConfig {
  /** systemone 端点基址(不含 /v1/systemone 路径段)。本地兼容层(如 arbiter)指向 localhost。 */
  baseUrl: string;
  /** TypeSafe API key(仅经环境变量/配置文件,不入日志)。 */
  apiKey: string;
  model: string;
  /** 通用出簇阈值:概率 ≥ 此值才激活该簇。默认 0.65(100 用例实测 operating point)。 */
  confidenceMin: number;
  /** mcp 专用阈值:实测 mcp 是系统性假阳性磁铁,需更高门槛。默认 0.85。 */
  confidenceMinMcp: number;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/** 读取 Jev 路由配置(每次调用实时读 env,支持 /router 即时改)。 */
export function getJevRouterConfig(): JevRouterConfig {
  return {
    baseUrl: (process.env.MOCODE_ROUTER_JEV_BASE_URL || DEFAULT_JEV_BASE_URL).replace(/\/+$/, ''),
    apiKey: process.env.MOCODE_ROUTER_JEV_API_KEY || '',
    model: process.env.MOCODE_ROUTER_JEV_MODEL || 'jev-latest',
    confidenceMin: readNumberEnv('MOCODE_ROUTER_CONFIDENCE_MIN', 0.65),
    confidenceMinMcp: readNumberEnv('MOCODE_ROUTER_CONFIDENCE_MIN_MCP', 0.85),
  };
}

/**
 * /router 的写入口:把 patch 中的字段写进对应环境变量。
 * 只改内存/进程环境;持久化由调用方写 ~/.mocode/config(见 config/file.ts)。
 */
export function updateJevRouterConfig(patch: Partial<JevRouterConfig>): void {
  if (patch.baseUrl !== undefined) process.env.MOCODE_ROUTER_JEV_BASE_URL = patch.baseUrl;
  if (patch.apiKey !== undefined) process.env.MOCODE_ROUTER_JEV_API_KEY = patch.apiKey;
  if (patch.model !== undefined) process.env.MOCODE_ROUTER_JEV_MODEL = patch.model;
  if (patch.confidenceMin !== undefined) process.env.MOCODE_ROUTER_CONFIDENCE_MIN = String(patch.confidenceMin);
  if (patch.confidenceMinMcp !== undefined)
    process.env.MOCODE_ROUTER_CONFIDENCE_MIN_MCP = String(patch.confidenceMinMcp);
}

/** Jev 后端是否已具备最小可用配置(有 key 才可能成功)。 */
export function isJevRouterConfigured(): boolean {
  return getJevRouterConfig().apiKey.trim() !== '';
}
