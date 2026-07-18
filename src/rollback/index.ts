import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { truncateDisplay } from '../ui/render.js';
import type { ChatMessage } from '../llm/index.js';
import { toText } from '../context/utils.js';

/**
 * 回滚子系统：以工作区文件快照记录每轮模型造成的实际变化，完全不读写 Git。
 * write_file/edit_file 使用单路径前后快照；run_command/MCP 等不透明工具使用工作区
 * 前后快照。回滚只恢复工作树，始终排除 .git，因此不会改变 index/暂存区。
 */

export interface Turn {
  turnId: number;
  firstLine: string;
}

type SnapshotKind = 'missing' | 'file' | 'directory' | 'symlink';
type StoredState = {
  kind: SnapshotKind;
  data?: string;
  mode?: number;
};

export interface Snapshot {
  turnId: number;
  path: string;
  /** v1: UTF-8 原文/null；v2: file=base64，symlink=target，其余 null。 */
  before: string | null;
  kind?: SnapshotKind;
  encoding?: 'base64';
  mode?: number;
  sequence?: number;
  ops?: string[];
  createdParents?: string[];
}

export interface FileChange {
  path: string;
  ops: string[];
  snapshotAvailable: boolean;
}

export interface RollbackPlan {
  n: number;
  cutoffIndex: number;
  cutoffTurnId: number;
  changes: FileChange[];
}

export interface PathMutationCapture {
  path: string;
  before: StoredState;
  sequence: number;
  createdParents: string[];
}

export interface WorkspaceMutationCapture {
  sequence: number;
  entries: Map<string, StoredState>;
}

export interface CurrentTurnMutationState {
  version: number;
  changedFiles: FileChange[];
}

let turnIdCounter = 0;
let currentTurnId = 0;
let sequenceCounter = 0;
/** Monotonic process-local generation; repeated writes to one path still invalidate validation. */
let mutationVersion = 0;
let turns: Turn[] = [];
let snapshots: Snapshot[] = [];

const rootDir = (): string => path.resolve(process.cwd());

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 规整成 cwd 相对路径；所有持久化快照均使用此格式。 */
function toRel(p: string): string {
  try {
    const rel = path.relative(rootDir(), path.resolve(p));
    return rel === '' ? '.' : rel;
  } catch {
    return p;
  }
}

/** 防止损坏/篡改的 snapshots.json 在恢复时写出工作区。 */
function safeFullPath(rel: string): string | null {
  const root = rootDir();
  const full = path.resolve(root, rel);
  return full !== root && isInside(root, full) ? full : null;
}

function readState(full: string): StoredState {
  try {
    const stat = lstatSync(full);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      return { kind: 'symlink', data: readlinkSync(full), mode };
    }
    if (stat.isDirectory()) return { kind: 'directory', mode };
    if (stat.isFile()) {
      return { kind: 'file', data: readFileSync(full).toString('base64'), mode };
    }
  } catch {
    // 不存在或不可读均按 missing；工具若最终也不可读，不会产生伪变化。
  }
  return { kind: 'missing' };
}

function sameState(a: StoredState, b: StoredState): boolean {
  return a.kind === b.kind && a.data === b.data && a.mode === b.mode;
}

function stateFromSnapshot(snapshot: Snapshot): StoredState {
  if (snapshot.kind) {
    return { kind: snapshot.kind, data: snapshot.before ?? undefined, mode: snapshot.mode };
  }
  // v1 向后兼容：before 是 UTF-8 文本，null 表示原文件不存在。
  if (snapshot.before === null) return { kind: 'missing' };
  return {
    kind: 'file',
    data: Buffer.from(snapshot.before, 'utf8').toString('base64'),
  };
}

function snapshotFromState(
  rel: string,
  state: StoredState,
  sequence: number,
  op: string,
  createdParents: string[] = [],
): Snapshot {
  return {
    turnId: currentTurnId,
    path: rel,
    before: state.data ?? null,
    kind: state.kind,
    encoding: state.kind === 'file' ? 'base64' : undefined,
    mode: state.mode,
    sequence,
    ops: [op],
    createdParents: createdParents.length > 0 ? createdParents : undefined,
  };
}

/** 同轮同路径只保留最早的 before；后续实际改动仅合并工具名。 */
function addSnapshot(next: Snapshot): void {
  if (next.turnId <= 0) return;
  const existingIndex = snapshots.findIndex(
    (item) => item.turnId === next.turnId && item.path === next.path,
  );
  if (existingIndex < 0) {
    snapshots.push(next);
    return;
  }
  const existing = snapshots[existingIndex];
  const existingSequence = existing.sequence ?? Number.MAX_SAFE_INTEGER;
  const nextSequence = next.sequence ?? Number.MAX_SAFE_INTEGER;
  const ops = new Set([...(existing.ops ?? []), ...(next.ops ?? [])]);
  if (nextSequence < existingSequence) {
    snapshots[existingIndex] = { ...next, ops: [...ops] };
  } else {
    existing.ops = [...ops];
  }
}

function missingParents(full: string): string[] {
  const root = rootDir();
  const result: string[] = [];
  let current = path.dirname(full);
  while (current !== root && isInside(root, current)) {
    if (existsSync(current)) break;
    result.push(toRel(current));
    current = path.dirname(current);
  }
  return result;
}

/** agent 主轮入口调用；子 agent 共享当前 turnId，不另开轮次。 */
export function beginTurn(firstLine: string): number {
  turnIdCounter += 1;
  currentTurnId = turnIdCounter;
  turns.push({ turnId: currentTurnId, firstLine });
  return currentTurnId;
}

/** Stable identity shared by tracing, validation, and rollback for the active main turn. */
export function getCurrentTurnId(): number {
  return currentTurnId;
}

/** 单路径工具执行前捕获，不立即记账；失败/no-op 不应出现在 rollback 中。 */
export function beginPathMutation(p: string): PathMutationCapture {
  const full = path.resolve(p);
  return {
    path: toRel(full),
    before: readState(full),
    sequence: ++sequenceCounter,
    createdParents: missingParents(full),
  };
}

/** 单路径工具执行后提交，仅当磁盘状态确实变化时写入事务日志。 */
export function endPathMutation(capture: PathMutationCapture, op: string): void {
  const full = safeFullPath(capture.path);
  if (!full) return;
  let changed = false;
  const after = readState(full);
  if (!sameState(capture.before, after)) {
    changed = true;
    addSnapshot(
      snapshotFromState(
        capture.path,
        capture.before,
        capture.sequence,
        op,
        capture.createdParents,
      ),
    );
  }
  // write_file 会递归创建父目录；即使最终写文件失败，这些目录也是本轮真实副作用。
  for (const parentRel of capture.createdParents) {
    const parent = safeFullPath(parentRel);
    if (parent && readState(parent).kind !== 'missing') {
      changed = true;
      addSnapshot(
        snapshotFromState(parentRel, { kind: 'missing' }, capture.sequence, op),
      );
    }
  }
  if (changed) mutationVersion += 1;
}

function isWorkspaceExcluded(full: string): boolean {
  const base = path.basename(full).toLowerCase();
  // Git 元数据必须永久排除以保护 index；依赖树/代码索引是可再生运行时状态，
  // 扫描它们既昂贵，也可能把后台 daemon 的写入误判成模型改动。
  if (base === '.git' || base === '.codegraph' || base === 'node_modules') return true;
  const sessionDir = path.resolve(config.sessionDir);
  return isInside(sessionDir, full);
}

function scanWorkspace(): Map<string, StoredState> {
  const entries = new Map<string, StoredState>();
  const walk = (dir: string): void => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (isWorkspaceExcluded(full)) continue;
      const state = readState(full);
      if (state.kind === 'missing') continue;
      const rel = toRel(full);
      entries.set(rel, state);
      if (state.kind === 'directory') walk(full);
    }
  };
  walk(rootDir());
  return entries;
}

/** run_command/MCP 前调用。不跟随 symlink，并排除 .git、会话快照、依赖树与代码索引。 */
export function beginWorkspaceMutation(): WorkspaceMutationCapture {
  return { sequence: ++sequenceCounter, entries: scanWorkspace() };
}

/** 不透明工具执行后比较整个工作区，把实际变化压入当前轮事务日志。 */
export function endWorkspaceMutation(
  capture: WorkspaceMutationCapture,
  op: string,
): void {
  const after = scanWorkspace();
  const paths = new Set([...capture.entries.keys(), ...after.keys()]);
  let changed = false;
  for (const rel of paths) {
    const beforeState = capture.entries.get(rel) ?? { kind: 'missing' as const };
    const afterState = after.get(rel) ?? { kind: 'missing' as const };
    if (sameState(beforeState, afterState)) continue;
    changed = true;
    addSnapshot(snapshotFromState(rel, beforeState, capture.sequence, op));
  }
  if (changed) mutationVersion += 1;
}

/** Current main turn changes, deduplicated by path, plus a generation for validation invalidation. */
export function getCurrentTurnMutationState(): CurrentTurnMutationState {
  const order: string[] = [];
  const byPath = new Map<string, FileChange>();
  for (const snapshot of snapshots) {
    if (snapshot.turnId !== currentTurnId) continue;
    let change = byPath.get(snapshot.path);
    if (!change) {
      change = { path: snapshot.path, ops: [], snapshotAvailable: true };
      byPath.set(snapshot.path, change);
      order.push(snapshot.path);
    }
    for (const op of snapshot.ops ?? ['file_change']) {
      if (!change.ops.includes(op)) change.ops.push(op);
    }
  }
  return { version: mutationVersion, changedFiles: order.map((item) => byPath.get(item)!) };
}

export function listTurns(): Turn[] {
  return turns.slice();
}

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
 * 规划回滚到第 n 轮。changes 只来自已确认发生磁盘差异的事务快照，
 * 因此失败/no-op 工具不会被误报；子 agent、run_command、MCP 变化同样可见。
 */
export function planRollback(n: number, history: ChatMessage[]): RollbackPlan {
  const cutoffTurnId = turns[n - 1]?.turnId ?? 0;
  const cutoffIndex = findCutoffIndex(n, history);
  const order: string[] = [];
  const map = new Map<string, FileChange>();
  const ensure = (rel: string): FileChange => {
    let change = map.get(rel);
    if (!change) {
      change = { path: rel, ops: [], snapshotAvailable: true };
      map.set(rel, change);
      order.push(rel);
    }
    return change;
  };

  for (const snapshot of snapshots) {
    if (snapshot.turnId <= cutoffTurnId) continue;
    const change = ensure(snapshot.path);
    for (const op of snapshot.ops ?? ['file_change']) {
      if (!change.ops.includes(op)) change.ops.push(op);
    }
  }

  return {
    n,
    cutoffIndex,
    cutoffTurnId,
    changes: order.map((rel) => map.get(rel)!),
  };
}

function depth(rel: string): number {
  return rel.split(/[\\/]+/).length;
}

function restoreSnapshot(snapshot: Snapshot): boolean {
  const full = safeFullPath(snapshot.path);
  if (!full) return false;
  const state = stateFromSnapshot(snapshot);
  try {
    if (state.kind === 'missing') {
      rmSync(full, { recursive: true, force: true });
      for (const parentRel of snapshot.createdParents ?? []) {
        const parent = safeFullPath(parentRel);
        if (!parent) continue;
        try {
          rmdirSync(parent);
        } catch {
          // 仅删除本轮创建且当前为空的父目录；非空/已不存在均保持。
        }
      }
      return true;
    }

    if (state.kind === 'directory') {
      const current = readState(full);
      if (current.kind !== 'missing' && current.kind !== 'directory') {
        rmSync(full, { recursive: true, force: true });
      }
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(path.dirname(full), { recursive: true });
      rmSync(full, { recursive: true, force: true });
      if (state.kind === 'file') {
        writeFileSync(full, Buffer.from(state.data ?? '', 'base64'));
      } else {
        symlinkSync(state.data ?? '', full);
      }
    }
    if (state.mode !== undefined && state.kind !== 'symlink') chmodSync(full, state.mode);
    return true;
  } catch {
    return false;
  }
}

/** 执行回滚：恢复工作树快照并截断对话/事务；从不调用 Git。 */
export function applyRollback(
  plan: RollbackPlan,
  history: ChatMessage[],
  revertPaths: Set<string>,
): { deletedMsgs: number; revertedFiles: string[] } {
  const deletedMsgs = history.length - plan.cutoffIndex;
  history.length = plan.cutoffIndex;

  const picks = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.turnId <= plan.cutoffTurnId || !revertPaths.has(snapshot.path)) continue;
    const existing = picks.get(snapshot.path);
    if (
      !existing ||
      snapshot.turnId < existing.turnId ||
      (snapshot.turnId === existing.turnId &&
        (snapshot.sequence ?? Number.MAX_SAFE_INTEGER) <
          (existing.sequence ?? Number.MAX_SAFE_INTEGER))
    ) {
      picks.set(snapshot.path, snapshot);
    }
  }

  const selected = [...picks.values()];
  // 先深到浅删除本轮新建项，再浅到深恢复原目录/文件。
  const removals = selected
    .filter((item) => stateFromSnapshot(item).kind === 'missing')
    .sort((a, b) => depth(b.path) - depth(a.path));
  const restores = selected
    .filter((item) => stateFromSnapshot(item).kind !== 'missing')
    .sort((a, b) => depth(a.path) - depth(b.path));
  const revertedFiles: string[] = [];
  for (const snapshot of [...removals, ...restores]) {
    if (restoreSnapshot(snapshot)) revertedFiles.push(snapshot.path);
  }

  turns = turns.filter((turn) => turn.turnId <= plan.cutoffTurnId);
  snapshots = snapshots.filter((snapshot) => snapshot.turnId <= plan.cutoffTurnId);
  currentTurnId = turns.at(-1)?.turnId ?? 0;
  return { deletedMsgs, revertedFiles };
}

export function pruneAfterCompaction(history: ChatMessage[]): void {
  const count = history.filter((message) => message.role === 'user').length;
  turns = count >= turns.length ? turns : turns.slice(-count);
  const alive = new Set(turns.map((turn) => turn.turnId));
  snapshots = snapshots.filter((snapshot) => alive.has(snapshot.turnId));
}

export function resetState(): void {
  turns = [];
  snapshots = [];
  turnIdCounter = 0;
  currentTurnId = 0;
  sequenceCounter = 0;
}

export function rebuildFromHistory(history: ChatMessage[]): void {
  const rebuilt: Turn[] = [];
  for (const message of history) {
    if (message.role !== 'user') continue;
    const first = toText((message as { content?: unknown }).content).split('\n')[0] ?? '';
    rebuilt.push({
      turnId: rebuilt.length + 1,
      firstLine: truncateDisplay(first, 40),
    });
  }
  turns = rebuilt;
  snapshots = [];
  turnIdCounter = rebuilt.length;
  currentTurnId = 0;
  sequenceCounter = 0;
}

function snapshotsPath(id: string): string {
  const current = path.join(config.sessionDir, id, 'snapshots.json');
  if (existsSync(current)) return current;
  return path.join(config.sessionDir, `${id}.snapshots.json`);
}

export function persistSnapshots(id: string): void {
  const dir = path.join(config.sessionDir, id);
  const current = path.join(dir, 'snapshots.json');
  const legacy = path.join(config.sessionDir, `${id}.snapshots.json`);
  try {
    if (turns.length === 0) {
      // 全量回滚后不能保留旧快照，否则 /resume 可能重新加载已删除轮次。
      if (existsSync(current)) unlinkSync(current);
      if (existsSync(legacy)) unlinkSync(legacy);
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      current,
      JSON.stringify({ version: 2, turns, snapshots }),
      'utf8',
    );
    // 迁移后的旧式扁平快照不再需要，避免磁盘上残留已回滚内容。
    if (existsSync(legacy)) unlinkSync(legacy);
  } catch {
    // 落盘失败不阻断会话；只失去跨重启回滚能力。
  }
}

export function loadSnapshots(id: string): boolean {
  const snapshotFile = snapshotsPath(id);
  if (!existsSync(snapshotFile)) return false;
  try {
    const record = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
      turns?: Turn[];
      snapshots?: Snapshot[];
    };
    if (!record || !Array.isArray(record.turns) || !Array.isArray(record.snapshots)) {
      return false;
    }
    turns = record.turns;
    snapshots = record.snapshots;
    turnIdCounter = turns.reduce((max, turn) => Math.max(max, turn.turnId), 0);
    sequenceCounter = snapshots.reduce(
      (max, snapshot) => Math.max(max, snapshot.sequence ?? 0),
      0,
    );
    currentTurnId = 0;
    return true;
  } catch {
    return false;
  }
}
