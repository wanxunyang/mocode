// Headless（一次性 / 非交互）模式：mocode -p "任务" 或 echo "任务" | mocode。
// 与 REPL 共用同一套装配（builtins 工具包 + MCP + Runtime + runAgentCore），
// 区别只在展示：没有全屏 TUI，正文流式写 stdout，进度写 stderr（保 stdout 可被管道解析）。
//
// 工具进度：默认每个调用打一行「[工具名] 关键参数」（经 summarizeToolCall，与 TUI
// 同源；browser fill 等敏感值刻意不显示）。--verbose 额外追加工具结果摘要。
// 正文通常不以换行收尾，工具行前先补一个换行，避免「…正文。[read_file] …」挤一行。
//
// 权限：非交互默认 fail-closed——confirm/dangerous 工具一律拒绝（见 permissions/index.ts
// 的 !process.stdin.isTTY 分支）。--dangerously-skip-permissions 显式关闭权限闸（与
// Claude Code 同名，操作者自担风险）。

import { setSandboxRoot } from './sandbox/root.js';
import { registerToolsExtension } from './tools/registry.js';
// 装配官方默认工具包：registry 不顶层 import builtins（破模块循环），入口须显式装配。
import './tools/builtins/index.js';
import { initializeAllMcp, getMcpTools, closeAllMcp } from './mcp/index.js';
import { config, buildBasePrompt, isMemoryEnabled } from './config/index.js';
import { effectiveSystemPrompt } from './skills/index.js';
import { buildMemoryIndexSection } from './memory/store.js';
import { defaultRuntime } from './runtime/index.js';
import { runAgentCore, type AgentHooks } from './agent/core.js';
import { summarizeToolCall, summarizeToolResult } from './ui/render.js';
import type { ChatMessage, ChatUsage, ToolCallRef } from './llm/index.js';

export interface HeadlessOptions {
  prompt: string;
  json: boolean;
  verbose: boolean;
  skipPermissions: boolean;
  sandboxRootOverride?: string;
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

  setSandboxRoot(opts.sandboxRootOverride ?? config.sandboxRoot ?? process.cwd());

  const runtime = defaultRuntime;
  await runtime.start();
  const sessionId = runtime.session.create();

  // MCP：与 REPL 同路径初始化；单个 server 失败不阻断。
  await initializeAllMcp();
  registerToolsExtension('mcp', getMcpTools());

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
    // 每个工具调用（含并行批）都先过 header：按模型发起顺序、带完整参数。
    onToolHeader: (tc: ToolCallRef) => {
      // 正文流不以换行收尾（最常见），工具行不补换行就会接在「…正文。」后面。
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
    // 无论成败都落盘 + 清理，保证会话可 --resume、MCP/浏览器进程不残留。
    try {
      runtime.session.save(history, sessionId, [prompt], []);
    } catch {
      // 落盘失败不覆盖主结果
    }
    closeAllMcp();
    await runtime.close();
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
    // 模型未走 onText 流式（极少见）时兜底输出。
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
