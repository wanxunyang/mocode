// 子 agent 封装:runAgentCore + (TUI 激活时)实时渲染 hooks。独立 history / 可受限工具子集 / 低步数上限。
// 供 task 工具(主 agent 派生子任务)调用——子 agent 的最终摘要回灌主 history。
//
// 与主 agent 的区别:
//  - 主屏渲染可选:全屏 TUI 激活时(layout.isTuiActive()),把子 agent 内部工具调用实时写入
//    主内容区并复用 batch 折叠机制(运行态逐条展开,执行完自动折叠回单行摘要,鼠标可点开查看);
//    TUI 未激活(host 嵌入 / 非 TTY)时保持纯静默——中间过程只缓冲进 transcript,不写主屏。
//  - 独立 history:不共享主对话,避免子任务的工具噪声污染主上下文。
//  - 紧凑系统提示:不复制主 agent 的 memory/skills/项目快照；由 context 传入已知事实。
//  - 工具子集:写任务默认继承主 Agent 工具（仅禁止递归 task）；只读模式按安全语义移除写工具。
//  - 不调 beginTurn：子 agent 共享主 agent 当前轮次；其文件修改进入同一回滚事务。
//  - 步数默认与主 Agent 相同，只作为无限循环保险，不以 token 配额提前终止有效任务。
//  - 中断透传:opts.signal(主 agent 的 abort signal)透传给 runAgentCore → chat/executeTool,
//    主 Ctrl+C 树杀子 agent(chat 流式 abort + run_command/web_fetch 即时取消)。

import type OpenAI from 'openai';
import { chatTools, type ChatMessage } from '../llm/index.js';
import { buildMocodeCorePrompt, config, isSubAgentEnabled } from '../config/index.js';
import { effectiveSystemPrompt } from '../skills/index.js';
import { ui } from '../ui/theme.js';
import * as layout from '../ui/layout.js';
import { isTuiActive } from '../ui/layout.js';
import * as batch from '../ui/batch.js';
import { isToolErrorOutput } from '../tools/result.js';
import { runAgentCore, type AgentHooks } from './core.js';
import { summarizeToolCall, summarizeToolResult, truncateDisplay } from '../ui/render.js';
import { t } from '../i18n/index.js';
import { createContextState } from '../session/compact.js';
import { inOverlay, mergeSubAgentChangeSet, type SubAgentResult } from '../agents/coordinator.js';

/** 子 agent 系统提示后缀:角色与约束。 */
const SUBAGENT_SUFFIX = `

## ⛯ SUB-AGENT MODE (you are a sub-agent)
You are a sub-agent spawned by the main agent to handle an isolated sub-task. You have your own conversation history (independent of the main thread).
- Focus solely on the assigned sub-task. Do NOT attempt to call the "sub-agent" tool (no recursive spawning).
- Use the tools available to you to complete the sub-task.
- When done, your final text reply will be returned to the main agent as a summary — make it concise and actionable: what you did, key findings, files changed, and any issues. The main agent will decide the next step based on your summary.`;

const SUBAGENT_ROLE = `## Sub-agent execution
You are executing one delegated sub-task with the same engineering standards and capabilities as mocode.
- Treat Task context as authoritative facts already established by the main agent; do not rediscover them without evidence they are stale.
- Focus on the delegated scope, but continue until it is genuinely complete. Do not stop to save tokens.
- Do not recursively call sub-agent. A write task runs in an isolated overlay; the coordinator merges it safely.
- Return concise findings, changes, checks you chose to run, and blockers to the coordinator.`;

/** 子 agent 运行选项。 */
export interface SpawnOptions {
  /** 子任务指令(作为子 agent 的 user 消息)。 */
  prompt: string;
  /** 附加系统提示(角色/约束),拼在 SUBAGENT_SUFFIX 后。 */
  systemPromptSuffix?: string;
  /** 允许的工具名白名单(可选)。无 = 全量工具;给则从 chatTools 过滤。 */
  tools?: string[];
  /** 步数上限；仍受 fast/standard profile cap 限制。 */
  maxSteps?: number;
  /** 主 agent 的 abort signal(可选)。透传给子 runAgentCore → chat/executeTool,
   *  主 Ctrl+C 树杀子 agent(chat 流式 abort + run_command/web_fetch 即时取消)。 */
  signal?: AbortSignal;
  /** Read tasks share the workspace; write tasks execute in an isolated overlay. */
  mode?: 'read' | 'write';
  /** Declared write set, used for provenance and resource scheduling by the task tool. */
  writeSet?: string[];
  /** Small coordinator-produced facts to reuse instead of rediscovering main-agent context. */
  context?: string;
  /** 主侧 sub-agent 调用的 tool_call id。实时渲染据此反查主侧批次,
   *  把本子 agent 的摘要行 + 工具明细挂到对应的调用行下面(并行派发时各归各行)。 */
  callId?: string;
}

/** 子 agent 运行结果。 */
export interface SpawnResult extends SubAgentResult {
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
  if (!isSubAgentEnabled()) {
    return {
      summary: null,
      completed: false,
      transcript: 'Sub-agent execution is disabled. Enable it with /subagent on.',
      status: 'failed', findings: [], readSet: [], changeSet: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
    };
  }
  const maxSteps = opts.maxSteps ?? config.subAgentMaxSteps;

  // 构造窄 worker prompt；主 Agent 已知事实只通过有界 context 注入，避免重复探索与重复计费。
  const systemPrompt = effectiveSystemPrompt(
    buildMocodeCorePrompt() + '\n\n' + SUBAGENT_ROLE + SUBAGENT_SUFFIX +
      (opts.systemPromptSuffix ? `\n\n${opts.systemPromptSuffix}` : ''),
  );
  const taskPrompt = opts.context?.trim()
    ? `Task context (authoritative; do not rediscover):\n${opts.context.slice(0, 4000)}\n\nSub-task:\n${opts.prompt}`
    : opts.prompt;

  // 写 worker 保留主 Agent 的完整能力；只读 mode 仅按调用契约移除副作用工具。
  let toolsOverride: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined;
  const mode = opts.mode ?? 'read';
  const requested = opts.tools?.length ? new Set(opts.tools) : null;
  const readOnly = new Set(['read_file', 'glob', 'grep', 'web_search', 'web_fetch', 'use_skill', 'memory_search', 'memory_list']);
  toolsOverride = chatTools.filter((tool) =>
    tool.function.name !== 'sub-agent' &&
    // plan_update 直写主会话 notes.md(不走 overlay),子代理不应改动主计划——统一排除。
    tool.function.name !== 'plan_update' &&
    (!requested || requested.has(tool.function.name)) &&
    (mode === 'write' || readOnly.has(tool.function.name)),
  );

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

  // 主屏实时渲染(子 agent 透明化):TUI 激活时把子 agent 内部步骤实时写入主内容区,
  // 复用 batch 折叠机制(mouse 点击摘要行可展开/收起)。TUI 未激活(host/非 TTY)时
  // 保持纯静默——只缓冲 transcript,不写屏,兼容嵌入宿主。
  const live = isTuiActive();
  let liveBatchId: string | null = null;
  const liveLayout = () => ({
    contentWrite: (s: string) => layout.contentWrite(s),
    contentReplaceLine: (absIdx: number, line: string) => layout.contentReplaceLine(absIdx, line),
    contentInsertAfter: (after: number, lines: string[], keepViewport?: boolean) =>
      layout.contentInsertAfter(after, lines, keepViewport),
    contentDeleteFrom: (startIdx: number, n: number) => layout.contentDeleteFrom(startIdx, n),
    totalRows: () => layout.totalRows(),
    repaintViewport: () => layout.repaintViewport(),
    isScrolled: () => layout.isScrolled(),
  });
  /** 本批是否挂在主侧调用行下(挂上了就由主侧负责分隔空行,自己不能往 buffer 末尾追加)。 */
  let nested = false;
  const ensureLiveBatch = (): void => {
    if (!live || liveBatchId) return;
    // 主侧 sub-agent 组容器批 = 父批;本子 agent 的工具批挂在其下并更深一层缩进,
    // 与同组其它子 agent 各归各的 └─ sub-agent 行(通过 groupChildIndex 定锚点)。
    const parentId = batch.batchIdForCall(opts.callId) ?? undefined;
    nested = parentId != null;
    const childIndex = parentId ? batch.getGroupChildIndex(opts.callId) : undefined;
    liveBatchId = batch.beginBatch(t('subagent.running'), {
      parentId,
      indent: parentId ? '        ' : undefined,
      groupChildIndex: childIndex,
      running: true,
    });
    batch.showLiveBatch(liveBatchId, liveLayout());
    // 默认折叠:只显示一行「子 Agent 运行中 · glob X  read_file Y」,不展开明细;
    // 用户点击摘要行后才展开看具体工具调用。
  };
  const finishLiveBatch = (status?: 'complete' | 'failed' | 'aborted'): void => {
    if (!live || !liveBatchId) return;
    const id = liveBatchId;
    liveBatchId = null;
    if (status) batch.setBatchLabel(id, status === 'complete'
      ? t('subagent.complete')
      : status === 'failed' ? t('subagent.failed') : t('subagent.running'));
    // 收尾:清除运行态标志,摘要行图标从「运行中 ◐」切回完成态 ●。
    batch.setBatchRunning(id, false);
    batch.endBatch(id, liveLayout());
    // 子 agent 完成后自动折叠:endBatch 登记了点击,但默认保持展开态;
    // 这里显式折叠回单行摘要,让执行完的批自动收起(用户可再点开)。
    if (status === 'complete' && batch.isExpanded(id)) batch.toggleBatch(id, liveLayout());
    // 嵌套批的分隔空行由主侧 flushToolBatch 统一补;这里再写会往 buffer 末尾插孤儿空行
    // (并行子 agent 各写一条,块尾堆出空白)。
    if (!nested) layout.contentWrite('\n');
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
      // 实时写入主内容区:子 agent 的每次工具调用累计到摘要行计数。
      ensureLiveBatch();
      if (liveBatchId) {
        batch.recordCall(liveBatchId, tc.name, summary);
        // 默认折叠,只刷新摘要行计数(glob/read_file 数量),不展开明细列表。
        batch.showLiveBatch(liveBatchId, liveLayout());
      }
    },
    onToolResult: (tc, output) => {
      const preview = summarizeToolResult(tc.name, output);
      if (preview) writeBuf(`  ↳ ${preview}\n`);
      if (liveBatchId) {
        // 子 agent 批无 diff(写任务走 overlay,最终由主 agent 合并);空 preview 用占位
        // 标记 entry 已完成,避免折叠后摘要仍显示"运行中"。
        batch.recordResult(
          liveBatchId,
          tc.name,
          preview || t('toolSummary.noOutput'),
          null,
          output,
          isToolErrorOutput(output),
        );
        batch.showLiveBatch(liveBatchId, liveLayout());
      }
    },
    onTextEnd: () => {
      if (lastChar && lastChar !== '\n') {
        writeBuf('\n');
        lastChar = '\n';
      }
    },
    onToolBatchEnd: () => {
      writeBuf('\n');
      // 子 agent 一轮工具调用结束:仍在运行(可能还有后续轮次),仅推进实时摘要,
      // 不折叠——等 onDone 整体完成才自动收起。
      if (liveBatchId) batch.showLiveBatch(liveBatchId, liveLayout());
    },
    onNoReply: () => writeBuf(`${ui.dim}(无回复)${ui.reset}\n`),
    onMaxSteps: () => {
      writeBuf(`  ● 达到最大步数(${maxSteps}),子 agent 停止。\n`);
      finishLiveBatch('failed');
    },
    onDone: (elapsedMs, usage) => {
      const tok = usage && usage.totalTokens
        ? `  · ${usage.totalTokens} tokens${usage.cachedTokens ? ` ↻${usage.cachedTokens} cached` : ''}`
        : '';
      writeBuf(`  ✻ 子 agent 耗时 ${(elapsedMs / 1000).toFixed(1)}s${tok}\n`);
      finishLiveBatch('complete');
    },
    onAbort: () => {
      // 中断:子 agent 未完成,收尾批(不折叠——用户可能想看中断前做了什么)。
      finishLiveBatch('aborted');
    },
    // onStepStart / onChatDone / onToolStart / onToolDone:子 agent 静默,无需 spinner 渲染。
    // abort 还原(history 还原 + 模式还原)由 core 的 abortRestore 处理,hooks 只管展示。
  };

  // 每个子 agent 独享统计/预算状态。不能保存再恢复模块级单例：多个 task 并发时
  // save/restore 会竞态，且 lastEstimate / schedulerLog 仍会污染主 agent。
  const localContextState = createContextState();
  const readSet = new Set<string>();
  const run = () => runAgentCore({
      history,
      userInput: taskPrompt,
      signal: opts.signal,
      hooks,
      maxSteps,
      toolsOverride,
      contextState: localContextState,
      suppressOpeningAnalysis: true, // 子代理不注入「开场分析」:仅主线面对用户的首次响应用
      onToolOutcome: (tool, args) => {
        if (tool === 'read_file' && typeof args.path === 'string') readSet.add(args.path);
        else if (['glob', 'grep'].includes(tool)) readSet.add('workspace');
      },
    });
  let result;
  let changeSet = null;
  let mergeStatus: 'committed' | 'conflict' | 'failed' = 'committed';
  if (opts.mode === 'write') {
    const isolated = await inOverlay(run);
    result = isolated.value;
    changeSet = isolated.changeSet;
    const declared = new Set((opts.writeSet ?? []).map((item) => item.replaceAll('\\', '/').toLowerCase()));
    const outsideDeclaration = declared.size > 0 && changeSet?.changes.some(
      (change) => !declared.has(change.path.replaceAll('\\', '/').toLowerCase()),
    );
    if (!result.completed || outsideDeclaration) mergeStatus = 'failed';
    else mergeStatus = await mergeSubAgentChangeSet(changeSet, opts.signal);
  } else {
    result = await run();
  }

  const status = opts.signal?.aborted || result.terminationReason === 'aborted'
    ? 'aborted'
    : mergeStatus === 'conflict' ? 'conflict'
    : mergeStatus === 'failed' || !result.completed ? 'failed'
    : 'completed';

  return {
    summary: result.finalText,
    completed: result.completed && status === 'completed',
    transcript: truncateDisplay(transcript, 20000), // 防过大;调试用,回灌主 history 的是 summary 不是 transcript
    status,
    findings: result.finalText ? [result.finalText] : [],
    readSet: [...readSet].sort(),
    changeSet,
    usage: {
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
      cachedTokens: result.usage?.cachedTokens ?? 0,
      reasoningTokens: result.usage?.reasoningTokens ?? 0,
    },
  };
}
