/**
 * 浏览器面板的主进程侧：一个 WebContentsView 承载网页，agent 通过 CDP 操作**同一个视图**。
 *
 * 为什么不是渲染层的 `<webview>`（实测 Electron 43 + playwright-core）：
 *  - `<webview>` 在 CDP 的 /json/list 里是 `type: "webview"` 目标，而 playwright 只把
 *    `type: "page"` 目标收进 BrowserContext —— connectOverCDP 后永远拿不到那一页，attach 失效。
 *  - `WebContentsView` 是 `type: "page"`，attach 后 click/typing 都是真的，且
 *    `setVisible(false)` / `removeChildView()` 都不销毁它的 webContents（面板藏起来时页面还在）。
 *
 * 代价：它是原生视图，永远盖在渲染层 DOM 之上，所以弹窗打开时必须由渲染层通知隐藏
 * （见 renderer/browser-panel.ts 的 overlay guard）。
 */

import { BrowserWindow, WebContentsView, type Session } from 'electron';
import {
  BROWSER_PANEL_SENTINEL,
  BROWSER_PANEL_START_URL,
  clampPanelBounds,
  panelPartitionFor,
  validatePanelUrl,
} from './browser-panel.js';

// URL 校验与 bounds 夹取都是纯函数，放 browser-panel.ts 便于单测；这里原样转发给 main.ts。
export { validatePanelUrl };

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewState {
  /** 当前视图所属空间；undefined = 纯任务（default 分区）。 */
  projectId?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 最近一次导航失败的原因（成功后清空）。 */
  error?: string;
}

interface Entry {
  projectId?: string;
  view: WebContentsView;
  /** 每个分区只配一次权限处理器。 */
  denyInstalled: boolean;
}

/**
 * 面板初始页用带哨兵的空白地址：agent attach 时优先挑 http(s) 页面，
 * 找不到就退回这个哨兵页（见 src/runtime/browser-manager.ts 的 openAttachedSession）。
 * 应用自身的渲染层是 file://，不会与之混淆。
 */
export const PANEL_BLANK_URL = `${BROWSER_PANEL_START_URL}${BROWSER_PANEL_SENTINEL}`;

export class BrowserHost {
  private readonly entries = new Map<string, Entry>();
  private active: Entry | null = null;
  private visible = false;
  private bounds: BrowserBounds | null = null;
  private disposed = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onState: (state: BrowserViewState) => void,
  ) {}

  /** 打开/切换空间并定位视图。bounds 是渲染层 stage 元素的 CSS 像素矩形。 */
  show(projectId: string | undefined, bounds: BrowserBounds): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || this.disposed) return;
    const entry = this.entryFor(projectId);
    this.bounds = clampBounds(win, bounds);
    if (this.active && this.active !== entry) {
      win.contentView.removeChildView(this.active.view);
    }
    this.active = entry;
    if (!win.contentView.children.includes(entry.view)) win.contentView.addChildView(entry.view);
    entry.view.setBounds(this.bounds);
    entry.view.setVisible(true);
    this.visible = true;
    this.emit(entry);
  }

  /** 隐藏视图（关面板 / 被弹窗遮住）：只 setVisible，不销毁页面。 */
  hide(): void {
    if (!this.active) return;
    this.visible = false;
    this.active.view.setVisible(false);
  }

  navigate(rawUrl: string): boolean {
    const url = validatePanelUrl(rawUrl);
    if (!url) return false;
    if (!this.active) return false;
    this.active.view.webContents.loadURL(url).catch(() => {
      /* did-fail-load 会把原因推回去，这里不重复报错 */
    });
    return true;
  }

  command(command: 'back' | 'forward' | 'reload'): boolean {
    const contents = this.active?.view.webContents;
    if (!contents || contents.isDestroyed()) return false;
    if (command === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    } else if (command === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    } else {
      contents.reload();
    }
    return true;
  }

  /** 空间被移除 / 应用退出时回收（同一分区的其它视图保留）。 */
  dispose(): void {
    this.disposed = true;
    const win = this.getWindow();
    for (const entry of this.entries.values()) {
      if (win && !win.isDestroyed()) {
        try { win.contentView.removeChildView(entry.view); } catch { /* 已移除 */ }
      }
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    }
    this.entries.clear();
    this.active = null;
    this.visible = false;
  }

  get currentUrl(): string {
    return this.active?.view.webContents.getURL() ?? '';
  }

  private entryFor(projectId: string | undefined): Entry {
    const key = projectId || '';
    const existing = this.entries.get(key);
    if (existing) return existing;
    const view = new WebContentsView({
      webPreferences: {
        partition: panelPartitionFor(projectId),
        contextIsolation: true,
        nodeIntegration: false,
        // 站点是任意网页：关掉 preload 与 Node，只当普通浏览器用。
        sandbox: true,
      },
    });
    const entry: Entry = { projectId, view, denyInstalled: false };
    this.entries.set(key, entry);
    // 每个空间一个分区，权限要按分区装（同一个分区重复装是幂等的）。
    denySessionPermissions(view.webContents.session);
    this.wire(entry);
    void view.webContents.loadURL(PANEL_BLANK_URL);
    return entry;
  }

  private wire(entry: Entry): void {
    const contents = entry.view.webContents;
    // agent 打开新窗口（target=_blank / window.open）不能真的弹一个游离窗口：
    // 那样它既不在面板里、也不在 CDP 可见页面上，用户完全看不见它在做什么。
    contents.setWindowOpenHandler(({ url }) => {
      const target = validatePanelUrl(url);
      if (target) void contents.loadURL(target);
      return { action: 'deny' };
    });
    const emit = (): void => this.emit(entry);
    contents.on('did-start-loading', emit);
    contents.on('did-stop-loading', emit);
    contents.on('did-navigate', emit);
    contents.on('did-navigate-in-page', emit);
    contents.on('page-title-updated', emit);
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED：用户中途改地址栏 / 页面自己跳走的正常中断。
      if (!isMainFrame || errorCode === -3) return;
      lastError.set(entry, `${errorDescription} (${validatedURL})`);
      emit();
    });
    contents.on('did-finish-load', () => { lastError.delete(entry); emit(); });
    contents.on('destroyed', () => {
      this.entries.delete(entry.projectId || '');
      if (this.active === entry) this.active = null;
    });
  }

  private emit(entry: Entry): void {
    if (this.active !== entry || this.disposed) return;
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return;
    let url = '';
    try { url = contents.getURL(); } catch { /* 视图销毁竞态 */ }
    const error = lastError.get(entry);
    const state: BrowserViewState = {
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      url,
      title: (() => { try { return contents.getTitle(); } catch { return ''; } })(),
      loading: (() => { try { return contents.isLoading(); } catch { return false; } })(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(error ? { error } : {}),
    };
    this.onState(state);
  }
}

/** 失败原因挂在 entry 上：WebContentsView 没有额外字段可用，又不想污染 state 类型。 */
const lastError = new WeakMap<Entry, string>();

/** 视图不能超出窗口内容区：渲染层量出的 rect 在缩放/贴边时可能溢出。 */
function clampBounds(win: BrowserWindow, bounds: BrowserBounds): BrowserBounds {
  const [width, height] = win.getContentSize();
  return clampPanelBounds(bounds, { width, height });
}

/** 面板分区的权限一律拒绝：agent 可能打开任意站点，不能顺带拿到定位/通知/摄像头。 */
export function denySessionPermissions(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}