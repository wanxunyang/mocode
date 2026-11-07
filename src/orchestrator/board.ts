// 监管工作台的数据层：把「这机器上有哪些工作区 × 每个工作区里有哪些 Run/lane」
// 收成一份扁平的、可渲染的快照。
//
// 读盘策略：只在面板需要时才读，且**优先读 snapshot.json**（原子写、已归约好的完整状态），
// 不重放 events.jsonl。重放是 append-only 账本的真相源，但一次面板刷新要跑几十个 Run 时
// 重放会把每次刷新变成 O(全部事件)，而面板每秒都要刷。`OrchestrationStore.load` 留给定点
// 排查（snapshot 缺失或损坏时作为回退）。
//
// 渲染拆成纯函数（`renderBoard`），面板循环只负责键位与定时器，因此配色/截断/空态都能单测。

import fs from 'node:fs';
import path from 'node:path';
import { ui } from '../ui/theme.js';
import { ansiDisplayWidth, truncateAnsi } from '../ui/render.js';
import { orchestrationRoot } from './store.js';
import type { WorkspaceInfo } from './workspaces.js';
import type { OrchestrationLane, OrchestrationRun, OrchestrationTask } from './types.js';

/** 面板里一条 lane 的即时状态，只保留「监管要看」的字段。 */
export interface BoardLane {
  runId: string;
  laneId: string;
  /** 执行档位：worktree / copy / inplace。 */
  mode: string;
  /** 实际的执行目录（worktree 路径 / 副本 / 原目录）；lane 还没打开时为空。 */
  executionRoot?: string;
  state: 'open' | 'closed';
  /** 当前正在跑的任务 id（没有则取最近一个已完成/失败的任务）。 */
  taskId?: string;
  taskStatus?: string;
  /** 最近一条进度消息（`thinking` / `tool: read_file` …）。 */
  lastEvent?: string;
  sessionId?: string;
  /** Run 停在 awaiting_user 时的原因：工作台必须能回答「为什么在等」。 */
  awaitingReason?: string;
  done: number;
  total: number;
  closedReason?: string;
  error?: string;
  /** 这条 lane 上待人回答的人工介入（工具审批 / Worker 提问）；空 = 没人在等。 */
  pendingApprovals: Array<{ id: string; kind: string; title: string }>;
  /** Worker 在 handoff 里写下的风险：控制面不展示就等于被吞掉。 */
  risks: string[];
}

export interface BoardRun {
  id: string;
  status: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  lanes: BoardLane[];
  awaitingReason?: string;
}

export interface BoardWorkspace {
  root: string;
  name: string;
  exists: boolean;
  git: boolean;
  branch?: string;
  dirty?: boolean;
  sessionCount: number;
  latestSession?: string;
  runs: BoardRun[];
}

export interface BoardSnapshot {
  collectedAt: string;
  workspaces: BoardWorkspace[];
  /** 有任务在跑的 lane 数 / 全部活着的 lane 数。 */
  busy: number;
  live: number;
  /** 读盘失败的 Run（损坏账本不阻断面板，但要能看见）。 */
  broken: number;
}

export interface CollectBoardOptions {
  /** 已知工作区（通常含 cwd）。 */
  workspaces: readonly WorkspaceInfo[];
  /** 每个工作区最多显示多少个 Run（按创建时间倒序）；默认 3。 */
  maxRunsPerWorkspace?: number;
  /** 是否保留终态 Run（默认 false：工作台关注「还在动的」）。 */
  includeTerminal?: boolean;
  /**
   * 是否保留已不存在的目录（默认 false）。注册表只增不删，长期使用后会堆一批
   * 已被删掉的临时工作区；它们在面板上只能占位，看不到任何 Run。
   */
  includeMissing?: boolean;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function laneFromRun(run: OrchestrationRun, lane: OrchestrationLane): BoardLane {
  const tasks = Object.values(run.tasks ?? {}).filter((task) => (task.lane ?? task.id) === lane.id);
  const done = tasks.filter((task) => task.status === 'completed').length;
  // 「当前」优先取仍在跑的；否则取最新结束的那条，让面板始终有可读的上下文。
  const active = tasks.find((task) => task.status === 'running' || task.status === 'dispatching');
  const latest = [...tasks].sort((a, b) => finishKey(b).localeCompare(finishKey(a)))[0];
  const shown: OrchestrationTask | undefined = active ?? latest;
  // 待决审批与风险都扫整条 lane 的任务，而不是只看当前那条：
  // 「刚跑完的那条留了个风险，下一条已经在跑」是最需要被看见的情形。
  const pendingApprovals = tasks.flatMap((task) =>
    Object.values(task.approvals ?? {})
      .filter((approval) => !approval.resolved)
      .map((approval) => ({ id: approval.id, kind: approval.kind, title: approval.title })),
  );
  const risks = tasks.flatMap((task) => task.output?.risks ?? []);
  return {
    runId: run.id,
    laneId: lane.id,
    mode: lane.mode ?? 'worktree',
    executionRoot: lane.worktreePath,
    state: lane.closed ? 'closed' : 'open',
    taskId: shown?.id,
    taskStatus: shown?.status,
    lastEvent: shown?.lastEvent,
    sessionId: lane.sessionId ?? shown?.sessionId,
    awaitingReason: run.status === 'awaiting_user' ? run.awaitingReason : undefined,
    done,
    total: tasks.length,
    closedReason: lane.closed?.reason,
    error: lane.closed?.error,
    pendingApprovals,
    risks,
  };
}

function finishKey(task: OrchestrationTask): string {
  return task.finishedAt ?? task.startedAt ?? '';
}

/** 快路径：snapshot.json 与 events 账本同源（每次 append 后原子重写），损坏时才回退重放。 */
function readRunSnapshot(directory: string): OrchestrationRun | undefined {
  const file = path.join(directory, 'snapshot.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as OrchestrationRun;
    // 只做形状最低校验：真正的合法性由 events 决定，这里只防「野 JSON」把面板画崩。
    if (!parsed || typeof parsed.id !== 'string' || !parsed.tasks || typeof parsed.status !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function loadRuns(root: string, options: CollectBoardOptions): { runs: BoardRun[]; broken: number } {
  const dir = orchestrationRoot(root);
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { runs: [], broken: 0 };
  }
  const runs: BoardRun[] = [];
  let broken = 0;
  for (const name of names) {
    const run = readRunSnapshot(path.join(dir, name));
    if (!run) {
      // 没有 snapshot 只有 events 的 P1 现场：面板不当它坏盘，只是这次不显示。
      if (fs.existsSync(path.join(dir, name, 'events.jsonl'))) broken++;
      continue;
    }
    if (!options.includeTerminal && TERMINAL.has(run.status)) continue;
    runs.push({
      id: run.id,
      status: run.status,
      objective: run.objective,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      awaitingReason: run.awaitingReason,
      lanes: Object.values(run.lanes ?? {}).map((lane) => laneFromRun(run, lane)),
    });
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = options.maxRunsPerWorkspace ?? 3;
  return { runs: runs.slice(0, limit), broken };
}

/** 汇总整机快照。只读，纯 IO，不碰账本、不抢控制器锁。 */
export function collectBoard(options: CollectBoardOptions): BoardSnapshot {
  const workspaces: BoardWorkspace[] = [];
  let busy = 0;
  let live = 0;
  let broken = 0;
  for (const info of options.workspaces) {
    if (!info.exists && options.includeMissing !== true) continue;
    const loaded = info.exists ? loadRuns(info.root, options) : { runs: [], broken: 0 };
    broken += loaded.broken;
    for (const run of loaded.runs) {
      // 终态 Run 的 lane 即使没显式 close 也不再"活着"——Run 已经结束了，没人会往里派活。
      const runAlive = !TERMINAL.has(run.status);
      live += runAlive ? run.lanes.filter((lane) => lane.state === 'open').length : 0;
      busy += run.lanes.filter((lane) => lane.taskStatus === 'running' || lane.taskStatus === 'dispatching').length;
    }
    workspaces.push({
      root: info.root,
      name: info.name,
      exists: info.exists,
      git: info.git,
      branch: info.branch,
      dirty: info.dirty,
      sessionCount: info.sessions.length,
      latestSession: info.sessions[0]?.id,
      runs: loaded.runs,
    });
  }
  // 有活的排前面：工作台第一眼要看到正在动的东西，而不是按路径字母序。
  const activity = (workspace: BoardWorkspace): number =>
    workspace.runs.reduce((sum, run) => sum + run.lanes.filter((lane) => lane.taskStatus === 'running').length, 0);
  workspaces.sort(
    (a, b) => activity(b) - activity(a) || Number(b.exists) - Number(a.exists) || a.root.localeCompare(b.root),
  );
  return { collectedAt: new Date().toISOString(), workspaces, busy, live, broken };
}

// ── 扁平行（选择器用） ───────────────────────────────────────────────────────

export interface BoardRow {
  kind: 'workspace' | 'lane';
  workspaceRoot: string;
  /** kind === 'lane' 时有值。 */
  runId?: string;
  laneId?: string;
}

/** 把树拍平成可上下移动的行；工作区标题行也可选中（用于看该工作区的汇总）。 */
export function boardRows(board: BoardSnapshot): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const workspace of board.workspaces) {
    rows.push({ kind: 'workspace', workspaceRoot: workspace.root });
    for (const run of workspace.runs) {
      for (const lane of run.lanes) {
        rows.push({ kind: 'lane', workspaceRoot: workspace.root, runId: run.id, laneId: lane.laneId });
      }
    }
  }
  return rows;
}

// ── 渲染（纯函数） ───────────────────────────────────────────────────────────

export interface RenderBoardOptions {
  cols: number;
  rows: number;
  /** 选中行的下标（对应 boardRows 的顺序）。 */
  selected: number;
}

export interface RenderedBoard {
  lines: string[];
  /** 选中行在 lines 中的下标（用于把窗口滚到它）。 */
  selectedLine: number;
  rows: BoardRow[];
}

const LANE_GLYPH: Record<string, string> = {
  running: '▶',
  dispatching: '▶',
  completed: '✓',
  failed: '!',
  interrupted: '!',
  cancelled: '×',
  pending: '○',
  ready: '○',
};

function statusColor(status: string | undefined): string {
  if (status === 'running' || status === 'dispatching') return ui.green;
  if (status === 'failed' || status === 'interrupted') return ui.red;
  if (status === 'completed') return ui.dim;
  if (status === 'awaiting_user') return ui.yellow;
  return '';
}

function fit(text: string, width: number): string {
  return truncateAnsi(text, Math.max(1, width));
}

/** 左侧列表 + 右侧详情；窄终端退化成只有列表（详情靠 Enter 钻取）。 */
export function renderBoard(board: BoardSnapshot, options: RenderBoardOptions): RenderedBoard {
  const cols = Math.max(20, options.cols);
  const rows = Math.max(4, options.rows);
  const flat = boardRows(board);
  // -1 = 不标记选中（一次性快照用）；否则钳到合法范围。
  const selected = flat.length === 0 || options.selected < 0 ? -1 : Math.min(options.selected, flat.length - 1);

  const lines: string[] = [];
  const header =
    `${ui.bold}${ui.accent}mocode supervise${ui.reset}  ` +
    `${board.busy > 0 ? `${ui.green}${board.busy} running${ui.reset}` : `${ui.dim}idle${ui.reset}`}` +
    `${ui.dim} · ${board.live} open lane(s) · ${board.workspaces.length} workspace(s)` +
    `${board.broken > 0 ? ` · ${board.broken} unreadable run(s)` : ''}` +
    ` · ${board.collectedAt.slice(11, 19)}${ui.reset}`;
  lines.push(fit(header, cols));

  const bodyRows = rows - 2; // 头部 + 底部键位
  // 没有选中项（一次性快照）时右栏没有内容，硬画一条竖线只是噪声，退化成单列。
  const wide = cols >= 76 && bodyRows >= 6 && selected >= 0;
  const leftWidth = wide ? Math.min(62, Math.floor(cols * 0.58)) : cols;
  const rightWidth = wide ? cols - leftWidth - 3 : 0;

  const left: Array<{ text: string; row?: number }> = [];
  let rowIndex = 0;
  for (const workspace of board.workspaces) {
    const running = workspace.runs.reduce(
      (sum, run) => sum + run.lanes.filter((lane) => lane.taskStatus === 'running').length,
      0,
    );
    const flags = [
      workspace.exists ? '' : `${ui.red}missing${ui.reset}`,
      workspace.git
        ? `${ui.dim}git:${workspace.branch ?? '?'}${workspace.dirty ? '*' : ''}${ui.reset}`
        : `${ui.dim}no-git${ui.reset}`,
    ].filter(Boolean);
    const marker = rowIndex === selected ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
    const badge = running > 0 ? `  ${ui.green}● ${running} busy${ui.reset}` : '';
    left.push({
      text: `${marker} ${truncateAnsi(workspace.name, 28)}  ${flags.join(' ')}${badge}`,
      row: rowIndex,
    });
    rowIndex++;
    for (const run of workspace.runs) {
      for (const lane of run.lanes) {
        const isSel = rowIndex === selected;
        const glyph = LANE_GLYPH[lane.taskStatus ?? ''] ?? (lane.state === 'closed' ? '·' : '○');
        const color = statusColor(lane.taskStatus) || (lane.state === 'closed' ? ui.dim : '');
        const progress = lane.total > 0 ? `${lane.done}/${lane.total}` : '';
        const activity = lane.lastEvent ? `  ${ui.dim}${lane.lastEvent}${ui.reset}` : '';
        // 「有人等你」必须比 awaitingReason 更优先显示：它在跑，但停下来等回答了。
        const ask =
          lane.pendingApprovals.length > 0
            ? `  ${ui.yellow}? ${lane.pendingApprovals.length} approval(s)${ui.reset}`
            : '';
        const wait = lane.awaitingReason ? `  ${ui.yellow}waiting: ${lane.awaitingReason}${ui.reset}` : '';
        const pointer = isSel ? `${ui.accent}${ui.bold}▸${ui.reset}` : ' ';
        left.push({
          text:
            `${pointer}   ${color}${glyph} ${lane.laneId}${ui.reset}` +
            `  ${ui.dim}${lane.mode}${ui.reset}` +
            `${progress ? `  ${ui.dim}${progress}${ui.reset}` : ''}` +
            `${lane.state === 'closed' ? `  ${ui.dim}closed${ui.reset}` : ''}` +
            `${ask || wait || activity}`,
          row: rowIndex,
        });
        rowIndex++;
      }
    }
    if (workspace.runs.length === 0) {
      left.push({ text: `    ${ui.dim}(no runs)${ui.reset}` });
    }
  }
  if (flat.length === 0) {
    left.push({
      text: `${ui.dim}  还没有任何编排 Run。用 mocode supervise dispatch <workspace> --lane <id> <objective> 派第一个活。${ui.reset}`,
    });
  }

  // 窗口：让选中行落在可视区中部，避免长列表一路顶到底。
  const windowRows = bodyRows;
  let start = 0;
  if (selected >= 0 && left.length > windowRows) {
    const pos = left.findIndex((line) => line.row === selected);
    if (pos >= 0) start = Math.max(0, Math.min(pos - Math.floor(windowRows / 2), left.length - windowRows));
  }
  const visible = left.slice(start, start + windowRows);

  if (!wide) {
    for (const line of visible) lines.push(fit(line.text, leftWidth));
    lines.push(footerLine(cols, flat.length));
    const picked = visible.findIndex((line) => line.row === selected);
    return { lines, selectedLine: picked >= 0 ? picked + 1 : 1, rows: flat };
  }

  // 右栏是「选中项详情」的一块固定内容，不跟着行的滚动位移走：
  // 行对齐会把它切碎——列表只有 3 行时，第 4 条详情（下一步该干什么）就永远不显示。
  const detail = detailLines(board, flat, selected, rightWidth);
  for (let index = 0; index < windowRows; index++) {
    const cell = visible[index];
    const leftText = cell ? fit(cell.text, leftWidth) : '';
    const pad = ' '.repeat(Math.max(0, leftWidth - ansiDisplayWidth(leftText)));
    lines.push(`${leftText}${pad}${ui.dim}│${ui.reset} ${detail[index] ?? ''}`.trimEnd());
  }
  lines.push(footerLine(cols, flat.length));
  const picked = visible.findIndex((cell) => cell.row === selected);
  return { lines, selectedLine: picked >= 0 ? picked + 1 : 1, rows: flat };
}

function footerLine(cols: number, count: number): string {
  const footer = `${ui.dim}↑↓ 选择 · r 刷新 · q 退出${count > 0 ? ` · ${count} 行` : ''}${ui.reset}`;
  return fit(footer, cols);
}

/** 非 TTY / `--json` 的一次性快照；人读版复用面板同一套行渲染。 */
export function formatBoardSnapshot(board: BoardSnapshot, options: { cols?: number; json?: boolean } = {}): string {
  if (options.json) return `${JSON.stringify(board, null, 2)}\n`;
  const rendered = renderBoard(board, { cols: options.cols ?? 100, rows: 200, selected: -1 });
  // 一次性输出不该拖一堆尾部空白行。
  const lines = [...rendered.lines];
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** 右侧详情：回答「在干什么 / 为什么等 / 改了哪些文件 / 下一步谁决定」。 */
function detailLines(board: BoardSnapshot, flat: readonly BoardRow[], selected: number, width: number): string[] {
  const row = flat[selected];
  if (!row) return [];
  const workspace = board.workspaces.find((item) => item.root === row.workspaceRoot);
  if (!workspace) return [];
  const lines: string[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (!value) return;
    lines.push(fit(`${ui.dim}${label}${ui.reset} ${value}`, width));
  };
  if (row.kind === 'workspace') {
    add('工作区', workspace.root);
    add('类型', workspace.git ? `git ${workspace.branch ?? ''}${workspace.dirty ? ' (dirty)' : ''}` : '非 git');
    add('会话', `${workspace.sessionCount} 个，最近 ${workspace.latestSession ?? '—'}`);
    add('Run', `${workspace.runs.length} 个（面板只看未终态的）`);
    return lines;
  }
  const run = workspace.runs.find((item) => item.id === row.runId);
  const lane = run?.lanes.find((item) => item.laneId === row.laneId);
  if (!run || !lane) return lines;
  add('Run', `${run.id}  ${run.status}`);
  add('目标', run.objective);
  add('lane', `${lane.laneId}  ${lane.mode}  ${lane.state}`);
  add('现场', lane.executionRoot);
  add('会话', lane.sessionId);
  add('任务', lane.taskId ? `${lane.taskId}  ${lane.taskStatus ?? ''}  ${lane.done}/${lane.total}` : undefined);
  add('当前动作', lane.lastEvent);
  for (const approval of lane.pendingApprovals) {
    add('待回答', `${ui.yellow}? ${approval.kind} ${approval.id}${ui.reset} ${approval.title}`);
  }
  for (const risk of lane.risks.slice(0, 3)) {
    add('风险', `${ui.yellow}${risk}${ui.reset}`);
  }
  if (lane.awaitingReason) add('等待', `${ui.yellow}${lane.awaitingReason}${ui.reset}`);
  if (lane.error) add('错误', `${ui.red}${lane.error}${ui.reset}`);
  add('下一步', 'dispatch 续派 / ask 问进度 / close 收工');
  return lines;
}
