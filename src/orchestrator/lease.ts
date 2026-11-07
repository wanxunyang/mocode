// 工作区写租约：并发 Worker 之间「谁能同时写同一个目录」的仲裁。
//
// 进程内的 ResourceLockManager 保护不了另一个 Host 进程，所以 inplace 档位额外用
// `<workspace>/.mocode/lane.lock` 做跨进程互斥（与 store 的 controller.lock 同一套思路：
// 写 PID + token，进程已死才允许接管）。

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type LeaseKind = 'isolated' | 'inplace';

export interface WorkspaceLease {
  readonly workspaceRoot: string;
  readonly kind: LeaseKind;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.mocode', 'lane.lock');
}

/**
 * 跨进程拿原地写锁。返回 undefined 表示别的进程正在原地写。
 * 锁文件坏掉或持锁进程已死时清掉重试一次；两次失败就如实返回冲突。
 */
function acquireInplaceFileLock(workspaceRoot: string): (() => void) | undefined {
  const target = lockPath(workspaceRoot);
  const token = randomBytes(12).toString('hex');
  const write = (): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    write();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: { pid?: unknown } = {};
    try {
      owner = JSON.parse(fs.readFileSync(target, 'utf8')) as { pid?: unknown };
    } catch {
      return undefined;
    }
    if (typeof owner.pid !== 'number' || processIsAlive(owner.pid)) return undefined;
    try {
      fs.unlinkSync(target);
      write();
    } catch {
      return undefined;
    }
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(target, 'utf8')) as { token?: unknown };
      if (owner.token === token) fs.unlinkSync(target);
    } catch {
      // 无法证明锁属于自己时绝不删除。
    }
  };
}

/**
 * 一次 Run 内的工作区租约表。
 *
 * - `isolated`（worktree / copy）：同工作区允许多个，受 `maxConcurrentPerWorkspace` 约束；
 * - `inplace`：同工作区**独占**，进程内单持有者 + 跨进程文件锁。
 */
export class WorkspaceLeaseManager {
  private readonly held = new Map<string, { isolated: number; inplace: boolean }>();

  /** 尝试取租约；返回 undefined 表示当前不可取（调用方据此延后该任务）。 */
  tryAcquire(workspaceRoot: string, kind: LeaseKind, perWorkspaceLimit: number): WorkspaceLease | undefined {
    const key = path.resolve(workspaceRoot).toLowerCase();
    const current = this.held.get(key) ?? { isolated: 0, inplace: false };
    if (current.inplace) return undefined;
    if (kind === 'inplace') {
      if (current.isolated > 0) return undefined;
      const releaseFile = acquireInplaceFileLock(workspaceRoot);
      if (!releaseFile) return undefined;
      this.held.set(key, { isolated: 0, inplace: true });
      let released = false;
      return {
        workspaceRoot,
        kind,
        release: () => {
          if (released) return;
          released = true;
          releaseFile();
          this.held.delete(key);
        },
      };
    }
    if (current.isolated >= perWorkspaceLimit) return undefined;
    this.held.set(key, { ...current, isolated: current.isolated + 1 });
    let released = false;
    return {
      workspaceRoot,
      kind,
      release: () => {
        if (released) return;
        released = true;
        const entry = this.held.get(key);
        if (!entry) return;
        if (entry.isolated <= 1) this.held.delete(key);
        else this.held.set(key, { ...entry, isolated: entry.isolated - 1 });
      },
    };
  }

  /** 当前持有的租约数量（测试与 status 用）。 */
  get size(): number {
    return this.held.size;
  }
}
