import { stdout } from 'node:process';
import { chat, type ChatMessage } from './llm.js';
import { executeTool } from './tools.js';
import { ui } from './ui.js';

const MAX_STEPS = 25; // 防止无限循环

/** agent 核心循环:
 *  流式调 LLM → 有 tool_calls 就执行并回灌历史 → 否则输出回复并返回。
 * history 在调用间持久,由 REPL 持有。
 */
export async function runAgent(
  history: ChatMessage[],
  userInput: string
): Promise<void> {
  history.push({ role: 'user', content: userInput });

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await chat(history, {
      onContentDelta: (delta) => {
        stdout.write(delta);
      },
      onToolCallStart: (name, preview) => {
        const line = preview
          ? `  ${ui.gray}[tool]${ui.reset} ${ui.cyan}${name}${ui.reset}  ${ui.dim}${preview}${ui.reset}`
          : `  ${ui.gray}[tool]${ui.reset} ${ui.cyan}${name}${ui.reset}`;
        stdout.write('\n' + line + '\n');
      },
    });

    if (result.toolCalls.length > 0) {
      // 把带 tool_calls 的 assistant 消息原样回灌(OpenAI 格式要求)
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
        const output = await executeTool(tc.name, tc.arguments);
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: output,
        } as ChatMessage);
      }
      continue; // 带着工具结果再调一次 LLM
    }

    // 没有工具调用:最终回复(内容已在流式过程中输出)
    const text = result.content ?? '(无回复)';
    if (!result.content) {
      stdout.write(text + '\n');
    }
    history.push({ role: 'assistant', content: text });
    return;
  }

  console.log(`${ui.yellow}[agent] 达到最大步数(25),本轮停止。${ui.reset}`);
}
