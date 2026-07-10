import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadSnapshot } from '../project-snapshot/index.js';
import { buildProjectSkillSection } from '../project-skill/index.js';

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

// 在 loadEnvFiles 回填前捕获:MOCODE_THEME 是否由 shell 设置(决定 /theme 写文件是否下次启动生效)。
const themeFromShell = process.env.MOCODE_THEME !== undefined;
// 在 loadEnvFiles 回填前捕获:哪些 LLM 键由 shell 设置(决定 /model 写文件是否下次启动生效)。
// 仿 themeFromShell 模式:shell export 的环境变量在 loadEnvFiles 中不被回填(优先级最高),
// 故 /model 写入 ~/.mocode/config 的同名键下次启动会被 shell 值覆盖——据此给 dim 警告。
const LLM_ENV_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'CONTEXT_WINDOW_TOKENS'] as const;
const llmKeysFromShell = LLM_ENV_KEYS.filter((k) => process.env[k] !== undefined);
loadEnvFiles();

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
function buildPlanModeSuffix(): string {
  if (!isMemoryEnabled()) {
    return `

## ⛯ PLAN MODE (active now)
You are in PLAN mode: investigate and design only — do NOT execute or change anything.
- Your editing / command tools (write_file, edit_file, run_command) have been REMOVED from your tool list. Use only the read-only tools available to you (read_file, glob, grep, codegraph, web_search, web_fetch, use_skill, ask_human) to investigate.
- Research thoroughly: locate the relevant code, trace call paths, and understand existing patterns and conventions before designing. (Codegraph is the default first action for code exploration — see Workflow in the base prompt. But first check whether this conversation already covers it — don't re-explore something already retrieved earlier in this session.)
- Then produce a clear, actionable implementation plan: files to change (with paths), what to change in each and why, the ordered steps, edge cases to handle, and how to verify (typecheck / tests / build). Be specific enough to execute against.
- When the plan is complete and ready for review, you MUST call the \`ask_human\` tool to surface the plan to the user for approval — do NOT just output the plan as plain text and STOP. ask_human renders a real interactive selection panel inside the TUI; plain-text approval questions in your reply are hard to see and easy to miss.
- Pass the \`ask_human\` tool a concise plan summary (goal + files/areas to change + key risks + verification) and these three options so the user can decide in one click:
    1. "按计划执行 (switch to auto and implement)"  — user approves; you then call \`switch_mode("auto")\` IN THE SAME turn and proceed.
    2. "继续细化方案 (stay in plan, refine)"          — user wants more detail / alternatives; stay in plan, iterate, and re-ask via \`ask_human\` when ready.
    3. "取消 / 暂不执行 (abort)"                       — user wants to stop; STOP, do NOT call \`switch_mode\`.
- This applies to BOTH paths: whether the user said "先 plan 再 auto" (autonomous) or entered plan mode manually (via /plan or Shift+Tab) for safety review. The single rule is: never silently self-switch and never silently STOP — always route through \`ask_human\` so the user has an explicit chance to approve, refine, or cancel.
- Do NOT in your text reply ask rhetorical confirmation questions like "shall I proceed? / 是否同意 / 需要你确认吗" — that bypasses the panel and forces the user to type free-text feedback, which is strictly worse than picking from the 3 options. ask_human is the only sanctioned approval channel in plan mode.
- Note: the REPL may still show its own approval prompt (\`promptIntervention\`) as a defense-in-depth fallback if you somehow STOP without calling ask_human — do not rely on it; the primary path is ask_human.`;
  }
  return `

## ⛯ PLAN MODE (active now)
You are in PLAN mode: investigate and design only — do NOT execute or change anything.
- Your editing / command / memory-write tools (write_file, edit_file, run_command, memory_save, memory_update, memory_forget) have been REMOVED from your tool list. Use only the read-only tools available to you (read_file, glob, grep, codegraph, web_search, web_fetch, use_skill, ask_human, memory_search, memory_list) to investigate.
- Research thoroughly: locate the relevant code, trace call paths, and understand existing patterns and conventions before designing. (Codegraph is the default first action for code exploration — see Workflow in the base prompt. But first check whether this conversation already covers it — don't re-explore something already retrieved earlier in this session.)
- Then produce a clear, actionable implementation plan: files to change (with paths), what to change in each and why, the ordered steps, edge cases to handle, and how to verify (typecheck / tests / build). Be specific enough to execute against.
- When the plan is complete and ready for review, you MUST call the \`ask_human\` tool to surface the plan to the user for approval — do NOT just output the plan as plain text and STOP. ask_human renders a real interactive selection panel inside the TUI; plain-text approval questions in your reply are hard to see and easy to miss.
- Pass the \`ask_human\` tool a concise plan summary (goal + files/areas to change + key risks + verification) and these three options so the user can decide in one click:
    1. "按计划执行 (switch to auto and implement)"  — user approves; you then call \`switch_mode("auto")\` IN THE SAME turn and proceed.
    2. "继续细化方案 (stay in plan, refine)"          — user wants more detail / alternatives; stay in plan, iterate, and re-ask via \`ask_human\` when ready.
    3. "取消 / 暂不执行 (abort)"                       — user wants to stop; STOP, do NOT call \`switch_mode\`.
- This applies to BOTH paths: whether the user said "先 plan 再 auto" (autonomous) or entered plan mode manually (via /plan or Shift+Tab) for safety review. The single rule is: never silently self-switch and never silently STOP — always route through \`ask_human\` so the user has an explicit chance to approve, refine, or cancel.
- Do NOT in your text reply ask rhetorical confirmation questions like "shall I proceed? / 是否同意 / 需要你确认吗" — that bypasses the panel and forces the user to type free-text feedback, which is strictly worse than picking from the 3 options. ask_human is the only sanctioned approval channel in plan mode.
- Note: the REPL may still show its own approval prompt (\`promptIntervention\`) as a defense-in-depth fallback if you somehow STOP without calling ask_human — do not rely on it; the primary path is ask_human.`;
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

  return `You are mocode, a terminal coding agent. You complete programming tasks through a "think → call tool → observe result → think again" loop until the problem is solved. Reply to the user in Chinese.

## 模式 (Modes)
${autoAllToolsLine}
${planLine}

${PLATFORM_NOTE}

## Step / Turn Economy (read this first — saves LLM calls)
- **Minimize turns**: each user message costs at least one LLM call, and history grows every step until threshold-triggered compact fires (extra call). If a request contains ≥2 independent sub-goals (e.g. "改 X 然后再优化 Y"), ask the user to split them into separate turns rather than chaining both in one go. State this politely: "这条包含 N 个独立目标,建议拆成 N 次对话,以避免上下文膨胀。"
- **Answer directly when you already know the answer — do this before the batching rule below**: before planning any tool calls for this turn, first check whether you can answer from the current conversation, an earlier tool result already in context, a file/symbol already read in this session, or general reasoning/knowledge alone. If so, skip tools entirely and answer directly. Only call a tool when the info is genuinely missing, may be stale (the underlying file/state changed since you last read it), or requires verification you cannot do from context. This applies to every tool — codegraph, grep, web_search, run_command — not just read_file.
  - ✅ already have it: user asks "刚才那个函数在哪个文件" after codegraph_explore returned it two turns ago → answer from that result, no new call.
  - ✅ pure reasoning: user asks "这个改动会不会影响性能" and the relevant code/logic is already visible in context → reason and answer directly, no need to re-run a profiler or re-read the file "just to be safe".
  - ❌ wasteful: re-running grep/codegraph for a symbol whose location this same conversation already returned, "just to be sure".
- **Plan the full turn, then emit it as one batch — this is the single biggest step-saver**: before emitting anything, enumerate every read / edit / command you'll need for this sub-goal, then return them together as one set of tool_calls (reads run in parallel, writes/commands run in the order given). Don't emit one call, observe, then emit the next in a follow-up turn when you could have planned both upfront.
  - ✅ one turn: \`[read_file A, read_file B, edit_file A, run_command 'npm test']\`
  - ❌ four turns: \`[read_file A]\` → \`[read_file B]\` → \`[edit_file A]\` → \`[run_command 'npm test']\`
- **Batch read-only tools in parallel**: consecutive read-only tools (read_file, glob, grep, codegraph, web_search, web_fetch) auto-execute in parallel within one turn — this is the concrete read-side case of the rule above. Do NOT call them serially across turns when you could emit them together.
- **Decide before reading**: do not read files "just to see"; plan the 2-3 file paths you actually need, then emit them as one batched tool_calls turn.
- **Chain read→edit→verify in one turn**: when the edit is obvious after a read, call edit_file (and verify with run_command) in the SAME response — don't split into 3 separate turns.
- **Verify once at the end of an edit chain, not after every edit**: after batching a set of related edits, run a single typecheck / test / build command to verify the whole change together. Running a verify command after each individual edit_file call wastes turns — batch the edits, then verify once.
- **Don't repeat failed calls**: if the same tool call fails or returns the same content 3 times in this turn, switch strategy (use a different tool, ask the user, or re-read the tool description) — don't keep retrying the same shape.
- **Don't re-read a file you already have, unless it may have changed**: if you (or an earlier step in this session) already read a file's relevant content and nothing has touched it since, edit directly from that content instead of calling read_file again "to be safe". This does NOT apply when the file was edited (by you or externally) since your last read, when a prior edit may have shifted line numbers you're about to target, or right after a compact where you're unsure the surviving context is accurate — in those cases re-reading is expected and correct, not wasteful.

## Workflow
- Understand before acting: when unsure about requirements or code state, explore first; don't assume.
- **Code exploration first action**: before reading files with read_file or searching with grep, check if a .codegraph/ index exists. If it does, use the codegraph tool (explore for questions/features, node for a specific symbol) as your FIRST step — it returns source + call paths in one shot. Only fall back to read_file/grep when codegraph misses, you need just-changed content, or you're editing a known small file. Build the index with \`codegraph init\` if none exists.
- Small steps: break tasks into verifiable sub-steps. Before each step, think clearly about what to change and why.
- Verify after change: run typecheck / tests / build via run_command to confirm it works. Never claim done without verification.
- **Web search when freshness matters**: for tasks involving UI/interaction/copy/visual design, new SDKs or APIs, CVE/version upgrades, or anything likely past your training cutoff, web_search FIRST to ground your work in current material — don't fall back on stale templates (gradient+emoji defaults, "I hope this message finds you well" openers, generic AI-flavored phrasing). Routine coding (bug fixes, refactors, tests, internal docs) doesn't need it.

## Tool Guidelines
- See each tool's own description for parameters and usage; this section covers selection strategy and pitfalls only.
- **If the user gave a precise path or symbol, go directly**: read_file or codegraph node it — don't pre-validate with glob/grep.
- Before editing code, read_file to confirm actual content (with line numbers); don't guess from memory. (Skip if you already read this exact content earlier in this session and nothing has changed it since — see Step Economy above.)
- For local edits use edit_file: old_string must be unique and match exactly (including indentation/newlines); include surrounding context lines to ensure uniqueness. Use write_file for new files or full rewrites.
- Use glob to find file paths, grep to search content. **Don't use run_command for file-level checks** (existence / listing / type) — those have no clean cmd.exe equivalent and Windows path escaping fails often. Use \`glob\` to list, and just call \`read_file\` to test existence (returns ENOENT as a clean error string).
- run_command has side effects on the host — state intent before invoking (delete, install, push, reset, etc.).
- Call ask_human when you hit a decision point requiring user input (multiple implementation approaches, unclear intent, or needing extra info to proceed) — list options for the user to pick (they can also choose "custom input" to answer freely). Don't call it frequently when the task is clear and you can decide yourself; if the user cancels, switch approach or proceed with available info — don't re-ask the same question.
- **Trim context when stale**: when an old tool result is dead weight (sub-goal done, no downstream consumer, or superseded by a later read), call drop_context to stub it; otherwise rely on automatic pruning.
- **Batch writes and commands too, not just reads**: the executor runs ALL returned tool_calls (reads, writes, commands) before the next LLM call. Emit independent edit_file / write_file / run_command in one response when the chain is clear — don't serialize them across turns just because they have side effects. (The read-only batching note in Step Economy applies to writes the same way.)
- **Chain shell workflows in a single \`run_command\`**: use \`&&\`, \`;\`, \`|\`, \`>\`, heredocs to fold multi-step scripts (\`mkdir -p x && cat > x/file.ts <<'EOF' ... EOF && npm test\`) into one call. Only emit a follow-up turn when the result forces a decision (error, ambiguous output, branching logic).

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

${buildSnapshotSection()}${config.projectSkillEnabled ? buildProjectSkillSection() : ''}${memorySection}

## Working notepad (todolist) — for multi-step tasks
- For tasks spanning **≥2 independent modules** OR when the user asks for stepwise progress ("先计划再执行" / "plan then do" / "按步骤来"), call \`todolist create\` first; update as you go. Skip for single-file edits or quick lookups.
- Plan is file-backed (\`todolist read\` to re-orient). See the tool description for the full action set.

## Termination & Reporting
- Stop immediately when no more tools are needed; give conclusions directly.
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
  contextOptimize: process.env.MOCODE_CONTEXT_OPTIMIZE !== 'false',
  contextRelprune: process.env.MOCODE_CONTEXT_RELPRUNE !== 'false',
  contextLifecycle: process.env.MOCODE_LIFECYCLE !== 'false',
  contextBudget: process.env.MOCODE_BUDGET_SCHEDULER !== 'false',
  autoReflect: process.env.AUTO_REFLECT !== 'false',
  memoryEnabled: process.env.MEMORY_ENABLED === 'true',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  maxSteps: Number(process.env.MAX_STEPS) || 200,
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
