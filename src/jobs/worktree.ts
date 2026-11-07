// Git worktree 隔离：为一次性任务创建 detached worktree（独立工作树 + 独立
// sandboxRoot），结束后销毁。任务写盘全部落在 worktree，主工作区零污染。
//
// 附带 node_modules 链接：新 worktree 没有依赖，跑不了构建/测试；junction(Win)/
// symlink(POSIX) 指向原仓库 node_modules，删链接不影响目标。

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function gitRaw(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function git(args: string[], cwd: string): { ok: boolean; output: string } {
  const result = gitRaw(args, cwd);
  return { ok: result.ok, output: `${result.stdout}${result.stderr}`.trim() };
}

/** 当前 git 仓库根；不是 git 仓库时返回 null。 */
export function gitTopLevel(cwd: string = process.cwd()): string | null {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? resolve(r.output.split('\n')[0] ?? '') : null;
}

export interface Worktree {
  path: string;
  repoRoot: string;
}

/**
 * 创建 detached worktree（基于 HEAD）。
 * 失败（非 git 仓库 / 有未跟踪冲突）抛错，由调用方决定是否回退普通模式。
 */
export function createWorktree(cwd: string = process.cwd()): Worktree {
  const repoRoot = gitTopLevel(cwd);
  if (!repoRoot) throw new Error(`not a git repository: ${cwd} (worktree isolation requires git)`);

  const id = `${Date.now()}-${randomBytes(2).toString('hex')}`;
  const wtPath = join(repoRoot, '.mocode', 'worktrees', `wt-${id}`);
  mkdirSync(join(repoRoot, '.mocode', 'worktrees'), { recursive: true });

  const added = git(['worktree', 'add', '--detach', wtPath, 'HEAD'], repoRoot);
  if (!added.ok) throw new Error(`git worktree add failed: ${added.output}`);

  // 链接 node_modules（若主仓库有），否则 worktree 内无法构建。
  const sourceModules = join(repoRoot, 'node_modules');
  if (existsSync(sourceModules)) {
    const link = join(wtPath, 'node_modules');
    if (process.platform === 'win32') {
      // directory junction：不需要管理员；rmdir 删链接不动目标。
      spawnSync('cmd', ['/c', 'mklink', '/J', link, sourceModules], { windowsHide: true });
    } else {
      symlinkSync(sourceModules, link, 'dir');
    }
  }

  return { path: wtPath, repoRoot };
}

/** 主仓库是否有未提交改动：worktree 基于 HEAD，看不到它们，调用方可据此提示 Worker 视角。 */
export function gitRepositoryDirty(dir: string): boolean {
  const status = git(['status', '--porcelain', '--untracked-files=normal'], dir);
  return status.ok && status.output.length > 0;
}

export interface WorktreeChanges {
  changedFiles: string[];
  patch: string | null;
  /** 当前内容的 tree 对象；同一条 lane 内可作为下一个 attempt 的 diff 基线。 */
  tree: string;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function headTree(wt: Worktree): string {
  const head = git(['rev-parse', 'HEAD^{tree}'], wt.path);
  // 空仓库没有 HEAD：以空 tree 为基线，未跟踪文件即全部改动。
  return head.ok && head.output ? head.output : EMPTY_TREE;
}

/**
 * 把 worktree 当前内容写成 tree 对象（只写 index，不提交），再相对 baselineTree 计算改动。
 * 共享 worktree 的 lane 靠它把「本次 attempt 的产出」与之前 attempt 的成果区分开；
 * baselineTree 省略时以 HEAD 为基线。
 */
export function snapshotWorktreeChanges(wt: Worktree, baselineTree?: string): WorktreeChanges {
  // add -A 让修改、删除、未跟踪文件都进入 index，write-tree 才能给出完整内容。
  const added = git(['add', '-A', '--', '.'], wt.path);
  if (!added.ok) throw new Error(`git add -A failed: ${added.output}`);
  const written = git(['write-tree'], wt.path);
  if (!written.ok || !written.output) throw new Error(`git write-tree failed: ${written.output}`);
  const tree = written.output;
  const baseline = baselineTree ?? headTree(wt);
  if (baseline === tree) return { changedFiles: [], patch: null, tree };
  const names = gitRaw(['diff', '--name-only', '-z', baseline, tree, '--'], wt.path);
  if (!names.ok) throw new Error(`git diff --name-only failed: ${names.stderr.trim()}`);
  const changedFiles = [...new Set(names.stdout.split('\0').filter(Boolean))].sort();
  const diff = gitRaw(['diff', '--binary', baseline, tree, '--'], wt.path);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  if (!diff.stdout) throw new Error('git reported changes but produced an empty patch.');
  return { changedFiles, patch: diff.stdout.endsWith('\n') ? diff.stdout : `${diff.stdout}\n`, tree };
}

/**
 * 严格收集 worktree 相对 HEAD 的文件列表与 unified diff。无改动不是错误；Git 命令失败会
 * 抛错，供需要保证成果不丢失的编排器决定保留 worktree。
 */
export function collectWorktreeChanges(wt: Worktree): WorktreeChanges {
  return snapshotWorktreeChanges(wt);
}

/** worktree 目录是否仍然可用（被手工删掉或 prune 后不能复用）。 */
export function worktreeIsUsable(wtPath: string): boolean {
  return existsSync(join(wtPath, '.git'));
}

/**
 * 兼容旧调用方：无改动或 Git 导出失败均返回 null。需要区分两者的新代码应使用
 * collectWorktreeChanges，避免在成果未保存时销毁 worktree。
 */
export function exportWorktreePatch(wt: Worktree): string | null {
  try {
    return collectWorktreeChanges(wt).patch;
  } catch {
    return null;
  }
}

/** 先删 node_modules 链接（防误伤目标），再移除 worktree + prune。 */
export function removeWorktree(wt: Worktree): void {
  const link = join(wt.path, 'node_modules');
  if (existsSync(link)) {
    try {
      if (process.platform === 'win32')
        rmdirSync(link); // junction：仅删链接
      else rmdirSync(link);
    } catch {
      // 链接删不掉仍尝试 worktree remove
    }
  }
  git(['worktree', 'remove', '--force', wt.path], wt.repoRoot);
  git(['worktree', 'prune'], wt.repoRoot);
}
