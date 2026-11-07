// Supervisor 对话 REPL：`mocode supervise`（无子命令）。
//
// 与普通 REPL 的关系：共用同一套 TUI，也共用**同一套交互层**。
//   - 画面：alt screen / 内容区 / 流式正文 / 底部状态行，全部来自 `ui/layout`；
//   - 输入态：`promptWithSlashMenu`——斜杠菜单、↑↓ 选择、Tab 补全、Ctrl+R 历史搜索；
//   - 运行态：`repl/running-input.ts` 的 startRunningListener——PgUp/PgDn/↑↓ 滚动回看、
//     鼠标滚轮、边看输出边打下一句（Enter 入队）、Ctrl+G 多行面板、Ctrl+C 中断；
//   - 状态行：`setStatusBase` + `enterRunningMode` 的 spinner/走时心跳。
//
// 早期版本把运行态交互自己写了一遍（只认 Ctrl+C），结果是模型在跑的那几十秒里输出区
// **完全没法滚动**——恰恰是最需要翻看的时候。复用而不是重写，是这里唯一正确的选择。
//
// 为什么不复用 repl/runtime.ts 的主循环：那条路径绑定了斜杠命令树、工具路由、回滚轮次、
// 记忆反思、MCP 加载等一大堆为「编码会话」服务的东西。这里需要的是「一个受约束的对话 +
// 少量本地命令」，自己写循环比给主 REPL 加一堆 if 更清楚，也不会把 supervisor 的状态漏进主 REPL。

import { stdin, stdout } from 'node:process';
import { config } from '../config/index.js';
import { createAgentRuntimeContext } from '../agent/runtime-context.js';
import { createRuntime, type Runtime } from '../runtime/index.js';
import { ui } from '../ui/theme.js';
import * as layout from '../ui/layout.js';
import { padEndDisplay, summarizeToolCall, truncateDisplay } from '../ui/render.js';
import { promptWithSlashMenu, type SlashCommand } from '../ui/prompt.js';
import {
  clearRunningInput,
  consumeQueuedTurn,
  getRunningInput,
  startRunningListener,
  stopRunningListener,
  waitForRunningComposer,
} from '../repl/running-input.js';
import { collectQueryHistory } from '../session/query-history.js';
import { SupervisorRuntime, type SupervisorNotice } from './supervisor.js';
import { terminalAutoOpenEnabled } from './terminal.js';
import { createSupervisorTools } from './tools.js';
import { buildSupervisorPrompt } from './supervisor-prompt.js';
import type { ChatMessage } from '../llm/index.js';
import type { AgentHooks } from '../agent/run-contracts.js';
import type { Tool } from '../tools/types.js';

export interface SupervisorChatOptions {
  /** Supervisor cwd：默认工作区与 `supervise` 的 --sandbox-root。 */
  root: string;
  /** 额外扫描根。 */
  scanRoots?: readonly string[];
  /** 测试注入的 Worker 执行器。 */
  worker?: () => import('./types.js').WorkerExecutor;
  /** 派活后是否自动弹独立终端看 Worker 现场（`--no-terminal` 关闭）。 */
  watchTerminals?: boolean;
  /** 测试注入的开窗实现。 */
  openTerminal?: (options: {
    title: string;
    args: string[];
    cwd?: string;
  }) => import('./terminal.js').TerminalLaunchResult;
}

const PROMPT = '❯ ';
const RUNNING_PLACEHOLDER = '编排中，可直接打下一句（Enter 排队）';

/** 斜杠菜单：与 handleLocalCommand 一一对应。菜单是唯一「命令发现」入口，
 *  用户不该靠背命令——这也是它和主 REPL 对齐的意义。 */
export function supervisorCommands(): SlashCommand[] {
  return [
    { name: '/status', desc: '编排状态（省略 run-id 列在跑的）' },
    { name: '/approvals', desc: '待决的人工介入（Worker 在等你回答）' },
    { name: '/approve', value: '/approve ', submit: false, desc: '回答审批：/approve <序号|id> <选项|cancel>' },
    { name: '/runs', desc: '各工作区最近的 Run' },
    { name: '/workspaces', desc: '这台机器上跑过 mocode 的工作区' },
    { name: '/help', desc: '命令说明' },
    { name: '/exit', desc: '退出（后台 Run 不停，可 supervise resume 续）' },
  ];
}

/** 首屏：说清这是谁、能做什么、怎么交互、怎么退出。 */
export function supervisorWelcome(options: { root: string; workspaceCount: number; liveRuns: number }): string[] {
  return [
    `${ui.bold}${ui.accent}mocode supervisor${ui.reset}  ${ui.dim}编排对话：派活 / 查进度 / 收工${ui.reset}`,
    '',
    `${ui.dim}  cwd        ${ui.reset}${options.root}`,
    `${ui.dim}  workspaces ${ui.reset}${options.workspaceCount} 个（supervise_workspaces 看全量）`,
    `${ui.dim}  live runs  ${ui.reset}${options.liveRuns} 个`,
    '',
    `${ui.dim}  直接说你要什么，例如：「在 MemoryBear 里把 README 的三个过期段落更新掉」${ui.reset}`,
    `${ui.dim}  输出时可 PgUp/PgDn · ↑↓ · 滚轮回看；运行中可直接打下一句，Enter 排队${ui.reset}`,
    `${ui.dim}  /status /approvals /approve /runs /workspaces /help /exit${ui.reset}`,
    '',
  ];
}

/** 本地斜杠命令（不进模型）。返回 'handled' / 'exit' / 'none'。 */
export type LocalCommandResult = { kind: 'handled'; output: string } | { kind: 'exit' } | { kind: 'none' };

export function handleLocalCommand(line: string, supervisor: SupervisorRuntime): LocalCommandResult {
  const [cmd] = line.trim().split(/\s+/);
  switch (cmd) {
    case '/exit':
    case '/quit':
      return { kind: 'exit' };
    case '/help':
      return {
        kind: 'handled',
        output:
          '直接说任务即可：我会拆活、派给隔离 lane 里的 mocode worker、盯着进度、跑完再问你要不要合回工作区。\n' +
          '/status [run-id]  编排状态（省略 run id 列在跑的）\n' +
          '/approvals        待决的人工介入（Worker 在等你回答）\n' +
          '/approve <n|id> <选项|cancel>  直接回答（不必经过模型）\n' +
          '/runs             各工作区最近的 Run\n' +
          '/workspaces       这台机器上跑过 mocode 的工作区\n' +
          '运行中：PgUp/PgDn 翻页 · ↑↓ 或滚轮回看 · 直接打字排队下一句 · Ctrl+G 多行 · Ctrl+C 中断\n' +
          '/exit             退出（后台 Run 不停，稍后 `mocode supervise resume <run-id>` 续）',
      };
    case '/status':
      return { kind: 'handled', output: supervisor.status(line.trim().split(/\s+/)[1]) };
    case '/approvals':
      return { kind: 'handled', output: supervisor.formatApprovals() };
    case '/approve': {
      // 本地直答：不占模型一轮，也不允许模型替人拍板敏感动作。
      const parts = line.trim().split(/\s+/).slice(1);
      const target = parts[0];
      const value = parts.slice(1).join(' ').trim();
      if (!target || !value) return { kind: 'handled', output: '用法：/approve <序号或 approvalId> <选项文本|cancel>' };
      const action = value === 'cancel' || value === 'cancelled' ? 'cancelled' : 'selected';
      return {
        kind: 'handled',
        output: supervisor.answerApproval(target, action, action === 'cancelled' ? undefined : value),
      };
    }
    case '/runs': {
      const rows = supervisor
        .recentRuns(3)
        .map(({ run, workspaceRoot }) => `${run.id}  ${run.status.padEnd(14)}${workspaceRoot}  ${run.objective}`);
      return { kind: 'handled', output: rows.length > 0 ? rows.join('\n') : '还没有任何编排 Run。' };
    }
    case '/workspaces':
      return { kind: 'handled', output: supervisor.formatWorkspaces() };
    default:
      return { kind: 'none' };
  }
}

/** 把 `tools` 转成 OpenAI schema 列表（与 run-coordinator 里同一套映射）。 */
function schemasOf(tools: readonly Tool[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function echoUser(lines: readonly string[]): void {
  const cols = layout.getGeo().cols;
  const text = lines
    .map((line, index) => {
      const full = `${index === 0 ? PROMPT : '  '}${line}`;
      return `${ui.userBg}${padEndDisplay(full, cols)}${ui.reset}`;
    })
    .join('\n');
  layout.contentWrite(`${text}\n\n`);
}

/**
 * 进入 supervisor 对话。返回进程退出码。
 * 非 TTY：不启动（对话模式需要真实终端），提示改用 CLI 子命令。
 */
export async function runSupervisorChat(options: SupervisorChatOptions): Promise<number> {
  if (!stdout.isTTY || !stdin.isTTY) {
    stdout.write(
      'mocode supervise (no command) is an interactive supervisor chat and needs a TTY.\n' +
        'For scripts use: mocode supervise start|dispatch|status|watch ...\n',
    );
    return 1;
  }

  const supervisor = new SupervisorRuntime({
    root: options.root,
    scanRoots: options.scanRoots,
    onNotice: writeNotice,
    worker: options.worker,
    // 默认开窗（可用 --no-terminal / MOCODE_SUPERVISE_NO_TERMINAL=1 关）：
    // 「执行画面进独立终端」是入口的默认体验，库对象自己不做这个决定。
    watchTerminals: options.watchTerminals ?? terminalAutoOpenEnabled(),
    ...(options.openTerminal ? { openTerminal: options.openTerminal } : {}),
  });
  const tools = createSupervisorTools(supervisor);
  const toolSchemas = schemasOf(tools);
  const allowed = new Set(tools.map((tool) => tool.name));

  // 独立 Runtime：自己的工具表（只有控制面工具）、自己的会话目录（supervisor cwd 下）。
  const context = createAgentRuntimeContext({
    tools,
    sandboxRoot: options.root,
    initialMode: 'auto',
  });
  const runtime: Runtime = createRuntime({ context });
  await runtime.start();
  const sessionId = runtime.session.create();

  const workspaces = supervisor.workspaces({ includeSessions: false });
  const history: ChatMessage[] = [
    {
      role: 'system',
      content: buildSupervisorPrompt({ root: options.root, workspaceCount: workspaces.length }),
    },
  ];
  /** Ctrl+R / Ctrl+P 历史搜索候选：当前对话发过的句子（不进模型）。 */
  const queryHistory: string[] = [];

  let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  /**
   * 最近一条执行态消息（`activity` 通道）。只占底栏一行，**不进正文**——
   * Worker 每几百毫秒来一条 `tool: read_file`，写进正文就是刷屏。
   */
  let latestActivity: { taskId: string; text: string } | undefined;

  /**
   * 状态行右段：在跑的 Run 数 + 待决审批数 + 最近一条执行态。
   *
   * 编排状态占的是「context 进度条」那个位置——supervisor 的对话本身很短，一个恒 0% 的
   * 上下文条毫无信息量；而「几个 Run 在跑、有几个审批在等人、最近在干什么」正是这个界面
   * 唯一需要盯的东西。审批用黄：它是唯一「没人动就一直停着」的状态。
   */
  const statusChips = (): string => {
    const runs = supervisor.liveRuns().length;
    const approvals = supervisor.pendingApprovals().length;
    const runChip = `${ui.dim}${runs} run${runs === 1 ? '' : 's'}${ui.reset}`;
    const approvalChip =
      approvals > 0 ? ` ${ui.yellow}? ${approvals} approval${approvals === 1 ? '' : 's'}${ui.reset}` : '';
    const activityChip = latestActivity
      ? ` ${ui.dim}◐ ${latestActivity.taskId} ${truncateDisplay(latestActivity.text, 36)}${ui.reset}`
      : '';
    return `${runChip}${approvalChip}${activityChip}`;
  };

  const refreshStatusBase = (): void => {
    layout.setStatusBase({
      model: config.model,
      contextBar: statusChips(),
      cwd: options.root,
      modeTag: 'Supervisor',
      // 这里没有 auto/plan 切换:留着默认提示也只会让人去按一个没反应的键。
      modeHint: '',
      lastTurnUsage: lastUsage,
    });
  };

  /**
   * 后台通知分两个通道落地：
   *   - `event`（任务开始/完成/失败/审批/收尾）→ 对话正文，人需要读；
   *   - `activity`（thinking / tool: xxx）→ 只更新底栏那一行。
   * 混在一起就是「执行画面刷屏」，也是独立终端窗口存在的理由。
   */
  function writeNotice(notice: SupervisorNotice): void {
    if (notice.channel === 'activity') {
      latestActivity = { taskId: notice.taskId ?? '', text: notice.text };
      refreshStatusBase();
      layout.drawStatusBar();
      return;
    }
    const color = notice.level === 'error' ? ui.yellow : ui.dim;
    layout.contentWrite(`${color}  ↳ [${notice.runId}] ${notice.text}${ui.reset}\n`);
  }

  layout.enterAltScreen();
  refreshStatusBase();
  layout.writeWelcomeBlock(
    supervisorWelcome({
      root: options.root,
      workspaceCount: workspaces.length,
      liveRuns: supervisor.liveRuns().length,
    }),
  );

  let hasSubmitted = false;
  let pendingPrefill: string[] | null = null;
  try {
    for (;;) {
      // 运行态打开的 Ctrl+G 面板可能在本轮结束时仍开着：等它关闭再进 INPUT 态，
      // 否则两个 keypress 监听抢键（面板内容随后经 getRunningInput 预填）。
      await waitForRunningComposer();

      // 运行中按 Enter 排队的句子：agent 一结束就自动发送，跳过输入框（入队那一刻即已确认）。
      // 斜杠命令不静默执行（否则排队 /exit 会在用户没看着时触发），改为填回输入框等确认。
      const queued = consumeQueuedTurn();
      let input: string[] | null = null;
      let autoSend = false;
      if (queued && queued.text.trim().length > 0) {
        if (queued.text.trim().startsWith('/')) {
          pendingPrefill = queued.text.split('\n');
        } else {
          input = queued.text.split('\n');
          autoSend = true;
          // 排队时仍在输入框草稿里的字（typeahead）不能丢：回填为下一轮预填。
          if (getRunningInput().trim()) pendingPrefill = [getRunningInput()];
          clearRunningInput();
        }
      }

      if (!autoSend) {
        if (hasSubmitted) layout.normalizeInputBoundary();
        layout.enterInputMode('supervisor 待命');
        try {
          input = await promptWithSlashMenu({
            prompt: PROMPT,
            commands: supervisorCommands(),
            history: () => collectQueryHistory(queryHistory).map((entry) => entry.text),
            // 预填：待确认的排队斜杠命令优先，否则运行中打的字。
            ...(pendingPrefill
              ? { initialLines: pendingPrefill }
              : getRunningInput()
                ? { initialLines: [getRunningInput()] }
                : {}),
          });
        } catch {
          break; // Ctrl+C / Ctrl+D
        }
        pendingPrefill = null;
        // 预填已消费：不清会一直重填同一段（主 REPL 同款约定）。
        clearRunningInput();
      }

      if (input === null) break;
      const line = input.join('\n').trim();
      if (!line) continue;
      hasSubmitted = true;
      layout.dismissWelcomeBlock();
      queryHistory.push(line);

      const local = handleLocalCommand(line, supervisor);
      if (local.kind === 'exit') break;
      if (local.kind === 'handled') {
        echoUser(input);
        layout.contentWrite(`${local.output.endsWith('\n') ? local.output : `${local.output}\n`}`);
        layout.contentWrite('\n');
        refreshStatusBase();
        continue;
      }

      echoUser(input);
      // 运行态：底栏 spinner + 走时。滚动回看 / 滚轮 / typeahead / Ctrl+G / Ctrl+C 全交给
      // startRunningListener——supervisor 自己只描述「这轮在干什么」。
      layout.enterRunningMode('supervisor 正在编排…', RUNNING_PLACEHOLDER);
      const signal = startRunningListener(RUNNING_PLACEHOLDER);

      const hooks: AgentHooks = {
        onStepStart: () => layout.setStatus('supervisor 思考中'),
        onText: (delta) => layout.contentWriteMd(delta),
        onLiveUsage: (usage) => layout.setLiveUsage(usage),
        onToolHeader: (call) => {
          layout.setStatus(`supervisor · ${call.name}`);
          layout.contentWrite(
            `  ${ui.accent}●${ui.reset} ${ui.bold}${call.name}${ui.reset} ${ui.dim}${summarizeToolCall(call.name, call.arguments)}${ui.reset}\n`,
          );
        },
        onToolResult: (_call, output) => {
          const first = output.split('\n').find((item) => item.trim().length > 0) ?? '';
          const text = first.length > 120 ? `${first.slice(0, 117)}…` : first;
          if (text) layout.contentWrite(`    ${ui.dim}→ ${text}${ui.reset}\n`);
        },
        onToolBatchEnd: () => {
          layout.contentWrite('\n');
          // 工具跑完是最便宜的刷新点：派活/收工都会改变 Run 与审批计数，用户看着底栏就知道进展。
          refreshStatusBase();
          layout.drawStatusBar();
        },
        onModelRetry: (info) =>
          layout.contentWrite(`${ui.dim}  retry ${info.nextAttempt} in ${info.waitMs}ms${ui.reset}\n`),
        onAbort: () => layout.contentWrite(`${ui.dim}  (interrupted)${ui.reset}\n`),
      };

      try {
        const result = await runtime.run({
          turn: 'new',
          turnLabel: line.split('\n')[0]?.slice(0, 40),
          history,
          userInput: line,
          hooks,
          signal,
          toolsOverride: toolSchemas,
          runtimeAllowedToolNames: allowed,
          // 编排快照走 ephemeral 段：每轮重新生成、不写回 history，历史里不留过期快照。
          memoryRecall: supervisor.snapshot(),
          suppressSessionState: true,
        });
        lastUsage = result.usage;
      } catch (error) {
        if (signal.aborted) {
          layout.contentWrite(`${ui.dim}  (interrupted)${ui.reset}\n`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          layout.contentWrite(`${ui.red}supervisor error${ui.reset} ${message}\n`);
        }
      } finally {
        stopRunningListener();
        layout.setLiveUsage(undefined);
      }

      try {
        runtime.session.save(history, sessionId, queryHistory);
      } catch {
        // 落盘失败不阻断对话
      }
      refreshStatusBase();
      layout.drawStatusBar();
      layout.contentWrite('\n');
    }
  } finally {
    // 只交还控制器租约：在跑的 Run 留在盘上，`mocode supervise resume <id>` 可续。
    supervisor.shutdown();
    await runtime.close();
  }
  return 0;
}
