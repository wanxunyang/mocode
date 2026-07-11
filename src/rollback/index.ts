import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { truncateDisplay } from '../ui/render.js';
import type { ChatMessage } from '../llm/index.js';
import { toText } from '../context/utils.js';

/**
 * 回滚子系统:`/rollback` 菜单(↑/↓)选轮次 → 选中第 X 轮 = 删该轮及之后 + 预填该轮 user 输入(Enter 重新跑);撤销被删轮次的文件改动(逐个「保留/撤销」询问)。
 *
 * 语义:选中下标 picked(0-based,= 第 picked+1 轮)→ `planRollback(picked)` 保 1..picked(删 picked+1 轮及之后),
 * 预填 userTexts[picked](= 第 picked+1 轮 user 输入)。**不是**保 1..picked+1——选中第 X 轮即"从第 X 轮重跑"。
 *
 * 撤销方案 = 落盘快照(不用 git):write_file/edit_file 执行前由 executeTool 调
 * recordMutation,把 before 内容存入快照(按轮次 turnId 打标)。回滚到第 n 轮时,
 * 对每条选「撤销」的路径,恢复 turnId > cutoffTurnId 的最小 turnId 快照的 before
 * (= 所选轮末状态;before===null = 当时不存在 → 删文件)。同文件多轮改动也能
 * 精确回到所选轮边界,不误伤更早轮次。
 *
 * 快照 + 轮次日志随 saveSession 落盘到 <sessionDir>/<id>.snapshots.json,/resume 读回
 * → 重启后仍可撤销。叶子模块:运行时只依赖 config(+ node:fs/path);ChatMessage
 * 用 import type 擦除,不拉 llm 运行时;不反向依赖任何业务。
 *
 * v1 偏离 / 局限:
 * - 撤销粒度 = 路径(非逐条 tool_call)——快照只能整路径回到轮末,无法只撤一条 edit。
 * - run_command 不撤销(shell 可任意改文件,无法跟踪)。
 * - 跨 /resume 后若文件被外部改过,恢复会用 before 覆盖(边缘情况,不处理)。
 * - 快照文件随大文件多次改动膨胀;/clear 重置;日后可按「turn 已不可回滚」裁剪。
 */

export interface Turn {
  turnId: number;
  firstLine: string;
}
export interface Snapshot {
  turnId: number;
  path: string; // cwd 相对路径(跨 /resume 同项目可识别)
  before: string | null; // null = 快照时文件不存在(新建)
}
export interface FileChange {
  path: string; // cwd 相对
  ops: string[]; // 涉及的工具名(write_file/edit_file),按出现顺序
  snapshotAvailable: boolean; // 是否存在 turnId > cutoff 的该路径快照(决定能否撤销)
}
export interface RollbackPlan {
  n: number;
  cutoffIndex: number; // history 截断点:保留 [0, cutoffIndex)
  cutoffTurnId: number;
  changes: FileChange[];
}

let turnIdCounter = 0;
let currentTurnId = 0;
let turns: Turn[] = [];
let snapshots: Snapshot[] = [];

const MUTATION_TOOLS = new Set(['write_file', 'edit_file']);

/** 规整成 cwd 相对路径(快照存相对,跨 /resume 同项目可识别;resolve 已归一 ./ 和 ..)。 */
function toRel(p: string): string {
  try {
    const rel = path.relative(process.cwd(), path.resolve(p));
    return rel === '' ? p : rel;
  } catch {
    return p;
  }
}

/** agent:runAgent 入口调——开新轮次。firstLine 已由调用方截断到 40。 */
export function beginTurn(firstLine: string): void {
  turnIdCounter += 1;
  currentTurnId = turnIdCounter;
  turns.push({ turnId: currentTurnId, firstLine });
}

/** tools/registry:write_file/edit_file 执行前调——记 before 快照(在 tool.execute 之前读)。 */
export function recordMutation(p: string): void {
  const rel = toRel(p);
  let before: string | null;
  try {
    before = readFileSync(path.resolve(p), 'utf8');
  } catch {
    before = null; // 文件不存在(新建)
  }
  snapshots.push({ turnId: currentTurnId, path: rel, before });
}

/** 列出当前可回滚的轮次(1-based 序号由调用方显示)。 */
export function listTurns(): Turn[] {
  return turns.slice();
}

/** history 里第 (n+1) 条 user 消息的下标(= 截断点);无则 history.length。 */
function findCutoffIndex(n: number, history: ChatMessage[]): number {
  let seen = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') {
      seen += 1;
      if (seen === n + 1) return i;
    }
  }
  return history.length;
}

/**
 * 规划回滚到第 n 轮(1-based):算截断点 + 被删轮次里涉及的文件改动(按 path 去重)。
 * 调用方据 changes 逐 path 问保留 / 撤销;snapshotAvailable=false 的项无法撤销。
 */
export function planRollback(n: number, history: ChatMessage[]): RollbackPlan {
  const cutoffTurnId = turns[n - 1]?.turnId ?? 0;
  const cutoffIndex = findCutoffIndex(n, history);
  const order: string[] = [];
  const map = new Map<string, FileChange>();
  for (let i = cutoffIndex; i < history.length; i++) {
    const tcs = (history[i] as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs as Array<{ function?: { name?: string; arguments?: string } }>) {
      const name = tc?.function?.name ?? '';
      if (!MUTATION_TOOLS.has(name)) continue;
      const argRaw = tc?.function?.arguments ?? '';
      let p = '';
      try {
        p = String((JSON.parse(argRaw) as { path?: unknown }).path ?? '');
      } catch {
        p = '';
      }
      if (!p) continue;
      const rel = toRel(p);
      let fc = map.get(rel);
      if (!fc) {
        fc = { path: rel, ops: [], snapshotAvailable: false };
        map.set(rel, fc);
        order.push(rel);
      }
      fc.ops.push(name);
    }
  }
  const changes: FileChange[] = order.map((rel) => {
    const fc = map.get(rel)!;
    fc.snapshotAvailable = snapshots.some(
      (s) => s.turnId > cutoffTurnId && s.path === rel
    );
    return fc;
  });
  return { n, cutoffIndex, cutoffTurnId, changes };
}

/**
 * 执行回滚:原地截断 history 到 cutoffIndex + 按选择恢复文件 + 裁剪 turns/snapshots。
 * revertPaths 为选「撤销」的相对路径集合。返回删除消息数 + 撤销文件列表。
 */
export function applyRollback(
  plan: RollbackPlan,
  history: ChatMessage[],
  revertPaths: Set<string>
): { deletedMsgs: number; revertedFiles: string[] } {
  const deletedMsgs = history.length - plan.cutoffIndex;
  history.length = plan.cutoffIndex; // 原地截断(保 history[0] system + 可能的 index-1 摘要)

  const revertedFiles: string[] = [];
  for (const rel of revertPaths) {
    // turnId > cutoff 的最小 turnId 快照 = 所选轮末状态
    let pick: Snapshot | null = null;
    for (const s of snapshots) {
      if (s.path !== rel) continue;
      if (s.turnId <= plan.cutoffTurnId) continue;
      if (!pick || s.turnId < pick.turnId) pick = s;
    }
    if (!pick) continue; // 无快照(不应发生:repl 已据 snapshotAvailable 过滤)
    const full = path.resolve(rel);
    try {
      if (pick.before === null) {
        unlinkSync(full);
      } else {
        writeFileSync(full, pick.before, 'utf8');
      }
      revertedFiles.push(rel);
    } catch {
      // 恢复失败不阻断回滚(文件可能被外部删 / 锁)
    }
  }

  // 裁剪:保 turnId ≤ cutoff(删掉被回滚掉的轮次及其快照)
  turns = turns.filter((t) => t.turnId <= plan.cutoffTurnId);
  snapshots = snapshots.filter((s) => s.turnId <= plan.cutoffTurnId);
  return { deletedMsgs, revertedFiles };
}

/** compact 摘要成功后调:按存活轮次数裁剪(M = 新 history 里 user 消息数)。 */
export function pruneAfterCompaction(history: ChatMessage[]): void {
  const m = history.filter((msg) => msg.role === 'user').length;
  turns = m >= turns.length ? turns : turns.slice(-m);
  const alive = new Set(turns.map((t) => t.turnId));
  snapshots = snapshots.filter((s) => alive.has(s.turnId));
}

/** /clear 调:清空全部状态。 */
export function resetState(): void {
  turns = [];
  snapshots = [];
  turnIdCounter = 0;
  currentTurnId = 0;
}

/**
 * 无 snapshots 文件时(/resume 旧会话)从 history 重建 turns(扫 user 消息,1..M,
 * 无快照 → 那些轮次的文件改动不可撤销)。turnIdCounter = M,后续新轮次从 M+1 续。
 */
export function rebuildFromHistory(history: ChatMessage[]): void {
  const out: Turn[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'user') continue;
    const first = toText((history[i] as { content?: unknown }).content).split('\n')[0] ?? '';
    out.push({ turnId: out.length + 1, firstLine: truncateDisplay(first, 40) });
  }
  turns = out;
  snapshots = [];
  turnIdCounter = out.length;
  currentTurnId = 0;
}

function snapshotsPath(id: string): string {
  return path.join(config.sessionDir, `${id}.snapshots.json`);
}

/** 随 saveSession 调:把 turns + snapshots 落盘(turns 为空则跳过,不写空文件)。 */
export function persistSnapshots(id: string): void {
  if (turns.length === 0) return;
  try {
    mkdirSync(config.sessionDir, { recursive: true });
    writeFileSync(
      snapshotsPath(id),
      JSON.stringify({ version: 1, turns, snapshots }),
      'utf8'
    );
  } catch {
    // 落盘失败不阻断(回滚仅失去跨重启能力)
  }
}

/**
 * /resume / --resume 加载会话后调:读回 turns + snapshots。成功返 true(状态已覆盖);
 * 失败 / 无文件返 false,调用方应改调 rebuildFromHistory(history) 兜底。
 */
export function loadSnapshots(id: string): boolean {
  const p = snapshotsPath(id);
  if (!existsSync(p)) return false;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8')) as {
      version?: number;
      turns?: Turn[];
      snapshots?: Snapshot[];
    };
    if (!rec || !Array.isArray(rec.turns) || !Array.isArray(rec.snapshots)) {
      return false;
    }
    turns = rec.turns;
    snapshots = rec.snapshots;
    turnIdCounter = turns.reduce((mx, t) => Math.max(mx, t.turnId), 0);
    currentTurnId = 0;
    return true;
  } catch {
    return false;
  }
}
