// 常驻资源的统一退出清理。
//
// 后台 dev server 是我们自己 spawn 的子进程,进程退出不会自动带走(Windows 尤其),必须显式树杀;
// Playwright 浏览器进程在正常路径 await close(),硬退出路径依赖 Playwright 自身的 exit 处理。
// 两个入口都必须幂等:normal exit / SIGINT / uncaughtException 可能重复触发。

import { stopAllDevServersSync } from './dev-server-manager.js';

let asyncDone = false;

/** 正常退出路径:可 await,尽量优雅关闭。 */
export async function shutdownRuntime(): Promise<void> {
  if (asyncDone) return;
  asyncDone = true;
  stopAllDevServersSync();
  try {
    // 动态 import:未用过 browser 工具时不该把 playwright 拉进进程。
    const { closeAllBrowsers } = await import('./browser-manager.js');
    await closeAllBrowsers();
  } catch {
    // 浏览器从未启动或已崩溃:忽略。
  }
}

/** 同步兜底(process exit / 信号 / 未捕获异常):只做同步树杀,不留孤儿 dev server。 */
export function shutdownRuntimeSync(): void {
  stopAllDevServersSync();
}
