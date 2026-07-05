// agent 核心循环(纯逻辑,无 TUI 依赖):流式 chat → 工具执行 → 回灌。
// 所有展示副作用经 AgentHooks 注入——主 agent 注入 TUI 渲染(layout + spinner + diff),
// 子 agent 注入静默/摘要 hooks(不写屏)。逻辑层共享,避免重复实现循环 / 分组 / abort 还原。
//
// 与 index.ts 的关系:index.ts 的 runAgent = runAgentCore + TUI hooks 薄封装(行为不变)。
// spawn.ts 的 spawnAgent = runAgentCore + 静默 hooks(子 agent)。

import { readFileSync } from 'node:fs';
import type OpenAI from 'openai';
import {
  chat,
  planChatTools,
  type ChatMessage,
  type ChatResult,
  type ToolCallRef,
} from '../llm/index.js';
import { executeTool } from '../tools/registry.js';
import { PLAN_DISABLED_TOOLS } from '../tools/constants.js';
import { getAgentMode, setAgentMode } from './mode.js';
import { maybeCompact, contextState, dropContextFromHistory } from '../session/index.js';
import { optimizeToolResult } from '../context/index.js';
import { createRelevancePruner } from '../context/relevance.js';
import { config } from '../config/index.js';
import { jailResolve } from '../sandbox/index.js';
import type { DropContextFilter, DropContextResult } from '../tools/types.js';

/** 解析工具 arguments JSON;非法或空返 null(调用方据此降级到普通 preview)。 */
function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** 只读工具集:一轮多个时,连续的只读工具成组 Promise.all 并行(无副作用、互不依赖)。 */
const READ_TOOL_NAMES = new Set([
  'read_file',
  'glob',
  'grep',
  'codegraph',
  'web_search',
  'web_fetch',
]);
/** mutation 工具:写盘 + 在 executeTool 内记回滚 before 快照,必须串行保快照序。 */
const isMutationTool = (name: string): boolean =>
  name === 'edit_file' || name === 'write_file';

/** 工具调用 ● 头所需信息(交给 hooks 渲染;core 不直接写屏)。 */
export interface ToolCallView {
  name: string;
  arguments: string;
  id: string;
}

/** mutation 执行前读旧内容供 diff:write_file 取整文件旧内容(不存在→null=新建),
 * edit_file 取 old_string 起始行号(供 diff 显示真实文件行号)。读不到则 diff 退化为相对行号。
 * 非 mutation 或参数非法返 { preWriteOld: null, editStartLine: 1 }。失败不阻断。 */
function readDiffContext(
  tc: ToolCallRef,
  parsed: Record<string, unknown> | null,
): { preWriteOld: string | null; editStartLine: number } {
  if (!parsed) return { preWriteOld: null, editStartLine: 1 };
  const p = String(parsed.path ?? '');
  if (!p) return { preWriteOld: null, editStartLine: 1 };
  if (tc.name === 'write_file') {
    try {
      // jailResolve:沙箱越界(../../、绝对外圈、软链出圈)抛错 → catch 兜底返 null,不泄露牢外内容(TOCTOU)
      return { preWriteOld: readFileSync(jailResolve(p), 'utf8'), editStartLine: 1 };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 文件不存在(新建)、不可读 或 沙箱越界(不泄露)
    }
  }
  if (tc.name === 'edit_file') {
    const oldStr = String(parsed.old_string ?? '');
    try {
      // jailResolve:同上,沙箱越界抛错 → catch 兜底,不泄露牢外内容
      const data = readFileSync(jailResolve(p), 'utf8');
      const idx = oldStr ? data.indexOf(oldStr) : -1;
      return {
        preWriteOld: null,
        editStartLine: idx >= 0 ? data.slice(0, idx).split('\n').length : 1,
      };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 读不到:diff 退化为相对行号(含沙箱越界)
    }
  }
  return { preWriteOld: null, editStartLine: 1 };
}

/** 回灌 tool 结果到 history:经 Context Optimization Pipeline 编码(tree/search/log/...)后裁到单条上限。
 *  tool_call_id 与 assistant.tool_calls 按序配对。未注册 encoder 时回落 capToolResultForHistory(零行为变化)。
 *  TUI 渲染(hooks.onToolResult)用原始 output,与此解耦——屏上看全量,LLM 看编码后紧凑版。
 *  出口再经 Relevance Pruner 做跨条裁剪:同 path 旧 read_file 自动 stub 为存根。
 *  - pruner 在每个 runAgentCore 实例化一次(本闭包持有),会话级状态。
 *  - 开关关闭时 pruner 不创建(零开销、零行为变化)。 */
function pushToolResult(
  history: ChatMessage[],
  tc: ToolCallRef,
  output: string,
  pruner: ReturnType<typeof createRelevancePruner> | null,
): void {
  const msg = {
    role: 'tool' as const,
    tool_call_id: tc.id,
    // optimizeToolResult:classifier 选 encoder → encode(保不变量压缩)→ capToolResultForHistory 兜底。
    // tc.arguments 透传给 encoder(上下文感知编码,如 read_file 的 offset/limit)。永不抛错。
    content: optimizeToolResult(tc.name, output, tc.arguments),
  } as ChatMessage;
  history.push(msg);
  // 相关性裁剪:只动 read_file / edit_file / write_file 三类(其它 tool 与本层无关)。
  // pruner 内部 try/catch + 幂等,永不抛错;开关关闭时 pruner=null 完全跳过。
  if (pruner) pruner.observePush(history, msg);
}

// ── hooks:把 runAgent 的展示副作用参数化 ──────────────────────────────────

/**
 * agent 循环的展示副作用接缝。主 agent 注入 TUI 渲染实现;子 agent 注入静默/摘要实现。
 * 所有方法可选——core 对 undefined hooks 安全跳过。
 */
export interface AgentHooks {
  /** 流式正文增量(主 agent:走 markdown 渲染写内容区)。 */
  onText?: (delta: string) => void;
  /** 模型开始生成某 tool_call 的参数(主 agent:补换行 + 启「生成中」spinner)。 */
  onToolCall?: (name: string) => void;
  /** 每步开始,spinner 启「思考中」(主 agent:spinner.start)。 */
  onStepStart?: () => void;
  /** chat 返回后停 spinner(主 agent:spinner.stop)。 */
  onChatDone?: () => void;
  /** 流式正文末尾补换行(若 onToolCall 已补则 no-op);防 ● 行黏在正文行尾。 */
  onTextEnd?: () => void;
  /** 工具调用 ● 头渲染(主 agent:工具名 + 参数摘要)。 */
  onToolHeader?: (tc: ToolCallRef) => void;
  /** 启「执行 工具」spinner(主 agent:spinner.start)。 */
  onToolStart?: (name: string) => void;
  /** 工具执行完停 spinner(主 agent:spinner.stop)。 */
  onToolDone?: () => void;
  /** 工具结果渲染(主 agent:mutation 走 diff 块;其余走一行 preview)。 */
  onToolResult?: (
    tc: ToolCallRef,
    output: string,
    parsed: Record<string, unknown> | null,
    preWriteOld: string | null,
    editStartLine: number,
  ) => void;
  /** 工具步末尾补一空行(与下一轮思考/正文分隔)。 */
  onToolBatchEnd?: () => void;
  /** 无回复提示(模型既无文本也无工具调用)。 */
  onNoReply?: () => void;
  /** 达到最大步数提示。 */
  onMaxSteps?: () => void;
  /** 中断还原:停 spinner + 补换行 + (已中断)提示 + history 还原 + 模式还原。 */
  onAbort?: () => void;
  /** 跑完(正常/达上限)在回复末尾打耗时摘要行;中断不调。 */
  onDone?: (elapsedMs: number) => void;
}

/** runAgentCore 的运行选项。 */
export interface AgentRunOptions {
  history: ChatMessage[];
  /** 纯文本字符串,或多模态 parts 数组(OpenAI content 数组,text + image_url)。 */
  userInput: string | ContentPart[];
  signal?: AbortSignal;
  /** 每步 chat() 返回后回调:repl 据此重算并重画状态行 context 用量条。 */
  onContextUpdate?: () => void;
  hooks: AgentHooks;
  /** 步数上限;缺省 = config.maxSteps。子 agent 可传更低值。 */
  maxSteps?: number;
  /** 工具 schema 覆盖;plan 模式传 planChatTools(只读子集)。子 agent 可传受限子集。
   *  缺省 = 按 getAgentMode() 自动选(auto=全量 / plan=只读)。 */
  toolsOverride?: OpenAI.Chat.Completions.ChatCompletionTool[];
  /** 跳过回滚快照记录(子 agent 逻辑隔离用)。true = 本 agent 的 write_file/edit_file 改动
   *  不进主回滚链,主 /rollback 不撤销。透传给 executeTool。 */
  skipRollback?: boolean;
}

/** OpenAI content array 的子集(text + image_url);repl 构造 user 多模态消息用。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

/** runAgentCore 的运行结果。 */
export interface AgentRunResult {
  /** 正常完毕 / 达上限 true;中断 false。 */
  completed: boolean;
  /** 最终 assistant 文本回复(content);无回复或中断为 null。 */
  finalText: string | null;
}

/**
 * agent 核心循环(纯逻辑):
 *  流式调 LLM(经 hooks.onText 实时渲染)→ 有 tool_calls 就分组执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由调用方持有。
 *  步前经 session/maybeCompact 自动压缩(接近窗口上限时三层压缩);
 *  工具结果进 history 前经 Context Optimization Pipeline(optimizeToolResult:类型化编码 + 长度裁剪)。
 *
 *  中断语义:signal 经 executeTool(name, args, signal) 串进工具;run_command/web_fetch 等 abort 即时杀
 *  (树杀子进程 / 取消 fetch),循环顶 if(signal.aborted) 兜底还原。不会留下未配对的 tool_call_id。
 *  abort 时 history 还原到本 turn 前(savedHistory 浅拷贝),模式还原,调 hooks.onAbort。
 *
 *  所有展示副作用经 hooks 注入;core 自身不直接调 layout / spinner(不依赖 ui/layout.ts)。
 *  但 core 仍依赖 ui/render.ts 的纯函数(summarizeToolCall / truncateDisplay / fmtElapsed)——
 *  这些是纯字符串格式化,无副作用,共享安全。
 */
export async function runAgentCore(
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const { history, userInput, signal, onContextUpdate, hooks, skipRollback } = opts;
  const maxSteps = opts.maxSteps ?? config.maxSteps;
  // 中断回滚快照:入口(本 turn push 任何消息前)整段浅拷贝。abort 时 length=0;push(...saved) 还原。
  // 用 slice() 而非 length:maybeCompact 会原地重建(length=0;push(...rebuilt)),savedLen 会失效。
  const savedHistory = history.slice();
  // 中断还原:LLM 中途可能调 switch_mode 切了模式,abort 时连同模式一起还原回轮首。
  const savedMode = getAgentMode();
  // 本轮计时:从入口到完毕(正常 return / 达上限),供 finally 打 ✻ Worked for 摘要行。
  const t0 = Date.now();
  let done = false; // 正常完毕 / 达上限 true;中断 false(不显摘要)
  history.push({ role: 'user', content: userInput });
  // drop_context 工具的上下文剔除回调:闭包捕获 history,原地剔除无关旧 tool 结果。
  // 保护由 dropContextFromHistory 内部保证:history[0](system)+ 当前轮(最后 user 及其后)永不剔除。
  // 子 agent 也在自己的 history 上操作(子 agent 独立 history);skipRollback 不影响此行为。
  const dropContext = (filter: DropContextFilter): DropContextResult =>
    dropContextFromHistory(history, filter);
  // 相关性裁剪 pruner:每个 runAgentCore 实例一个,纯静态、不调 LLM、自动判定 read_file 失效。
  // 开关关闭时为 null,所有 pushToolResult 调用走无 pruner 路径(零行为变化)。
  const relprune = config.contextRelprune ? createRelevancePruner() : null;
  // 本轮流式状态:首个正文 token 到达即停 spinner(思考期间 spinner 持续转「思考中…」,不写思考内容)。
  let mode: 'idle' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';

  const onText = (s: string) => {
    hooks.onText?.(s); // 主 agent:走 markdown 渲染写内容区
    mode = 'text';
    gotText = true;
    if (s) lastChar = s[s.length - 1];
  };

  const onToolCall = (name: string) => {
    // 文本/思考已流完,模型转而生成 tool_call 参数(可能很长,如 write_file 整篇内容):
    // 补换行(让随后的 ● 行与 diff 不黏在正文末尾)+ 启「生成中」内联 spinner,内容区不再干等。
    if (lastChar && lastChar !== '\n') {
      hooks.onTextEnd?.(); // 主 agent:layout.contentWrite('\n')
      lastChar = '\n';
    }
    hooks.onToolCall?.(name); // 主 agent:spinner.start(`生成 ${name}…`)
  };

  // 中断还原:停 spinner + 补换行 + (已中断)提示 + history 还原到本 turn 前 + 模式还原。
  // 两处共用:① await chat() 抛 AbortError 的 catch;② 工具被 abort 杀后循环顶检查。
  const abortRestore = (): void => {
    hooks.onAbort?.();
    history.length = 0;
    history.push(...savedHistory);
    setAgentMode(savedMode);
  };
  try {
    for (let step = 0; step < maxSteps; step++) {
      // 上一步工具被 abort 杀(run_command/web_fetch 等)→ signal.aborted,直接还原退出,不等 maybeCompact + chat()
      if (signal?.aborted) {
        abortRestore();
        return { completed: false, finalText: null };
      }
      // 步前:接近窗口上限时自动压缩(三层)。此时 spinner 已停,通知行干净。
      await maybeCompact(history);
      hooks.onStepStart?.(); // 主 agent:spinner.start('思考中')
      mode = 'idle';
      gotText = false;
      lastChar = '';
      let result: ChatResult;
      try {
        // 每步读实时模式:LLM 可能在上一步调 switch_mode 切了模式,这里立即用对应工具集
        // (auto=chatTools 全量;plan=planChatTools 只读子集)。模式由 src/agent/mode.ts 单一持有。
        // 调用方可传 toolsOverride 覆盖(子 agent 受限工具子集)。
        result = await chat(
          history,
          { onText, onToolCall },
          signal,
          opts.toolsOverride ??
            (getAgentMode() === 'plan' ? planChatTools : undefined),
        );
      } catch (e) {
        // 中断(用户运行中 Ctrl+C):chat() 抛 AbortError(signal.aborted)→ 还原 history + 模式 + return(不抛)。
        // 工具执行现已串 signal:run_command/web_fetch 被 abort 即时杀,循环顶检查兜底(不会留未配对 tool_call_id)。
        if (
          signal?.aborted ||
          (e instanceof Error &&
            (e.name === 'AbortError' || e.name === 'APIUserAbortError'))
        ) {
          abortRestore();
          return { completed: false, finalText: null };
        }
        throw e;
      }
      contextState.lastUsage = result.usage; // 供 /context 与状态行显示实测 token
      hooks.onChatDone?.(); // 主 agent:spinner.stop()
      // lastUsage 已更新:触发状态行 context 用量条重算+重画,运行中不再冻结在轮首。
      onContextUpdate?.();

      if (result.toolCalls.length > 0) {
        // 流式正文末尾补换行(若 onToolCall 已补则 lastChar='\n',此处 no-op);防 ● 行黏在正文行尾
        if (mode !== 'idle' && lastChar !== '\n') hooks.onTextEnd?.();
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

        // 工具分组执行(保 tool_calls 原顺序):连续的只读工具(READ_TOOL_NAMES)成组并发——一次性启动全部
        // executeTool(调用即开始 I/O),再按原顺序逐个 await + 渲染(● 头与 ↳ 结果紧邻,修并行时"全 ● 后全 ↳"分离)。
        // mutation(write_file/edit_file)及 run_command/use_skill 各为单步串行屏障——mutation 串行保
        // recordMutation 调用序 = 回滚快照序(executeTool 内写前记 before 快照,同文件多次写需按序)。
        // 渲染与 history 回灌一律按原顺序;并发只影响执行时序,tool_call_id 仍按序配对。
        // executeTool 永不抛错(调度器 try/catch 返字符串),故 await 单个 promise 不会抛(永远 resolve 为字符串)。
        const calls = result.toolCalls;
        let i = 0;
        while (i < calls.length) {
          if (READ_TOOL_NAMES.has(calls[i].name)) {
            // 收集连续只读组(≥1),并发执行:先一次性启动所有(executeTool 调用即开始 I/O),
            // 再按原顺序逐个 await + 渲染——● 头与 ↳ 结果紧邻、顺序 = tool_calls 序(修"全 ● 后全 ↳"分离 bug)。
            // 异步工具(web_fetch 等)并发跑、总耗时 ≈ 最慢一个;同步工具(glob/grep)map 时已顺序跑完,await 即返。
            let j = i;
            while (j < calls.length && READ_TOOL_NAMES.has(calls[j].name)) j++;
            const batch = calls.slice(i, j);
            const started = batch.map((tc) => executeTool(tc.name, tc.arguments, signal, { skipRollback, dropContext }));
            for (let k = 0; k < batch.length; k++) {
              const tc = batch[k];
              hooks.onToolHeader?.(tc);
              hooks.onToolStart?.(tc.name);
              const output = await started[k];
              hooks.onToolDone?.();
              hooks.onToolResult?.(tc, output, null, null, 1); // 只读工具无 diff
              pushToolResult(history, tc, output, relprune);
            }
            i = j;
          } else if (calls[i].name === 'task') {
            // task 并发组:连续的 task 调用成组并发(子 agent 并行跑,各自独立 history)。
            // 一次性启动全部(executeTool 即 spawnAgent,子 agent 开始跑),再并发 await + 渲染。
            // task 是长任务,并发 fan-out 总耗时 ≈ 最慢一个子 agent。
            // task 与 mutation/run_command 之间串行屏障(task 子 agent 可能有文件改动,不能和 write_file 乱序)。
            // 渲染:先批量打印所有 ● 头 + 启 spinner(让用户看到多个 task 同时在跑),再逐个 await 出结果。
            // (若像只读组那样「header → await → result」串行,长 task 的第二个 header 要等第一个跑完才出现,
            //  视觉上只有一个在跑——与并发事实不符。)
            //
            // plan 模式防御 backstop(与单步串行分支同语义):schema 已剔除 task,正常不会进这里;
            // 防后端幻觉调用——不执行(绝不派生子 agent,子 agent 可能有 mutation,违反只读),直接返错回灌。
            if (getAgentMode() === 'plan') {
              const tc = calls[i];
              hooks.onToolHeader?.(tc);
              const err = `错误:计划模式下禁用工具 ${tc.name}(仅读探查,不改动文件 / 不跑命令)`;
              hooks.onToolResult?.(tc, err, null, null, 1);
              pushToolResult(history, tc, err, relprune);
              i++;
              continue;
            }
            let j = i;
            while (j < calls.length && calls[j].name === 'task') j++;
            const batch = calls.slice(i, j);
            const started = batch.map((tc) => executeTool(tc.name, tc.arguments, signal, { skipRollback, dropContext }));
            // 先批量打印所有头 + 启 spinner(多 task 并发,spinner 只显一个,但 ● 头都打出来)
            for (const tc of batch) {
              hooks.onToolHeader?.(tc);
            }
            hooks.onToolStart?.(batch[0].name); // spinner:多 task 共用一个「执行 task…」
            // 逐个 await 出结果(按 tool_calls 原序,保 tool_call_id 配对);结果到即渲染 ↳
            for (let k = 0; k < batch.length; k++) {
              const tc = batch[k];
              const output = await started[k];
              hooks.onToolResult?.(tc, output, null, null, 1); // task 结果是摘要,无 diff
              pushToolResult(history, tc, output, relprune);
            }
            hooks.onToolDone?.();
            i = j;
          } else {
            // 单步串行(mutation / run_command / use_skill)——逐个执行,保快照序
            const tc = calls[i];
            // plan 模式防御 backstop:schema 已剔除这些工具,正常不会进这里;防后端幻觉调用——
            // 不执行,直接返错回灌(让模型看到「plan 模式禁用」并停止),绝不写盘 / 跑命令。
            if (getAgentMode() === 'plan' && PLAN_DISABLED_TOOLS.has(tc.name)) {
              hooks.onToolHeader?.(tc);
              const err = `错误:计划模式下禁用工具 ${tc.name}(仅读探查,不改动文件 / 不跑命令)`;
              hooks.onToolResult?.(tc, err, null, null, 1);
              pushToolResult(history, tc, err, relprune);
              i++;
              continue;
            }
            hooks.onToolHeader?.(tc);
            const parsed = isMutationTool(tc.name)
              ? parseArgs(tc.arguments)
              : null;
            const { preWriteOld, editStartLine } = readDiffContext(tc, parsed);
            hooks.onToolStart?.(tc.name);
            const output = await executeTool(tc.name, tc.arguments, signal, { skipRollback, dropContext });
            hooks.onToolDone?.();
            hooks.onToolResult?.(tc, output, parsed, preWriteOld, editStartLine);
            pushToolResult(history, tc, output, relprune);
            // 相关性裁剪 mutation 通知:edit_file/write_file 后,该 path 之前的所有 read_file
            // 结果已失效(已不再是文件当前状态)→ stub 为存根。pruner 内部 try/catch + 幂等。
            // 非 mutation 工具(run_command/use_skill/memory_* 等)此处 path="" 不触发。
            if (relprune && isMutationTool(tc.name)) {
              const mp = parsed?.path;
              if (typeof mp === 'string' && mp) relprune.observeMutation(history, mp);
            }
            i++;
          }
        }
        // 工具步末尾补一空行:与下一轮的思考 / 正文分隔(否则 ↳ 后紧接 ▎ 思考,无空行不好看;
        // 与正文→● 的 1 空行对称)。工具结果已以 \n 收尾,此处再补 \n 恰好 1 空行。
        hooks.onToolBatchEnd?.();
        continue; // 带着工具结果再调一次 LLM
      }

      if (mode !== 'idle' && lastChar !== '\n') hooks.onTextEnd?.(); // 流式末尾补换行

      // 没有工具调用:流式正文即最终回复(已实时打印)
      if (!gotText) hooks.onNoReply?.();
      history.push({ role: 'assistant', content: result.content });
      done = true;
      return { completed: true, finalText: result.content };
    }

    hooks.onMaxSteps?.();
    done = true;
    return { completed: true, finalText: null };
  } finally {
    // 跑完(正常 / 达上限)在回复末尾打耗时摘要行(仿 Claude Code);中断 done=false 不打。
    if (done) {
      hooks.onDone?.(Date.now() - t0);
    }
  }
}

// ── 导出共享辅助(主 agent 的 TUI hooks 实现要用)──────────────────────────
export { parseArgs, readDiffContext, isMutationTool, READ_TOOL_NAMES };
