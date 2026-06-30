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
  /** 后台反思 pass 总开关。关掉则只靠手动 /reflect + 机会主义 memory_update。 */
  autoReflect: boolean;
  /** 每 N 个轮次触发一次后台反思 pass(与 agent 并发,不阻塞)。默认 5。 */
  reflectEveryN: number;
  /** 每轮 agent 循环最大步数(防无限循环)。默认 25。 */
  maxSteps: number;
  /** 会话落盘目录(cwd 下)。 */
  sessionDir: string;
  /** AnySearch 联网搜索 API key(可选)。不配则走匿名免费额度(按 IP 限流)。 */
  searchApiKey?: string;
  /** AnySearch API base,默认官方端点。 */
  searchBaseUrl: string;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(
      `\n[config] 缺少 ${key}。运行 \`mocode config\` 初始化,或在 ~/.mocode/config / <cwd>/.env 中设置(参考 .env.example)。\n`
    );
    process.exit(1);
  }
  return v;
}

const SYSTEM_PROMPT = `You are mocode, a terminal coding agent. You complete programming tasks through a "think → call tool → observe result → think again" loop until the problem is solved. Reply to the user in Chinese.

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

## Termination & Reporting
- Stop immediately when no more tools are needed; give conclusions directly.
- Report honestly: say success when successful, say where you're stuck when failing, and mention anything skipped. Reference code in "path:line" format (e.g., src/index.ts:42). Keep it concise.`;

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
  autoReflect: process.env.AUTO_REFLECT !== 'false',
  reflectEveryN: Number(process.env.REFLECT_EVERY_N) || 5,
  maxSteps: Number(process.env.MAX_STEPS) || 200,
  sessionDir: path.join(process.cwd(), '.mocode', 'sessions'),
  searchApiKey: process.env.ANYSEARCH_API_KEY,
  searchBaseUrl: process.env.ANYSEARCH_BASE_URL || 'https://api.anysearch.com',
};
