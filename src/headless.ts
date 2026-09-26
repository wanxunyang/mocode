// Headless（一次性 / 非交互）模式：mocode -p "任务" 或 echo "任务" | mocode。
// 与 REPL 共用同一套装配（builtins 工具包 + MCP + runAgentCore），区别只在展示：
// 没有全屏 TUI，正文流式写 stdout，进度写 stderr（保 stdout 可被管道解析）。
//
// 工具进度：默认每个调用打一行「[工具名] 关键参数」（经 summarizeToolCall，与 TUI
// 同源；browser fill 等敏感值刻意不显示）。--verbose 额外追加工具结果摘要。
//
// 隔离（B3）：
// - --session-dir <path>：会话写到独立目录（不污染主 .mocode/sessions）。
// - --worktree：在 git detached worktree 里跑，sandboxRoot 指向 worktree，
//   结束自动销毁；主工作区零改动。两者都走独立 Runtime（不碰全局单例）。
//
// 权限：非交互默认 fail-closed——confirm/dangerous 工具一律拒绝（见 permissions/index.ts
// 的 !process.stdin.isTTY 分支）。--dangerously-skip-permissions 显式关闭权限闸。

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
import type { ChatMessage, ChatUsage, ToolCallRef } from './llm/index.js';
import { createWorktree, removeWorktree, type Worktree } from './jobs/worktree.js';

export interface HeadlessOptions {
  prompt: string;
  json: boolean;
  verbose: boolean;
  skipPermissions: boolean;
  sandboxRootOverride?: string;
  /** 会话独立落盘目录（--session-dir）。 */
  sessionDir?: string;
  /** 在 git detached worktree 中执行（--worktree）。 */
  worktree?: boolean;
}

export interface HeadlessJsonResult {
  terminationReason: 'completed' | 'aborted' | 'max_steps';
  text: string | null;
  sessionId: string;
  changedFiles: string[];
  usage?: ChatUsage;
  elapsedMs: number;
  model: string;
}

/** 读取 stdin 全部内容作为 prompt（管道场景）。 */
async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const prompt = (opts.prompt ?? '').trim();
  if (!prompt) {
    process.stderr.write('mocode: empty prompt (use -p "..." or pipe via stdin)\n');
    return 1;
  }

  if (opts.skipPermissions) config.permissionEnabled = false;

  // worktree：先建隔离工作树（失败明确报错，不静默回退主工作区——避免误以为已隔离）。
  let wt: Worktree | null = null;
  if (opts.worktree) {
    try {
      wt = createWorktree();
    } catch (e) {
      process.stderr.write(`mocode: worktree setup failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  const effectiveSandboxRoot = wt?.path ?? opts.sandboxRootOverride;
  const isolated = wt !== null || opts.sessionDir !== undefined;

  // MCP 先初始化并注册到全局：独立 Runtime 创建时会复制当前 builtinTools（含 MCP），
  // 故这步必须早于 new Runtime。
  await initializeAllMcp();
  registerToolsExtension('mcp', getMcpTools());

  let runtime: Runtime;
  if (isolated) {
    runtime = new Runtime({
      sandboxRoot: effectiveSandboxRoot, // undefined → context 回退全局根（--session-dir 单用场景）
      ...(opts.sessionDir ? { configOverrides: { sessionDir: path.resolve(opts.sessionDir) } } : {}),
    });
  } else {
    setSandboxRoot(effectiveSandboxRoot ?? config.sandboxRoot ?? process.cwd());
    runtime = defaultRuntime;
  }

  await runtime.start();
  const sessionId = runtime.session.create();

  const history: ChatMessage[] = [
    {
      role: 'system',
      content: effectiveSystemPrompt(buildBasePrompt(sessionId) + buildMemoryIndexSection(isMemoryEnabled())),
    },
  ];

  let textBuffer = '';
  const hooks: AgentHooks = {
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
    onModelRetry: (info) => {
      process.stderr.write(`[retry] model error (${info.code}), retry ${info.nextAttempt} in ${info.waitMs}ms\n`);
    },
  };

  const startedAt = Date.now();
  let exitCode = 0;
  let result;
  try {
    result = await runAgentCore({
      history,
      userInput: prompt,
      hooks,
      runtimeContext: runtime.context,
    });
  } finally {
    try {
      runtime.session.save(history, sessionId, [prompt], []);
    } catch {
      // 落盘失败不覆盖主结果
    }
    closeAllMcp();
    await runtime.close();
    // worktree 最后销毁（runtime 已关闭、文件句柄释放）。
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
