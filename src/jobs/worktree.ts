// Git worktree 隔离：为一次性任务创建 detached worktree（独立工作树 + 独立
// sandboxRoot），结束后销毁。任务写盘全部落在 worktree，主工作区零污染。
//
// 附带 node_modules 链接：新 worktree 没有依赖，跑不了构建/测试；junction(Win)/
// symlink(POSIX) 指向原仓库 node_modules，删链接不影响目标。

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function git(args: string[], cwd: string): { ok: boolean; output: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
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
export function createWorktree(): Worktree {
  const repoRoot = gitTopLevel();
  if (!repoRoot) throw new Error('not a git repository (worktree isolation requires git)');

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
