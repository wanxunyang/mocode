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
import { toText } from '../context/utils.js';
import type { ChatMessage } from '../llm/index.js';
import { truncateDisplay } from '../ui/render.js';

/**
 * 回滚子系统：以工作区文件快照记录每轮模型造成的实际变化，完全不读写 Git。
 * write_file/edit_file 使用单路径前后快照；run_command/MCP 等不透明工具使用工作区
 * 前后快照。回滚只恢复工作树，始终排除 .git，因此不会改变 index/暂存区。
 */

export interface Turn {
  turnId: number;
  firstLine: string;
}

export type SnapshotKind = 'missing' | 'file' | 'directory' | 'symlink';
export interface StoredState {
  kind: SnapshotKind;
  data?: string;
  mode?: number;
  /** 廉价变更指纹(file=`size:mtimeNs`,symlink=target,directory='')。 */
  stamp?: string;
}

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
  /** begin 时固定，避免异步工具结束时被其它 runtime 的 beginTurn 污染。 */
  turnId: number;
  /** begin 时固定，避免执行期间 cwd/provider 改变。 */
  workspaceRoot: string;
}

export interface WorkspaceMutationCapture {
  sequence: number;
  entries: Map<string, StoredState>;
  /** begin 时固定，end 必须扫描同一工作区并记入同一轮。 */
  turnId: number;
  workspaceRoot: string;
  sessionsRoot: string;
}

export interface CurrentTurnMutationState {
  version: number;
  changedFiles: FileChange[];
}

export type RollbackRootProvider = () => string;
export type RollbackRootSource = string | RollbackRootProvider;

const EXCLUDED_WORKSPACE_DIRS: readonly string[] = Object.freeze([
  '.git',
  '.hg',
  '.svn',
  '.codegraph',
  '.mocode',
  'node_modules',
  'vendor',
  'bower_components',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  'pods',
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

const CAPTURE_FILE_LIMIT = 1024 * 1024;
const CAPTURE_TOTAL_LIMIT = 32 * 1024 * 1024;
const CAPTURE_ENTRY_LIMIT = 20000;
const SCAN_CONCURRENCY = 16;
const YIELD_EVERY = 64;
const YIELD_BYTES = 1024 * 1024;
const FRESH_WINDOW_MS = 2000;

interface CachedContent {
  stamp: string;
  mode: number;
  data: string;
}

/**
 * 一个完整、实例隔离的回滚事务存储。每个 runtime 可持有独立实例，使轮次、序号、
 * 快照、mutation generation 和扫描缓存互不干扰。
 */
export class RollbackStore {
  private turnIdCounter = 0;
  private currentTurnId = 0;
  private sequenceCounter = 0;
  private mutationVersion = 0;
  private turns: Turn[] = [];
  private snapshots: Snapshot[] = [];
  private contentCache = new Map<string, CachedContent>();
  private readonly workspaceRootProvider: RollbackRootProvider;
  private readonly sessionsRootProvider: RollbackRootProvider;

  constructor(
    workspaceRoot: RollbackRootSource = () => process.cwd(),
    sessionsRoot: RollbackRootSource = () => config.sessionDir,
  ) {
    this.workspaceRootProvider = this.rootProvider(workspaceRoot);
    this.sessionsRootProvider = this.rootProvider(sessionsRoot);
  }

  private rootProvider(source: RollbackRootSource): RollbackRootProvider {
    if (typeof source === 'string') {
      const fixed = path.resolve(source);
      return () => fixed;
    }
    return () => path.resolve(source());
  }

  private rootDir(): string {
    return this.workspaceRootProvider();
  }

  private sessionsDir(): string {
    return this.sessionsRootProvider();
  }

  private yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  private isInside(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private toRel(root: string, value: string): string {
    try {
      const rel = path.relative(root, path.resolve(root, value));
      return rel === '' ? '.' : rel;
    } catch {
      return value;
    }
  }

  private safeFullPath(root: string, rel: string): string | null {
    const full = path.resolve(root, rel);
    return full !== root && this.isInside(root, full) ? full : null;
  }

  private readState(full: string): StoredState {
    try {
      const stat = lstatSync(full);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) return { kind: 'symlink', data: readlinkSync(full), mode };
      if (stat.isDirectory()) return { kind: 'directory', mode };
      if (stat.isFile()) return { kind: 'file', data: readFileSync(full).toString('base64'), mode };
    } catch {
      // 不存在或不可读均按 missing；工具若最终也不可读，不会产生伪变化。
    }
    return { kind: 'missing' };
  }

  private sameState(a: StoredState, b: StoredState): boolean {
    if (a.kind !== b.kind || a.mode !== b.mode) return false;
    if (a.data !== undefined && b.data !== undefined) return a.data === b.data;
    if (a.data === undefined && b.data === undefined && a.stamp === undefined && b.stamp === undefined) return true;
    return a.stamp === b.stamp;
  }

  private stateFingerprint(state: StoredState): string {
    return createHash('sha256')
      .update(JSON.stringify([state.kind, state.data ?? null, state.mode ?? null]))
      .digest('hex');
  }

  private stateFromSnapshot(snapshot: Snapshot): StoredState {
    if (snapshot.kind) return { kind: snapshot.kind, data: snapshot.before ?? undefined, mode: snapshot.mode };
    if (snapshot.before === null) return { kind: 'missing' };
    return { kind: 'file', data: Buffer.from(snapshot.before, 'utf8').toString('base64') };
  }

  private snapshotFromState(
    turnId: number,
    rel: string,
    state: StoredState,
    sequence: number,
    op: string,
    createdParents: string[] = [],
    after?: StoredState,
  ): Snapshot {
    return {
      turnId,
      path: rel,
      before: state.data ?? null,
      kind: state.kind,
      encoding: state.kind === 'file' ? 'base64' : undefined,
      mode: state.mode,
      sequence,
      ops: [op],
      createdParents: createdParents.length > 0 ? createdParents : undefined,
      afterFingerprint: after ? this.stateFingerprint(after) : undefined,
      contentUnavailable: state.kind === 'file' && state.data === undefined ? true : undefined,
    };
  }

  private addSnapshot(next: Snapshot): void {
    if (next.turnId <= 0) return;
    const existingIndex = this.snapshots.findIndex((item) => item.turnId === next.turnId && item.path === next.path);
    if (existingIndex < 0) {
      this.snapshots.push(next);
      return;
    }
    const existing = this.snapshots[existingIndex];
    const existingSequence = existing.sequence ?? Number.MAX_SAFE_INTEGER;
    const nextSequence = next.sequence ?? Number.MAX_SAFE_INTEGER;
    const ops = new Set([...(existing.ops ?? []), ...(next.ops ?? [])]);
    const latestAfterFingerprint = nextSequence >= existingSequence ? next.afterFingerprint : existing.afterFingerprint;
    if (nextSequence < existingSequence) {
      this.snapshots[existingIndex] = { ...next, ops: [...ops], afterFingerprint: latestAfterFingerprint };
    } else {
      existing.ops = [...ops];
      existing.afterFingerprint = latestAfterFingerprint;
    }
  }

  private missingParents(root: string, full: string): string[] {
    const result: string[] = [];
    let current = path.dirname(full);
    while (current !== root && this.isInside(root, current)) {
      if (existsSync(current)) break;
      result.push(this.toRel(root, current));
      current = path.dirname(current);
    }
    return result;
  }

  beginTurn(firstLine: string): number {
    this.turnIdCounter += 1;
    this.currentTurnId = this.turnIdCounter;
    this.turns.push({ turnId: this.currentTurnId, firstLine });
    return this.currentTurnId;
  }

  getCurrentTurnId(): number {
    return this.currentTurnId;
  }

  beginPathMutation(value: string): PathMutationCapture {
    const workspaceRoot = this.rootDir();
    const full = path.resolve(workspaceRoot, value);
    return {
      path: this.toRel(workspaceRoot, full),
      before: this.readState(full),
      sequence: ++this.sequenceCounter,
      createdParents: this.missingParents(workspaceRoot, full),
      turnId: this.currentTurnId,
      workspaceRoot,
    };
  }

  endPathMutation(capture: PathMutationCapture, op: string): void {
    const full = this.safeFullPath(capture.workspaceRoot, capture.path);
    if (!full) return;
    let changed = false;
    const after = this.readState(full);
    if (!this.sameState(capture.before, after)) {
      changed = true;
      this.addSnapshot(
        this.snapshotFromState(
          capture.turnId,
          capture.path,
          capture.before,
          capture.sequence,
          op,
          capture.createdParents,
          after,
        ),
      );
    }
    for (const parentRel of capture.createdParents) {
      const parent = this.safeFullPath(capture.workspaceRoot, parentRel);
      if (!parent) continue;
      const parentState = this.readState(parent);
      if (parentState.kind !== 'missing') {
        changed = true;
        this.addSnapshot(
          this.snapshotFromState(capture.turnId, parentRel, { kind: 'missing' }, capture.sequence, op, [], parentState),
        );
      }
    }
    if (changed) this.mutationVersion += 1;
  }

  private isWorkspaceExcluded(full: string, sessionsRoot: string): boolean {
    const base = path.basename(full).toLowerCase();
    if (EXCLUDED_WORKSPACE_DIRS.includes(base)) return true;
    return this.isInside(sessionsRoot, full);
  }

  private async scanWorkspace(workspaceRoot: string, sessionsRoot: string): Promise<Map<string, StoredState>> {
    const entries = new Map<string, StoredState>();
    const nextCache = new Map<string, CachedContent>();
    const paths: string[] = [];

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
        if (this.isWorkspaceExcluded(full, sessionsRoot)) continue;
        paths.push(full);
        if (child.isDirectory()) await walk(full);
      }
    };
    await walk(workspaceRoot);

    let budget = CAPTURE_TOTAL_LIMIT;
    let cursor = 0;
    let processed = 0;
    let bytesSinceYield = 0;
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const full = paths[cursor++];
        if (++processed % YIELD_EVERY === 0 || bytesSinceYield >= YIELD_BYTES) {
          bytesSinceYield = 0;
          await this.yieldToEventLoop();
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
            const fresh = Date.now() - Number(stat.mtimeNs / 1000000n) < FRESH_WINDOW_MS;
            const cached = fresh ? undefined : this.contentCache.get(full);
            if (cached && cached.stamp === stamp && cached.mode === mode) {
              budget -= size;
              state = { kind: 'file', data: cached.data, stamp, mode };
              nextCache.set(full, cached);
            } else if (size <= CAPTURE_FILE_LIMIT && budget - size >= 0) {
              budget -= size;
              bytesSinceYield += size;
              const data = (await fsp.readFile(full)).toString('base64');
              state = { kind: 'file', data, stamp, mode };
              nextCache.set(full, { stamp, mode, data });
            } else {
              state = { kind: 'file', stamp, mode };
            }
          } else {
            state = { kind: 'missing' };
          }
        } catch {
          state = { kind: 'missing' };
        }
        if (state.kind !== 'missing') entries.set(this.toRel(workspaceRoot, full), state);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(1, paths.length)) }, worker));
    this.contentCache = nextCache;
    return entries;
  }

  async beginWorkspaceMutation(): Promise<WorkspaceMutationCapture> {
    const turnId = this.currentTurnId;
    const sequence = ++this.sequenceCounter;
    const workspaceRoot = this.rootDir();
    const sessionsRoot = this.sessionsDir();
    const entries = await this.scanWorkspace(workspaceRoot, sessionsRoot);
    return {
      sequence,
      entries,
      turnId,
      workspaceRoot,
      sessionsRoot,
    };
  }

  async endWorkspaceMutation(capture: WorkspaceMutationCapture, op: string): Promise<void> {
    const after = await this.scanWorkspace(capture.workspaceRoot, capture.sessionsRoot);
    const paths = new Set([...capture.entries.keys(), ...after.keys()]);
    let changed = false;
    for (const rel of paths) {
      const beforeState = capture.entries.get(rel) ?? { kind: 'missing' as const };
      const afterState = after.get(rel) ?? { kind: 'missing' as const };
      if (this.sameState(beforeState, afterState)) continue;
      changed = true;
      this.addSnapshot(this.snapshotFromState(capture.turnId, rel, beforeState, capture.sequence, op, [], afterState));
    }
    if (changed) this.mutationVersion += 1;
  }

  getCurrentTurnMutationState(): CurrentTurnMutationState {
    const order: string[] = [];
    const byPath = new Map<string, FileChange>();
    for (const snapshot of this.snapshots) {
      if (snapshot.turnId !== this.currentTurnId) continue;
      let change = byPath.get(snapshot.path);
      if (!change) {
        change = { path: snapshot.path, ops: [], snapshotAvailable: snapshot.contentUnavailable !== true };
        byPath.set(snapshot.path, change);
        order.push(snapshot.path);
      }
      if (snapshot.contentUnavailable) change.snapshotAvailable = false;
      for (const op of snapshot.ops ?? ['file_change']) {
        if (!change.ops.includes(op)) change.ops.push(op);
      }
    }
    return { version: this.mutationVersion, changedFiles: order.map((item) => byPath.get(item)!) };
  }

  listTurns(): Turn[] {
    return this.turns.slice();
  }

  private findCutoffIndex(n: number, history: ChatMessage[]): number {
    let seen = 0;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        seen += 1;
        if (seen === n + 1) return i;
      }
    }
    return history.length;
  }

  planRollback(n: number, history: ChatMessage[]): RollbackPlan {
    const cutoffTurnId = this.turns[n - 1]?.turnId ?? 0;
    const cutoffIndex = this.findCutoffIndex(n, history);
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

    for (const snapshot of this.snapshots) {
      if (snapshot.turnId <= cutoffTurnId) continue;
      const change = ensure(snapshot.path);
      if (snapshot.contentUnavailable) change.snapshotAvailable = false;
      for (const op of snapshot.ops ?? ['file_change']) {
        if (!change.ops.includes(op)) change.ops.push(op);
      }
    }
    return { n, cutoffIndex, cutoffTurnId, changes: order.map((rel) => map.get(rel)!) };
  }

  private depth(rel: string): number {
    return rel.split(/[\\/]+/).length;
  }

  private restoreSnapshot(root: string, snapshot: Snapshot): boolean {
    const full = this.safeFullPath(root, snapshot.path);
    if (!full || snapshot.contentUnavailable) return false;
    const state = this.stateFromSnapshot(snapshot);
    try {
      if (state.kind === 'missing') {
        const current = this.readState(full);
        if (current.kind === 'directory') rmdirSync(full);
        else rmSync(full, { recursive: false, force: true });
        for (const parentRel of snapshot.createdParents ?? []) {
          const parent = this.safeFullPath(root, parentRel);
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
        const current = this.readState(full);
        if (current.kind !== 'missing' && current.kind !== 'directory') rmSync(full, { recursive: true, force: true });
        mkdirSync(full, { recursive: true });
      } else {
        mkdirSync(path.dirname(full), { recursive: true });
        rmSync(full, { recursive: true, force: true });
        if (state.kind === 'file') writeFileSync(full, Buffer.from(state.data ?? '', 'base64'));
        else symlinkSync(state.data ?? '', full);
      }
      if (state.mode !== undefined && state.kind !== 'symlink') chmodSync(full, state.mode);
      return true;
    } catch {
      return false;
    }
  }

  applyRollback(
    plan: RollbackPlan,
    history: ChatMessage[],
    revertPaths: Set<string>,
  ): { deletedMsgs: number; revertedFiles: string[]; conflictedFiles: string[] } {
    const deletedMsgs = history.length - plan.cutoffIndex;
    history.length = plan.cutoffIndex;

    const picks = new Map<string, Snapshot>();
    const latest = new Map<string, Snapshot>();
    for (const snapshot of this.snapshots) {
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

    const root = this.rootDir();
    const selected: Snapshot[] = [];
    const conflictedFiles: string[] = [];
    for (const snapshot of picks.values()) {
      const expected = latest.get(snapshot.path)?.afterFingerprint;
      const full = this.safeFullPath(root, snapshot.path);
      if (expected && (!full || this.stateFingerprint(this.readState(full)) !== expected))
        conflictedFiles.push(snapshot.path);
      else selected.push(snapshot);
    }
    const removals = selected
      .filter((item) => this.stateFromSnapshot(item).kind === 'missing')
      .sort((a, b) => this.depth(b.path) - this.depth(a.path));
    const restores = selected
      .filter((item) => this.stateFromSnapshot(item).kind !== 'missing')
      .sort((a, b) => this.depth(a.path) - this.depth(b.path));
    const revertedFiles: string[] = [];
    for (const snapshot of [...removals, ...restores]) {
      if (this.restoreSnapshot(root, snapshot)) revertedFiles.push(snapshot.path);
      else if (!conflictedFiles.includes(snapshot.path)) conflictedFiles.push(snapshot.path);
    }

    this.turns = this.turns.filter((turn) => turn.turnId <= plan.cutoffTurnId);
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.turnId <= plan.cutoffTurnId);
    this.currentTurnId = this.turns.at(-1)?.turnId ?? 0;
    return { deletedMsgs, revertedFiles, conflictedFiles };
  }

  pruneAfterCompaction(history: ChatMessage[]): void {
    const count = history.filter((message) => message.role === 'user').length;
    this.turns = count >= this.turns.length ? this.turns : this.turns.slice(-count);
    const alive = new Set(this.turns.map((turn) => turn.turnId));
    this.snapshots = this.snapshots.filter((snapshot) => alive.has(snapshot.turnId));
  }

  resetState(): void {
    this.turns = [];
    this.snapshots = [];
    this.turnIdCounter = 0;
    this.currentTurnId = 0;
    this.sequenceCounter = 0;
    this.contentCache = new Map();
  }

  rebuildFromHistory(history: ChatMessage[]): void {
    const rebuilt: Turn[] = [];
    for (const message of history) {
      if (message.role !== 'user') continue;
      const first = toText((message as { content?: unknown }).content).split('\n')[0] ?? '';
      rebuilt.push({ turnId: rebuilt.length + 1, firstLine: truncateDisplay(first, 40) });
    }
    this.turns = rebuilt;
    this.snapshots = [];
    this.turnIdCounter = rebuilt.length;
    this.currentTurnId = 0;
    this.sequenceCounter = 0;
  }

  private snapshotsPath(id: string): string {
    const sessionsRoot = this.sessionsDir();
    const current = path.join(sessionsRoot, id, 'snapshots.json');
    if (existsSync(current)) return current;
    return path.join(sessionsRoot, `${id}.snapshots.json`);
  }

  persistSnapshots(id: string): void {
    const sessionsRoot = this.sessionsDir();
    const dir = path.join(sessionsRoot, id);
    const current = path.join(dir, 'snapshots.json');
    const legacy = path.join(sessionsRoot, `${id}.snapshots.json`);
    try {
      if (this.turns.length === 0) {
        if (existsSync(current)) unlinkSync(current);
        if (existsSync(legacy)) unlinkSync(legacy);
        return;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(current, JSON.stringify({ version: 2, turns: this.turns, snapshots: this.snapshots }), 'utf8');
      if (existsSync(legacy)) unlinkSync(legacy);
    } catch {
      // 落盘失败不阻断会话；只失去跨重启回滚能力。
    }
  }

  loadSnapshots(id: string): boolean {
    const snapshotFile = this.snapshotsPath(id);
    if (!existsSync(snapshotFile)) return false;
    try {
      const record = JSON.parse(readFileSync(snapshotFile, 'utf8')) as { turns?: Turn[]; snapshots?: Snapshot[] };
      if (!record || !Array.isArray(record.turns) || !Array.isArray(record.snapshots)) return false;
      this.turns = record.turns;
      this.snapshots = record.snapshots;
      this.turnIdCounter = this.turns.reduce((max, turn) => Math.max(max, turn.turnId), 0);
      this.sequenceCounter = this.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.sequence ?? 0), 0);
      this.currentTurnId = 0;
      return true;
    } catch {
      return false;
    }
  }
}
