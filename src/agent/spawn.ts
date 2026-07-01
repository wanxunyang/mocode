// 子 agent 封装:runAgentCore + 静默 hooks。独立 history / 可受限工具子集 / 低步数上限。
// 供 task 工具(主 agent 派生子任务)调用——子 agent 的最终摘要回灌主 history。
//
// 与主 agent 的区别:
//  - 不写主屏(layout.contentWrite):中间过程(流式正文 / 工具头 / diff)缓冲到内部字符串,
//    结束返回给 task 工具(task 把它当 tool 结果回灌主 history,主 agent 据此继续)。
//  - 独立 history:不共享主对话,避免子任务的工具噪声污染主上下文。
//  - 系统提示复用主 agent 组装链(config.systemPrompt + memory 段 + skills 段)+ 子 agent 角色后缀。
//  - 工具子集:按白名单从 chatTools 过滤;无白名单 = 全量(但 task 工具调用方通常会限定只读)。
//  - 不调 beginTurn(不进主回滚链);但文件 mutation 仍经 executeTool→recordMutation,
//    归入当前主轮次(语义:子 agent 的改动属于当前主轮,可随 /rollback 一起撤销)。
//  - 步数上限默认更低(config.subAgentMaxSteps ?? 50),防子任务失控耗尽配额。
//  - 中断透传:opts.signal(主 agent 的 abort signal)透传给 runAgentCore → chat/executeTool,
//    主 Ctrl+C 树杀子 agent(chat 流式 abort + run_command/web_fetch 即时取消)。
//  - 逻辑隔离(回滚):skipRollback=true,子 agent 的 write_file/edit_file 改动不进主回滚快照链,
//    主 /rollback 不撤销子 agent 改动(靠 git 兜底)。子 agent 与主 agent 共享 cwd(文件改动可见)。

import type OpenAI from 'openai';
import { chatTools, type ChatMessage } from '../llm/index.js';
import { config } from '../config/index.js';
import { effectiveSystemPrompt } from '../skills/index.js';
import { buildMemorySection, buildMemoryIndexSection } from '../memory/index.js';
import { ui } from '../ui/theme.js';
import { runAgentCore, type AgentHooks } from './core.js';
import { summarizeToolCall, summarizeToolResult, truncateDisplay } from '../ui/render.js';

/** 子 agent 系统提示后缀:角色与约束。 */
const SUBAGENT_SUFFIX = `

## ⛯ SUB-AGENT MODE (you are a sub-agent)
You are a sub-agent spawned by the main agent to handle an isolated sub-task. You have your own conversation history (independent of the main thread).
- Focus solely on the assigned sub-task. Do NOT attempt to call the "task" tool (no recursive spawning).
- Use the tools available to you to complete the sub-task.
- When done, your final text reply will be returned to the main agent as a summary — make it concise and actionable: what you did, key findings, files changed, and any issues. The main agent will decide the next step based on your summary.`;

/** 子 agent 运行选项。 */
export interface SpawnOptions {
  /** 子任务指令(作为子 agent 的 user 消息)。 */
  prompt: string;
  /** 附加系统提示(角色/约束),拼在 SUBAGENT_SUFFIX 后。 */
  systemPromptSuffix?: string;
  /** 允许的工具名白名单(可选)。无 = 全量工具;给则从 chatTools 过滤。 */
  tools?: string[];
  /** 步数上限(可选,默认 config.subAgentMaxSteps ?? 50)。 */
  maxSteps?: number;
  /** 主 agent 的 abort signal(可选)。透传给子 runAgentCore → chat/executeTool,
   *  主 Ctrl+C 树杀子 agent(chat 流式 abort + run_command/web_fetch 即时取消)。 */
  signal?: AbortSignal;
}

/** 子 agent 运行结果。 */
export interface SpawnResult {
  /** 子 agent 最终文本回复;中断或无回复为 null。 */
  summary: string | null;
  /** 正常完毕 true;中断 false。 */
  completed: boolean;
  /** 子 agent 中间过程的人类可读日志(工具调用 + 结果摘要 + 流式正文片段)。主 agent 通常不看,调试用。 */
  transcript: string;
}

/**
 * 派生一个子 agent 执行独立子任务。
 *
 * 行为:
 *  - 构造独立 history:[{system: 主系统提示 + SUBAGENT_SUFFIX + 自定义后缀}, {user: prompt}]
 *  - 工具子集:按 opts.tools 白名单过滤 chatTools;无白名单 = 全量。
 *  - 静默 hooks:流式正文 / 工具头 / 结果缓冲到 transcript;不写主屏(layout)。
 *  - 返回 { summary, completed, transcript }。summary 给 task 工具回灌主 history。
 *
 * 中断:opts.signal 透传给子 runAgentCore——主 Ctrl+C 树杀子 agent(chat abort + 工具 abort)。
 * 子 agent 跑在主 signal 下,主 abort 即子 abort;子 agent 的 abortRestore 还原子 history + 模式。
 */
export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const maxSteps = opts.maxSteps ?? config.subAgentMaxSteps ?? 50;

  // 构造子 agent 系统提示:复用主 agent 组装链 + 子 agent 角色后缀 + 自定义后缀。
  const systemPrompt = effectiveSystemPrompt(
    config.systemPrompt +
      buildMemorySection() +
      buildMemoryIndexSection() +
      SUBAGENT_SUFFIX +
      (opts.systemPromptSuffix ? `\n\n${opts.systemPromptSuffix}` : ''),
  );

  // 工具子集:白名单过滤。无白名单 = 全量 chatTools,但始终剔除 task(防递归派生)。
  let toolsOverride: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined;
  if (opts.tools && opts.tools.length > 0) {
    const allow = new Set(opts.tools);
    toolsOverride = chatTools.filter(
      (t) => allow.has(t.function.name) && t.function.name !== 'task',
    );
  } else {
    toolsOverride = chatTools.filter((t) => t.function.name !== 'task');
  }

  // 独立 history(子 agent 自己持有,不共享主对话)。
  // 只塞 system;user 消息由 runAgentCore 的 userInput 参数 push(与主 agent 一致)。
  const history: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // 静默 hooks:缓冲中间过程到 transcript,不写主屏。
  let transcript = '';
  const buf: string[] = [];
  const writeBuf = (s: string): void => {
    buf.push(s);
    transcript += s;
  };

  let lastChar = '';

  const hooks: AgentHooks = {
    onText: (s) => {
      writeBuf(s); // 缓冲流式正文(无 markdown 渲染,原始文本)
      if (s) lastChar = s[s.length - 1];
    },
    onToolCall: (name) => {
      if (lastChar && lastChar !== '\n') {
        writeBuf('\n');
        lastChar = '\n';
      }
      // 子 agent 静默:不启 spinner(name 参数仅主 agent 用)
    },
    onToolHeader: (tc) => {
      const summary = summarizeToolCall(tc.name, tc.arguments);
      writeBuf(`  ● ${tc.name}  ${summary}\n`);
    },
    onToolResult: (tc, output) => {
      const preview = summarizeToolResult(tc.name, output);
      if (preview) writeBuf(`  ↳ ${preview}\n`);
    },
    onTextEnd: () => {
      if (lastChar && lastChar !== '\n') {
        writeBuf('\n');
        lastChar = '\n';
      }
    },
    onToolBatchEnd: () => writeBuf('\n'),
    onNoReply: () => writeBuf(`${ui.dim}(无回复)${ui.reset}\n`),
    onMaxSteps: () =>
      writeBuf(`  ● 达到最大步数(${maxSteps}),子 agent 停止。\n`),
    onDone: (elapsedMs) =>
      writeBuf(`  ✻ 子 agent 耗时 ${(elapsedMs / 1000).toFixed(1)}s\n`),
    // onStepStart / onChatDone / onToolStart / onToolDone / onAbort:子 agent 静默,无需 spinner / 中断渲染。
    // abort 还原(history 还原 + 模式还原)由 core 的 abortRestore 处理,hooks 只管展示。
  };

  const result = await runAgentCore({
    history,
    userInput: opts.prompt,
    signal: opts.signal, // 主 Ctrl+C 树杀子 agent(chat abort + 工具 abort)
    hooks,
    maxSteps,
    toolsOverride,
    skipRollback: true, // 逻辑隔离:子 agent 文件改动不进主回滚快照链,主 /rollback 不撤销(靠 git 兜底)
  });

  return {
    summary: result.finalText,
    completed: result.completed,
    transcript: truncateDisplay(transcript, 20000), // 防过大;调试用,回灌主 history 的是 summary 不是 transcript
  };
}
