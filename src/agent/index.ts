import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { renderFileChange } from '../ui/diff.js';
import * as layout from '../ui/layout.js';
import { beginTurn } from '../rollback/index.js';
import {
  maybeCompact,
  capToolResultForHistory,
  contextState,
} from '../session/index.js';

const MAX_STEPS = 25; // 防止无限循环

/** 解析工具 arguments JSON;非法或空返 null(调用方据此降级到普通 preview)。 */
function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

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
  // 开新轮次(回滚用):首行截断 40,供 /rollback 轮次菜单展示。
  beginTurn(truncateDisplay(userInput.split('\n')[0] ?? '', 40));
  layout.contentMode(); // 防御性:确保光标在内容续写位(enterRunningMode 已置,这里兜底)
  // spinner:状态行 + 续写位内联转圈(思考中 / 执行 工具时,内容区不再「干等」)。
  // 内联帧不进缓冲、停时清掉,随后结果即写在该行——故 spinner 不入历史、PgUp 看不到。
  const spinner = new Spinner((msg, frame) => {
    layout.setStatus(msg, frame ?? undefined);
    if (frame) {
      layout.paintLiveAtCursor(
        `  ${ui.brightMagenta}${frame}${ui.reset} ${ui.dim}${msg}…${ui.reset}`
      );
    } else {
      layout.clearLiveAtCursor();
    }
  });
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
    spinner.stop(); // 任何正文 token 都停 spinner(首 token 停「思考中」;onToolCall 重启后若又来文本则停「生成中」)。未旋转时 stop 为 no-op。
    mode = 'text';
    gotText = true;
    layout.contentWrite(s);
    if (s) lastChar = s[s.length - 1];
  };

  const onToolCall = (name: string) => {
    // 文本/思考已流完,模型转而生成 tool_call 参数(可能很长,如 write_file 整篇内容):
    // 补换行(让随后的 ● 行与 diff 不黏在正文末尾)+ 启「生成中」内联 spinner,内容区不再干等。
    if (lastChar && lastChar !== '\n') {
      layout.contentWrite('\n');
      lastChar = '\n';
    }
    if (name) spinner.start(`生成 ${name}…`);
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
        result = await chat(history, { onText, onThinking, onToolCall }, signal);
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
        // 流式正文末尾补换行(若 onToolCall 已补则 lastChar='\n',此处 no-op);防 ● 行黏在正文行尾
        if (mode !== 'idle' && lastChar !== '\n') layout.contentWrite('\n');
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
          const isMutation = tc.name === 'edit_file' || tc.name === 'write_file';
          const parsed = isMutation ? parseArgs(tc.arguments) : null;
          // write_file 覆盖场景:执行前读旧内容供 diff(不存在→null=新建)。
          // edit_file:执行前读文件定位 old_string 起始行,供 diff 显示真实文件行号。
          // 两者皆失败不阻断(读不到则 diff 退化为相对行号 / 不渲染)。
          let preWriteOld: string | null = null;
          let editStartLine = 1;
          if (parsed) {
            const p = String(parsed.path ?? '');
            if (p) {
              if (tc.name === 'write_file') {
                try {
                  preWriteOld = readFileSync(resolve(p), 'utf8');
                } catch {
                  preWriteOld = null; // 文件不存在(新建)或不可读
                }
              } else if (tc.name === 'edit_file') {
                const oldStr = String(parsed.old_string ?? '');
                try {
                  const data = readFileSync(resolve(p), 'utf8');
                  const idx = oldStr ? data.indexOf(oldStr) : -1;
                  if (idx >= 0) editStartLine = data.slice(0, idx).split('\n').length;
                } catch {
                  // 读不到:startLine 保持 1(diff 退化为相对行号)
                }
              }
            }
          }
          spinner.start(`执行 ${tc.name}`);
          const output = await executeTool(tc.name, tc.arguments);
          spinner.stop();
          // edit_file / write_file 成功:渲染 diff 块(行号 + 语法高亮,仿 Claude Code);其余工具走一行 preview。
          if (isMutation && parsed && !output.startsWith('错误')) {
            layout.contentWrite(
              renderFileChange({
                path: String(parsed.path ?? ''),
                kind: tc.name === 'edit_file' ? 'edit' : 'write',
                oldStr:
                  tc.name === 'edit_file'
                    ? String(parsed.old_string ?? '')
                    : preWriteOld,
                newStr: String(
                  (tc.name === 'edit_file' ? parsed.new_string : parsed.content) ??
                    '',
                ),
                startLine: tc.name === 'edit_file' ? editStartLine : 1,
              }),
            );
          } else {
            const preview = summarizeToolResult(tc.name, output);
            if (preview) {
              layout.contentWrite(`  ${ui.gray}↳ ${preview}${ui.reset}\n`);
            }
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
