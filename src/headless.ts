// Headless（一次性 / 非交互）模式：mocode -p "任务" 或 echo "任务" | mocode。
// 与 REPL 共用同一套装配（builtins 工具包 + MCP + runAgentCore），区别只在展示：
// 没有全屏 TUI，正文流式写 stdout，进度写 stderr（保 stdout 可被管道解析）。
//
// 工具进度：默认每个调用打一行「[工具名] 关键参数」（summarizeToolCall，与 TUI
// 同源；browser fill 等敏感值刻意不显示）。--verbose 追加工具结果摘要。
//
// 具名 Bot（C2）：--bot <name> 时用 Bot 的岗位提示作为角色前缀，并按其工具白名单
// 过滤可调用工具（toolsOverride + runtimeAllowedToolNames，schema 即上限）。
//
// 隔离：--session-dir <path> 会话独立目录；--worktree 在 git detached worktree 中
// 执行并自动销毁。两者走独立 Runtime（不碰全局单例）。
//
// 权限：非交互默认 fail-closed（permissions/index.ts 的 !isTTY 分支）。
// --dangerously-skip-permissions 显式关闭权限闸。

import path from 'node:path';
import { setSandboxRoot } from './sandbox/root.js';
import { registerToolsExtension } from './tools/registry.js';
// 装配官方默认工具包：registry 不顶层 import builtins（破模块循环），入口须显式装配。
import './tools/builtins/index.js';
import { initializeAllMcp, getMcpTools, closeAllMcp } from './mcp/index.js';
import { config, buildBasePrompt, isMemoryEnabled } from './config/index.js';
import { effectiveSystemPrompt } from './skills/index.js';
import { buildMemoryIndexSection } from './memory/store.js';
import { defaultRuntime, Runtime } from './runtime/index.js';
import { runAgentCore, type AgentHooks } from './agent/core.js';
import { summarizeToolCall, summarizeToolResult } from './ui/render.js';
import { getToolChatSchema } from './tools/policy.js';
import type { ChatMessage, ChatUsage, ToolCallRef } from './llm/index.js';
import { createWorktree, removeWorktree, type Worktree } from './jobs/worktree.js';
import { runAsIdentity } from './bots/bus.js';
import { createAsyncApprovalChecker } from './jobs/approval.js';
import { writeCheckpoint, readCheckpoint, deleteCheckpoint } from './jobs/checkpoint.js';
import { getBot, type BotRecord } from './bots/store.js';
import type { Tool } from './tools/types.js';

export interface HeadlessOptions {
  prompt: string;
  json: boolean;
  verbose: boolean;
  skipPermissions: boolean;
  sandboxRootOverride?: string;
  /** 会话独立落盘目录（--session-dir）。 */
  sessionDir?: string;
  /** 在 git worktree 中执行（--worktree）。 */
  worktree?: boolean;
  /** 以具名 Bot 身份运行（--bot）。 */
  botName?: string;
  /** 后台 job id（job-runner 模式）：设置即启用异步审批 checker 并使用独立 Runtime。 */
  jobId?: string;
  /** D3: resume bg job from its last checkpoint. */
  resumeFromCheckpoint?: boolean;
}

export interface HeadlessJsonResult {
  terminationReason: 'completed' | 'aborted' | 'max_steps';
  text: string | null;
  sessionId: string;
  changedFiles: string[];
  usage?: ChatUsage;
  elapsedMs: number;
  model: string;
  bot?: string;
}

/** 读取 stdin 全部内容作为 prompt（管道场景）。 */
async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * 解析 Bot：查记录、解析其沙箱范围、校验白名单。
 * 返回 null 表示未使用 Bot；找不到 Bot 抛错（不静默用默认身份，避免误以为岗位生效）。
 */
function resolveBot(
  botName: string | undefined,
  baseSandbox: string,
): {
  bot: BotRecord;
  sandboxRoot: string;
} | null {
  if (!botName) return null;
  const bot = getBot(botName);
  if (!bot) throw new Error(`bot "${botName}" not found (project .mocode/bots or global ~/.mocode/bots)`);
  let sandboxRoot = baseSandbox;
  if (bot.sandboxPath) {
    // project bot 相对其工作区；global bot 相对当前 cwd。
    const anchor = bot.scope === 'project' ? baseSandbox : process.cwd();
    sandboxRoot = path.resolve(anchor, bot.sandboxPath);
  }
  return { bot, sandboxRoot };
}

/** 从工具目录按白名单构造 schema 集 + 允许名集合。 */
function buildBotToolFilter(
  catalog: readonly Tool[],
  allowNames: readonly string[],
): { toolsOverride: NonNullable<Parameters<typeof runAgentCore>[0]['toolsOverride']>; allowed: Set<string> } {
  const wanted = new Set(allowNames);
  const toolsOverride = catalog
    .filter((t) => wanted.has(t.name))
    .map((t) => getToolChatSchema(t.name, catalog))
    .filter((s): s is NonNullable<typeof s> => s !== null);
  return { toolsOverride, allowed: new Set(toolsOverride.map((s) => s.function.name)) };
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const prompt = (opts.prompt ?? '').trim();
  if (!prompt) {
    process.stderr.write('mocode: empty prompt (use -p "..." or pipe via stdin)\n');
    return 1;
  }

  if (opts.skipPermissions) config.permissionEnabled = false;

  // worktree 先建（失败明确报错，不静默回退主工作区）。
  let wt: Worktree | null = null;
  if (opts.worktree) {
    try {
      wt = createWorktree();
    } catch (e) {
      process.stderr.write(`mocode: worktree setup failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  const initialSandbox = wt?.path ?? opts.sandboxRootOverride ?? config.sandboxRoot ?? process.cwd();

  // Bot 解析（在选沙箱之后：bot.sandboxPath 可进一步收窄）。
  let botInfo: { bot: BotRecord; sandboxRoot: string } | null;
  try {
    botInfo = resolveBot(opts.botName, initialSandbox);
  } catch (e) {
    if (wt) {
      try {
        removeWorktree(wt);
      } catch {
        // ignore
      }
    }
    process.stderr.write(`mocode: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const effectiveSandboxRoot = botInfo?.sandboxRoot ?? initialSandbox;
  const isolated = wt !== null || opts.sessionDir !== undefined || opts.jobId !== undefined;

  // MCP 先初始化注册：独立 Runtime 创建时复制当前 builtinTools（含 MCP），须早于 new Runtime。
  await initializeAllMcp();
  registerToolsExtension('mcp', getMcpTools());

  let runtime: Runtime;
  if (isolated) {
    runtime = new Runtime({
      sandboxRoot: effectiveSandboxRoot,
      ...(opts.sessionDir ? { configOverrides: { sessionDir: path.resolve(opts.sessionDir) } } : {}),
      // bg job：注入异步审批 checker（命中需授权动作时挂起，等 mocode approve）。
      ...(opts.jobId
        ? {
            services: {
              checkPermission: createAsyncApprovalChecker({
                jobId: opts.jobId,
                sandboxRoot: effectiveSandboxRoot,
                getPrompt: () => prompt,
              }),
            },
          }
        : {}),
    });
  } else {
    setSandboxRoot(effectiveSandboxRoot);
    runtime = defaultRuntime;
  }

  await runtime.start();
  const sessionId = runtime.session.create();

  // Bot 工具白名单：从该 runtime 实际工具目录过滤。
  let toolFilter: ReturnType<typeof buildBotToolFilter> | null = null;
  if (botInfo?.bot.tools && botInfo.bot.tools.length) {
    toolFilter = buildBotToolFilter(runtime.context.toolRuntime.tools, botInfo.bot.tools);
    if (toolFilter.toolsOverride.length === 0) {
      process.stderr.write('mocode: bot tool whitelist matched no available tools\n');
      await runtime.close();
      if (wt) {
        try {
          removeWorktree(wt);
        } catch {
          // ignore
        }
      }
      return 1;
    }
  }

  // 系统提示：Bot 岗位角色在前，基础约定在后；白名单存在时补一句工具边界。
  const baseConventions = buildBasePrompt(sessionId) + buildMemoryIndexSection(isMemoryEnabled());
  const systemContent = botInfo
    ? `# Role\n${botInfo.bot.systemPrompt}\n\n` +
      `${botInfo.bot.description ? `**Position:** ${botInfo.bot.description}\n\n` : ''}` +
      `---\n\n${baseConventions}` +
      (toolFilter ? `\n\n## Tool boundary\nOnly these tools are available: ${[...toolFilter.allowed].join(', ')}.` : '')
    : baseConventions;

  const history: ChatMessage[] = [{ role: 'system', content: effectiveSystemPrompt(systemContent) }];
  let resumedFromCheckpoint = false;
  if (opts.resumeFromCheckpoint && opts.jobId) {
    const snap = readCheckpoint(opts.jobId);
    if (snap && snap.length) {
      history.length = 0;
      history.push(...snap);
      resumedFromCheckpoint = true;
    } else {
      process.stderr.write('mocode: no checkpoint to resume from\n');
      await runtime.close();
      return 1;
    }
  }

  let textBuffer = '';
  // D3 runaway guard (bg jobs only): hard wall-clock / token caps.
  let jobSignal: AbortSignal | undefined;
  let jobGuard:
    | { timer?: ReturnType<typeof setTimeout>; tokens: number; maxTokens: number; controller?: AbortController }
    | undefined;
  if (opts.jobId) {
    const maxMs = Number(process.env.MOCODE_JOB_MAX_MS ?? 0);
    const maxTokens = Number(process.env.MOCODE_JOB_MAX_TOKENS ?? 0);
    if (maxMs > 0 || maxTokens > 0) {
      const controller = new AbortController();
      const state = { tokens: 0, maxTokens, controller, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      if (maxMs > 0)
        state.timer = setTimeout(() => {
          process.stderr.write(`\n[guard] job exceeded ${maxMs}ms; aborting\n`);
          controller.abort();
        }, maxMs);
      jobGuard = state;
      jobSignal = controller.signal;
    }
  }
  const hooks: AgentHooks = {
    onLiveUsage: (u) => {
      if (!jobGuard) return;
      jobGuard.tokens = Math.max(jobGuard.tokens, u.totalTokens);
      if (jobGuard.maxTokens && jobGuard.tokens > jobGuard.maxTokens) {
        process.stderr.write(`\n[guard] job exceeded ${jobGuard.maxTokens} tokens; aborting\n`);
        jobGuard.controller?.abort();
      }
    },
    onText: (delta) => {
      textBuffer += delta;
      if (!opts.json) process.stdout.write(delta);
    },
    onToolHeader: (tc: ToolCallRef) => {
      if (!opts.json && textBuffer && !textBuffer.endsWith('\n')) {
        process.stdout.write('\n');
        textBuffer += '\n';
      }
      process.stderr.write(`[${tc.name}] ${summarizeToolCall(tc.name, tc.arguments)}\n`);
    },
    onToolResult: (tc: ToolCallRef, output: string) => {
      if (!opts.verbose) return;
      process.stderr.write(`  → ${summarizeToolResult(tc.name, output)}\n`);
    },
    ...(opts.jobId
      ? {
          onCheckpoint: (h: ChatMessage[]) => writeCheckpoint(opts.jobId!, h),
        }
      : {}),
    onModelRetry: (info) => {
      process.stderr.write(`[retry] model error (${info.code}), retry ${info.nextAttempt} in ${info.waitMs}ms\n`);
    },
  };

  const startedAt = Date.now();
  let exitCode = 0;
  let result;
  const invokeCore = () =>
    runAgentCore({
      history,
      userInput: prompt,
      hooks,
      ...(jobSignal ? { signal: jobSignal } : {}),
      runtimeContext: runtime.context,
      ...(resumedFromCheckpoint ? { continueFromHistory: true } : {}),
      ...(toolFilter ? { toolsOverride: toolFilter.toolsOverride, runtimeAllowedToolNames: toolFilter.allowed } : {}),
    });
  try {
    result = opts.botName ? await runAsIdentity(opts.botName, () => invokeCore()) : await invokeCore();
  } finally {
    if (jobGuard?.timer) clearTimeout(jobGuard.timer);
    try {
      runtime.session.save(history, sessionId, [prompt], []);
    } catch {
      // 落盘失败不覆盖主结果
    }
    closeAllMcp();
    await runtime.close();
    if (wt) {
      try {
        removeWorktree(wt);
      } catch {
        process.stderr.write(`mocode: failed to remove worktree ${wt.path}（手动清理）\n`);
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const finalText = result.finalText ?? (opts.json ? null : textBuffer);

  if (opts.json) {
    const payload: HeadlessJsonResult = {
      terminationReason: result.terminationReason,
      text: finalText,
      sessionId,
      changedFiles: result.changedFiles ?? [],
      usage: result.usage,
      elapsedMs,
      model: config.model,
      ...(opts.botName ? { bot: opts.botName } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (finalText && !textBuffer) {
    process.stdout.write(finalText);
  }
  if (!opts.json && process.stdout.isTTY && finalText && !finalText.endsWith('\n')) process.stdout.write('\n');

  if (result.terminationReason === 'aborted') exitCode = 130;
  else if (result.terminationReason === 'max_steps' || !result.completed) exitCode = 1;

  return exitCode;
}

/** 无 -p 且 stdin 被重定向时，从 stdin 取 prompt；返回 null 表示无可用输入。 */
export async function resolvePrompt(inlinePrompt?: string): Promise<string | null> {
  if (inlinePrompt !== undefined) return inlinePrompt;
  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    return piped || null;
  }
  return null;
}
