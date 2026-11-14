/**
 * 浏览器面板的跨进程约定。
 *
 * 主进程（Chrome 启动参数、webview 挂载校验、权限拒绝）与渲染层（webview 的 partition）
 * 必须用同一套分区名，否则 agent 接管的页面和用户看到的面板会是两份登录态。
 * 本文件只放纯常量/纯函数：渲染层没有打包器，不能 import 任何 node 依赖。
 */

/** 面板网页的 session 分区前缀；每个空间一份，登录态按空间隔离、跨会话保留。 */
export const BROWSER_PANEL_PARTITION_PREFIX = 'persist:mocode-browser';

/** 面板分区名。空间未知时退到 default（纯任务 / 首屏还没选中空间）。 */
export function panelPartitionFor(projectId?: string | null): string {
  return `${BROWSER_PANEL_PARTITION_PREFIX}-${projectId || 'default'}`;
}

/**
 * 面板初始页。刻意不用 http(s)：agent attach 时优先挑 http(s) 页面（用户真正在看的站点），
 * 空白页只作为兜底，不会被误当成操作目标。
 */
export const BROWSER_PANEL_START_URL = 'about:blank';

/**
 * 面板哨兵：初始页带这段 hash，agent 侧据此认出「这块空白页就是面板」。
 * 两侧（browser-host.ts 的 PANEL_BLANK_URL、src/runtime/browser-manager.ts）共用这一份。
 */
export const BROWSER_PANEL_SENTINEL = '#mocode-browser-panel';

/**
 * 只放行 http(s)：面板是「看本地服务 / 看文档」的工具，不需要 file:// 或自定义协议 ——
 * 后者会让 agent 借浏览器读到磁盘文件，等于绕过 sandbox。
 */
export function validatePanelUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
}

/** 视图不能超出窗口内容区：渲染层量出的 rect 在缩放/贴边时可能溢出。 */
export function clampPanelBounds(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(Math.round(bounds.x), viewport.width));
  const y = Math.max(0, Math.min(Math.round(bounds.y), viewport.height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width), viewport.width - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height), viewport.height - y)),
  };
}