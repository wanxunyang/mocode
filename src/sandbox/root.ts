// 共享叶子:沙箱根目录(文件操作边界)。零依赖、不反向引用业务、不落盘。
// 依赖方向无环:tools/registry → sandbox、tools/builtins/* → sandbox、agent/core → sandbox、repl → sandbox
// —— 全是「业务 → 叶子」,同 src/agent/mode.ts。
//
// 设计:sandboxRoot 是纯边界记录(默认 = process.cwd(),不 chdir),避免与 config.sessionDir 等
// 模块加载期计算的值产生错位(若 chdir 会令那些值变陈旧)。主 Agent 使用全局 root，
// 并发子 Agent 通过 AsyncLocalStorage 获得互不干扰的 overlay root。

import { AsyncLocalStorage } from 'node:async_hooks';

let currentRoot: string | null = null;
const scopedRoots = new AsyncLocalStorage<string>();

/** 当前沙箱根(绝对路径)。未初始化返 null,调用方 ?? process.cwd() 兜底(防御)。 */
export function getSandboxRoot(): string | null {
  return scopedRoots.getStore() ?? currentRoot;
}

/** Run one asynchronous agent against an isolated sandbox without changing sibling roots. */
export function withSandboxRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
  return scopedRoots.run(root, run);
}

/** 设置沙箱根。repl startRepl 启动时调一次(默认 process.cwd();--sandbox-root / SANDBOX_ROOT 可覆盖)。
 *  返回之前的值,供未来 save/restore(子 agent worktree 隔离)用。 */
export function setSandboxRoot(root: string | null): string | null {
  const prev = currentRoot;
  currentRoot = root;
  return prev;
}
