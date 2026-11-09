// Lane 的「执行现场」：git worktree / 非 git 副本 / 原地目录的打开、基线、差分与收尾。
//
// 为什么单独成模块：同一套现场语义现在有两个执行器要用——
//   - `HostWorkerExecutor`（headless：spawn bin/mocode-agent-host.js，跑 runAgentCore）；
//   - `LaneReplExecutor`（可视：开一个真 mocode REPL 窗口，经 lane.commands/events 驱动）。
// 两个执行器如果各自实现一遍 patch/diff 口径，迟早会在「什么算改动」上分叉，所以现场逻辑
// 只此一份，执行器只负责「用谁去干活」。
//
// 这里的任何一步无法归档都必须保留现场：lane 可能是成果的唯一副本。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorktree,
  removeWorktree,
  snapshotWorktreeChanges,
  worktreeIsUsable,
  type Worktree,
  type WorktreeAuditOptions,
  type WorktreeChanges,
} from '../jobs/worktree.js';
import {
  createDirCopy,
  diffRoots,
  diffSnapshots,
  isMocodeRuntimeState,
  readSnapshot,
  snapshotDirectory,
  writeSnapshot,
  type DirSnapshot,
} from '../jobs/dir-snapshot.js';
import { validateChangedFiles } from './scope.js';
import type { LaneCloseRequest, LaneCloseResult, LaneRequest, TaskContract, WorkerTaskRequest } from './types.js';

export type ExecMode = 'worktree' | 'copy' | 'inplace';

/** 一次 attempt 的执行现场：git worktree、非 git 副本，或原地目录。 */
export interface ExecSite {
  path: string;
  repoRoot: string;
  mode: ExecMode;
  /** 本次是否新建（新建才需要上报基线）。 */
  created: boolean;
}

/**
 * 非 git 档位的差分与复制排除项：`.mocode` 下的运行时目录（会话、编排账本、历史现场）既不该被当成
 * 用户改动，也不该在复制时被算进体积预算。项目级 `.mocode/config` 仍然保留，副本里配置不变。
 */
export const NON_GIT_EXCLUDES = ['.mocode/sessions', '.mocode/orchestrations', '.mocode/worktrees', '.mocode/lanes'];

/**
 * 改动审计的排除规则。除运行时目录外还要剔除 mocode 自己写出的状态（记忆、统计、便签）：
 * 那些不是 Worker 对用户代码的改动，否则 `read_only` 任务会被自己的运行时文件误判成「改了文件」。
 */
export const AUDIT_OPTIONS = { excludes: NON_GIT_EXCLUDES, ignore: isMocodeRuntimeState };

/** 默认的副本落点根：与编排账本同在 `~/.mocode` 下，但不在任何工作区内部。 */
export function defaultCopyRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MOCODE_LANE_COPY_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.mocode', 'lanes');
}

export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 选一个**不在源目录内部**的副本落点。
 *
 * 副本绝不能落在被复制的目录里：`fs.cpSync` 会拒绝「复制到自身子目录」，
 * 而且落进去的副本又会被下一次复制再复制一遍。默认落在 `~/.mocode/lanes`，
 * 但工作区本身可能就是家目录，所以再退一步到系统临时目录；都落在源内才报错。
 */
export function resolveCopyTarget(source: string, preferredRoot: string, runId: string, laneId: string): string {
  for (const root of [preferredRoot, path.join(os.tmpdir(), 'mocode-lanes')]) {
    const target = path.join(root, runId, laneId, 'copy');
    if (!isWithin(source, target)) return target;
  }
  throw new Error(
    `Cannot place the isolated copy for lane ${laneId}: every candidate root is inside ${source}. ` +
      'Set MOCODE_LANE_COPY_ROOT to a directory outside it, or run in place with --allow-inplace.',
  );
}

export function orchestrationDir(run: { id: string; workspaceRoot: string }): string {
  return path.join(run.workspaceRoot, '.mocode', 'orchestrations', run.id);
}

export interface LaneSiteOptions {
  createWorktree?: (cwd: string) => Worktree;
  collectChanges?: (worktree: Worktree, baselineTree?: string, options?: WorktreeAuditOptions) => WorktreeChanges;
  removeWorktree?: (worktree: Worktree) => void;
  /** copy 档位的体积上限（字节），默认读 MOCODE_LANE_COPY_MAX_MB。 */
  copyLimitBytes?: number;
  /** copy 副本的落点根目录；默认 `~/.mocode/lanes`（`MOCODE_LANE_COPY_ROOT` 可覆盖）。 */
  copyRoot?: string;
}

export interface CollectContext {
  run: WorkerTaskRequest['run'];
  laneId: string;
  attempt: number | 'close';
  baselineTree?: string;
  baselineIndex?: string;
}

/** 现场管理：打开 / 算基线 / 差分 / 写 attempt patch / 收尾归档。 */
export class LaneSite {
  private readonly createIsolatedWorktree: (cwd: string) => Worktree;
  private readonly collectChanges: (
    worktree: Worktree,
    baselineTree?: string,
    options?: WorktreeAuditOptions,
  ) => WorktreeChanges;
  private readonly removeIsolatedWorktree: (worktree: Worktree) => void;
  private readonly copyLimitBytes: number | undefined;
  private readonly copyRoot: string;

  constructor(options: LaneSiteOptions = {}) {
    this.createIsolatedWorktree = options.createWorktree ?? createWorktree;
    this.collectChanges = options.collectChanges ?? snapshotWorktreeChanges;
    this.removeIsolatedWorktree = options.removeWorktree ?? removeWorktree;
    this.copyLimitBytes = options.copyLimitBytes;
    this.copyRoot = options.copyRoot ? path.resolve(options.copyRoot) : defaultCopyRoot();
  }

  artifact(run: WorkerTaskRequest['run'], laneId: string, ...parts: string[]): string {
    const file = path.join(orchestrationDir(run), 'artifacts', 'lanes', laneId, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  }

  /**
   * 打开执行现场。git 仓库走 worktree（P1 行为），非 git 目录走副本；
   * `inplace` 必须由用户显式授权，否则拒绝执行——原地写不是系统能替用户做的决定。
   */
  openExecution(lane: LaneRequest | undefined, request: WorkerTaskRequest): ExecSite {
    const repoRoot = lane?.workspaceRoot ?? request.run.workspaceRoot;
    const mode: ExecMode = lane?.mode ?? 'worktree';
    if (mode === 'worktree') {
      if (lane?.worktreePath && worktreeIsUsable(lane.worktreePath)) {
        return { path: lane.worktreePath, repoRoot, mode, created: false };
      }
      const worktree = this.createIsolatedWorktree(repoRoot);
      return { path: worktree.path, repoRoot, mode, created: true };
    }
    if (mode === 'inplace') {
      if (!lane?.allowInplace) {
        throw new Error(
          `Lane ${lane?.id ?? '(unknown)'} targets a non-git workspace ${repoRoot}. ` +
            'Refusing to write in place without --allow-inplace; drop the flag to use a copy instead.',
        );
      }
      return { path: repoRoot, repoRoot, mode, created: !lane.worktreePath };
    }
    // copy：复用已有副本，否则整目录复制一份。
    if (lane?.worktreePath && fs.existsSync(lane.worktreePath)) {
      return { path: lane.worktreePath, repoRoot, mode, created: false };
    }
    const target = resolveCopyTarget(repoRoot, this.copyRoot, request.run.id, lane?.id ?? request.task.id);
    const created = createDirCopy(repoRoot, target, {
      excludes: NON_GIT_EXCLUDES,
      maxBytes: this.copyLimitBytes,
    });
    return { path: created, repoRoot, mode, created: true };
  }

  /** 新建现场时计算基线：git 用 tree 对象，非 git 用目录索引快照文件。 */
  baseFor(
    site: ExecSite,
    request: WorkerTaskRequest,
    lane: LaneRequest | undefined,
  ): { baseTree?: string; baseIndex?: string } {
    if (site.mode === 'worktree') {
      const base = this.collectChanges({ path: site.path, repoRoot: site.repoRoot });
      return { baseTree: base.tree };
    }
    const snapshot = snapshotDirectory(site.path, AUDIT_OPTIONS);
    const file = writeSnapshot(this.artifact(request.run, lane?.id ?? request.task.id, 'base-index.json'), snapshot);
    return { baseIndex: file };
  }

  collect(
    site: ExecSite,
    context: CollectContext,
  ): { changedFiles: string[]; patch: string | null; tree?: string; index?: string } {
    if (site.mode === 'worktree') {
      // 审计口径与 copy 档位保持一致：mocode 自己的运行时文件不算 Worker 的改动。
      // 少了这一层，git lane 里的 `read_only` 任务会被自己的 `.mocode/sessions/**` 判死。
      const changes = this.collectChanges(
        { path: site.path, repoRoot: site.repoRoot },
        context.baselineTree,
        AUDIT_OPTIONS,
      );
      return { changedFiles: changes.changedFiles, patch: changes.patch, tree: changes.tree };
    }
    const baselineFile = context.baselineIndex ?? this.artifact(context.run, context.laneId, 'base-index.json');
    let baseline: DirSnapshot;
    try {
      baseline = readSnapshot(baselineFile);
    } catch {
      baseline = snapshotDirectory(site.path, AUDIT_OPTIONS);
    }
    const current = snapshotDirectory(site.path, AUDIT_OPTIONS);
    const diff = diffSnapshots(baseline, current);
    const index = writeSnapshot(
      this.artifact(context.run, context.laneId, `attempt-${context.attempt}-index.json`),
      current,
    );
    // 副本档位的基线内容仍在原目录里，能给出真实 unified diff；
    // 原地写没有可用的旧内容，只报 changedFiles（lane.diff 由清单文件代替）。
    const patch =
      site.mode === 'copy' && diff.changed.length > 0
        ? diffRoots(site.repoRoot, site.path, diff.changed, AUDIT_OPTIONS) || null
        : null;
    return { changedFiles: diff.changed, patch, index };
  }

  /** 把一次 attempt 的差分落成产物；没有 patch 时返回 undefined（非 git 档位只能给清单）。 */
  writeAttemptPatch(
    run: WorkerTaskRequest['run'],
    taskId: string,
    attempt: number,
    changes: { patch: string | null; changedFiles: string[] },
    mode: ExecMode,
  ): string | undefined {
    if (!changes.patch) return undefined;
    const file = path.join(
      orchestrationDir(run),
      'artifacts',
      taskId,
      `attempt-${attempt}.${mode === 'worktree' ? 'patch' : 'diff'}`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, changes.patch, 'utf8');
    return file;
  }

  /** 控制面门槛：Worker 不能自宣完成却违反任务契约。 */
  violations(contract: TaskContract, changedFiles: readonly string[]): string[] {
    return [
      ...(contract.changePolicy === 'read_only' && changedFiles.length > 0
        ? [`Read-only worker modified files: ${changedFiles.join(', ')}`]
        : []),
      ...validateChangedFiles(contract, changedFiles),
    ];
  }

  /**
   * 收尾 lane：导出整条 lane 相对打开时的累计 diff、归档最终会话，再按需销毁执行现场。
   * 任何一步无法归档都保留现场——lane 可能是唯一的成果副本。
   */
  async closeLane(request: LaneCloseRequest): Promise<LaneCloseResult> {
    const { lane } = request;
    const mode: ExecMode = lane.mode ?? 'worktree';
    if (!lane.worktreePath) return { kept: mode === 'inplace' };
    if (mode === 'inplace') {
      // 原地写没有可删除的现场；留下的只有 changedFiles 清单与归档会话。
      const patchPath = this.writeInplaceManifest(request);
      const sessionArchivePath = this.archiveSession(request, lane.worktreePath);
      return { patchPath, sessionArchivePath, kept: true };
    }
    const site: ExecSite = { path: lane.worktreePath, repoRoot: lane.workspaceRoot, mode, created: false };
    let patchPath: string | undefined;
    let keep = lane.keepWorktree;
    let error: string | undefined;
    let sessionArchivePath: string | undefined;
    const exists = mode === 'worktree' ? worktreeIsUsable(site.path) : fs.existsSync(site.path);
    if (exists) {
      try {
        const changes = this.collect(site, {
          run: request.run,
          laneId: lane.id,
          attempt: 'close',
          // 收尾导出的是整条 lane 相对打开时的累计改动。
          baselineTree: lane.baseTree,
          baselineIndex: this.laneBaseIndex(request.run, lane.id),
        });
        if (changes.patch) {
          patchPath = this.artifact(request.run, lane.id, mode === 'worktree' ? 'lane.patch' : 'lane.diff');
          fs.writeFileSync(patchPath, changes.patch, 'utf8');
        } else if (changes.changedFiles.length > 0) {
          patchPath = this.artifact(request.run, lane.id, 'lane.files.json');
          fs.writeFileSync(
            patchPath,
            `${JSON.stringify({ mode, root: lane.workspaceRoot, changedFiles: changes.changedFiles }, null, 2)}\n`,
            'utf8',
          );
        }
      } catch (failure) {
        keep = true;
        error = `Lane artifact collection failed: ${failure instanceof Error ? failure.message : String(failure)}`;
      }
      try {
        sessionArchivePath = this.archiveSession(request, site.path);
      } catch (failure) {
        keep = true;
        error = `${error ? `${error} ` : ''}Lane session archive failed: ${
          failure instanceof Error ? failure.message : String(failure)
        }`;
      }
    }
    if (!keep) {
      try {
        if (mode === 'worktree') this.removeIsolatedWorktree({ path: site.path, repoRoot: site.repoRoot });
        else fs.rmSync(site.path, { recursive: true, force: true });
      } catch (failure) {
        error = `${error ? `${error} ` : ''}Execution site cleanup failed: ${
          failure instanceof Error ? failure.message : String(failure)
        }`;
      }
    }
    return { patchPath, sessionArchivePath, kept: keep, error };
  }

  private archiveSession(request: LaneCloseRequest, execPath: string): string | undefined {
    const { lane } = request;
    if (!lane.sessionId) return undefined;
    const source = path.join(execPath, '.mocode', 'sessions', lane.sessionId);
    if (!fs.existsSync(source)) return undefined;
    const target = path.join(
      request.run.workspaceRoot,
      '.mocode',
      'orchestrations',
      request.run.id,
      'artifacts',
      'lanes',
      lane.id,
      'session',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
    return target;
  }

  /** 打开 lane 时落下的目录索引基线（非 git 档位）；不存在时由 collect 退化处理。 */
  private laneBaseIndex(run: WorkerTaskRequest['run'], laneId: string): string {
    return this.artifact(run, laneId, 'base-index.json');
  }

  /** 原地写的 lane 收尾只留清单：没有基线内容就无法生成 diff，宁可说清楚也不伪造 patch。 */
  private writeInplaceManifest(request: LaneCloseRequest): string | undefined {
    const { lane } = request;
    try {
      const baseline = readSnapshot(this.laneBaseIndex(request.run, lane.id));
      const current = snapshotDirectory(lane.workspaceRoot, AUDIT_OPTIONS);
      const diff = diffSnapshots(baseline, current);
      const file = this.artifact(request.run, lane.id, 'lane.files.json');
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mode: 'inplace', root: lane.workspaceRoot, changedFiles: diff.changed }, null, 2)}\n`,
        'utf8',
      );
      return file;
    } catch {
      return undefined;
    }
  }
}
