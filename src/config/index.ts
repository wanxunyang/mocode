import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * 按优先级加载配置文件并回填 process.env:
 *   候选(文件内升序、后者覆盖前者):~/.mocode/config(全局)→ <cwd>/.mocode/config → <cwd>/.env(兼容旧用法)。
 *   合并后只回填 process.env 里**尚未设置**的键——shell 里 export 的环境变量永远优先。
 * 故 `mocode` 可在任意目录 / 任意终端启动:全局配置(~/.mocode/config)兜底,项目级文件按需覆盖。
 */
function loadEnvFiles(): void {
  const candidates = [
    path.join(os.homedir(), '.mocode', 'config'),
    path.join(process.cwd(), '.mocode', 'config'),
    path.join(process.cwd(), '.env'),
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
  /** 后台反思 pass 总开关。关掉则只靠手动 /reflect + 机会主义 memory_update。 */
  autoReflect: boolean;
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
  /** 主题名(对应 src/ui/theme.ts 的 THEMES 表键)。默认 default;shell env MOCODE_THEME 覆盖文件。 */
  theme: string;
  /** MOCODE_THEME 是否由 shell 环境变量设置(非文件回填)。若是,/theme 写文件下次启动仍被 shell 盖。 */
  themeFromShell: boolean;
  /** 由 shell 环境变量设置的 LLM 键名列表(非文件回填)。若含某键,/model 写该键下次启动仍被 shell 盖。 */
  llmKeysFromShell: string[];
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

const SYSTEM_PROMPT = `You are mocode, a terminal coding agent. You complete programming tasks through a "think → call tool → observe result → think again" loop until the problem is solved. Reply to the user in Chinese.

${PLATFORM_NOTE}

## Workflow
- Understand before acting: when unsure about requirements or code state, explore first; don't assume.
- Small steps: break tasks into verifiable sub-steps. Before each step, think clearly about what to change and why.
- Verify after change: run typecheck / tests / build via run_command to confirm it works. Never claim done without verification.

## Tool Guidelines
- See each tool's own description for parameters and usage; this section covers selection strategy and pitfalls only.
- **Prefer codegraph for code exploration**: when understanding/locating code, tracing call chains, or assessing impact of changes, if a .codegraph/ index exists, use the codegraph tool first (explore to query by question, node to look up a single symbol) — it returns relevant source + call paths in one shot, more accurate and economical than piecing together via read_file/grep. Fall back to read_file / grep / glob only when codegraph is unavailable (no index), misses, you need to see just-changed content, or you're editing a single known small file. Build the index first with \`codegraph init\` if none exists.
- Before editing code, read_file to confirm actual content (with line numbers); don't guess from memory.
- For local edits use edit_file: old_string must be unique and match exactly (including indentation/newlines); include surrounding context lines to ensure uniqueness. Use write_file for new files or full rewrites.
- Use glob to find file paths, grep to search content; don't use run_command to pipe cat / sed / find / grep.
- run_command runs per platform (cmd on Windows, bash elsewhere); state intent before running commands with side effects (deleting files, installing packages, git push, resets, etc.).
- Use web_search for information beyond training data (new versions, news, real-time data, latest APIs); don't answer potentially outdated info from memory.
- Use web_fetch to read a specific URL (a link from search results, or a URL given by the user); it only fetches static HTML — if a JS-rendered page yields no body, switch to web_search (its results include cleaned body text).
- Call ask_human when you hit a decision point requiring user input (multiple implementation approaches, unclear intent, or needing extra info to proceed) — list options for the user to pick (they can also choose "custom input" to answer freely). Don't call it frequently when the task is clear and you can decide yourself; if the user cancels, switch approach or proceed with available info — don't re-ask the same question.
- **Drop irrelevant context** (use sparingly): call drop_context to stub-replace tool results in history that are BOTH (a) irrelevant to the current task AND (b) large (the freed tokens must clearly exceed the ~300 tokens the call itself costs — roughly only worth it when targeting ≥2 bulky results, e.g. wide grep/read sweeps that returned mostly-irrelevant hits). The call itself adds a tool-call round-trip, so don't call it for one small result or when you're near done. It preserves tool_call_id pairing (only content changes); the system prompt and current turn are never dropped. Use filters (toolNames / contains) to target precisely.

## Failure Handling
- Tools return errors as strings (edit_file no match or non-unique, run_command non-zero exit, etc.). Analyze the root cause, adjust, then retry — don't resend the same call verbatim.
- When a command errors, read the actual output before judging; don't skip it.

## Safety & Boundaries
- Confirm with the user before irreversible or outward-facing operations (delete, overwrite existing files, push, request external services), unless explicitly authorized.
- Operate only within authorized scope; when unsure, ask — don't guess.

## Memory (cross-session long-term facts)
- A "memory index" (id/title/summary only) is injected into the system prompt. Retrieve full body via memory_search (pass id or keyword); use memory_list to see the entire index.
- Store non-obvious, cross-session-useful facts/decisions/pitfalls (architecture conventions, gotchas, user preferences, decisions made) with memory_save — only long-term stable items, not current bugs / temp files / undecided TODOs.
- If an existing memory is outdated or contradicts new facts, correct it in-place with memory_update(id, …) (don't create a duplicate); archive clearly-stale ones with memory_forget(id).
- Before saving, memory_search to check for an existing similar entry to avoid duplicates. Better to store less than to store trivially correct information.
- A background reflection pass periodically mines and organizes memories from the session (no manual action needed), but key facts you proactively save are more reliable.

## Plan vs Auto modes
- Default is AUTO mode: you research and execute with all tools (read/edit/run_command/memory/web/skills).
- For complex or multi-step tasks, the user may switch to PLAN mode (Shift+Tab): your editing/command/memory-write tools are then removed from your tool list, and you must research with read-only tools only and produce a step-by-step plan (no execution). On approval the session returns to auto mode to execute the plan.

## Termination & Reporting
- Stop immediately when no more tools are needed; give conclusions directly.
- Report honestly: say success when successful, say where you're stuck when failing, and mention anything skipped. Reference code in "path:line" format (e.g., src/index.ts:42). Keep it concise.`;

/**
 * plan 模式追加到系统提示末尾的指令(切到 plan 模式时由 repl 拼进 history[0])。
 * 与 SYSTEM_PROMPT 同语种(英文),指示:只读探查、产出步骤化计划、不执行、审批后回 auto。
 */
export const PLAN_MODE_SUFFIX = `

## ⛯ PLAN MODE (active now)
You are in PLAN mode: investigate and design only — do NOT execute or change anything.
- Your editing / command / memory-write tools (write_file, edit_file, run_command, memory_save, memory_update, memory_forget) have been REMOVED from your tool list. Use only the read-only tools available to you (read_file, glob, grep, codegraph, web_search, web_fetch, use_skill, ask_human, memory_search, memory_list) to investigate.
- Research thoroughly: locate the relevant code, trace call paths, and understand existing patterns and conventions before designing. Prefer codegraph when a .codegraph/ index exists.
- Then produce a clear, actionable implementation plan: files to change (with paths), what to change in each and why, the ordered steps, edge cases to handle, and how to verify (typecheck / tests / build). Be specific enough to execute against.
- Present the plan as your final reply and STOP, unless the user explicitly asked you to "plan first then execute" / "先 plan 再 auto" / autonomous execution: in that case, after presenting the plan, call the switch_mode tool with mode="auto" to switch back to auto mode WITHIN THE SAME TURN and continue implementing the plan yourself (your write/edit/command/memory-write tools become available again immediately). The user will see no approval prompt because you self-switched.
- If the user entered plan mode manually (via /plan or Shift+Tab) for a safety review and did NOT ask for autonomous execution, do NOT call switch_mode — present the plan and STOP. Do NOT ask the user for confirmation or approval in your text reply (e.g. "is this plan OK?", "shall I proceed?", "需要你确认") — the REPL automatically shows an approval prompt after you STOP, so asking in text is redundant and forces the user to answer twice. Just present the plan and end your reply.`;

export const config: Config = {
  baseURL: requireEnv('LLM_BASE_URL'),
  apiKey: requireEnv('LLM_API_KEY'),
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
  systemPrompt: SYSTEM_PROMPT,
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS) || 128000,
  compactThreshold: Number(process.env.COMPACT_THRESHOLD) || 0.85,
  includeUsage: process.env.LLM_STREAM_USAGE !== 'false',
  autoCompact: process.env.AUTO_COMPACT !== 'false',
  contextOptimize: process.env.MOCODE_CONTEXT_OPTIMIZE !== 'false',
  autoReflect: process.env.AUTO_REFLECT !== 'false',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  maxSteps: Number(process.env.MAX_STEPS) || 200,
  subAgentMaxSteps: Number(process.env.SUB_AGENT_MAX_STEPS) || 50,
  sessionDir: path.join(process.cwd(), '.mocode', 'sessions'),
  searchApiKey: process.env.ANYSEARCH_API_KEY,
  sandboxRoot: process.env.SANDBOX_ROOT || undefined,
  searchBaseUrl: process.env.ANYSEARCH_BASE_URL || 'https://api.anysearch.com',
  theme: process.env.MOCODE_THEME || 'default',
  themeFromShell,
  llmKeysFromShell,
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
