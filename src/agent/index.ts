import { stdout } from 'node:process';
import { chat, type ChatMessage } from '../llm/index.js';
import { executeTool } from '../tools/registry.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import { summarizeToolCall, summarizeToolResult } from '../ui/render.js';
import {
  maybeCompact,
  capToolResultForHistory,
  contextState,
} from '../session/index.js';

const MAX_STEPS = 25; // 防止无限循环

/**
 * agent 核心循环:
 *  流式调 LLM(onText / onThinking 实时打印)→ 有 tool_calls 就执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由 REPL 持有。
 *  步前经 session/maybeCompact 自动压缩(接近窗口上限时三层压缩);
 *  工具结果进 history 前经 capToolResultForHistory 裁到单条上限。
 *
 *  思考段在结束(切到 text / tool_call / 流结束)时用 ANSI 回卷并擦除,
 *  换成一行的折叠标题;原文存入 collapsedThinkings 供 /think N 重打。
 */
export async function runAgent(
  history: ChatMessage[],
  userInput: string,
  collapsedThinkings: string[] = []
): Promise<void> {
  history.push({ role: 'user', content: userInput });
  const spinner = new Spinner();
  // 本轮流式状态:区分「思考」与「正文」,首个 token 到达即停 spinner。
  let mode: 'idle' | 'thinking' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';
  // 折叠用:累计本段思考已占用的显示行数 + 原文缓冲。
  let thinkingBuffer = '';
  let thinkingLines = 0;

  /** 把当前还在屏幕上可见的思考段擦掉,换成一行折叠标题;原文入栈。 */
  const flushThinkCollapsed = () => {
    if (mode !== 'thinking') return;
    collapsedThinkings.push(thinkingBuffer);
    const idx = collapsedThinkings.length;
    // 光标上移 thinkingLines 行,再清到屏幕末尾,最后印一行折叠标题。
    stdout.write(`\x1B[${thinkingLines}A\x1B[J`);
    stdout.write(
      `${ui.dim}▎ 思考 ▸ (${thinkingBuffer.length} 字符, /think ${idx} 展开)${ui.reset}\n`
    );
    thinkingBuffer = '';
    thinkingLines = 0;
    // 之后任何输出按 text 走,不再回到 thinking(避免后续再被错误折叠)
    mode = 'text';
  };

  const onThinking = (s: string) => {
    if (mode === 'idle') {
      spinner.stop();
      stdout.write(`${ui.dim}▎ 思考${ui.reset}\n`);
      thinkingLines = 1; // 标题行占 1 行
    } else if (mode === 'text') {
      stdout.write(`\n${ui.dim}▎ 思考(续)${ui.reset}\n`);
      thinkingLines += 1; // 续标题 + 之前的换行
    }
    mode = 'thinking';
    thinkingBuffer += s;
    stdout.write(`${ui.dim}${s}${ui.reset}`);
    thinkingLines += (s.match(/\n/g) || []).length;
    if (s) lastChar = s[s.length - 1];
  };

  const onText = (s: string) => {
    flushThinkCollapsed(); // 思考→正文过渡时折叠
    if (mode === 'idle') spinner.stop();
    mode = 'text';
    gotText = true;
    stdout.write(s);
    if (s) lastChar = s[s.length - 1];
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // 步前:接近窗口上限时自动压缩(三层)。此时 spinner 已停,通知行干净。
      await maybeCompact(history);
      spinner.start('思考中');
      mode = 'idle';
      gotText = false;
      lastChar = '';
      const result = await chat(history, { onText, onThinking });
      contextState.lastUsage = result.usage; // 供 /context 显示实测 token
      spinner.stop();

      if (result.toolCalls.length > 0) {
        // 思考后直接进入 tool_call(无 text):先把可见的思考段折叠
        flushThinkCollapsed();
        // 带工具调用的 assistant 消息原样回灌(OpenAI 格式要求)
        history.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } as ChatMessage);

        for (const tc of result.toolCalls) {
          const summary = summarizeToolCall(tc.name, tc.arguments);
          stdout.write(
            `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}${tc.name}${ui.reset}  ${ui.dim}${summary}${ui.reset}\n`
          );
          spinner.start(`执行 ${tc.name}`);
          const output = await executeTool(tc.name, tc.arguments);
          spinner.stop();
          const preview = summarizeToolResult(tc.name, output);
          if (preview) {
            stdout.write(`  ${ui.gray}↳ ${preview}${ui.reset}\n`);
          }
          history.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: capToolResultForHistory(tc.name, output),
          } as ChatMessage);
        }
        continue; // 带着工具结果再调一次 LLM
      }

      // 思考后既无 tool_call 也无 text(纯思考):兜底折叠
      flushThinkCollapsed();
      if (mode !== 'idle' && lastChar !== '\n') stdout.write('\n'); // 流式末尾补换行

      // 没有工具调用:流式正文即最终回复(已实时打印)
      if (!gotText) stdout.write(`${ui.dim}(无回复)${ui.reset}\n`);
      history.push({ role: 'assistant', content: result.content });
      return;
    }

    stdout.write(
      `  ${ui.yellow}●${ui.reset} ${ui.yellow}达到最大步数(${MAX_STEPS}),本轮停止。${ui.reset}\n`
    );
  } finally {
    spinner.stop();
  }
}
