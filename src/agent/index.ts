import { stdout } from 'node:process';
import { chat, type ChatMessage } from '../llm/index.js';
import { executeTool } from '../tools/registry.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import { summarizeToolCall, summarizeToolResult } from '../ui/render.js';

const MAX_STEPS = 25; // 防止无限循环

/**
 * agent 核心循环:
 *  流式调 LLM(onText / onThinking 实时打印)→ 有 tool_calls 就执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由 REPL 持有。
 */
export async function runAgent(
  history: ChatMessage[],
  userInput: string
): Promise<void> {
  history.push({ role: 'user', content: userInput });
  const spinner = new Spinner();
  // 本轮流式状态:区分「思考」与「正文」,首个 token 到达即停 spinner。
  let mode: 'idle' | 'thinking' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';

  const onThinking = (s: string) => {
    if (mode === 'idle') {
      spinner.stop();
      stdout.write(`${ui.dim}▎ 思考${ui.reset}\n`);
    } else if (mode === 'text') {
      stdout.write(`\n${ui.dim}▎ 思考(续)${ui.reset}\n`);
    }
    mode = 'thinking';
    stdout.write(`${ui.dim}${s}${ui.reset}`);
    if (s) lastChar = s[s.length - 1];
  };

  const onText = (s: string) => {
    if (mode === 'idle') spinner.stop();
    if (mode === 'thinking') stdout.write('\n'); // 思考段结束,换行分隔
    mode = 'text';
    gotText = true;
    stdout.write(s);
    if (s) lastChar = s[s.length - 1];
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      spinner.start('思考中');
      mode = 'idle';
      gotText = false;
      lastChar = '';
      const result = await chat(history, { onText, onThinking });
      spinner.stop();
      if (mode !== 'idle' && lastChar !== '\n') stdout.write('\n'); // 流式末尾补换行

      if (result.toolCalls.length > 0) {
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
            content: output,
          } as ChatMessage);
        }
        continue; // 带着工具结果再调一次 LLM
      }

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
