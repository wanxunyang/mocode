import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { getSandboxRoot } from '../sandbox/root.js';
import { getCurrentSessionId, setCurrentSessionId } from '../session/state.js';
import { buildWorkDisciplineSection, inferModelFamily } from '../agent/work-discipline.js';
import {
  detectLanguage,
  setLanguage,
  t,
  type Language,
} from '../i18n/index.js';

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
    path.join(process.cwd(), '.env'),              // 兼容旧用法,优先级最低
    path.join(os.homedir(), '.mocode', 'config'),  // 全局(/model 与 mocode config 写此)
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
const LLM_ENV_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'CONTEXT_WINDOW_TOKENS'] as const;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256000;
const llmKeysFromShell = LLM_ENV_KEYS.filter((k) => process.env[k] !== undefined);
loadEnvFiles();
setLanguage(detectLanguage(process.env.MOCODE_LANGUAGE));

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
  /** 模型上下文窗口(token)。全局默认 256000，可通过环境变量或 /model 覆盖。 */
  contextWindowTokens: number;
  /** 流式请求里带 stream_options.include_usage 拿真实 usage。后端不认 stream_options 时关掉。 */
  includeUsage: boolean;
  /** 自动压缩总开关。关掉则只靠手动 /compact。 */
  autoCompact: boolean;
  /** Typed context encoding for old logs/searches during real pressure only.
   * Normal tool results remain raw (apart from the hard per-result safety cap).
   * Default false; set MOCODE_CONTEXT_OPTIMIZE=true to enable this optional stage. */
  contextOptimize: boolean;
  /** Exact supersession pruning during real pressure only. Normal history is never
   * rewritten. Default false; set MOCODE_CONTEXT_RELPRUNE=true to enable it. */
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
   * 记忆子系统总开关。关闭时:5 个 memory_* 工具不进工具表,buildSystemPrompt
   * 里的 Memory Index 段 + memory_* 工具使用说明整段不出现,plan 模式提示词里的
   * 工具名也跟着消失。运行时 /memory_switch 改;持久化 MEMORY_ENABLED。
   * 默认 false:新用户零侵入,想用记忆功能显式打开。
   */
  memoryEnabled: boolean;
  /** 每 N 个轮次触发一次后台反思 pass(与 agent 并发,不阻塞)。默认 5。 */
  reflectEveryN: number;
  /** 每轮 agent 循环最大步数(防无限循环)。默认 25。 */
  maxSteps: number;
  /** 子 Agent 总开关。默认关闭；/subagent on|off 运行时切换并刷新模型工具表。 */
  subAgentEnabled: boolean;
  /** 前端工具簇总开关(browser / dev_server / screenshot / view_image)。默认关闭；
   *  /fe on|off 运行时切换并刷新模型工具表;这些工具依赖 playwright 二进制或抓取桌面,隐私/资源面大,默认不暴露。 */
  frontendToolsEnabled: boolean;
  /** 子 Agent 默认步数上限，只防止无限循环；调用方可按任务提高。 */
  subAgentMaxSteps: number;
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
  if (process.platform === 'win32') {
    return `## Environment (Windows)
- \`run_command\` uses \`cmd.exe /c\`: use cmd syntax and \`%VAR%\`; Unix builtins and command substitution are unavailable.
- Prefer read_file/glob/grep for file discovery and reading. When shell is necessary, use forward-slash paths or invoke PowerShell explicitly.`;
  }
  if (process.platform === 'darwin') {
    return `## Environment (macOS)
- \`run_command\` uses bash with BSD utilities. Prefer read_file/glob/grep; account for BSD/GNU differences when shell commands are necessary.`;
  }
  return `## Environment (Linux/Unix)
- \`run_command\` uses bash. Prefer read_file/glob/grep when they fit; otherwise use standard POSIX/GNU syntax.`;
})();

/**
 * 基础系统提示的"记忆段落":开 isMemoryEnabled() 时才拼。
 * 默认关(新用户零侵入):这段 + 工具表里的 5 个 memory_* + 系统提示尾部的 Memory Index
 * 都不出现;打开 /memory_switch 后下一次新建 system message 才注入。
 */
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
  if (!sessionId) return '';

  const root = getSandboxRoot() ?? process.cwd();
  const p = path.join(root, '.mocode', 'sessions', sessionId, 'notes.md');
  if (!fs.existsSync(p)) return '';
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    if (!content) return '';

    // 1) 提取 ## 标题行（最多 15 个，按文件出现顺序保留）
    const headers = content.split('\n')
      .filter(l => /^##\s/.test(l))
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
      ...(active.length ? active.map(h => `  - ${h.replace(/^##\s+/, '')}`) : ['  - (none)']),
    ];
    if (archived.length) {
      lines.push(`Done (${archived.length}):`);
      lines.push(...archived.map(h => `  - ${h.replace(/^##\s+/, '')}`));
    }
    lines.push('');
    return lines.join('\n');
  } catch {
    return '';
  }
}

const SYSTEM_PROMPT_MEMORY_SECTION = `
## Memory (cross-session facts)
- The prompt may contain a title/summary index; retrieve details with memory_search or inspect all with memory_list.
- Save only stable, non-obvious cross-session facts. Search before saving; update an existing entry instead of duplicating it, and archive stale entries.`;

/** Inject only retrieval guidance; MOCODE.md contents stay outside the prompt until read on demand. */
function buildMemoryPromptSection(): string {
  if (!isMemoryEnabled()) return '';
  const projectMocode = path.join(process.cwd(), 'MOCODE.md');
  const mocodeHint = fs.existsSync(projectMocode)
    ? '\n- `MOCODE.md` exists at the workspace root but is not preloaded. Read it with `read_file` only when the task may depend on project architecture, conventions, commands, prior decisions, or user preferences; skip it for greetings and unrelated simple requests. Current code and the user request override stale memory.'
    : '';
  return SYSTEM_PROMPT_MEMORY_SECTION + mocodeHint;
}

/**
 * plan 模式追加到系统提示末尾的指令(切到 plan 模式时由 repl 拼进 history[0])。
 * 与 SYSTEM_PROMPT 同语种(英文),指示:只读探查、产出步骤化计划、不执行、审批后回 auto。
 *
 * memoryEnabled=false 时:memory_save/update/forget 三个写工具名字 + "memory-write tools" 这
 * 句都不出现,且 read-only 列表里的 memory_search/memory_list 也移除——避免提示词里出现
 * 根本不存在的工具名引起 LLM 调不到。
 *
 * .codegraph/ 存在性也动态决定:有索引时引导 LLM 优先用 codegraph skill(免去逐文件扫);
 * 没索引时干脆不提,避免 LLM 调出失败。函数化(非 const)以便在 buildPlanModeSuffix 里现拼。
 */
function buildPlanResearchRules(): string {
  const cg = hasCodegraphIndex()
    ? ' Prefer the available codegraph skill for call paths and blast radius.'
    : '';
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
  const memorySection = buildMemoryPromptSection();
  const notepadSection = buildNotepadSection(sessionId);

  // 静态主体:稳定段落集中在前,让支持 prompt caching 的后端能命中前缀缓存(#12)。
  // 约束:staticBody 的前缀段(尤其 ## Core behavior 第一行)必须是纯静态文本,
  // 不得嵌入会话级可变函数调用(如 t()/config.model)。否则 /language、/model
  // 切换会让最敏感的前缀变化,破坏自动前缀缓存命中。可变值统一放到
  // ## Termination & Reporting 段末尾(仍在切片边界之前,子 agent 仍能拿到)。
  const staticBody = `## Core behavior
You are mocode, a terminal coding agent. Complete programming tasks through a "think → call tool → observe result → think again" loop until solved.

## Modes
- AUTO is the default: investigate and complete the task with the tools currently exposed.
- PLAN is read-only research and design; do not make changes until the user approves and switches back to AUTO.

${PLATFORM_NOTE}

${buildWorkDisciplineSection(inferModelFamily(config.model))}

## Workflow
- Use existing conversation and tool evidence before gathering more. Inspect only what supports the next decision; do not guess.
- Keep changes focused. Decide for yourself whether a check is worth running; prefer the smallest relevant check and avoid broad test/build suites unless the task or risk justifies them.
- Use web search only when freshness materially affects the answer.
${buildCodegraphSection()}

## Tool use
- During tool-calling turns, stay silent unless something important enough must reach the user — otherwise just call the tool and let it run.
- Go directly to a known path or symbol; use discovery tools only when the location is unknown.
- Edit against a FRESH read: before any edit_file/write_file, call read_file on the exact path and copy both its latest hash and the exact target text. Never reconstruct old_string from a grep/summary/diff — those lose whitespace and indentation and cause edit failures.
- A read_file hash from before a compaction, session resume, edit conflict, or external change is STALE and will be rejected — re-read rather than reuse an old hash.
- Emit multiple independent tool calls in ONE assistant message so they run concurrently — e.g. several read_file regions, a grep plus a glob, or several web_fetch calls. One lookup per message wastes a full model round-trip each time. Place parallel-safe calls consecutively; keep any call that depends on their results (e.g. an edit) for the next message.
- Never batch a read with an edit that depends on it; do not repeat overlapping reads or unchanged failed calls.
- On failure, inspect the full error, change the approach, and retry only with a reason. Drop stale tool output when it no longer supports the task.
- For generated content over roughly 200 lines or 5K tokens, use small staged writes rather than one oversized tool argument.
- Use \`ask_human\` only for a genuinely user-owned decision; otherwise choose the safest reversible option and proceed.

## Safety & Boundaries
- Get confirmation before irreversible or outward-facing actions such as deletion, push, production changes, or external requests, unless explicitly authorized.
- Stay within the authorized workspace and disclose anything skipped or unverifiable.

## Termination & Reporting
- Stop immediately when no more tools are needed; give conclusions directly.
- **Do not stop prematurely during exploration**: if you started investigating but haven't gathered enough information to answer the user's question, keep calling tools. Only stop when you have sufficient evidence or hit a dead end.
- **No flattery / no preamble in conclusions**: skip "Sure", "好的", "我已经完成了" and similar no-information prefixes — jump straight to substance.
- Report honestly: say success when successful, say where you're stuck when failing, and mention anything skipped. Reference code in "path:line" format (e.g., src/index.ts:42). Keep it concise.
${t('assistant.languageInstruction')}`;

  // 动态段(置于末尾):memory 索引 + notepad 索引 + notepad 使用说明。
  // 按需注入(#13):有内容的索引才拼对应标题,避免空标题噪声。
  //   - "## Project context" 仅当 memorySection/notepadSection 非空(notepad 索引依赖 notes.md 存在);
  //   - notepad 使用说明**无条件**注入:否则会陷入"说明依赖 notes.md 存在 → 模型不知要建 → 文件永不存在"的鸡生蛋循环,功能对模型不可见。说明放在 prompt 末尾,不影响 staticBody 的前缀缓存。
  const dynamicParts: string[] = [];
  const ctxContent = `${memorySection}${notepadSection}`.trimEnd();
  if (ctxContent) {
    dynamicParts.push(`## Project context (dynamic reference)\n${ctxContent}`);
  }
  dynamicParts.push(
    `## Session Notepad (\`.mocode/sessions/${sessionId ?? '<id>'}/notes.md\`)\n` +
    'Use this compact, persistent working surface for tasks with at least three steps or context-loss risk; skip it for simple work.\n\n' +
    'Keep at most one active plan:\n' +
    '```\n' +
    '## Plan: <title>\n' +
    'Goal: <outcome>\n' +
    '### Steps\n' +
    '- [ ] 1. <verifiable step>\n' +
    '### Progress\n' +
    '- <completed phase and evidence>\n' +
    '```\n' +
    'Create this file proactively with write_file when the task warrants it; read_file the full notes.md whenever you need to recover context after compaction.\n' +
    'Update checkboxes and Progress after each completed phase. Before the final reply, reconcile the plan with actual work, then rename it to `## Done:` or remove it. Keep other notes concise and session-specific; use memory for stable cross-session facts.',
  );

  return `${staticBody}\n\n${dynamicParts.join('\n\n')}`;
}

/** 静态主体结束 + 会话私有段起点标记,供 buildMocodeCorePrompt 稳健切片(#17)。 */
const MARKER_STATIC_END = '## Termination & Reporting';
const MARKER_DYNAMIC_SECTION = '## Project context (dynamic reference)';
const MARKER_DROPPABLE_SECTION = '## Session Notepad (';

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
 * plan 模式追加到系统提示末尾的指令。
 * 历史曾是 `export const PLAN_MODE_SUFFIX`(顶层字面量);现改为按 isMemoryEnabled()
 * 动态拼:false 时不出现 memory_* 工具名,避免 LLM 想调不存在的工具。
 *
 * 注意:已改为 getter(每次访问现拼),让运行时切 /memory_switch 后立即生效。
 * 旧 import `PLAN_MODE_SUFFIX` 路径不变;repl 推荐改用 getPlanModeSuffix()(语义更清晰)。
 * 不能直接 `export const PLAN_MODE_SUFFIX = buildPlanModeSuffix()`:
 * 该表达式在模块初始化时立即求值,而 buildPlanModeSuffix 内部读 config,config 还未求值 → TDZ。
 */
export function getPlanModeSuffix(): string {
  return buildPlanModeSuffix();
}

export const config: Config = {
  baseURL: requireEnv('LLM_BASE_URL'),
  apiKey: requireEnv('LLM_API_KEY'),
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
  // 用 getter 而非 buildBasePrompt() 立即求值:因为本对象字面量求值时 buildBasePrompt 读 config.memoryEnabled,
  // 而 config 还没完成初始化(TDZ)。Getter 让每次访问都现拼,运行时 /memory_switch 立即生效。
  get systemPrompt(): string {
    return buildBasePrompt();
  },
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS) || DEFAULT_CONTEXT_WINDOW_TOKENS,
  includeUsage: process.env.LLM_STREAM_USAGE !== 'false',
  autoCompact: process.env.AUTO_COMPACT !== 'false',
  contextOptimize: process.env.MOCODE_CONTEXT_OPTIMIZE === 'true',
  contextRelprune: process.env.MOCODE_CONTEXT_RELPRUNE === 'true',
  contextLifecycle: process.env.MOCODE_LIFECYCLE !== 'false',
  contextBudget: process.env.MOCODE_BUDGET_SCHEDULER !== 'false',
  autoReflect: process.env.AUTO_REFLECT === 'true',
  memoryEnabled: process.env.MEMORY_ENABLED === 'true',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  maxSteps: Number(process.env.MAX_STEPS) || 1000,
  subAgentEnabled: process.env.MOCODE_SUBAGENT_ENABLED === 'true',
  subAgentMaxSteps: Number(process.env.SUB_AGENT_MAX_STEPS) || Number(process.env.MAX_STEPS) || 1000,
  frontendToolsEnabled: process.env.MOCODE_FRONTEND_TOOLS_ENABLED === 'true',
  sessionDir: path.join(process.cwd(), '.mocode', 'sessions'),
  searchApiKey: process.env.ANYSEARCH_API_KEY,
  sandboxRoot: process.env.SANDBOX_ROOT || undefined,
  searchBaseUrl: process.env.ANYSEARCH_BASE_URL || 'https://api.anysearch.com',
  maxImageBytes: process.env.MOCODE_MAX_IMAGE_BYTES
    ? Number(process.env.MOCODE_MAX_IMAGE_BYTES)
    : undefined,
  theme: process.env.MOCODE_THEME || 'default',
  themeFromShell,
  llmKeysFromShell,
  permissionEnabled: process.env.MOCODE_PERMISSION !== 'false',
  permissionNonInteractiveAllow: process.env.MOCODE_PERMISSION_NON_INTERACTIVE_ALLOW === 'true',
};

/**
 * 运行时更新模型相关配置(/model 命令调)。
 * - 更新 config 对象字段(即时生效:chat() 读 config.model,reconfigureClient 读 config.baseURL/apiKey)。
 * - 同步 process.env(保持内存一致:其他读 process.env 的路径也拿到新值;且使新值在下次启动的
 *   loadEnvFiles 中被视为"已设",不被文件回填覆盖——即"优先拿这里的")。
 * 持久化(写 ~/.mocode/config)由调用方走 writeConfigKeys,此处只管内存 + env。
 * 重建 OpenAI 客户端(baseURL/apiKey 是构造时固化的实例字段)由调用方走 reconfigureClient。
 */
export function updateModelConfig(opts: {
  model?: string;
  baseURL?: string;
  apiKey?: string;
  contextWindowTokens?: number;
}): void {
  if (opts.model !== undefined) {
    config.model = opts.model;
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
}

/** 子 Agent 总开关；默认 false，关闭时 sub-agent 不进入模型工具表。 */
export function isSubAgentEnabled(): boolean {
  return config.subAgentEnabled;
}

/** 运行时切换子 Agent；工具 schema 刷新与持久化由 REPL 调用方完成。 */
export function updateSubAgentConfig(enabled: boolean): void {
  config.subAgentEnabled = enabled;
  process.env.MOCODE_SUBAGENT_ENABLED = enabled ? 'true' : 'false';
}

/** 前端工具簇总开关；默认 false，关闭时 browser/dev_server/screenshot/view_image 不进入模型工具表。 */
export function isFrontendToolsEnabled(): boolean {
  return config.frontendToolsEnabled;
}

/** 运行时切换前端工具簇；工具 schema 刷新与持久化由 REPL 调用方完成。 */
export function updateFrontendToolsConfig(enabled: boolean): void {
  config.frontendToolsEnabled = enabled;
  process.env.MOCODE_FRONTEND_TOOLS_ENABLED = enabled ? 'true' : 'false';
}

/**
 * 记忆子系统总开关:单一来源。/memory_switch、/memory_status、buildSystemPrompt、
 * tools/builtins/index.ts、tools/constants.ts 的 plan-mode 列表都从这里查。
 * 默认 false(新用户零侵入)。
 */
export function isMemoryEnabled(): boolean {
  return config.memoryEnabled;
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
 * 切换记忆子系统开关(/memory_switch on|off 调)。
 * - 更新 config 单例字段(其它模块下次调 isMemoryEnabled() 即拿新值)。
 * - 同步 process.env.MEMORY_ENABLED(下次启动 loadEnvFiles 不被文件回填)。
 * 持久化(写 ~/.mocode/config 的 MEMORY_ENABLED 键)由调用方走 writeConfigKeys。
 *
 * 注:开关切换对当前会话的 tool list / 已拼好的 systemPrompt 不会自动重算 —
 * 工具表在 REPL 启动时构建,systemPrompt 在每轮 chat() 拼时按 isMemoryEnabled()
 * 现查现拼(关掉时该轮拼出来的 prompt 即不带 memory_* 段)。所以切换在「下一轮
 * agent 调用」起即时生效,本轮已发出的请求不会回滚。
 */
export function updateMemoryConfig(enabled: boolean): void {
  config.memoryEnabled = enabled;
  process.env.MEMORY_ENABLED = enabled ? 'true' : 'false';
}

/** 切换界面与模型回复语言；持久化由 REPL 调用 config/file.ts 完成。 */
export function updateLanguageConfig(language: Language): void {
  setLanguage(language);
  process.env.MOCODE_LANGUAGE = language;
}
