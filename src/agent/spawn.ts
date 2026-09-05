// 子 agent 封装:runAgentCore + (TUI 激活时)实时渲染 hooks。
// 供 task 工具(主 agent 派生子任务)调用——子 agent 的最终摘要回灌主 history。
//
// 子 agent 与主 agent 完全同源(无任何能力裁剪):
//  - 同一份系统提示、同一份工具 schema、同一份对话前缀(delegation 命中前缀缓存);
//  - 写操作直接落在工作区,进入主 agent 当前轮次的同一回滚事务(spawn 不调 beginTurn);
//  - 步数默认与主 agent 相同,只作为无限循环保险,不以 token 配额提前终止有效任务;
//  - 中断透传:opts.signal 透传给 runAgentCore → chat/executeTool,主 Ctrl+C 树杀子 agent。
// 与主 agent 的唯一差别是渲染与 history 归属:
//  - 主屏渲染可选:TUI 激活时把子 agent 内部工具调用实时写入主内容区并复用 batch 折叠;
//    TUI 未激活(host 嵌入 / 非 TTY)时纯静默,中间过程只缓冲进 transcript。
//  - 独立 history 分支:子任务的工具噪声不回灌主对话,只有最终摘要回灌。

import type OpenAI from 'openai';
import { chatTools, type ChatMessage, type ChatUsage } from '../llm/index.js';
import { buildMocodeCorePrompt, config, isSubAgentHardDisabled } from '../config/index.js';
import { getToolChatSchema } from '../tools/policy.js';
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

/** 子 agent 系统提示后缀(仅 legacy 直接调用路径用;共享前缀路径的系统提示直接复用父 agent)。 */
const SUBAGENT_SUFFIX = `

## ⛯ SUB-AGENT MODE (you are a sub-agent)
You are a sub-agent spawned by the main agent to handle a delegated sub-task, with the same tools and full capabilities as the main agent.
- Focus on the assigned sub-task and see it through to completion.
- When done, your final text reply is returned to the main agent as the result — concise and actionable: what you did, key findings, files changed, blockers.`;

const SUBAGENT_ROLE = `## Sub-agent execution
You are executing one delegated sub-task with the same engineering standards and full capabilities as the main agent.
- Treat Task context as authoritative facts already established by the main agent; do not rediscover them without evidence they are stale.
- Focus on the delegated scope, but continue until it is genuinely complete. Do not stop to save tokens.
- Return concise findings, changes, checks you chose to run, and blockers to the main agent.`;

/** 子 agent 运行选项。 */
export interface SpawnOptions {
  /** 子任务指令(作为子 agent 的 user 消息)。 */
  prompt: string;
  /** 附加系统提示(角色/约束),拼在 SUBAGENT_SUFFIX 后。 */
  systemPromptSuffix?: string;
  /** 调用方进一步缩小的工具白名单。undefined=不额外限制；显式 []=零工具。 */
  tools?: string[];
  /** 产生 sub-agent/run_skill 调用的父 step 不可变授权上限；子执行面只能与其求交。 */
  parentAllowedToolNames?: readonly string[];
  /**
   * 父 agent 委派前缀(官方 TUI/stdio 经 task 工具派发时由 core 注入)。提供后子 agent 的
   * 系统提示/工具 schema/对话历史前缀与父 step 逐字节一致,委派消息只追加在尾部——
   * 命中主 agent 已缓存的前缀缓存,子 agent 不再重复探索。缺省(直接调用/测试)回退紧凑上下文。
   */
  delegation?: {
    history: readonly OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  };
  /** 步数上限；仍受 fast/standard profile cap 限制。 */
  maxSteps?: number;
  /** 主 agent 的 abort signal(可选)。透传给子 runAgentCore → chat/executeTool,
   *  主 Ctrl+C 树杀子 agent(chat 流式 abort + run_command/web_fetch 即时取消)。 */
  signal?: AbortSignal;
  /** Small coordinator-produced facts to reuse instead of rediscovering main-agent context. */
  context?: string;
  /** 主侧 sub-agent 调用的 tool_call id。实时渲染据此反查主侧批次,
   *  把本子 agent 的摘要行 + 工具明细挂到对应的调用行下面(并行派发时各归各行)。 */
  callId?: string;
  /** 静默模式(供 run_skill 等 opaque workflow 用):TUI 下不产可展开 batch,
   *  只写一行 spinner → 完成后替换为单行结果摘要。 */
  quiet?: boolean;
  /** quiet 模式的标签文字;缺省从 prompt 截取(通常不够好,建议调用方显式传)。 */
  quietLabel?: string;
}

/** 子 agent 运行结果。自包含声明(原 `SubAgentResult` 基类随 overlay coordinator 一并删除)。 */
export interface SpawnResult {
  status: 'completed' | 'failed' | 'aborted';
  /** 子 agent 最终文本回复;中断或无回复为 null。 */
  summary: string | null;
  /** 正常完毕 true;中断 false。 */
  completed: boolean;
  /** 子 agent 中间过程的人类可读日志(工具调用 + 结果摘要 + 流式正文片段)。主 agent 通常不看,调试用。 */
  transcript: string;
  usage: ChatUsage;
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
  if (isSubAgentHardDisabled()) {
    return {
      summary: null,
      completed: false,
      transcript: 'Sub-agent execution is disabled by MOCODE_SUBAGENT_ENABLED=false.',
      status: 'failed',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
    };
  }
  const maxSteps = opts.maxSteps ?? config.subAgentMaxSteps;
  const requested = opts.tools === undefined ? null : new Set(opts.tools);

  const shared =
    opts.delegation && opts.delegation.history.length > 0 && opts.delegation.history[0]?.role === 'system'
      ? opts.delegation
      : null;

  let toolsOverride: OpenAI.Chat.Completions.ChatCompletionTool[];
  let runtimeAllowedToolNames: Set<string> | undefined;
  let history: ChatMessage[];
  let userInput: string;

  if (shared) {
    // ── 共享前缀模式(官方 TUI/stdio 派发路径)──
    // 系统提示 = 父 history[0](含 skills 段),工具 schema = 父 step activeTools,
    // history = 父前缀(上游已去掉尾部「产生本次调用的 assistant tool_call 消息」)。
    // 整条前缀与主 agent 已发送内容逐字节一致 → 命中前缀缓存;子 agent 直接看到
    // 主 agent 已读过的文件与结论,不再重复探索。
    // 不做任何裁剪:子 agent 的工具面就是父 step 的工具面。
    let tools = [...shared.tools];
    if (requested) {
      // 显式 tools 白名单是调用方主动的特化收缩(skill allowed-tools),可裁 schema。
      tools = tools.filter((tool) => requested.has(tool.function.name));
    }
    toolsOverride = tools;
    // schema 即上限。显式给 runtimeAllowedToolNames 可让 core 跳过 legacy profile 防线,
    // 否则旧 profile 会误删父 policy 已授予的工具(如 memory-*)——子代理必须与父同源。
    runtimeAllowedToolNames = new Set(tools.map((tool) => tool.function.name));
    history = [...shared.history];
    userInput = [
      '[Sub-agent delegation] The main agent delegated a sub-task to you. The conversation above is the shared working context — treat facts already established there as ground truth; do NOT redo exploration that is already done.',
      opts.context?.trim() ? `Task context (authoritative; do not rediscover):\n${opts.context.slice(0, 4000)}` : '',
      `Sub-task:\n${opts.prompt}`,
      [
        "You have the same tools and the same full capabilities as the main agent. Your file writes land directly in the workspace and belong to the main agent's current rollback transaction.",
        'Your final text reply is returned to the main agent as the result — concise and actionable: what you did, key findings, files changed, blockers.',
      ].join('\n'),
      opts.systemPromptSuffix ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');
  } else {
    // ── legacy 紧凑上下文(直接调用 / 未迁移嵌入 / 测试)──
    // 没有父前缀可复用时自建 worker 上下文;能力面仍以父 step 上限为准,不额外收缩。
    const systemPrompt = effectiveSystemPrompt(
      buildMocodeCorePrompt() +
        '\n\n' +
        SUBAGENT_ROLE +
        SUBAGENT_SUFFIX +
        (opts.systemPromptSuffix ? `\n\n${opts.systemPromptSuffix}` : ''),
    );
    // 子 worker 只能在父 step 的不可变 capability 上限内进一步缩小。没有父快照时以当前
    // chatTools 为 baseline；显式 tools:[] 必须保持零工具，不能误当成"未限制"。
    const parentNames = opts.parentAllowedToolNames
      ? [...new Set(opts.parentAllowedToolNames)]
      : chatTools.map((tool) => tool.function.name);
    const effectiveNames = parentNames.filter((name) => !requested || requested.has(name));
    toolsOverride = effectiveNames.flatMap((name) => {
      const schema = getToolChatSchema(name);
      return schema ? [schema] : [];
    });
    runtimeAllowedToolNames = new Set(toolsOverride.map((tool) => tool.function.name));
    // 独立 history(子 agent 自己持有,不共享主对话)。
    // 只塞 system;user 消息由 runAgentCore 的 userInput 参数 push(与主 agent 一致)。
    history = [{ role: 'system', content: systemPrompt }];
    userInput = opts.context?.trim()
      ? `Task context (authoritative; do not rediscover):\n${opts.context.slice(0, 4000)}\n\nSub-task:\n${opts.prompt}`
      : opts.prompt;
  }

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
  //
  // quiet 模式(供 run_skill 等 opaque workflow 用):不产可展开 batch,
  // 只在首次工具调用时写一行「◐ 执行 skill…」,完成后替换为「● skill 完成: 摘要」。
  const live = isTuiActive() && !opts.quiet;
  const quiet = isTuiActive() && !!opts.quiet;
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

  // quiet 模式:完全静默,不写任何行(连 spinner 都没有);
  // 子 agent 的执行过程与结果只回灌为主 agent 的 run_skill 工具结果。
  const ensureQuietLine = (_label: string): void => {
    if (!quiet) return; // 静默:什么都不输出
  };
  const replaceQuietLine = (_status: string, _detail: string): void => {
    if (!quiet) return; // 静默:什么都不输出
  };

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
    if (status)
      batch.setBatchLabel(
        id,
        status === 'complete'
          ? t('subagent.complete')
          : status === 'failed'
            ? t('subagent.failed')
            : t('subagent.running'),
      );
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
    onToolCall: (_name) => {
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
      ensureQuietLine(opts.quietLabel ?? t('skill.executing', { name: opts.prompt.slice(0, 40) }));
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
        // 子 agent 批不展示 diff(其写入已直接落工作区,由主 agent 的当前回滚事务统一追踪);
        // 空 preview 用占位标记 entry 已完成,避免折叠后摘要仍显示"运行中"。
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
      if (quiet) replaceQuietLine('failed', t('skill.maxSteps', { max: String(maxSteps) }));
    },
    onDone: (elapsedMs, usage) => {
      const tok =
        usage && usage.totalTokens
          ? `  · ${usage.totalTokens} tokens${usage.cachedTokens ? ` ↻${usage.cachedTokens} cached` : ''}`
          : '';
      writeBuf(`  ✻ 子 agent 耗时 ${(elapsedMs / 1000).toFixed(1)}s${tok}\n`);
      finishLiveBatch('complete');
      if (quiet) {
        replaceQuietLine('complete', `${t('skill.complete')}  ${(elapsedMs / 1000).toFixed(1)}s${tok}`);
      }
    },
    onAbort: () => {
      // 中断:子 agent 未完成,收尾批(不折叠——用户可能想看中断前做了什么)。
      finishLiveBatch('aborted');
      if (quiet) replaceQuietLine('aborted', t('skill.aborted'));
    },
    // onStepStart / onChatDone / onToolStart / onToolDone:子 agent 静默,无需 spinner 渲染。
    // abort 还原(history 还原 + 模式还原)由 core 的 abortRestore 处理,hooks 只管展示。
  };

  // 每个子 agent 独享统计/预算状态。不能保存再恢复模块级单例：多个 task 并发时
  // save/restore 会竞态，且 lastEstimate / schedulerLog 仍会污染主 agent。
  const localContextState = createContextState();
  // 与主 agent 完全同源:写操作直接落在工作区,进入主 agent 当前轮次的同一回滚事务
  // (spawn 不调 beginTurn)。没有 overlay 拷贝/ChangeSet 合并这一步——那是旧 read/write
  // 双模式的产物,子 agent 不再受限,也就不需要"先隔离再合并"。
  const result = await runAgentCore({
    history,
    userInput,
    signal: opts.signal,
    hooks,
    maxSteps,
    toolsOverride,
    runtimeAllowedToolNames,
    contextState: localContextState,
    suppressOpeningAnalysis: true, // 子代理不注入「开场分析」:仅主线面对用户的首次响应用
    // 子代理不注入主会话「会话状态」(plan + 笔记):那是主 agent 的工作面,委派消息已带齐
    // 子任务所需上下文,重复注入只白付 token。
    suppressSessionState: true,
  });

  const status: SpawnResult['status'] =
    opts.signal?.aborted || result.terminationReason === 'aborted'
      ? 'aborted'
      : result.completed
        ? 'completed'
        : 'failed';

  return {
    summary: result.finalText,
    completed: result.completed && status === 'completed',
    transcript: truncateDisplay(transcript, 20000), // 防过大;调试用,回灌主 history 的是 summary 不是 transcript
    status,
    usage: {
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
      cachedTokens: result.usage?.cachedTokens ?? 0,
      reasoningTokens: result.usage?.reasoningTokens ?? 0,
    },
  };
}
