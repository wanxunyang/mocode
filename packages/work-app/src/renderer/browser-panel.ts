/**
 * 浏览器面板（渲染层）。
 *
 * 页面本身不在这里：它是主进程的 WebContentsView（browser-host.ts），因为只有 `page` 类型的
 * CDP 目标才能被 agent 的 playwright attach 接管。渲染层负责三件事：
 *  1. 画工具栏（地址栏 / 前进后退 / 刷新 / dev_server 快捷入口）和状态行；
 *  2. 把 stage 的矩形量出来交给主进程 —— 原生视图是在窗口坐标系里绝对定位的；
 *  3. 弹窗出现时把视图藏起来：原生视图永远盖在 DOM 之上，不藏就会遮住 modal。
 */

export interface BrowserPanelApi {
  t: (key: string, vars?: Record<string, string | number>) => string;
  icon: (name: string) => string;
  escapeHtml: (value: string) => string;
  /** 当前空间 id（任务归属空间优先于全局选中空间）。 */
  currentProjectId: () => string | undefined;
  show: (payload: { projectId?: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean; message?: string }>;
  hide: () => Promise<{ ok: boolean }>;
  navigate: (url: string) => Promise<{ ok: boolean; message?: string }>;
  command: (command: 'back' | 'forward' | 'reload') => Promise<{ ok: boolean }>;
  onState: (callback: (state: BrowserViewState) => void) => () => void;
}

export interface BrowserViewState {
  projectId?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

let api: BrowserPanelApi | null = null;
let root: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let addressInput: HTMLInputElement | null = null;
let statusEl: HTMLElement | null = null;
let backButton: HTMLButtonElement | null = null;
let forwardButton: HTMLButtonElement | null = null;
let detachState: (() => void) | null = null;
let observer: ResizeObserver | null = null;

/** 用户是否把面板停在浏览器视图上（关闭面板 / 切到文件视图都会置 false）。 */
let panelVisible = false;
/** 主进程当前是否真的有可见视图（避免重复 hide/show）。 */
let viewShown = false;
/** 被弹窗临时遮挡：此时 DOM 面板仍算打开，只是原生视图要先藏起来。 */
let suspended = false;
let lastBounds = '';
let lastProjectKey = '';
/** 最近一次 dev_server 报的 readyUrl：工具栏给一个一键入口。 */
let devServerUrl = '';

function need(): BrowserPanelApi {
  if (!api) throw new Error('browser panel not initialized');
  return api;
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

/** 地址栏容错：裸 localhost:5173 走 http，其它裸域名补 https。 */
export function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  return `https://${value}`;
}

function updateDevServerChip(): void {
  const chip = root?.querySelector<HTMLElement>('[data-browser-devserver]');
  if (!chip) return;
  chip.classList.toggle('hidden', !devServerUrl);
  chip.textContent = devServerUrl.replace(/^https?:\/\//, '');
  chip.title = devServerUrl;
}

/** 弹窗/浮层：它们盖不住原生视图，只能反过来把视图藏起来。 */
const OVERLAY_SELECTOR = [
  '.modal:not(.hidden)',
  '.image-viewer:not(.hidden)',
  '#search-panel:not(.hidden)',
  '.cheatsheet:not(.hidden)',
].join(',');

function overlaysOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * 量出 stage 在窗口内容区的矩形。getBoundingClientRect 是 CSS 像素、相对视口，
 * 与 BrowserWindow 的内容区坐标一致（主进程还会再夹一次窗口边界）。
 */
function measure(): { x: number; y: number; width: number; height: number } | null {
  if (!stage) return null;
  const rect = stage.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function applyVisibility(): void {
  const panel = need();
  const want = panelVisible && !suspended && !overlaysOpen();
  if (!want) {
    if (viewShown) { viewShown = false; void panel.hide(); }
    return;
  }
  const bounds = measure();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
  const projectId = panel.currentProjectId();
  const key = `${projectId ?? ''}|${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (viewShown && key === lastBounds) return;
  viewShown = true;
  lastBounds = key;
  lastProjectKey = projectId ?? '';
  void panel.show({ ...(projectId ? { projectId } : {}), bounds });
}

/** 面板打开（或切到浏览器视图）。幂等。 */
export function showBrowserPanel(): void {
  if (!root) return;
  panelVisible = true;
  root.classList.remove('hidden');
  updateDevServerChip();
  applyVisibility();
}

/** 面板关闭 / 切到其它视图：只藏原生视图，页面与登录态都还在。 */
export function hideBrowserPanel(): void {
  panelVisible = false;
  root?.classList.add('hidden');
  applyVisibility();
}

/** 地址栏 / 工具卡的一键打开。 */
export function navigateBrowserPanel(url: string): void {
  const target = normalizeBrowserUrl(url);
  if (!target) return;
  showBrowserPanel();
  if (addressInput) addressInput.value = target;
  void need().navigate(target).then((result) => {
    if (!result.ok && result.message) setStatus(result.message);
  });
}

/** dev_server 报出 readyUrl 时记住它（同一空间内跨任务沿用最近一次）。 */
export function rememberDevServerUrl(url: string): void {
  if (!url || url === devServerUrl) return;
  devServerUrl = url;
  updateDevServerChip();
}

function applyState(state: BrowserViewState): void {
  if (backButton) backButton.disabled = !state.canGoBack;
  if (forwardButton) forwardButton.disabled = !state.canGoForward;
  // 面板可能因为切空间而切了分区：那边的页面状态不属于当前空间，忽略。
  if (panelVisible && lastProjectKey && (state.projectId ?? '') !== lastProjectKey) return;
  if (state.error) {
    setStatus(`${need().t('browser.loadFailed')} ${state.error}`);
    return;
  }
  if (state.loading) { setStatus(need().t('browser.loading')); return; }
  setStatus(state.title || '');
  // 空白哨兵页不覆盖用户正在输入的内容。
  if (addressInput && state.url && !state.url.includes('#mocode-browser-panel') && document.activeElement !== addressInput) {
    addressInput.value = state.url;
  }
}

export function initBrowserPanel(container: HTMLElement, browserApi: BrowserPanelApi): void {
  api = browserApi;
  root = container;
  const t = browserApi.t;
  container.innerHTML = `
    <div class="browser-toolbar">
      <button class="browser-nav" data-browser="back" disabled>${browserApi.icon('arrow-left')}</button>
      <button class="browser-nav browser-nav-flip" data-browser="forward" disabled>${browserApi.icon('arrow-left')}</button>
      <input class="browser-address" type="text" spellcheck="false" autocomplete="off"
        placeholder="${browserApi.escapeHtml(t('browser.addressPlaceholder'))}"
        aria-label="${browserApi.escapeHtml(t('browser.addressPlaceholder'))}" />
      <button class="browser-nav" data-browser="reload">${browserApi.icon('regen')}</button>
      <button class="browser-devserver hidden" data-browser-devserver type="button"></button>
    </div>
    <div class="browser-stage"></div>
    <div class="browser-status" role="status"></div>`;
  stage = container.querySelector('.browser-stage');
  addressInput = container.querySelector('.browser-address');
  statusEl = container.querySelector('.browser-status');
  backButton = container.querySelector('[data-browser="back"]');
  forwardButton = container.querySelector('[data-browser="forward"]');
  const reloadButton = container.querySelector<HTMLButtonElement>('[data-browser="reload"]');

  backButton?.addEventListener('click', () => void need().command('back'));
  forwardButton?.addEventListener('click', () => void need().command('forward'));
  reloadButton?.addEventListener('click', () => void need().command('reload'));
  container.querySelector('[data-browser-devserver]')?.addEventListener('click', () => {
    if (devServerUrl) navigateBrowserPanel(devServerUrl);
  });
  addressInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    navigateBrowserPanel(addressInput!.value);
  });

  // 尺寸变化（侧栏拖拽、窗口缩放、输入卡增高）都要重报 bounds：原生视图不会自己跟着 DOM 走。
  observer?.disconnect();
  observer = new ResizeObserver(() => {
    // bounds 变了必须重报，否则 lastBounds 的幂等判断会挡住更新。
    lastBounds = '';
    applyVisibility();
  });
  if (stage) observer.observe(stage);
  window.addEventListener('resize', () => { lastBounds = ''; applyVisibility(); });

  // 弹窗开关是 class 切换，只能观察属性（没有别的可靠事件）。
  const overlayWatcher = new MutationObserver(() => {
    const next = overlaysOpen();
    if (next === suspended) return;
    suspended = next;
    applyVisibility();
  });
  overlayWatcher.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

  detachState?.();
  detachState = browserApi.onState(applyState);
  updateDevServerChip();
}

/** 切语言后调用：工具栏的占位/aria 是 initBrowserPanel 时写死的，必须重刷。 */
export function refreshBrowserPanelLabels(): void {
  if (!api || !addressInput) return;
  const placeholder = api.t('browser.addressPlaceholder');
  addressInput.placeholder = placeholder;
  addressInput.setAttribute('aria-label', placeholder);
}

/** 空间切换后调用：分区变了，视图要重新挂到新空间上。 */
export function refreshBrowserPanelProject(): void {
  const projectId = need().currentProjectId();
  if ((projectId ?? '') === lastProjectKey) return;
  lastProjectKey = projectId ?? '';
  lastBounds = '';
  viewShown = false;
  applyVisibility();
}