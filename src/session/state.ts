import { AsyncLocalStorage } from 'node:async_hooks';

// Default-runtime session identity stays free of config/store imports to avoid initialization cycles.
let defaultCurrentSessionId: string | undefined;
const activeSessionIdProviders = new AsyncLocalStorage<() => string | undefined>();

/** 获取当前异步 runtime 的会话 ID；无 scope 时读取默认进程 runtime。 */
export function getCurrentSessionId(): string | undefined {
  return activeSessionIdProviders.getStore()?.() ?? defaultCurrentSessionId;
}

/** SessionStore 默认兼容实例专用：绕过异步 scope，避免 provider 自递归。 */
export function getDefaultCurrentSessionId(): string | undefined {
  return defaultCurrentSessionId;
}

/** 设置默认进程 runtime 的当前活跃会话 ID。 */
export function setCurrentSessionId(id: string | undefined, cwd: string): void {
  defaultCurrentSessionId = id;
  void cwd;
}

/** 让 notes/config 等旧读取入口在异步 runtime 树内看到实例会话身份。 */
export function withCurrentSessionIdProvider<T>(provider: () => string | undefined, run: () => Promise<T>): Promise<T> {
  return activeSessionIdProviders.run(provider, run);
}
