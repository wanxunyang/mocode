// Lane 与 supervisor 之间的文件通道。
//
// 为什么需要文件而不是 stdio：派出去的 worker 现在就是**一个真的 mocode REPL**（同款 TUI、同款输入框），
// 它必须独占 stdin/stdout 才能跟人交互。于是控制面与它之间只能走旁路文件：
//
//   lane.commands   supervisor → lane  （派活 / 插话：一行一条 NDJSON 指令）
//   lane.events     lane → supervisor  （ready / turn.started / turn.finished / exit）
//
// 与上一版 live.log 的区别：这里**不再**镜像 worker 的执行画面。画面就在那个终端里，人能直接看、
// 直接打字；控制面只关心「这一轮跑完了没有、结论是什么」。少一条正文级事件流，少一套只读面板。
//
// 为什么按 lane 而不是按 task 分文件：一个 lane 就是一个长驻的 REPL 进程（会话有状态），
// 后续任务续接同一进程，通道自然也是这条 lane 的。task 的身份通过指令/事件里的 `id` 携带。

import fs from 'node:fs';
import path from 'node:path';

/** supervisor → lane：一条要执行的话。`id` 由 supervisor 生成，事件会原样带回。 */
export interface LaneCommand {
  t: number;
  id: string;
  /** 派活时的任务 id（同一 lane 里逐条任务）；插话时等于当前任务或 `tell-*`。 */
  taskId?: string;
  text: string;
  /** 派活 = task（跑完要收 handoff），插话 = tell（不产生交接）。 */
  kind: 'task' | 'tell';
}

/** lane → supervisor：生命周期与逐轮结论。 */
export type LaneEvent =
  | {
      t: number;
      kind: 'ready';
      pid?: number;
      sessionId?: string;
      workspacePath?: string;
      /** 本次窗口拉起的唯一标记：控制面只认自己那次 ready（旧进程的 ready 已经过期）。 */
      launch?: string;
    }
  | { t: number; kind: 'turn.started'; id: string }
  | {
      t: number;
      kind: 'turn.finished';
      id: string;
      outcome: 'completed' | 'failed' | 'interrupted';
      summary: string;
      error?: string;
    }
  | { t: number; kind: 'exit'; reason?: string };

export interface LaneChannelPaths {
  /** lane → supervisor */
  events: string;
  /**
   * supervisor → lane 的「请优雅关窗」信号（文件存在 = 请求退出）。
   *
   * 为什么不用 lane.commands 表达：指令会被输入框当成一轮对话消费，而关窗不是要 agent 干活。
   * 为什么必须是协作式而不是 `process.kill`：Windows 上 process.kill 走 TerminateProcess，
   * 目标进程拿不到任何执行清理代码的机会（exit / SIGTERM 处理器都不跑），于是 alt screen、
   * 鼠标追踪、raw mode、DECSTBM margins 全部留在终端里——表现就是「进程已退出，画面还在，
   * 滚轮翻不动，点哪都没反应」。
   */
  stop: string;
  /** supervisor → lane */
  commands: string;
}

/**
 * 只算路径，不建目录。
 *
 * 放在 `<workspace>/.mocode/orchestrations/<run>/artifacts/lanes/<lane>/` 下，与 lane.patch /
 * session 归档同处一地：一次 Run 的全部产物在一个目录里，事后排查不用四处找。
 */
export function laneChannelPaths(workspaceRoot: string, runId: string, laneId: string): LaneChannelPaths {
  const dir = path.join(path.resolve(workspaceRoot), '.mocode', 'orchestrations', runId, 'artifacts', 'lanes', laneId);
  return {
    events: path.join(dir, 'lane.events'),
    commands: path.join(dir, 'lane.commands'),
    stop: path.join(dir, 'lane.stop'),
  };
}

/** 解析一段 NDJSON；写到一半的坏行跳过（下一轮再读），不当错误。 */
export function parseJsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // 尾部半行：writer 正在追加，留给下一轮
    }
  }
  return out;
}

/**
 * 逐行读一个文件，只返回 `consumed` 之后**完整**的行。
 *
 * 用行数而不是字节做游标：这两条通道的行都很短（指令/事件），频率也低（一次任务几行），
 * 按行便宜且天然不怕尾部半行。`split('\n')` 的最后一个元素永远是没有结尾换行的那段，
 * 文件以 \n 结尾时是空串、否则是正在写的半行——两种都不该被消费。
 */
export function readLinesFrom(file: string, consumed: number): { lines: string[]; consumed: number } {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { lines: [], consumed };
  }
  const complete = content.split('\n').slice(0, -1);
  const pending = complete.slice(consumed);
  return { lines: pending, consumed: consumed + pending.length };
}

/** 增量读通道文件里的结构化条目。 */
export function readChannel<T>(file: string, consumed: number): { items: T[]; consumed: number } {
  const read = readLinesFrom(file, consumed);
  return { items: parseJsonLines<T>(read.lines.join('\n')), consumed: read.consumed };
}

function appendLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

/** supervisor 侧：投一条指令。 */
export function appendLaneCommand(paths: LaneChannelPaths, command: LaneCommand): void {
  appendLine(paths.commands, command);
}

/** lane 侧：报一条事件。写失败不影响正在跑的这一轮（日志是旁路）。 */
export function appendLaneEvent(paths: LaneChannelPaths, event: LaneEvent): void {
  try {
    appendLine(paths.events, event);
  } catch {
    // 通道不可写（权限/磁盘）不该让对话崩掉；下一轮事件仍会尝试。
  }
}

/** 通道重置：新的 lane 进程接手时清掉上一轮的残留事件（指令保留，未消费的仍该被执行）。 */
export function resetLaneEvents(paths: LaneChannelPaths): void {
  try {
    fs.mkdirSync(path.dirname(paths.events), { recursive: true });
    fs.writeFileSync(paths.events, '', 'utf8');
  } catch {
    // 同上：写不进去不影响主流程
  }
  // 上一次窗口留下的关闭请求必须清掉，否则新窗口一起来就会立刻自尽。
  clearLaneStop(paths);
}

/** supervisor 侧：请求 lane 优雅关窗（走 REPL 自己的退出路径，能正确复原终端）。 */
export function requestLaneStop(paths: LaneChannelPaths, reason = 'stop requested'): void {
  try {
    fs.mkdirSync(path.dirname(paths.stop), { recursive: true });
    fs.writeFileSync(paths.stop, JSON.stringify({ t: Date.now(), reason }), 'utf8');
  } catch {
    // 写不进去就让调用方退到硬杀
  }
}

/** lane 侧：有没有人请求关窗。 */
export function laneStopRequested(paths: LaneChannelPaths): boolean {
  try {
    fs.accessSync(paths.stop);
    return true;
  } catch {
    return false;
  }
}

/** 清掉关闭请求（开新窗口前 / 窗口已退出后）。 */
export function clearLaneStop(paths: LaneChannelPaths): void {
  try {
    fs.rmSync(paths.stop, { force: true });
  } catch {
    // 忽略
  }
}
