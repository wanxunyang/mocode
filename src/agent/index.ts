import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import {
  maybeCompact,
  capToolResultForHistory,
  contextState,
} from '../session/index.js';
import { config } from '../config/index.js';

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

/** 工具调用 ● 头:工具名 + 参数摘要(按 tool_calls 原顺序打印,让用户看到本轮跑哪些工具)。 */
function writeToolHeader(tc: ToolCallRef): void {
  const summary = summarizeToolCall(tc.name, tc.arguments);
  layout.contentWrite(
    `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}${tc.name}${ui.reset}  ${ui.dim}${summary}${ui.reset}\n`
  );
}

/**
 * mutation 执行前读旧内容供 diff:write_file 取整文件旧内容(不存在→null=新建),
 * edit_file 取 old_string 起始行号(供 diff 显示真实文件行号)。读不到则 diff 退化为相对行号。
 * 非 mutation 或参数非法返 { preWriteOld: null, editStartLine: 1 }。失败不阻断。
 */
function readDiffContext(
  tc: ToolCallRef,
  parsed: Record<string, unknown> | null,
): { preWriteOld: string | null; editStartLine: number } {
  if (!parsed) return { preWriteOld: null, editStartLine: 1 };
  const p = String(parsed.path ?? '');
  if (!p) return { preWriteOld: null, editStartLine: 1 };
  if (tc.name === 'write_file') {
    try {
      return { preWriteOld: readFileSync(resolve(p), 'utf8'), editStartLine: 1 };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 文件不存在(新建)或不可读
    }
  }
  if (tc.name === 'edit_file') {
    const oldStr = String(parsed.old_string ?? '');
    try {
      const data = readFileSync(resolve(p), 'utf8');
      const idx = oldStr ? data.indexOf(oldStr) : -1;
      return {
        preWriteOld: null,
        editStartLine: idx >= 0 ? data.slice(0, idx).split('\n').length : 1,
      };
    } catch {
      return { preWriteOld: null, editStartLine: 1 }; // 读不到:diff 退化为相对行号
    }
  }
  return { preWriteOld: null, editStartLine: 1 };
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

/** 回灌 tool 结果到 history(裁到单条上限);tool_call_id 与 assistant.tool_calls 按序配对。 */
function pushToolResult(
  history: ChatMessage[],
  tc: ToolCallRef,
  output: string,
): void {
  history.push({
    role: 'tool',
    tool_call_id: tc.id,
    content: capToolResultForHistory(tc.name, output),
  } as ChatMessage);
}

/**
 * agent 核心循环:
 *  流式调 LLM(onText 实时写内容区)→ 有 tool_calls 就执行并回灌
 *  → 否则流式正文即最终回复。history 在调用间持久,由 REPL 持有。
 *  步前经 session/maybeCompact 自动压缩(接近窗口上限时三层压缩);
 *  工具结果进 history 前经 capToolResultForHistory 裁到单条上限。
 *
 *  所有正文写经 layout.contentWrite(保证落在内容区、跟踪续写位、底栏不被顶);
 *  spinner 经 onFrame 回调刷状态行(layout.drawStatusBar),等待时内容区静止、底栏转圈。
 *  思考期间不写思考内容,只让 spinner 持续转「思考中…」(首个正文 / tool_call token 到达才停)。
 */
export async function runAgent(
  history: ChatMessage[],
  userInput: string,
  signal?: AbortSignal,
  /** 每步 chat() 返回后回调:repl 据此重算并重画状态行 context 用量条(运行中实时刷新,不冻结在轮首)。 */
  onContextUpdate?: () => void,
): Promise<void> {
  // 中断回滚快照:入口(本 turn push 任何消息前)整段浅拷贝。abort 时 length=0;push(...saved) 还原。
  // 用 slice() 而非 length:maybeCompact 会原地重建(length=0;push(...rebuilt)),savedLen 会失效。
  const savedHistory = history.slice();
  // 中断还原:LLM 中途可能调 switch_mode 切了模式,abort 时连同模式一起还原回轮首
  // (避免 mode.ts 留在 auto、history[0] 却被还原回 plan 的错位;listener 重写 history[0] 与 savedHistory 幂等)。
  const savedMode = getAgentMode();
  // 本轮计时:从入口到完毕(正常 return / 达上限),供 finally 打 ✻ Worked for 摘要行。
  // 与 layout 的 turnStart 各自独立(差几毫秒),避免 agent 反向读 layout 状态的耦合。
  const t0 = Date.now();
  let done = false; // 正常完毕 / 达上限 true;中断 false(不显摘要)
  history.push({ role: 'user', content: userInput });
  // 开新轮次(回滚用):首行截断 40,供 /rollback 轮次菜单展示。
  beginTurn(truncateDisplay(userInput.split('\n')[0] ?? '', 40));
  layout.contentMode(); // 防御性:运行态光标归输入框光标位供 IME 锚定(enterRunningMode 已置,这里兜底)
  // spinner:续写位内联转圈(思考中 / 执行 工具时,内容区不再「干等」)。
  // 只走内联 paintLiveAtCursor——不调 setStatus,状态行不重复 spinner 文字(状态行只显走时,
  // 由 turnTimer 200ms 续刷);内联帧不进缓冲、停时清掉,随后结果即写在该行——故 spinner 不入历史、PgUp 看不到。
  const spinner = new Spinner((msg, frame) => {
    if (frame) {
      layout.paintLiveAtCursor(
        `  ${ui.brightMagenta}${frame}${ui.reset} ${ui.dim}${msg}…${ui.reset}`
      );
    } else {
      layout.clearLiveAtCursor();
    }
  });
  // 本轮流式状态:首个正文 token 到达即停 spinner(思考期间 spinner 持续转「思考中…」,不写思考内容)。
  let mode: 'idle' | 'text' = 'idle';
  let gotText = false;
  let lastChar = '';

  const onText = (s: string) => {
    spinner.stop(); // 任何正文 token 都停 spinner(首 token 停「思考中」;onToolCall 重启后若又来文本则停「生成中」)。未旋转时 stop 为 no-op。
    mode = 'text';
    gotText = true;
    layout.contentWriteMd(s); // 正文走 markdown 渲染(代码块高亮 / 标题 / 列表 / 行内 …),见 ui/markdown.ts
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
    for (let step = 0; step < config.maxSteps; step++) {
      // 步前:接近窗口上限时自动压缩(三层)。此时 spinner 已停,通知行干净。
      await maybeCompact(history);
      spinner.start('思考中');
      mode = 'idle';
      gotText = false;
      lastChar = '';
      let result: ChatResult;
      try {
        // 每步读实时模式:LLM 可能在上一步调 switch_mode 切了模式,这里立即用对应工具集
        // (auto=chatTools 全量;plan=planChatTools 只读子集)。模式由 src/agent/mode.ts 单一持有。
        result = await chat(history, { onText, onToolCall }, signal, getAgentMode() === 'plan' ? planChatTools : undefined);
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
          setAgentMode(savedMode); // 还原模式:listener 重写 history[0] 回轮首系统提示(与 savedHistory 幂等)
          return;
        }
        throw e;
      }
      contextState.lastUsage = result.usage; // 供 /context 与状态行显示实测 token
      spinner.stop();
      // lastUsage 已更新:触发状态行 context 用量条重算+重画,运行中不再冻结在轮首。
      onContextUpdate?.();

      if (result.toolCalls.length > 0) {
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
            const started = batch.map((tc) => executeTool(tc.name, tc.arguments));
            for (let k = 0; k < batch.length; k++) {
              const tc = batch[k];
              writeToolHeader(tc);
              spinner.start(`执行 ${tc.name}`);
              const output = await started[k];
              spinner.stop();
              writeToolResult(tc, output, null, null, 1); // 只读工具无 diff
              pushToolResult(history, tc, output);
            }
            i = j;
          } else {
            // 单步串行(mutation / run_command / use_skill)——逐个执行,保快照序
            const tc = calls[i];
            // plan 模式防御 backstop:schema 已剔除这些工具,正常不会进这里;防后端幻觉调用——
            // 不执行,直接返错回灌(让模型看到「plan 模式禁用」并停止),绝不写盘 / 跑命令。
            if (getAgentMode() === 'plan' && PLAN_DISABLED_TOOLS.has(tc.name)) {
              writeToolHeader(tc);
              const err = `错误:计划模式下禁用工具 ${tc.name}(仅读探查,不改动文件 / 不跑命令)`;
              writeToolResult(tc, err, null, null, 1);
              pushToolResult(history, tc, err);
              i++;
              continue;
            }
            writeToolHeader(tc);
            const parsed = isMutationTool(tc.name)
              ? parseArgs(tc.arguments)
              : null;
            const { preWriteOld, editStartLine } = readDiffContext(tc, parsed);
            spinner.start(`执行 ${tc.name}`);
            const output = await executeTool(tc.name, tc.arguments);
            spinner.stop();
            writeToolResult(tc, output, parsed, preWriteOld, editStartLine);
            pushToolResult(history, tc, output);
            i++;
          }
        }
        // 工具步末尾补一空行:与下一轮的思考 / 正文分隔(否则 ↳ 后紧接 ▎ 思考,无空行不好看;
        // 与正文→● 的 1 空行对称)。工具结果已以 \n 收尾,此处再补 \n 恰好 1 空行。
        layout.contentWrite('\n');
        continue; // 带着工具结果再调一次 LLM
      }

      if (mode !== 'idle' && lastChar !== '\n') layout.contentWrite('\n'); // 流式末尾补换行

      // 没有工具调用:流式正文即最终回复(已实时打印)
      if (!gotText) layout.contentWrite(`${ui.dim}(无回复)${ui.reset}\n`);
      history.push({ role: 'assistant', content: result.content });
      done = true;
      return;
    }

    layout.contentWrite(
      `  ${ui.yellow}●${ui.reset} ${ui.yellow}达到最大步数(${config.maxSteps}),本轮停止。${ui.reset}\n`
    );
    done = true;
  } finally {
    spinner.stop();
    // 跑完(正常 / 达上限)在回复末尾打耗时摘要行(仿 Claude Code);中断 done=false 不打。
    if (done) {
      layout.contentWrite(
        `  ${ui.dim}✻ Worked for ${fmtElapsed(Date.now() - t0)}${ui.reset}\n`
      );
    }
  }
}
