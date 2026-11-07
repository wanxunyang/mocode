// `supervise lane`：在 lane 的执行目录里跑一个**真的 mocode REPL**。
//
// 这是整条设计的核心：派出去的 worker 不是"另一个东西"，就是 mocode 本体——同一套 TUI、
// 同一个输入框、同一套斜杠命令。人可以在那个窗口里直接打字，supervisor 也可以经
// lane.commands 派活；两者是同一个输入框的两个来源，语义完全一致。
//
// 因此这里只做三件不属于 REPL 的事：
//   1. 把 cwd / 沙箱根 / 会话目录切到 lane 的执行现场（否则会话会落进别的工作区）；
//   2. 把 lane 的会话读回来（同一个 lane 的后续任务续接同一段对话）；
//   3. 接上 lane.events / lane.commands 这两个旁路文件（stdin/stdout 归 TUI，不能被动）。
//
// 不做的：不镜像画面（画面就是这个终端）、不改 UI（任何画屏代码都会让"看起来跟手敲 mocode
// 不一样"）、不新增命令（斜杠命令树仍由主 REPL 提供）。

import fs from 'node:fs';
import {
  appendLaneEvent,
  laneChannelPaths,
  laneStopRequested,
  readChannel,
  resetLaneEvents,
  type LaneCommand,
} from './lane-channel.js';
import { OrchestrationStore } from './store.js';
import { switchWorkspaceRoot } from '../workspace/index.js';
import { exitAltScreen } from '../ui/layout.js';
import { setHandoffDisplaySuppressed } from '../ui/handoff-block.js';

export interface LaneReplOptions {
  workspaceRoot: string;
  runId: string;
  laneId: string;
  /** 本次窗口拉起的标记（由 supervisor 生成）；ready 事件原样带回，用来区分"我这次开的窗口"。 */
  launch?: string;
  /** 命令通道轮询间隔；默认 400ms，与输入框的第二输入源轮询同量级。 */
  pollMs?: number;
  /**
   * 看到 stop 信号后，最多再等多久就强制复原终端并退出；默认 8s。
   *
   * 为什么要有这个兜底：输入框的关窗轮询只在空闲时生效，正在跑一轮时轮不到它，
   * 而控制面的宽限期（`stopGraceMs`，默认 15s）一到就硬杀——终端会烂在 alt screen 里。
   * 8s < 15s，保证我们总是先于硬杀自己收场。
   */
  stopFallbackMs?: number;
}

export interface LaneReplTarget {
  execPath: string;
  sessionId?: string;
  paths: ReturnType<typeof laneChannelPaths>;
}

/**
 * 解析一个 lane 的执行现场与通道路径（不产生副作用，CLI 与执行器都可复用）。
 * lane 还没开过现场时回落到工作区根（inplace 语义）。
 */
export function resolveLaneTarget(workspaceRoot: string, runId: string, laneId: string): LaneReplTarget {
  const store = OrchestrationStore.load(workspaceRoot, runId);
  const run = store.current;
  const lane = run.lanes[laneId];
  if (!lane) throw new Error(`run ${runId} has no lane ${laneId}.`);
  const execPath = lane.worktreePath ?? lane.workspaceRoot ?? run.workspaceRoot;
  return { execPath, sessionId: lane.sessionId, paths: laneChannelPaths(run.workspaceRoot, run.id, lane.id) };
}

/**
 * 跑一个 lane REPL，直到人退出（`/exit` / `Ctrl+D`）。
 *
 * 返回值只表示"这个窗口结束了"，不代表任务成败——任务成败由 turn.finished 事件上报，
 * 控制面据此记账。
 */
export async function runLaneRepl(options: LaneReplOptions): Promise<number> {
  const workspaceRoot = options.workspaceRoot;
  const target = resolveLaneTarget(workspaceRoot, options.runId, options.laneId);
  // ① 现场三单例：chdir + sandboxRoot + sessionDir。只改其中一处会留半个工作区
  // （文件读写走 lane，会话却写回主工作区），这是 /cd 早就踩过的坑。
  if (fs.existsSync(target.execPath)) switchWorkspaceRoot(target.execPath);
  const paths = target.paths;
  resetLaneEvents(paths);

  const exit = (reason: string): void => {
    appendLaneEvent(paths, { t: Date.now(), kind: 'exit', reason });
  };

  try {
    // ② 续接 lane 的会话。会话目录必须已经切到 lane 现场，所以这里动态 import：
    // session store 在模块加载时就会读 config.sessionDir。
    const { loadSession } = await import('../session/index.js');
    const loaded = target.sessionId ? loadSession(target.sessionId, { restoreAssets: true }) : null;

    /** 已从通道取出、等待 REPL 空闲消费的指令（FIFO）。 */
    const queue: LaneCommand[] = [];
    /** 正在执行的那条指令；REPL 一次只跑一轮，所以它最多一个。 */
    let active: LaneCommand | undefined;
    let consumed = 0;
    let poller: NodeJS.Timeout | undefined;

    const drain = (): void => {
      const read = readChannel<LaneCommand>(paths.commands, consumed);
      consumed = read.consumed;
      for (const command of read.items) {
        if (!command || typeof command.text !== 'string') continue;
        queue.push(command);
      }
    };
    // 启动前先吃一遍：supervisor 可能在窗口起来之前就投了指令。
    drain();
    poller = setInterval(drain, options.pollMs ?? 400);
    poller.unref?.();

    // 关窗的兜底通道（与输入框的空闲轮询互补）。
    //
    // 输入框那条 externalExitRequested 只在**空闲**时被问到：正在跑一轮、或输入面板占着键时
    // 根本轮不到它。而控制面的宽限期一到就会硬杀，于是终端照样烂在 alt screen 里。
    // 这里不看 REPL 状态，只认「stop 信号挂了这么久还没退出」这一个事实。
    let stopSince: number | undefined;
    const stopWatchdog = setInterval(
      () => {
        if (!laneStopRequested(paths)) {
          stopSince = undefined;
          return;
        }
        stopSince ??= Date.now();
        if (Date.now() - stopSince < (options.stopFallbackMs ?? 8_000)) return;
        // 走不到正常退出路径时，至少把终端复原再退——绝不把 alt screen 留给用户。
        // 先报 exit：控制面据此知道是「响应了请求」，而不是把我们当卡死硬杀。
        exit('stop request forced the window to close');
        exitAltScreen();
        process.exit(0);
      },
      Math.max(options.pollMs ?? 400, 200),
    );
    stopWatchdog.unref?.();

    const { startRepl } = await import('../repl/index.js');
    // 这个进程就是「派出去的那个 mocode」：模型收尾时按协议吐的 `<mocode_handoff>` 块
    // 只在显示层摘掉，`finalText` 保持完整，控制面照旧解析入账。
    // 手敲 `mocode` 的窗口永远不开这个开关（默认 false）。
    setHandoffDisplaySuppressed(true);
    await startRepl(
      loaded?.history,
      loaded?.id ?? target.sessionId,
      target.execPath,
      loaded?.queryHistory,
      loaded?.lastToolGroups,
      {
        // 第二输入源：只有输入框为空时才取，人正在打字时绝不抢字。
        takeExternalTurn: () => {
          if (active) return null;
          const command = queue.shift();
          if (!command) return null;
          active = command;
          appendLaneEvent(paths, { t: Date.now(), kind: 'turn.started', id: command.id });
          return command.text;
        },
        onTurnFinished: ({ ok, finalText }) => {
          if (!active) return; // 人自己打的字：不是派活，不产生交接
          const command = active;
          active = undefined;
          const summary = (finalText ?? '').trim();
          appendLaneEvent(paths, {
            t: Date.now(),
            kind: 'turn.finished',
            id: command.id,
            outcome: ok ? 'completed' : 'failed',
            summary,
            ...(ok ? {} : { error: summary ? summary.split('\n')[0] : 'The turn ended without a final answer.' }),
          });
        },
        // 关窗走这里，不走 process.kill：kill 在 Windows 上是 TerminateProcess，目标进程
        // 拿不到执行清理代码的机会，终端会烂在 alt screen 里（画面还在、滚轮翻不动）。
        // 这里返回 true 后输入框按 Ctrl+D 处理，REPL 顺着正常退出路径复原终端。
        externalExitRequested: () => laneStopRequested(paths),
        onReady: ({ sessionId }) => {
          appendLaneEvent(paths, {
            t: Date.now(),
            kind: 'ready',
            pid: process.pid,
            ...(sessionId ? { sessionId } : {}),
            workspacePath: target.execPath,
            ...(options.launch ? { launch: options.launch } : {}),
          });
        },
      },
    );
    if (poller) clearInterval(poller);
    poller = undefined;
    clearInterval(stopWatchdog);
    exit('lane repl exited');
    return 0;
  } catch (error) {
    exit(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
