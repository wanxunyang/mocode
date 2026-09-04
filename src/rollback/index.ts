import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
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
  /**
   * 廉价变更指纹(file=`size:mtimeNs`,symlink=target,directory='')。
   * 工作区扫描用它判断"这个文件是否需要重读内容",从而在两次扫描之间复用缓存;
   * 内容因超预算未捕获时(data===undefined)也靠它检测变化。
   */
  stamp?: string;
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
  /** Fingerprint immediately after the latest Agent mutation; rollback refuses newer user edits. */
  afterFingerprint?: string;
  /** 工作区扫描时该文件内容超出捕获预算(仅有变更指纹):可报告变化,但不可用于恢复。 */
  contentUnavailable?: boolean;
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

/**
 * 状态等价判定。两侧都捕获了内容时按内容比(与旧行为一致,精确);
 * 任一侧内容未捕获(超预算的大文件)时退化为 stamp 比较——size+mtimeNs 变了就算变。
 */
function sameState(a: StoredState, b: StoredState): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  if (a.data !== undefined && b.data !== undefined) return a.data === b.data;
  if (a.data === undefined && b.data === undefined && a.stamp === undefined && b.stamp === undefined) {
    return true; // directory / missing:kind+mode 已足够
  }
  return a.stamp === b.stamp;
}

function stateFingerprint(state: StoredState): string {
  return createHash('sha256')
    .update(JSON.stringify([state.kind, state.data ?? null, state.mode ?? null]))
    .digest('hex');
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
  after?: StoredState,
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
    afterFingerprint: after ? stateFingerprint(after) : undefined,
    // 文件但没有内容 = 工作区扫描时超出捕获预算,只能报告"变了",不能拿它覆盖磁盘。
    contentUnavailable: state.kind === 'file' && state.data === undefined ? true : undefined,
  };
}

/** 同轮同路径只保留最早的 before；后续实际改动仅合并工具名。 */
function addSnapshot(next: Snapshot): void {
  if (next.turnId <= 0) return;
  const existingIndex = snapshots.findIndex((item) => item.turnId === next.turnId && item.path === next.path);
  if (existingIndex < 0) {
    snapshots.push(next);
    return;
  }
  const existing = snapshots[existingIndex];
  const existingSequence = existing.sequence ?? Number.MAX_SAFE_INTEGER;
  const nextSequence = next.sequence ?? Number.MAX_SAFE_INTEGER;
  const ops = new Set([...(existing.ops ?? []), ...(next.ops ?? [])]);
  const latestAfterFingerprint = nextSequence >= existingSequence ? next.afterFingerprint : existing.afterFingerprint;
  if (nextSequence < existingSequence) {
    snapshots[existingIndex] = { ...next, ops: [...ops], afterFingerprint: latestAfterFingerprint };
  } else {
    existing.ops = [...ops];
    existing.afterFingerprint = latestAfterFingerprint;
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
    addSnapshot(snapshotFromState(capture.path, capture.before, capture.sequence, op, capture.createdParents, after));
  }
  // write_file 会递归创建父目录；即使最终写文件失败，这些目录也是本轮真实副作用。
  for (const parentRel of capture.createdParents) {
    const parent = safeFullPath(parentRel);
    if (parent && readState(parent).kind !== 'missing') {
      changed = true;
      addSnapshot(snapshotFromState(parentRel, { kind: 'missing' }, capture.sequence, op, [], readState(parent)));
    }
  }
  if (changed) mutationVersion += 1;
}

// 构建产物 / 依赖树 / 缓存 / 运行时状态目录：可再生，扫描它们既昂贵也易把后台 daemon、
// 打包器、mocode 自身(会话日志 / dev-server 日志 / 截图)的写入误判成模型改动。
// 回滚本就只应覆盖源码。
const EXCLUDED_WORKSPACE_DIRS = new Set([
  // VCS / 索引 / mocode 自身运行时状态(会话、trace、dev-server 日志、记忆、截图每轮都在写,
  // 既无回滚意义,又会被误判成模型改动)
  '.git',
  '.hg',
  '.svn',
  '.codegraph',
  '.mocode',
  // 依赖树与包管理器缓存
  'node_modules',
  'vendor',
  'bower_components',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  'pods',
  // 构建产物
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.output',
  '.next',
  '.nuxt',
  '.vite',
  '.turbo',
  '.svelte-kit',
  '.angular',
  '.astro',
  '.docusaurus',
  '.dart_tool',
  '.terraform',
  // 临时与缓存
  '.tmp',
  'tmp',
  '.cache',
  '.parcel-cache',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
]);

/** 单文件内容捕获上限：更大的文件只留 stamp(可检测变化,不可恢复),避免把巨型二进制读进内存。 */
const CAPTURE_FILE_LIMIT = 1024 * 1024;
/** 单次扫描的内容总预算：超出后剩余文件只留 stamp。 */
const CAPTURE_TOTAL_LIMIT = 32 * 1024 * 1024;
/** 条目上限：超大工作区不做无边界遍历(超出部分不参与变更检测)。 */
const CAPTURE_ENTRY_LIMIT = 20000;
/** 并发文件操作数：冷缓存(尤其 Windows 杀软逐文件扫描)下 I/O 重叠远快于串行。 */
const SCAN_CONCURRENCY = 16;
/** 让出事件循环的节奏:每 N 个条目,或每累计编码 M 字节(base64 是纯 CPU,大文件靠字节数兜底)。 */
const YIELD_EVERY = 64;
const YIELD_BYTES = 1024 * 1024;
/**
 * 刚被写过的文件不信缓存,强制重读内容。
 * 原因:stamp 依赖 mtime 精度。NTFS/ext4/APFS 是 100ns~ns 级,但 exFAT / 部分网络盘只有 1~2s,
 * 那里一条"同尺寸原地改写"可能与快照前共享同一时间戳,只比 stamp 会漏掉真实变化。
 * 只对最近 2s 内改动的文件付重读代价(通常正是命令刚碰过的那几个),开销可忽略。
 */
const FRESH_WINDOW_MS = 2000;

interface CachedContent {
  stamp: string;
  mode: number;
  data: string;
}

/** path → 上次扫描捕获的内容。stamp(size+mtimeNs)未变即复用，未改动的文件不重复读盘。 */
let contentCache = new Map<string, CachedContent>();

let cachedSessionDir = '';
let resolvedSessionDir = '';

function sessionDirAbs(): string {
  if (config.sessionDir !== cachedSessionDir) {
    cachedSessionDir = config.sessionDir;
    resolvedSessionDir = path.resolve(config.sessionDir);
  }
  return resolvedSessionDir;
}

function isWorkspaceExcluded(full: string): boolean {
  const base = path.basename(full).toLowerCase();
  // Git 元数据必须永久排除以保护 index；依赖树/代码索引/构建产物/临时目录是可再生运行时状态。
  if (EXCLUDED_WORKSPACE_DIRS.has(base)) return true;
  return isInside(sessionDirAbs(), full);
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 工作区快照(run_command / dev_server / MCP 等不透明工具用)。
 *
 * **必须是异步且带缓存的**：本函数在每次这类工具调用前后各跑一次，直接坐在用户交互
 * 路径上。旧实现用 readdirSync + 全量 readFileSync(base64) 同步遍历整棵工作树 ——
 * 冷文件缓存下 400 个文件实测就要 ~3s(Windows)，几千个文件即数十秒，期间事件循环
 * 完全阻塞：spinner 冻结、走时停摆、键鼠无响应，用户看到的就是「卡在 执行 run_command」。
 *
 * 现在:
 *  1) fs/promises + 有界并发 + 定期 setImmediate 让出 → 事件循环全程可呼吸;
 *  2) 内容按 (size, mtimeNs, mode) 缓存复用 → 未改动的文件不再重复读盘,
 *     一次会话里只有首次扫描付全量代价,之后只读真正变化的文件;
 *  3) 单文件 / 总量 / 条目数三重预算 → 巨型仓库不会把内存和时间吃穿。
 */
async function scanWorkspace(): Promise<Map<string, StoredState>> {
  const entries = new Map<string, StoredState>();
  const nextCache = new Map<string, CachedContent>();
  const paths: string[] = [];

  // 第一趟:只 readdir 收集条目(廉价,不读内容)。目录本身即刻记账,顺序稳定。
  const walk = async (dir: string): Promise<void> => {
    if (paths.length >= CAPTURE_ENTRY_LIMIT) return;
    let children;
    try {
      children = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (paths.length >= CAPTURE_ENTRY_LIMIT) return;
      const full = path.join(dir, child.name);
      if (isWorkspaceExcluded(full)) continue;
      paths.push(full);
      // isDirectory() 对 symlink 为 false —— 与旧实现一致:不跟随软链。
      if (child.isDirectory()) await walk(full);
    }
  };
  await walk(rootDir());

  // 第二趟:有界并发读状态。budget 由完成顺序消费——两次扫描间某个大文件是否被捕获
  // 可能不同,sameState 在任一侧缺内容时退化为 stamp 比较,故不会产生伪变化。
  let budget = CAPTURE_TOTAL_LIMIT;
  let cursor = 0;
  let processed = 0;
  let bytesSinceYield = 0;
  const worker = async (): Promise<void> => {
    while (cursor < paths.length) {
      const full = paths[cursor++];
      if (++processed % YIELD_EVERY === 0 || bytesSinceYield >= YIELD_BYTES) {
        bytesSinceYield = 0;
        await yieldToEventLoop();
      }
      let state: StoredState;
      try {
        const stat = await fsp.lstat(full, { bigint: true });
        const mode = Number(stat.mode) & 0o777;
        if (stat.isSymbolicLink()) {
          const target = await fsp.readlink(full);
          state = { kind: 'symlink', data: target, stamp: target, mode };
        } else if (stat.isDirectory()) {
          state = { kind: 'directory', mode, stamp: '' };
        } else if (stat.isFile()) {
          const size = Number(stat.size);
          const stamp = `${size}:${stat.mtimeNs}`;
          // 未来时间戳(时钟偏移)同样按"新鲜"处理 —— 宁可多读一次,不可漏判变化。
          const fresh = Date.now() - Number(stat.mtimeNs / 1000000n) < FRESH_WINDOW_MS;
          const cached = fresh ? undefined : contentCache.get(full);
          if (cached && cached.stamp === stamp && cached.mode === mode) {
            budget -= size; // 命中也计预算,保证冷/热缓存下的捕获集合一致
            state = { kind: 'file', data: cached.data, stamp, mode };
            nextCache.set(full, cached);
          } else if (size <= CAPTURE_FILE_LIMIT && budget - size >= 0) {
            budget -= size;
            bytesSinceYield += size;
            const data = (await fsp.readFile(full)).toString('base64');
            state = { kind: 'file', data, stamp, mode };
            nextCache.set(full, { stamp, mode, data });
          } else {
            // 超大文件 / 预算耗尽:只留指纹,能报告变化但不参与内容恢复。
            state = { kind: 'file', stamp, mode };
          }
        } else {
          state = { kind: 'missing' };
        }
      } catch {
        state = { kind: 'missing' }; // 不存在或不可读:工具若最终也不可读,不会产生伪变化
      }
      if (state.kind === 'missing') continue;
      entries.set(toRel(full), state);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, paths.length)) }, worker));

  // 缓存整体替换:已删除的文件自然被淘汰,内存上限 ≈ CAPTURE_TOTAL_LIMIT。
  contentCache = nextCache;
  return entries;
}

/** run_command/MCP 前调用。不跟随 symlink，并排除 .git、会话快照、依赖树与代码索引。 */
export async function beginWorkspaceMutation(): Promise<WorkspaceMutationCapture> {
  return { sequence: ++sequenceCounter, entries: await scanWorkspace() };
}

/** 不透明工具执行后比较整个工作区，把实际变化压入当前轮事务日志。 */
export async function endWorkspaceMutation(capture: WorkspaceMutationCapture, op: string): Promise<void> {
  const after = await scanWorkspace();
  const paths = new Set([...capture.entries.keys(), ...after.keys()]);
  let changed = false;
  for (const rel of paths) {
    const beforeState = capture.entries.get(rel) ?? { kind: 'missing' as const };
    const afterState = after.get(rel) ?? { kind: 'missing' as const };
    if (sameState(beforeState, afterState)) continue;
    changed = true;
    addSnapshot(snapshotFromState(rel, beforeState, capture.sequence, op, [], afterState));
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
      change = {
        path: snapshot.path,
        ops: [],
        snapshotAvailable: snapshot.contentUnavailable !== true,
      };
      byPath.set(snapshot.path, change);
      order.push(snapshot.path);
    }
    if (snapshot.contentUnavailable) change.snapshotAvailable = false;
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
    if (snapshot.contentUnavailable) change.snapshotAvailable = false;
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
  // 内容未捕获(工作区扫描时超出预算):宁可报冲突,也不能拿空内容覆盖用户文件。
  if (snapshot.contentUnavailable) return false;
  const state = stateFromSnapshot(snapshot);
  try {
    if (state.kind === 'missing') {
      const current = readState(full);
      if (current.kind === 'directory') rmdirSync(full);
      else rmSync(full, { recursive: false, force: true });
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
): { deletedMsgs: number; revertedFiles: string[]; conflictedFiles: string[] } {
  const deletedMsgs = history.length - plan.cutoffIndex;
  history.length = plan.cutoffIndex;

  const picks = new Map<string, Snapshot>();
  const latest = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.turnId <= plan.cutoffTurnId || !revertPaths.has(snapshot.path)) continue;
    const latestSnapshot = latest.get(snapshot.path);
    if (
      !latestSnapshot ||
      snapshot.turnId > latestSnapshot.turnId ||
      (snapshot.turnId === latestSnapshot.turnId && (snapshot.sequence ?? -1) > (latestSnapshot.sequence ?? -1))
    ) {
      latest.set(snapshot.path, snapshot);
    }
    const existing = picks.get(snapshot.path);
    if (
      !existing ||
      snapshot.turnId < existing.turnId ||
      (snapshot.turnId === existing.turnId &&
        (snapshot.sequence ?? Number.MAX_SAFE_INTEGER) < (existing.sequence ?? Number.MAX_SAFE_INTEGER))
    ) {
      picks.set(snapshot.path, snapshot);
    }
  }

  const selected: Snapshot[] = [];
  const conflictedFiles: string[] = [];
  for (const snapshot of picks.values()) {
    const expected = latest.get(snapshot.path)?.afterFingerprint;
    const full = safeFullPath(snapshot.path);
    if (expected && (!full || stateFingerprint(readState(full)) !== expected)) {
      conflictedFiles.push(snapshot.path);
    } else {
      selected.push(snapshot);
    }
  }
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
    else if (!conflictedFiles.includes(snapshot.path)) conflictedFiles.push(snapshot.path);
  }

  turns = turns.filter((turn) => turn.turnId <= plan.cutoffTurnId);
  snapshots = snapshots.filter((snapshot) => snapshot.turnId <= plan.cutoffTurnId);
  currentTurnId = turns.at(-1)?.turnId ?? 0;
  return { deletedMsgs, revertedFiles, conflictedFiles };
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
  contentCache = new Map();
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
    writeFileSync(current, JSON.stringify({ version: 2, turns, snapshots }), 'utf8');
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
    sequenceCounter = snapshots.reduce((max, snapshot) => Math.max(max, snapshot.sequence ?? 0), 0);
    currentTurnId = 0;
    return true;
  } catch {
    return false;
  }
}
