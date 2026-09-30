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

/**
 * 把 worktree 相对 HEAD 的全部改动导出为 unified diff（含未跟踪文件，binary 标记为
 * Binary files differ）。无改动返回 null（调用方不写空 patch 文件）。
 *
 * 用 spawnSync 而非异步 spawn：本函数只在 headless/runner 的收尾路径调用（事件循环
 * 已无流式渲染在跑），且 removeWorktree 本身就是同步链，拆异步收益为零。
 */
export function exportWorktreePatch(wt: Worktree): string | null {
  const status = git(['status', '--porcelain'], wt.path);
  if (!status.ok || !status.output) return null; // 无改动 / git 不可用
  // 未跟踪文件：先 git add -N(intent-to-add) 让 diff 能覆盖新文件,否则 --worktree
  // 默认跳过 untracked,新建的文件会随 worktree 一起消失。--intent-to-add 不改
  // index 的实际内容、不产生对象,worktree remove --force 可正常清理。
  git(['add', '-N', '.'], wt.path);
  const diff = git(['diff', 'HEAD', '--binary'], wt.path);
  if (!diff.ok || !diff.output) return null;
  return `${diff.output}\n`;
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
