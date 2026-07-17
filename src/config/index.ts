import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadSnapshot } from '../project-snapshot/index.js';
import { buildProjectSkillSection } from '../project-skill/index.js';
import { getSandboxRoot } from '../sandbox/root.js';
import { getCurrentSessionId } from '../session/state.js';
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
const llmKeysFromShell = LLM_ENV_KEYS.filter((k) => process.env[k] !== undefined);
loadEnvFiles();
setLanguage(detectLanguage(process.env.MOCODE_LANGUAGE));

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
  /** 模型上下文窗口(token)。须对齐真实模型窗口(GLM-4.6≈128k,DeepSeek-V3≈64k,Qwen 视版本)。 */
  contextWindowTokens: number;
  /** 自动压缩触发阈值(占窗口比例)。默认 0.85,保守偏早以吸收估算误差与下一步增长。 */
  compactThreshold: number;
  /** 流式请求里带 stream_options.include_usage 拿真实 usage。后端不认 stream_options 时关掉。 */
  includeUsage: boolean;
  /** 自动压缩总开关。关掉则只靠手动 /compact。 */
  autoCompact: boolean;
  /** 代码变更后的任务收尾自动验证。默认 true；失败会回灌 Agent 继续修复。 */
  autoValidate: boolean;
  /** Context Optimization Pipeline 总开关(工具结果进 LLM 前的类型化编码:tree/search/log/…)。
   *  关掉则工具结果原样进 LLM(仅长度裁剪),零行为变化。默认 true。 */
  contextOptimize: boolean;
  /** 相关性裁剪总开关(read_file 跨条裁剪:同 path 旧 read + 已被 mutation 覆写的旧 read
   *  自动替换为存根)。纯静态、不调 LLM;关掉则保留所有 read 结果(只受 capToolResultForHistory
   *  单条上限与 microcompact 旧区截短影响)。默认 true;
   *  设 MOCODE_CONTEXT_RELPRUNE=false 全局回退。 */
  contextRelprune: boolean;
  /** 观察者生命周期总开关(LIVE→REFERENCED→OBSOLETE→STUB 四态机;grep/glob/codegraph
   *  producer ↔ read/edit/write consumer 引用追踪;孤立+老化非观察类工具自动 STUB;
   *  观察类工具永远只到 REFERENCED,不自动 STUB)。与 contextRelprune 并列,纯静态、不调 LLM。
   *  默认 true;设 MOCODE_LIFECYCLE=false 全局回退。 */
  contextLifecycle: boolean;
  /** Context Budget Scheduler 总开关(五区分账 + ROI 排序调度)。
   *  关掉则 agent 步前退化为 maybeCompact(history) 老路径(只看总占用 0.85 阈值),
   *  零行为变化。默认 true;设 MOCODE_BUDGET_SCHEDULER=false 全局回退。 */
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
  /** 子 agent(task 工具派生)默认步数上限。防子任务失控耗尽配额。默认 50。 */
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
  /** 项目快照缓存总开关：跨 session 持久化静态项目文件 + 项目结构摘要。
   *  关闭时 read_file 不走 snapshot cache，system prompt 不注入 snapshot 提示段。
   *  默认 true；设 MOCODE_PROJECT_SNAPSHOT=false 全局回退。 */
  projectSnapshotEnabled: boolean;
  /** 工具权限系统总开关:基于 Tool.risk 字段(safe/confirm/dangerous)在执行前弹确认面板。
   *  关闭则所有工具直接放行(零交互,向后兼容旧行为)。默认 true。
   *  设 MOCODE_PERMISSION=false 全局回退。 */
  permissionEnabled: boolean;
  /** Allow confirmation-requiring tools without a TTY. Defaults false (fail closed). */
  permissionNonInteractiveAllow: boolean;
  /** 项目专属 Skill 总开关:跨 session 持久化项目开发知识(约定/架构/坑点)。
   *  开启后 .mocode/project-skill.md 内容注入系统提示词，Agent 可通过 project_skill_update 工具动态更新。
   *  默认 false(零侵入);设 MOCODE_PROJECT_SKILL=true 启用。 */
  projectSkillEnabled: boolean;
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
- You are on Windows; run_command runs commands via cmd.exe (/c). Unix shell builtins are NOT available here.
- Windows equivalents: which→where, cat→type, ls→dir, rm→del/rd, cp→copy, mv→move. cmd.exe uses %VAR% (not $VAR); pipes (|) and redirects (>, >>) work, but no $(...) command substitution or backticks.
- head/tail/find/grep/sed have no cmd.exe equivalent — use the dedicated tools (read_file for head/tail, glob for find, grep for grep), or invoke PowerShell via run_command if you need more.
- **Avoid \`run_command\` for file ops on Windows**: cmd /c re-parses paths with backslashes / spaces / quotes — fragile, and ~half of "agent can't find file" failures trace back to this. Use the dedicated tools (read_file/glob/grep) which take absolute Windows paths natively, no shell involved. In particular, NEVER \`dir\` / \`ls\` / \`Test-Path\` / \`if exist\` / \`python -c "os.path.exists(...)"\` — those waste turns on escaping. Use \`glob\` to list, and just call \`read_file\` to test existence (returns ENOENT as a clean error string). If you must shell out, use forward slashes (\`C:/foo/bar\`).
- Prefer the dedicated tools (read_file/glob/grep) over shell equivalents — they're cross-platform and already wired in.`;
  }
  if (process.platform === 'darwin') {
    return `## Environment (macOS)
- You are on macOS; run_command runs via bash -c (user default shell may be zsh). BSD coreutils, not GNU.
- Pitfalls: sed -i needs an empty backup-ext arg (sed -i '' 's/x/y/' file); grep -P unavailable (use grep -E or the grep tool); find/readlink/date are BSD variants; readlink -f unsupported (use realpath, or greadlink -f if GNU coreutils installed via brew).
- Prefer the dedicated tools (read_file/glob/grep) over shell equivalents — they sidestep BSD/GNU differences.`;
  }
  return `## Environment (Linux/Unix)
- You are on ${process.platform}; run_command runs via bash -c. GNU coreutils — standard POSIX/GNU shell syntax is safe.
- Still prefer the dedicated tools (read_file/glob/grep) over hand-rolled shell where they fit — they avoid quoting pitfalls and are already wired in.`;
})();

/**
 * 基础系统提示的"记忆段落":开 isMemoryEnabled() 时才拼。
 * 默认关(新用户零侵入):这段 + 工具表里的 5 个 memory_* + 系统提示尾部的 Memory Index
 * 都不出现;打开 /memory_switch 后下一次新建 system message 才注入。
 */
/**
 * 项目快照段落：开 isProjectSnapshotEnabled() 且有快照时才拼。
 * 告诉 LLM 项目已有哪些静态文件可 cache hit，减少无谓 read_file。
 */
function buildSnapshotSection(): string {
  if (!config.projectSnapshotEnabled) return '';
  try {
    const snap = loadSnapshot();
    if (!snap) return '';
    
    // 快照内容已经是完整的 markdown，直接返回
    return `\n${snap.content}\n`;
  } catch {
    return '';
  }
}

/**
 * 项目快照总开关查询器（read-file 工具用）。
 */
export function isProjectSnapshotEnabled(): boolean {
  return config.projectSnapshotEnabled;
}

import { setCurrentSessionId } from '../session/state.js';

/**
 * Session notepad 段落：读取 .mocode/sessions/<sessionId>/notes.md，只注入 ## 标题行作为目录摘要。
 * Agent 用 write_file/edit_file/read_file 维护此文件，抗 compact（在 context window 之外）。
 * 文件不存在或为空时返空串（零开销）。
 */
function buildNotepadSection(): string {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return '';
  
  const root = getSandboxRoot() ?? process.cwd();
  const p = path.join(root, '.mocode', 'sessions', sessionId, 'notes.md');
  if (!fs.existsSync(p)) return '';
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    if (!content) return '';

    // 1) 提取 ## 标题行（最多 15 个），用作目录摘要
    const headers = content.split('\n')
      .filter(l => /^##\s/.test(l))
      .slice(0, 15);

    // 2) 提取 Plan 段进度（仅当存在 "## Plan: ..." 时）
    const planMatch = content.match(/^## Plan:\s*(.+)$/m);
    const stepsTotal = (content.match(/^\s*-\s*\[[ xX]\]\s*\d+\./gm) || []).length;
    const stepsDone  = (content.match(/^\s*-\s*\[[xX]\]\s*\d+\./gm) || []).length;
    const planChip = planMatch
      ? `\nPlan: ${planMatch[1].trim()} (${stepsDone}/${stepsTotal})`
      : '';

    if (headers.length === 0 && !planChip) return '';
    return [
      '',
      `## Session Notepad (your working notes — use read_file(".mocode/sessions/${sessionId}/notes.md") for details)`,
      'Sections:',
      ...headers,
      planChip,
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

const SYSTEM_PROMPT_MEMORY_SECTION = `
## Memory (cross-session long-term facts)
- A "memory index" (id/title/summary only) is injected into the system prompt. Retrieve full body via memory_search (pass id or keyword); use memory_list to see the entire index.
- Store non-obvious, cross-session-useful facts/decisions/pitfalls (architecture conventions, gotchas, user preferences, decisions made) with memory_save — only long-term stable items, not current bugs / temp files / undecided TODOs.
- If an existing memory is outdated or contradicts new facts, correct it in-place with memory_update(id, …) (don't create a duplicate); archive clearly-stale ones with memory_forget(id).
- Before saving, memory_search to check for an existing similar entry to avoid duplicates. Better to store less than to store trivially correct information.
- A background reflection pass periodically mines and organizes memories from the session (no manual action needed), but key facts you proactively save are more reliable.`;

/**
 * plan 模式追加到系统提示末尾的指令(切到 plan 模式时由 repl 拼进 history[0])。
 * 与 SYSTEM_PROMPT 同语种(英文),指示:只读探查、产出步骤化计划、不执行、审批后回 auto。
 *
 * memoryEnabled=false 时:memory_save/update/forget 三个写工具名字 + "memory-write tools" 这
 * 句都不出现,且 read-only 列表里的 memory_search/memory_list 也移除——避免提示词里出现
 * 根本不存在的工具名引起 LLM 调不到。
 */
const PLAN_RESEARCH_RULES = `
- Research enough to locate relevant code, trace call paths, and understand existing conventions. Use the codegraph-first Workflow, but do not repeat information already retrieved in this session.
- Produce an actionable plan: files and reasons, ordered steps, edge cases, and verification (typecheck / tests / build).
- When ready, MUST call the \`ask_human\` tool with a concise summary and exactly these options:
  1. "按计划执行 (switch to auto and implement)" — call \`switch_mode("auto")\` in the same turn, then implement.
  2. "继续细化方案 (stay in plan, refine)" — remain in plan and refine.
  3. "取消 / 暂不执行 (abort)" — stop without switching mode.
- Never silently switch or stop. Do not ask approval in plain text; \`ask_human\` is the approval channel.
- The REPL approval prompt is only a fallback; do not rely on it.`;

function buildPlanModeSuffix(): string {
  const memoryTools = isMemoryEnabled()
    ? 'memory_save, memory_update, memory_forget'
    : '';
  const readOnlyTools = isMemoryEnabled()
    ? 'read_file, glob, grep, codegraph, web_search, web_fetch, use_skill, ask_human, memory_search, memory_list'
    : 'read_file, glob, grep, codegraph, web_search, web_fetch, use_skill, ask_human';
  const removed = ['write_file', 'edit_file', 'run_command', memoryTools]
    .filter(Boolean)
    .join(', ');
  return `

## ⛯ PLAN MODE (active now)
You are in PLAN mode: investigate and design only — do NOT execute or change anything.
- Removed from your tool list: ${removed}. Use only these read-only tools: ${readOnlyTools}.
${PLAN_RESEARCH_RULES}`;
}

/** 兼容旧名字:repl 的 buildSystemMessage 仍引 PLAN_MODE_SUFFIX(变量)。运行时按需现拼。 */
export function buildBasePrompt(): string {
  const autoAllToolsLine = isMemoryEnabled()
    ? '- Default is AUTO mode: you research and execute with all tools (read/edit/run_command/memory/web/skills).'
    : '- Default is AUTO mode: you research and execute with all tools (read/edit/run_command/web/skills).';
  const memorySection = isMemoryEnabled() ? SYSTEM_PROMPT_MEMORY_SECTION : '';
  const planLine = isMemoryEnabled()
    ? '- For complex or multi-step tasks, the user may switch to PLAN mode (Shift+Tab): your editing/command/memory-write tools are then removed from your tool list, and you must research with read-only tools only and produce a step-by-step plan (no execution). On approval the session returns to auto mode to execute the plan.'
    : '- For complex or multi-step tasks, the user may switch to PLAN mode (Shift+Tab): your editing/command tools are then removed from your tool list, and you must research with read-only tools only and produce a step-by-step plan (no execution). On approval the session returns to auto mode to execute the plan.';

  return `## Core behavior
You are mocode, a terminal coding agent. Complete programming tasks through a "think → call tool → observe result → think again" loop until solved. ${t('assistant.languageInstruction')}

## 模式 (Modes)
${autoAllToolsLine}
${planLine}

${PLATFORM_NOTE}

## Tool details
### Token-efficient execution
- First check whether the answer is already in this conversation or a previous tool result. If yes, answer directly; do not re-run tools "to be safe".
- Plan the complete sub-task before calling tools. Batch independent reads in one turn. Because tool calls in one response execute without intermediate model reasoning, never batch a read with an edit that depends on its result.
- Do not read "just to see". Read only what supports the next decision. Re-read after a change, compaction, stale state, or uncertain line context.
- Prefer one precise call over overlapping searches. If a call fails, inspect the error and change the approach instead of repeating it unchanged.
- Batch only independent read-only calls. After their results arrive, make the dependent edit in the next turn; then batch independent edits and one final verification when their exact inputs are already known.
- Read only what supports the next decision; verify once after a related edit set, not after every edit.
- Do not repeat an unchanged failing call; after three unproductive attempts, change tools or ask for the missing decision.
- For \`edit_file\`, derive \`old_string\` by copying the exact relevant lines from the latest successful \`read_file\` of that same path; never reconstruct it from memory, a summary, grep output, or a previous diff. That read becomes stale after any edit/write to the path, compaction/resume, or a possible external change. On an \`old_string\` mismatch, re-read the exact region and retry once with the newly returned text; never retry identical arguments.

## Workflow
- Understand requirements and current code before acting; do not guess.
- If \`.codegraph/\` exists, use \`codegraph\` first for unfamiliar code questions. Use direct reads for known or recently changed files.
- After modifications, run the smallest relevant verification, then typecheck/build when appropriate. Never claim success without evidence.
- Use web search only when freshness materially affects the answer (new APIs, versions, security, current UI conventions).

## Tool rules
- Precise path/symbol → go directly to \`read_file\` or \`codegraph node\`; use \`glob\`/\`grep\` only for discovery.
- Before editing, read the exact target region and use its verbatim text as \`old_string\`. Use \`edit_file\` for unique local replacements and \`write_file\` for new/full files.
- Local edits require an exact unique match; use \`write_file\` for new/full files.
- Use \`glob\`/\`grep\` for discovery and \`run_command\` for execution or verification, not file existence checks. State intent before side effects.
- Call \`ask_human\` only when a real user decision is required; otherwise decide and proceed.
- Drop stale tool output when it no longer supports the current sub-task. Keep only evidence needed for the next decision.
- Batch independent writes only when each input is already known and their order does not matter. Keep dependent mutations sequential. Combine a clear shell workflow in one command; follow up when its result creates a decision.

## Large file writes (avoid token-cap truncation)
- \`write_file\` / \`edit_file\` arguments are part of the model's JSON output — a single tool call's content > ~5K tokens risks mid-stream truncation when the model's max output (default 8K–16K tokens) is exceeded, producing a "arguments 不是合法 JSON" error. Even with \`MAX_TOKENS=32000\` set, huge files still risk truncation.
- **For large files (rough threshold: >200 lines OR >5K tokens of content)**, default to one of these strategies instead of one giant \`write_file\`:
  - **Skeleton + edit**: \`write_file\` a small skeleton (head + placeholders), then call \`edit_file\` repeatedly to append/replace sections — each edit stays well under the cap, and partial progress survives a stream error.
  - **Shell heredoc**: \`run_command\` with \`cat > path <<'EOF' ... EOF\` (bash) or \`Set-Content -Path ... -Value @"..."@\` (PowerShell) — the file content bypasses the model's JSON output entirely, so no token cap applies. Prefer this for generated/structured content (JSON config, full HTML pages, large code dumps).
- For small files (≤200 lines, ≤5K tokens) just use \`write_file\` directly — no need to over-engineer.

## Failure Handling
- Tools return errors as strings (edit_file no match or non-unique, run_command non-zero exit, etc.). Analyze the root cause, adjust, then retry — don't resend the same call verbatim.
- When a command errors, read the actual output before judging; don't skip it.

## Safety & Boundaries
- Confirm with the user before irreversible or outward-facing operations (delete, overwrite existing files, push, request external services), unless explicitly authorized.
- Operate only within authorized scope; when unsure, ask — don't guess.

## Project context (dynamic reference)
${buildSnapshotSection()}${config.projectSkillEnabled ? buildProjectSkillSection() : ''}${memorySection}${buildNotepadSection()}

## Session Notepad — working notes file
${getCurrentSessionId() 
  ? `You maintain a working notepad at \`.mocode/sessions/${getCurrentSessionId()}/notes.md\` using write_file / edit_file / read_file.`
  : 'You maintain a working notepad (path will be shown after the session starts).'}
This is your private working surface — write intermediate findings, decisions, open questions,
and anything you might need to recall later. The file survives context compaction.

### WHEN TO WRITE
The notepad is opt-in for complex work, not a routine task log. Use it only when the task has at least 3 meaningful steps, spans multiple investigation/implementation phases, or contains details that are genuinely at risk of being lost to context compaction.

Do NOT create, read, or update the notepad for simple tasks, including:
- Questions that can be answered directly
- One-step commands or lookups
- Small, localized edits that can be completed without intermediate notes
- Work that only needs a few tool calls and fits comfortably in the current context

For qualifying complex work:
- After exploring code and discovering key constraints → add a section
- Before making a consequential design decision → record reasoning and alternatives considered
- When accumulating data across many tool calls → store concise intermediates
- When you realize important information may be lost after compaction → write it down
- After completing a substantial phase → summarize what you learned

### FORMAT (markdown, section-based)
Use \`## <topic>\` headers to organize. Each section is self-contained.
Example:

    ## Auth Module
    - JWT TTL: 86400s, hardcoded at src/auth/jwt.ts:42
    - Config path: config.auth.jwt.ttl (does not exist yet)
    - Migration: read from config with fallback to 86400

    ## Decision: Schema Validation
    - Chose: zod over joi
    - Why: project already uses zod (config/index.ts:8), joi would add a dep
    - Risk: none — zod already in dependency tree

    ## Open Questions
    - [ ] Does the refresh token flow need TTL config too?
    - [ ] Check if rate limiter interacts with auth middleware

### RULES
${getCurrentSessionId() 
  ? `- Your notepad file path is: \`.mocode/sessions/${getCurrentSessionId()}/notes.md\`. Use this exact path for all read_file/write_file/edit_file operations on your notes.`
  : '- Your notepad file path will be available after the session starts.'}
- Use write_file to create/overwrite; use edit_file to append or modify sections
- Keep the file concise — summarize, don't dump raw tool output
- At task completion, the file can be deleted or left for the user's reference
- Do NOT use this for cross-session knowledge (use memory_save for that)

### PLAN FORMAT (use for any task with ≥3 steps)
Write the plan as a top-level \`## Plan:\` section. The system extracts this for the status bar chip, so follow the format exactly.

    ## Plan: <task title>

    Goal: <one-line goal>

    ### Steps
    - [ ] 1. <step 1>
    - [x] 2. <step 2>
    - [ ] 3. <step 3>

    ### Progress
    - <what you learned / did in this phase>

Rules:
- Only ONE active \`## Plan:\` section at a time.
- Mark steps \`[x]\` as you complete them; append a line to \`### Progress\` after each phase.
- Before your final response, reconcile every step with the work actually completed, then delete the plan section or rename it to \`## Done: <title>\`.
- The host hides an unchanged active plan when an agent turn ends as a safety fallback; this does not edit the notepad. Keep updating the plan during execution so live progress remains accurate.

## Termination & Reporting
- Stop immediately when no more tools are needed; give conclusions directly.
- **Do not stop prematurely during exploration**: if you started investigating but haven't gathered enough information to answer the user's question, keep calling tools. Only stop when you have sufficient evidence or hit a dead end.
- **No flattery / no preamble in conclusions**: skip "Sure", "好的", "我已经完成了" and similar no-information prefixes — jump straight to substance.
- Report honestly: say success when successful, say where you're stuck when failing, and mention anything skipped. Reference code in "path:line" format (e.g., src/index.ts:42). Keep it concise.`;
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
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS) || 128000,
  compactThreshold: Number(process.env.COMPACT_THRESHOLD) || 0.85,
  includeUsage: process.env.LLM_STREAM_USAGE !== 'false',
  autoCompact: process.env.AUTO_COMPACT !== 'false',
  autoValidate: process.env.MOCODE_AUTO_VALIDATE !== 'false',
  contextOptimize: process.env.MOCODE_CONTEXT_OPTIMIZE !== 'false',
  contextRelprune: process.env.MOCODE_CONTEXT_RELPRUNE !== 'false',
  contextLifecycle: process.env.MOCODE_LIFECYCLE !== 'false',
  contextBudget: process.env.MOCODE_BUDGET_SCHEDULER !== 'false',
  autoReflect: process.env.AUTO_REFLECT !== 'false',
  memoryEnabled: process.env.MEMORY_ENABLED === 'true',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  maxSteps: Number(process.env.MAX_STEPS) || 200,
  subAgentEnabled: process.env.MOCODE_SUBAGENT_ENABLED === 'true',
  subAgentMaxSteps: Number(process.env.SUB_AGENT_MAX_STEPS) || 50,
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
  projectSnapshotEnabled: process.env.MOCODE_PROJECT_SNAPSHOT !== 'false',
  permissionEnabled: process.env.MOCODE_PERMISSION !== 'false',
  permissionNonInteractiveAllow: process.env.MOCODE_PERMISSION_NON_INTERACTIVE_ALLOW === 'true',
  projectSkillEnabled: process.env.MOCODE_PROJECT_SKILL === 'true',
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

/** 子 Agent 总开关；默认 false，关闭时 task 不进入模型工具表。 */
export function isSubAgentEnabled(): boolean {
  return config.subAgentEnabled;
}

/** 运行时切换子 Agent；工具 schema 刷新与持久化由 REPL 调用方完成。 */
export function updateSubAgentConfig(enabled: boolean): void {
  config.subAgentEnabled = enabled;
  process.env.MOCODE_SUBAGENT_ENABLED = enabled ? 'true' : 'false';
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

/**
 * 项目专属 Skill 总开关:单一来源。/project_skill、buildBasePrompt、
 * tools/builtins/index.ts 都从这里查。默认 false(零侵入)。
 */
export function isProjectSkillEnabled(): boolean {
  return config.projectSkillEnabled;
}

/**
 * 切换项目专属 Skill 开关(/project_skill on|off 调)。
 * - 更新 config 单例字段(其它模块下次调 isProjectSkillEnabled() 即拿新值)。
 * - 同步 process.env.MOCODE_PROJECT_SKILL(下次启动 loadEnvFiles 不被文件回填)。
 * 持久化(写 ~/.mocode/config 的 MOCODE_PROJECT_SKILL 键)由调用方走 writeConfigKeys。
 */
export function updateProjectSkillConfig(enabled: boolean): void {
  config.projectSkillEnabled = enabled;
  process.env.MOCODE_PROJECT_SKILL = enabled ? 'true' : 'false';
}

/**
 * 切换项目快照开关(/snapshot on|off 调)。
 * - 更新 config 单例字段(其它模块下次读 config.projectSnapshotEnabled 即拿新值:
 *   buildSnapshotSection 现拼现读、read-file 每次 execute 现读)。
 * - 同步 process.env.MOCODE_PROJECT_SNAPSHOT(下次启动 loadEnvFiles 不会被文件回填)。
 * 持久化(写 ~/.mocode/config 的 MOCODE_PROJECT_SNAPSHOT 键)由调用方走 updateConfigKey。
 */
export function updateSnapshotConfig(enabled: boolean): void {
  config.projectSnapshotEnabled = enabled;
  process.env.MOCODE_PROJECT_SNAPSHOT = enabled ? 'true' : 'false';
}

/** 切换界面与模型回复语言；持久化由 REPL 调用 config/file.ts 完成。 */
export function updateLanguageConfig(language: Language): void {
  setLanguage(language);
  process.env.MOCODE_LANGUAGE = language;
}
