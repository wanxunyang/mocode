// lane 档位与 Run 定义的落定（CLI `supervise start/dispatch` 与 Supervisor 对话工具共用）。
//
// 这里只做「纯判定 + 目录校验」，不碰账本也不启动调度：`resolveLaneMode` 决定一条 lane 写在哪，
// `prepareDefinition` 在建 Run 之前把所有 lane 的绝对路径与档位钉死。两者原本住在 cli.ts，
// 抽出来的原因只有一个—— Supervisor 的工具集也要用同一套规则，不能各写一份。

import fs from 'node:fs';
import path from 'node:path';
import { gitTopLevel } from '../jobs/worktree.js';
import type { LaneInput, LaneMode, OrchestrationDefinition } from './types.js';

/** 该目录能否用 git worktree 隔离：必须是仓库根，而不是仓库里的子目录。 */
export function gitRootStatus(dir: string): 'root' | 'subdirectory' | 'none' {
  const top = gitTopLevel(dir);
  if (!top) return 'none';
  return path.resolve(top) === path.resolve(dir) ? 'root' : 'subdirectory';
}

/**
 * 按工作区能力决定执行档位：git 仓库根 → worktree；其它 → copy（非 git 的默认选择）。
 * `inplace` 只有在用户显式 `--allow-inplace` 时才允许，否则直接报错而不是静默降级。
 */
export function resolveLaneMode(dir: string, declared: LaneMode | undefined, allowInplace: boolean): LaneMode {
  if (!fs.existsSync(dir)) throw new Error(`workspace does not exist: ${dir}`);
  const git = gitRootStatus(dir);
  if (declared === 'inplace') {
    if (!allowInplace) {
      throw new Error(
        `${dir} would be modified in place. Pass --allow-inplace to accept that, or drop the mode to use a copy.`,
      );
    }
    return 'inplace';
  }
  if (declared === 'copy') return 'copy';
  if (declared === 'worktree') {
    if (git !== 'root') {
      throw new Error(
        `${dir} cannot use the worktree mode (${git === 'none' ? 'not a git repository' : 'not the git repository root'}).`,
      );
    }
    return 'worktree';
  }
  // 未声明：git 仓库根用 worktree，非 git 目录用副本。
  // git 子目录既不能建 worktree（会放大到整仓），也不该静默只复制一个子目录，
  // 所以要求用户显式给出仓库根或显式指定 copy。
  if (git === 'subdirectory') {
    throw new Error(
      `${dir} is inside the git repository ${gitTopLevel(dir)}; pass that repository root so the worker sees the whole tree.`,
    );
  }
  return git === 'root' ? 'worktree' : 'copy';
}

/**
 * 建 Run 前把所有 lane 的档位落定，并逐个校验工作区。
 * 没有声明 lanes 时按每个任务的 lane 隐式补一条（与 state.normalizeLanes 的规则一致）。
 */
export function prepareDefinition(
  definition: OrchestrationDefinition,
  root: string,
  allowInplace: boolean,
): OrchestrationDefinition {
  const declared = definition.lanes ?? [];
  const lanes: LaneInput[] = [];
  if (declared.length > 0) {
    const seen = new Set<string>();
    for (const lane of declared) {
      const dir = path.resolve(root, lane.workspaceRoot ?? '.');
      const key = `${lane.id}\u0000${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lanes.push({ ...lane, workspaceRoot: dir, mode: resolveLaneMode(dir, lane.mode, allowInplace) });
    }
  } else {
    const dir = path.resolve(root);
    const mode = resolveLaneMode(dir, undefined, allowInplace);
    for (const id of new Set(definition.tasks.map((task) => task.lane?.trim() || task.id))) {
      lanes.push({ id, workspaceRoot: dir, mode });
    }
  }
  return { ...definition, lanes };
}
