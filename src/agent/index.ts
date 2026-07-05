// 主 agent:runAgentCore + TUI 渲染 hooks 的薄封装。
// 循环逻辑(流式 chat → 工具分组执行 → 回灌 / abort 还原 / maybeCompact)全部在 core.ts,
// 本文件只负责把展示副作用(layout.contentWrite / Spinner / diff / 回滚轮次)注入为 AgentHooks。
// 行为与重构前的单文件 runAgent 完全一致——这是安全重构,实跑回归验证。

import type { ChatMessage, ToolCallRef } from '../llm/index.js';
import { ui } from '../ui/theme.js';
import { Spinner } from '../ui/spinner.js';
import {
  summarizeToolCall,
  summarizeToolResult,
  truncateDisplay,
  fmtElapsed,
} from '../ui/render.js';
import { renderFileChange } from '../ui/diff.js';
import * as layout from '../ui/layout.js';
import { beginTurn } from '../rollback/index.js';
import { config } from '../config/index.js';
import {
  runAgentCore,
  parseArgs,
  readDiffContext,
  isMutationTool,
  type AgentHooks,
  type AgentRunResult,
  type ContentPart,
} from './core.js';
import { createPetHooks } from '../pet/state.js';

/** 取 userInput 的首行:字符串直接 split;多模态 parts 找首个 text part 再 split。 */
function firstLineOf(ui: string | ContentPart[]): string {
  if (typeof ui === 'string') return ui.split('\n')[0] ?? '';
  const first = ui.find((p) => p.type === 'text') as { text: string } | undefined;
  return first?.text.split('\n')[0] ?? '';
}

/** 工具调用 ● 头:工具名 + 参数摘要(按 tool_calls 原顺序打印,让用户看到本轮跑哪些工具)。 */
function writeToolHeader(tc: ToolCallRef): void {
  const summary = summarizeToolCall(tc.name, tc.arguments);
  layout.contentWrite(
    `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}${tc.name}${ui.reset}  ${ui.dim}${summary}${ui.reset}\n`
  );
}

/** 渲染工具结果:mutation 成功走 diff 块(行号 + 语法高亮,仿 Claude Code);其余走一行 preview。 */
function writeToolResult(
  tc: ToolCallRef,
  output: string,
  parsed: Record<string, unknown> | null,
  preWriteOld: string | null,
  editStartLine: number,
): void {
  if (isMutationTool(tc.name) && parsed && !output.startsWith('错误')) {
    layout.contentWrite(
      renderFileChange({
        path: String(parsed.path ?? ''),
        kind: tc.name === 'edit_file' ? 'edit' : 'write',
        oldStr:
          tc.name === 'edit_file'
            ? String(parsed.old_string ?? '')
            : preWriteOld,
        newStr: String(
          (tc.name === 'edit_file' ? parsed.new_string : parsed.content) ?? '',
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
}

/**
 * agent 核心循环(主 agent,TUI 渲染版):
 *  流式调 LLM(onText 实时写内容区)→ 有 tool_calls 就执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由 REPL 持有。
 *  步前经 session/maybeCompact 自动压缩(接近窗口上限时三层压缩);
 *  工具结果进 history 前经 capToolResultForHistory 裁到单条上限。
 *
 *  所有正文写经 layout.contentWrite(保证落在内容区、跟踪续写位、底栏不被顶);
 *  spinner 经 onFrame 回调刷状态行(layout.drawStatusBar),等待时内容区静止、底栏转圈。
 *  思考期间不写思考内容,只让 spinner 持续转「思考中…」(首个正文 / tool_call token 到达才停)。
 *
 *  循环逻辑委托 runAgentCore;本函数只注入 TUI 渲染 hooks(layout + spinner + diff + 回滚轮次)。
 *  开新轮次(beginTurn)在入口调——core 不依赖 rollback,回滚轮次是主 agent 的展示副作用。
 */
export async function runAgent(
  history: ChatMessage[],
  userInput: string | ContentPart[],
  signal?: AbortSignal,
  /** 每步 chat() 返回后回调:repl 据此重算并重画状态行 context 用量条(运行中实时刷新,不冻结在轮首)。 */
  onContextUpdate?: () => void,
): Promise<AgentRunResult> {
  // 开新轮次(回滚用):首行截断 40,供 /rollback 轮次菜单展示。
  beginTurn(truncateDisplay(firstLineOf(userInput), 40));
  layout.contentMode(); // 防御性:运行态光标归输入框光标位供 IME 锚定(enterRunningMode 已置,这里兜底)

  // spinner:状态行最前面转圈(思考中 / 生成 / 执行 工具时,状态栏 lead 位显帧 + 文字)。
  // 经 setStatus 注入状态行(spinnerFrame + statusText),composeStatus 把帧 + 文字放 lead 位;
  // 不画内容区续写位——内容区在等待期间保持干净,首 token 到达即从续写位开始写正文。
  const spinner = new Spinner((msg, frame) => {
    layout.setStatus(frame ? `${msg}…` : '', frame ?? undefined);
  });

  // lastChar 镜像:core 跟踪流式末字符决定补换行,但 TUI hooks 需读它决定 layout.contentWrite('\n')。
  // core 的 onTextEnd hook 只在 lastChar !== '\n' 时才调,调后置 '\n';镜像与此同步。
  let lastChar = '';

  const hooks: AgentHooks = {
    onText: (s) => {
      spinner.stop(); // 任何正文 token 都停 spinner(首 token 停「思考中」;onToolCall 重启后若又来文本则停「生成中」)。未旋转时 stop 为 no-op。
      layout.contentWriteMd(s); // 正文走 markdown 渲染(代码块高亮 / 标题 / 列表 / 行内 …),见 ui/markdown.ts
      if (s) lastChar = s[s.length - 1];
    },
    onToolCall: (name) => {
      // 文本/思考已流完,模型转而生成 tool_call 参数(可能很长,如 write_file 整篇内容):
      // 补换行(让随后的 ● 行与 diff 不黏在正文末尾)+ 启「生成中」内联 spinner,内容区不再干等。
      if (lastChar && lastChar !== '\n') {
        layout.contentWrite('\n');
        lastChar = '\n';
      }
      if (name) spinner.start(`生成 ${name}`);
    },
    onStepStart: () => spinner.start('思考中'),
    onChatDone: () => spinner.stop(),
    onTextEnd: () => {
      if (lastChar && lastChar !== '\n') {
        layout.contentWrite('\n');
        lastChar = '\n';
      }
    },
    onToolHeader: (tc) => writeToolHeader(tc),
    onToolStart: (name) => spinner.start(`执行 ${name}`),
    onToolDone: () => spinner.stop(),
    onToolResult: (tc, output, parsed, preWriteOld, editStartLine) =>
      writeToolResult(tc, output, parsed, preWriteOld, editStartLine),
    onToolBatchEnd: () => layout.contentWrite('\n'),
    onNoReply: () =>
      layout.contentWrite(`${ui.dim}(无回复)${ui.reset}\n`),
    onMaxSteps: () =>
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}达到最大步数(${config.maxSteps}),本轮停止。${ui.reset}\n`
      ),
    onAbort: () => {
      spinner.stop();
      if (lastChar && lastChar !== '\n') layout.contentWrite('\n');
      layout.contentWrite(`${ui.dim}(已中断)${ui.reset}\n`);
    },
    onDone: (elapsedMs, usage) => {
      const tok = formatTurnTokens(usage);
      layout.contentWrite(
        `  ${ui.dim}✻ Worked for ${fmtElapsed(elapsedMs)}${tok}${ui.reset}\n`
      );
    },
  };

  // 桌宠状态广播:与 TUI hooks 并列注入,互不干扰(petHooks 只调 bridge.sendState,不写屏;
  // 未 /pet 连接时 sendState 内部 no-op)。仅主 agent 走这里——子 agent(spawn.ts)不引用 createPetHooks,
  // 故子 agent 永不广播桌宠状态。
  const petHooks = createPetHooks();
  const combinedHooks: AgentHooks = mergeHooks(hooks, petHooks);

  let result: AgentRunResult | undefined;
  try {
    result = await runAgentCore({
      history,
      userInput,
      signal,
      onContextUpdate,
      hooks: combinedHooks,
    });
  } finally {
    spinner.stop();
  }
  return result;
}

/** 把两组 AgentHooks 合并为一组:每个方法依次调用两侧已定义的实现(顺序不保证跨方法一致,
 *  但同一事件内先 a 后 b)。用于把桌宠状态广播 hooks 与 TUI 渲染 hooks 并列挂载,互不影响。 */
function mergeHooks(a: AgentHooks, b: AgentHooks): AgentHooks {
  const merged: AgentHooks = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AgentHooks>;
  for (const key of keys) {
    const fa = a[key] as ((...args: unknown[]) => void) | undefined;
    const fb = b[key] as ((...args: unknown[]) => void) | undefined;
    (merged as Record<string, unknown>)[key] = (...args: unknown[]) => {
      fa?.(...args);
      fb?.(...args);
    };
  }
  return merged;
}

/** 摘要行后追加的本轮 token 文本。例:`  · 1.5k tokens (↑ 1.2k ↓ 0.3k)`。
 *  关闭 include_usage / 全失败 → usage=undefined → 不输出(保持原摘要行长度,不留空白)。 */
function formatTurnTokens(usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined): string {
  if (!usage) return '';
  const total = usage.totalTokens;
  if (!total) return '';
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(total >= 10000 ? 0 : 1)}k`);
  return `  ·  ${fmt(total)} tokens (↑ ${fmt(usage.promptTokens)} ↓ ${fmt(usage.completionTokens)})`;
}
