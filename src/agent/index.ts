// 主 agent:runAgentCore + TUI 渲染 hooks 的薄封装。
// 循环逻辑(流式 chat → 工具分组执行 → 回灌 / abort 还原 / maybeCompact)全部在 core.ts,
// 本文件只负责把展示副作用(layout.contentWrite / Spinner / diff / 回滚轮次)注入为 AgentHooks。
// 行为与重构前的单文件 runAgent 完全一致——这是安全重构,实跑回归验证。

import type { ChatMessage, ChatUsage, ToolCallRef } from '../llm/index.js';
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
import * as batch from '../ui/batch.js';
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
import { t } from '../i18n/index.js';
import { isToolErrorOutput } from '../tools/result.js';
import { appendCurrentSessionTraceEvent } from '../session/index.js';

/** 当前 turn 的 batch id(runAgent 内闭包变量;一条 turn 一轮 tool batch 结束即清空)。 */
let currentBatchId: string | null = null;

/** 取 userInput 的首行:字符串直接 split;多模态 parts 找首个 text part 再 split。 */
function firstLineOf(ui: string | ContentPart[]): string {
  if (typeof ui === 'string') return ui.split('\n')[0] ?? '';
  const first = ui.find((p) => p.type === 'text') as { text: string } | undefined;
  return first?.text.split('\n')[0] ?? '';
}

/** 工具调用 ● 头:工具名 + 参数摘要(按 tool_calls 原顺序打印,让用户看到本轮跑哪些工具)。
 *  重构后改为累积到 BatchRenderer,onToolBatchEnd 时统一打摘要行;
 *  展开/折叠由 BatchRenderer + 鼠标 release 决定,本函数不再直接写屏。 */
function writeToolHeader(tc: ToolCallRef): void {
  // 改文件工具是 batch 屏障：先收尾之前的普通工具，确保 mutation 永远独占一批。
  if (isMutationTool(tc.name)) flushToolBatch();
  if (!currentBatchId) currentBatchId = batch.beginBatch();
  batch.recordCall(currentBatchId, tc.name, summarizeToolCall(tc.name, tc.arguments));
  // 第一条工具开始时立即落摘要；后续调用加入同一 batch，并原地刷新计数。
  batch.showLiveBatch(currentBatchId, layout);
}

/** 渲染工具结果:mutation 成功走 diff 块(行号 + 语法高亮);其余走一行 preview。
 *  同 writeToolHeader,改为累积到 BatchRenderer(只缓存字符串,不写屏)。 */
function writeToolResult(
  tc: ToolCallRef,
  output: string,
  parsed: Record<string, unknown> | null,
  preWriteOld: string | null,
  editStartLine: number,
): void {
  if (!currentBatchId) return;
  let diff: string | null = null;
  if (isMutationTool(tc.name) && parsed && !isToolErrorOutput(output)) {
    diff = renderFileChange({
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
    });
  }
  const preview = diff ? '' : summarizeToolResult(tc.name, output);
  batch.recordResult(currentBatchId, tc.name, preview, diff, output);
  // mutation 结果（成功 diff 或错误输出）立即可见，并阻止后续普通工具并入这一批。
  if (isMutationTool(tc.name)) flushToolBatch(true);
}

/** 将跨 LLM 工具轮次累计的调用写入内容区；正文开始或整个 turn 收尾时才切批。 */
function flushToolBatch(expandSingleEntry = false): void {
  if (!currentBatchId) return;
  const id = currentBatchId;
  currentBatchId = null;
  batch.endBatch(id, layout);
  if (expandSingleEntry) batch.expandSingleEntryFully(id, layout);
  // 普通摘要只有一个“当前空行”，再 break 一次把它提交为分隔空行。
  // mutation 自动展开时 content.insertAfter 已先把该当前空行提交到 rows；若这里仍补 \n，
  // diff 后就会固定出现两条空白行。
  if (!expandSingleEntry) layout.contentWrite('\n');
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
  currentBatchId = null; // 新 turn 清旧 batch id(防上 turn 残留)

  // spinner:状态行最前面转圈(思考中 / 生成 / 执行 工具时,状态栏 lead 位显帧 + 文字)。
  // 经 setStatus 注入状态行(spinnerFrame + statusText),composeStatus 把帧 + 文字放 lead 位;
  // 不画内容区续写位——内容区在等待期间保持干净,首 token 到达即从续写位开始写正文。
  const spinner = new Spinner((msg, frame) => {
    layout.setStatus(frame ? `${msg}…` : '', frame ?? undefined);
  });

  // lastChar 镜像:core 跟踪流式末字符决定补换行,但 TUI hooks 需读它决定 layout.contentWrite('\n')。
  // core 的 onTextEnd hook 只在 lastChar !== '\n' 时才调,调后置 '\n';镜像与此同步。
  let lastChar = '';
  // 正文 -> 工具的边界由 core.onTextEnd 与本层 onToolCall 分两段完成。
  // markdown 段末已经是完整物理行，因此再写 1 个 \n 就代表 1 条空白行；
  // 不能按普通字符串的“两个换行才有一个空行”来计算。
  let textBoundaryNewlines = 0;
  let hasPendingTextBoundary = false;
  let toolBatchFollowsText = false;

  const hooks: AgentHooks = {
    onText: (s) => {
      // 纯空白 chunk 在视觉上不是正文：既不切 batch，也不写入 markdown 缓冲。
      // 部分兼容后端会在连续工具轮次间流出 " " / "\n"，若据此切批会漏掉首个工具。
      if (currentBatchId && s.trim().length === 0) return;
      const followsToolBatch = currentBatchId !== null;
      // batch 收尾已经统一留了一条空白行。部分后端会把下一段正文以 \n / \n\n
      // 开头发来；去掉这些“边界换行”，避免与 UI 分隔叠成两条空白行。
      const visible = followsToolBatch ? s.replace(/^(?:[ \t]*\r?\n)+/, '') : s;
      if (s) flushToolBatch();
      spinner.stop(); // 任何正文 token 都停 spinner(首 token 停「思考中」;onToolCall 重启后若又来文本则停「生成中」)。未旋转时 stop 为 no-op。
      layout.contentWriteMd(visible); // 正文走 markdown 渲染(代码块高亮 / 标题 / 列表 / 行内 …),见 ui/markdown.ts
      if (visible) {
        lastChar = visible[visible.length - 1];
        if (visible.trim().length > 0) {
          hasPendingTextBoundary = true;
          textBoundaryNewlines = 0;
        }
      }
    },
    onToolCall: (name) => {
      // 文本/思考已流完,模型转而生成 tool_call 参数(可能很长,如 write_file 整篇内容):
      // 补换行(让随后的 ● 行与 diff 不黏在正文末尾)+ 启「生成中」内联 spinner,内容区不再干等。
      if (hasPendingTextBoundary) {
        toolBatchFollowsText = true;
        if (textBoundaryNewlines < 1) {
          layout.contentWrite('\n');
        }
        lastChar = '\n';
        textBoundaryNewlines = 1;
        hasPendingTextBoundary = false;
      }
      if (name) spinner.start(t('agent.generating', { tool: name }));
    },
    onStepStart: () => spinner.start(t('agent.thinking')),
    onChatDone: () => spinner.stop(),
    onTextEnd: () => {
      if (lastChar && lastChar !== '\n') {
        layout.contentWrite('\n');
        lastChar = '\n';
        if (hasPendingTextBoundary) textBoundaryNewlines = 1;
      }
    },
    onToolHeader: (tc) => {
      // mutation 的自动展开会把 current/committed 空行状态互相转换；在首摘要真正
      // 落屏前按视觉行归一，避免同样的文本→edit 边界偶发 1 行或 2 行。
      if (toolBatchFollowsText && isMutationTool(tc.name)) {
        layout.normalizeMutationBoundary();
      }
      toolBatchFollowsText = false;
      writeToolHeader(tc);
    },
    onToolStart: (name) => spinner.start(t('agent.executing', { tool: name })),
    onToolDone: () => spinner.stop(),
    onToolResult: (tc, output, parsed, preWriteOld, editStartLine) =>
      writeToolResult(tc, output, parsed, preWriteOld, editStartLine),
    onToolBatchEnd: () => {
      // 一次工具轮次结束不再切 UI batch；下一轮若仍无正文，继续复用 currentBatchId。
    },
    onNoReply: () => {
      flushToolBatch();
      layout.contentWrite(`${ui.dim}${t('agent.noReply')}${ui.reset}\n`);
    },
    onMaxSteps: () => {
      flushToolBatch();
      layout.contentWrite(
        `  ${ui.yellow}●${ui.reset} ${ui.yellow}${t('agent.maxSteps', { count: config.maxSteps })}${ui.reset}\n`
      );
    },
    onAbort: () => {
      spinner.stop();
      if (lastChar && lastChar !== '\n') layout.contentWrite('\n');
      flushToolBatch();
      layout.contentWrite(`${ui.dim}${t('agent.aborted')}${ui.reset}\n`);
    },
    onValidationStart: (command) => {
      flushToolBatch();
      spinner.start(t('agent.validating', { command }));
    },
    onValidationResult: (validation) => {
      spinner.stop();
      const color = validation.status === 'passed'
        ? ui.green
        : validation.status === 'failed'
          ? ui.red
          : ui.yellow;
      const command = validation.command ?? t('agent.validationNoCommand');
      const detail = validation.status === 'skipped' && validation.skipReason
        ? `${validation.status}: ${validation.skipReason}`
        : validation.status;
      layout.contentWrite(
        `  ${color}●${ui.reset} ${t('agent.validationResult', { command, status: detail })}\n`,
      );
    },
    onDone: (elapsedMs, usage) => {
      flushToolBatch();
      const tok = formatTurnTokens(usage);
      layout.contentWrite(
        `  ${ui.dim}✻ ${t('agent.workedFor', { elapsed: fmtElapsed(elapsedMs) })}${tok}${ui.reset}\n`
      );
      // 内容区触底时，DECSTBM 增量滚屏可能只推进物理终端，未把 Worked 前已在
      // buffer 中的空行完整画出来；用户滚动/点击触发 repaint 后才“突然”出现。
      // 轮次收尾立即按 buffer 原子重画，使未满屏与触底滚屏的布局一致。
      layout.repaintViewport();
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
      autoValidate: config.autoValidate,
      onTraceEvent: appendCurrentSessionTraceEvent,
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

/** 摘要行后追加的本轮 token 文本。
 *  例(无 cache):
 *    `  ·  1.5k tokens (↑ 1.2k ↓ 0.3k)`
 *  例(命中 cache,DeepSeek 类折扣计费):
 *    `  ·  72k tokens (↑ 8k ↓ 3k) · ↻ 61k cached`
 *  例(CoT 模型 + cache):
 *    `  ·  72k tokens (↑ 8k ↓ 3k) · ↻ 61k cached · reasoning 1.2k`
 *
 *  设计要点:
 *  - 括号里 ↑ 显示**计费 prompt**(= 全量 - cached),不是后端报的 raw prompt,
 *    否则用户看到 69k 会按全价估成本,实际只花了 5-9k 的 $。
 *  - ↻ 显示 cache 命中(白嫖部分),让用户一眼看到优化效果(系统 prompt 越长、对话越长越显著)。
 *  - reasoning 是 completion 的子集(已含在 ↓ 里),仅作信息;不二次计入成本。
 *  - 总数 total 不变 —— 是数学意义上的"流过的 token",反映 LLM 实际工作量。
 *  关闭 include_usage / 全失败 → usage=undefined → 不输出(保持原摘要行长度)。 */
function formatTurnTokens(usage: ChatUsage | undefined): string {
  if (!usage) return '';
  const total = usage.totalTokens;
  if (!total) return '';
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(total >= 10000 ? 0 : 1)}k`);
  const cached = usage.cachedTokens;
  const reasoning = usage.reasoningTokens;
  const billablePrompt = usage.promptTokens - cached;
  const extras: string[] = [];
  if (cached > 0) extras.push(`↻ ${fmt(cached)} cached`);
  if (reasoning > 0) extras.push(`reasoning ${fmt(reasoning)}`);
  const extrasStr = extras.length > 0 ? ` · ${extras.join(' · ')}` : '';
  return `  ·  ${fmt(total)} tokens (↑ ${fmt(billablePrompt)} ↓ ${fmt(usage.completionTokens)})${extrasStr}`;
}
