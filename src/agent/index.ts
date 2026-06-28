import {
  chat,
  type ChatMessage,
  type ChatResult,
} from '../llm/index.js';
import { executeTool } from '../tools/registry.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import {
  summarizeToolCall,
  summarizeToolResult,
  truncateDisplay,
} from '../ui/render.js';
import * as layout from '../ui/layout.js';
import { beginTurn } from '../rollback/index.js';
import {
  maybeCompact,
  capToolResultForHistory,
  contextState,
} from '../session/index.js';

const MAX_STEPS = 25; // 防止无限循环

/**
 * agent 核心循环:
 *  流式调 LLM(onText / onThinking 实时写内容区)→ 有 tool_calls 就执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由 REPL 持有。
 *  步前经 session/maybeCompact 自动压缩(接近窗口上限时三层压缩);
 *  工具结果进 history 前经 capToolResultForHistory 裁到单条上限。
 *
 *  所有正文写经 layout.contentWrite(保证落在内容区、跟踪续写位、底栏不被顶);
 *  spinner 经 onFrame 回调刷状态行(layout.drawStatusBar),等待时内容区静止、底栏转圈。
 *  思考段用 layout.beginSegment / eraseSegmentBack 精确按物理行折叠(修预存按 \n 数行漏擦 bug),
 *  原文存入 collapsedThinkings 供 /think N 重打。
 */
export async function runAgent(
  history: ChatMessage[],
  userInput: string,
  collapsedThinkings: string[] = [],
  signal?: AbortSignal
): Promise<void> {
  // 中断回滚快照:入口(本 turn push 任何消息前)整段浅拷贝。abort 时 length=0;push(...saved) 还原。
  // 用 slice() 而非 length:maybeCompact 会原地重建(length=0;push(...rebuilt)),savedLen 会失效。
  const savedHistory = history.slice();
  history.push({ role: 'user', content: userInput });
  // 开新轮次(回滚用):首行截断 40,供双击 Esc 轮次列表展示。
  beginTurn(truncateDisplay(userInput.split('\n')[0] ?? '', 40));
  layout.contentMode(); // 防御性:确保光标在内容续写位(enterRunningMode 已置,这里兜底)
  const spinner = new Spinner((msg, frame) =>
    layout.setStatus(msg, frame ?? undefined)
  );
  // 本轮流式状态:区分「思考」与「正文」,首个 token 到达即停 spinner。
  let mode: 'idle' | 'thinking' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';
  // 折叠用:累计本段思考原文缓冲。
  let thinkingBuffer = '';

  /** 把当前还在屏幕上可见的思考段擦掉,换成一行折叠标题;原文入栈。 */
  const flushThinkCollapsed = () => {
    if (mode !== 'thinking') return;
    collapsedThinkings.push(thinkingBuffer);
    const idx = collapsedThinkings.length;
    layout.eraseSegmentBack(); // 逐行擦思考段(不用 ED——ED 会清穿底栏)
    layout.contentWrite(
      `${ui.dim}▎ 思考 ▸ (${thinkingBuffer.length} 字符, /think ${idx} 展开)${ui.reset}\n`
    );
    thinkingBuffer = '';
    // 之后任何输出按 text 走,不再回到 thinking(避免后续再被错误折叠)
    mode = 'text';
  };

  const onThinking = (s: string) => {
    if (mode === 'idle') {
      spinner.stop();
      if (lastChar && lastChar !== '\n') layout.contentWrite('\n');
      layout.beginSegment(); // 思考段起点(标题行)
      layout.contentWrite(`${ui.dim}▎ 思考${ui.reset}\n`);
    } else if (mode === 'text') {
      // 续思考:先把续标题放到新行,再开新段(段起点 = 续标题行,擦除不误伤上文)
      if (lastChar && lastChar !== '\n') layout.contentWrite('\n');
      layout.beginSegment();
      layout.contentWrite(`${ui.dim}▎ 思考(续)${ui.reset}\n`);
    }
    mode = 'thinking';
    thinkingBuffer += s;
    layout.contentWrite(`${ui.dim}${s}${ui.reset}`);
    if (s) lastChar = s[s.length - 1];
  };

  const onText = (s: string) => {
    flushThinkCollapsed(); // 思考→正文过渡时折叠
    if (mode === 'idle') spinner.stop();
    mode = 'text';
    gotText = true;
    layout.contentWrite(s);
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
      let result: ChatResult;
      try {
        result = await chat(history, { onText, onThinking }, signal);
      } catch (e) {
        // 中断(用户运行中 Ctrl+C):停 spinner、补换行、提示、history 还原到本 turn 前、return(不抛)。
        // abort 只在 await chat() 期生效;tool 执行不可中断,故不会留下未配对的 tool_call_id。
        if (
          signal?.aborted ||
          (e instanceof Error &&
            (e.name === 'AbortError' || e.name === 'APIUserAbortError'))
        ) {
          spinner.stop();
          if (lastChar && lastChar !== '\n') layout.contentWrite('\n');
          layout.contentWrite(`${ui.dim}(已中断)${ui.reset}\n`);
          history.length = 0;
          history.push(...savedHistory);
          return;
        }
        throw e;
      }
      contextState.lastUsage = result.usage; // 供 /context 与状态行显示实测 token
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
          layout.contentWrite(
            `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}${tc.name}${ui.reset}  ${ui.dim}${summary}${ui.reset}\n`
          );
          spinner.start(`执行 ${tc.name}`);
          const output = await executeTool(tc.name, tc.arguments);
          spinner.stop();
          const preview = summarizeToolResult(tc.name, output);
          if (preview) {
            layout.contentWrite(`  ${ui.gray}↳ ${preview}${ui.reset}\n`);
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
      if (mode !== 'idle' && lastChar !== '\n') layout.contentWrite('\n'); // 流式末尾补换行

      // 没有工具调用:流式正文即最终回复(已实时打印)
      if (!gotText) layout.contentWrite(`${ui.dim}(无回复)${ui.reset}\n`);
      history.push({ role: 'assistant', content: result.content });
      return;
    }

    layout.contentWrite(
      `  ${ui.yellow}●${ui.reset} ${ui.yellow}达到最大步数(${MAX_STEPS}),本轮停止。${ui.reset}\n`
    );
  } finally {
    spinner.stop();
  }
}
