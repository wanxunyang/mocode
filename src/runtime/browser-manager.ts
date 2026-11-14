// Playwright 浏览器会话管理器。
//
// 设计要点:
//  - 会话跨工具调用存活(Browser 单例 + 每会话独立 BrowserContext/Page),这样 agent 可以
//    navigate → click → screenshot 连续操作同一个页面,而不是每次重开浏览器丢状态。
//  - playwright 用动态 import:启动 mocode 不该为一个可选能力付加载成本,缺浏览器二进制时
//    也能给出明确的 `npx playwright install chromium` 指引而不是崩在模块加载期。
//  - 默认只允许回环地址。agent 能驱动真浏览器意味着它能发任意请求,若放开就等于给了
//    SSRF / 内网扫描能力。放开需用户显式设 MOCODE_BROWSER_ALLOW_REMOTE=true。
//  - 采集 console / pageerror / requestfailed 到有界 ring buffer:前端问题往往只在控制台可见,
//    截图看不出来。

import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright';
import { randomBytes } from 'node:crypto';
import { getSandboxRoot } from '../sandbox/root.js';
import {
  createDiagnostics,
  recordDiagnostic,
  resolveDiagnosticsLogPath,
  snapshotDiagnostics,
  type BrowserDiagnostics,
  type DiagnosticsState,
} from './browser-diagnostics.js';

export type BrowserErrorCode = 'INVALID_ARGUMENTS' | 'SANDBOX_DENIED' | 'TIMEOUT' | 'EXECUTION_ERROR';

export class BrowserManagerError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserManagerError';
  }
}

// 诊断摘要的类型与采集实现都在 browser-diagnostics.ts（纯函数、无 playwright 依赖，可单测）。
export type { BrowserDiagnostics } from './browser-diagnostics.js';

export interface BrowserSessionSnapshot {
  sessionId: string;
  url: string;
  title: string;
  headed: boolean;
  viewport: { width: number; height: number };
  /** 与会话共享同一页面（应用内浏览器面板），而不是 mocode 自己拉起的浏览器。 */
  attached?: boolean;
}

interface SessionRecord {
  sessionId: string;
  context: BrowserContext;
  page: Page;
  headed: boolean;
  /** 页面属于宿主应用的面板：关会话只解绑监听，不关闭页面与浏览器。 */
  attached: boolean;
  /** 计数 + 环缓冲 + 日志落盘，见 browser-diagnostics.ts。 */
  diag: DiagnosticsState;
  cleanup: Array<() => void>;
}

const ATTACHED_SESSION_ID = 'panel';
const sessions = new Map<string, SessionRecord>();
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** 面板页可能还没导航完；attach 时轮询等待它出现。 */
const ATTACH_WAIT_ATTEMPTS = 15;
const ATTACH_WAIT_INTERVAL_MS = 200;

let browserPromise: Promise<Browser> | null = null;
let launchedHeaded = false;
let attachPromise: Promise<Browser> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveTimeout(input: unknown): number {
  const value = Number(input ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, 500), MAX_TIMEOUT_MS);
}

function remoteAllowed(): boolean {
  return process.env.MOCODE_BROWSER_ALLOW_REMOTE === 'true';
}

/** 默认只放行 http/https 回环地址;拒绝 file:/data:/javascript: 等本地读取与脚本注入面。 */
export function validateNavigationUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BrowserManagerError('INVALID_ARGUMENTS', `Invalid url: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserManagerError('SANDBOX_DENIED', `Only http and https URLs are allowed (received ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new BrowserManagerError('SANDBOX_DENIED', 'URLs with embedded credentials are not allowed.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!loopback && !remoteAllowed()) {
    throw new BrowserManagerError(
      'SANDBOX_DENIED',
      `Only localhost, 127.0.0.1, and ::1 are allowed by default (received ${url.hostname}). ` +
        'Set MOCODE_BROWSER_ALLOW_REMOTE=true to permit remote navigation.',
    );
  }
  return url;
}

/**
 * driver 解析链：全量 `playwright`（CLI 版随依赖装）→ `playwright-core`（桌面版只分发这个,
 * 省 ~5MB 的浏览器下载器）。两者 API 同源,谁在先用谁 —— 桌面版因此不需要用户跑 `playwright install`。
 */
async function loadDriver(): Promise<typeof import('playwright')> {
  const failures: string[] = [];
  for (const spec of ['playwright', 'playwright-core']) {
    try {
      return (await import(spec)) as unknown as typeof import('playwright');
    } catch (error) {
      failures.push(`${spec}: ${errorMessage(error)}`);
    }
  }
  throw new BrowserManagerError('EXECUTION_ERROR', `Playwright is not available (${failures.join('; ')}).`);
}

/**
 * 可执行文件解析链：自带 Chromium → 系统 Edge → 系统 Chrome。
 * 桌面版不打 Chromium 二进制,靠后两档命中(Win 自带 Edge,macOS/Linux 一般有 Chrome)。
 */
const BROWSER_CHANNELS: ReadonlyArray<string | undefined> = [undefined, 'msedge', 'chrome'];

async function launchBrowser(headed: boolean): Promise<Browser> {
  const playwright = await loadDriver();
  const failures: string[] = [];
  for (const channel of BROWSER_CHANNELS) {
    try {
      return await playwright.chromium.launch({ headless: !headed, ...(channel ? { channel } : {}) });
    } catch (error) {
      failures.push(`${channel ?? 'bundled chromium'}: ${errorMessage(error)}`);
    }
  }
  throw new BrowserManagerError(
    'EXECUTION_ERROR',
    `Unable to launch a browser (${failures.join('; ')}). ` +
      `Install Chrome or Edge, or run "npx playwright install chromium".`,
  );
}

async function getBrowser(headed: boolean): Promise<Browser> {
  const existing = browserPromise ? await browserPromise.catch(() => null) : null;
  // headless 与 headed 是不同的进程模式;请求切换时重开,避免默默给出与请求不符的模式。
  if (existing?.isConnected() && launchedHeaded === headed) return existing;
  if (existing?.isConnected()) await existing.close().catch(() => {});

  launchedHeaded = headed;
  browserPromise = launchBrowser(headed);
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

function record(session: SessionRecord, bucket: 'console' | 'pageErrors' | 'failedRequests', line: string): void {
  recordDiagnostic(session.diag, bucket, line);
}

/** 诊断日志落在工作区的 `.mocode/browser/` 下，模型可用 grep/read_file 按需取细节。 */
function openDiagnostics(sessionId: string): DiagnosticsState {
  const root = getSandboxRoot() ?? process.cwd();
  try {
    return createDiagnostics({ logPath: resolveDiagnosticsLogPath(root, sessionId) });
  } catch {
    // 只读工作区等场景建不了目录：降级成纯内存诊断，不影响浏览器功能。
    return createDiagnostics({ logPath: null });
  }
}

/** CDP 端点：由宿主应用（workspace 的浏览器面板）在启动时注入；CLI 下不存在。 */
export function attachedEndpoint(): string | null {
  const value = (process.env.MOCODE_BROWSER_CDP_URL ?? '').trim();
  return value ? value : null;
}

function bindPageListeners(session: SessionRecord): void {
  const { page } = session;
  const onConsole = (message: ConsoleMessage): void => {
    record(session, 'console', `[${message.type()}] ${message.text()}`);
  };
  const onPageError = (error: Error): void => record(session, 'pageErrors', errorMessage(error));
  const onRequestFailed = (request: {
    method(): string;
    url(): string;
    failure(): { errorText: string } | null;
  }): void => {
    record(
      session,
      'failedRequests',
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
    );
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed as never);
  const offConsole = (): void => {
    page.off('console', onConsole);
  };
  const offPageError = (): void => {
    page.off('pageerror', onPageError);
  };
  const offRequestFailed = (): void => {
    page.off('requestfailed', onRequestFailed as never);
  };
  session.cleanup = [offConsole, offPageError, offRequestFailed];
}

function createSessionRecord(input: {
  sessionId: string;
  context: BrowserContext;
  page: Page;
  headed: boolean;
  attached: boolean;
}): SessionRecord {
  const session: SessionRecord = {
    ...input,
    diag: openDiagnostics(input.sessionId),
    cleanup: [],
  };
  input.page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  bindPageListeners(session);
  return session;
}

/**
 * 宿主应用浏览器面板的空白页哨兵。面板初始停在 `about:blank#mocode-browser-panel`：
 * 它既能让 attach 拿到「一块属于面板的页面」，又不会让模型误以为用户已经打开了某个站点。
 * 应用自身的 renderer 是 file://，永远不会命中这里。
 * （对应实现在 packages/work-app/src/browser-host.ts 的 PANEL_BLANK_URL，改动需同步。）
 */
const PANEL_SENTINEL = '#mocode-browser-panel';

/**
 * 接管宿主应用面板里的页面（`connectOverCDP`）。
 *
 * 关键点：面板的网页必须是 CDP 里的 `page` 目标 —— `<webview>` 是 `webview` 目标，
 * playwright 根本不会把它放进 BrowserContext，所以宿主一律用 WebContentsView 承载面板。
 * 这里按优先级挑：先 http(s)（用户真正在看的站点），再面板哨兵空白页。
 */
async function openAttachedSession(endpoint: string): Promise<BrowserSessionSnapshot> {
  const existing = sessions.get(ATTACHED_SESSION_ID);
  if (existing && !existing.page.isClosed()) return describe(existing);

  const playwright = await loadDriver();
  if (!attachPromise) {
    attachPromise = playwright.chromium.connectOverCDP(endpoint) as Promise<Browser>;
  }
  let browser: Browser;
  try {
    browser = await attachPromise;
  } catch (error) {
    attachPromise = null;
    throw new BrowserManagerError(
      'EXECUTION_ERROR',
      `Unable to attach to the app browser panel at ${endpoint} (${errorMessage(error)}). ` +
        'Open the browser panel in the app first, or unset MOCODE_BROWSER_CDP_URL.',
    );
  }

  const wanted = process.env.MOCODE_BROWSER_PANEL_MATCH ?? '';
  let picked: { context: BrowserContext; page: Page } | null = null;
  for (let attempt = 0; attempt < ATTACH_WAIT_ATTEMPTS && !picked; attempt++) {
    // 两轮：先找用户真正打开的站点，再退到面板哨兵空白页 —— 后者保证「用户刚打开面板、
    // 还没输网址」时 agent 也能先拿到这块页面，navigate 下去就是同一个视图。
    for (const pass of ['site', 'blank'] as const) {
      for (const context of browser.contexts()) {
        const page = context.pages().find((candidate) => {
          const url = candidate.url();
          if (pass === 'blank') return url.includes(PANEL_SENTINEL);
          if (!url.startsWith('http:') && !url.startsWith('https:')) return false;
          return wanted ? url.includes(wanted) : true;
        });
        if (page) {
          picked = { context, page };
          break;
        }
      }
      if (picked) break;
    }
    if (!picked) await new Promise((resolve) => setTimeout(resolve, ATTACH_WAIT_INTERVAL_MS));
  }
  if (!picked) {
    throw new BrowserManagerError(
      'EXECUTION_ERROR',
      'The app browser panel has no page open yet. Open the Browser view in the app and retry.',
    );
  }

  const session = createSessionRecord({
    sessionId: ATTACHED_SESSION_ID,
    context: picked.context,
    page: picked.page,
    headed: true,
    attached: true,
  });
  sessions.set(ATTACHED_SESSION_ID, session);
  return describe(session);
}

export async function openSession(opts: { headed?: boolean } = {}): Promise<BrowserSessionSnapshot> {
  const endpoint = attachedEndpoint();
  if (endpoint) return openAttachedSession(endpoint);

  const headed = opts.headed === true;
  const browser = await getBrowser(headed);
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
  const page = await context.newPage();

  const session = createSessionRecord({
    sessionId: `page-${randomBytes(3).toString('hex')}`,
    context,
    page,
    headed,
    attached: false,
  });
  sessions.set(session.sessionId, session);
  return describe(session);
}

function requireSession(sessionId?: string): SessionRecord {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      const known = [...sessions.keys()];
      throw new BrowserManagerError(
        'INVALID_ARGUMENTS',
        known.length
          ? `Unknown browser sessionId "${sessionId}". Known sessions: ${known.join(', ')}.`
          : `Unknown browser sessionId "${sessionId}". Call action=open first.`,
      );
    }
    return session;
  }
  // 只有一个会话时允许省略 sessionId,减少模型出错面;多会话必须显式指定。
  const all = [...sessions.values()];
  if (all.length === 1) return all[0];
  if (all.length === 0) {
    throw new BrowserManagerError('INVALID_ARGUMENTS', 'No browser session is open. Call action=open first.');
  }
  throw new BrowserManagerError(
    'INVALID_ARGUMENTS',
    `Multiple browser sessions are open; specify sessionId. Known sessions: ${all.map((s) => s.sessionId).join(', ')}.`,
  );
}

function describe(session: SessionRecord): BrowserSessionSnapshot {
  const viewport = session.page.viewportSize() ?? DEFAULT_VIEWPORT;
  return {
    sessionId: session.sessionId,
    url: session.page.url(),
    title: '',
    headed: session.headed,
    viewport,
    ...(session.attached ? { attached: true } : {}),
  };
}

async function describeAsync(session: SessionRecord): Promise<BrowserSessionSnapshot> {
  const base = describe(session);
  return { ...base, title: await session.page.title().catch(() => '') };
}

/** Playwright 的超时错误统一映射成结构化 TIMEOUT,便于 agent 区分「选择器没出现」与真故障。 */
function wrapActionError(error: unknown): never {
  if (error instanceof BrowserManagerError) throw error;
  const message = errorMessage(error);
  if (/Timeout .* exceeded|waiting for/i.test(message)) {
    throw new BrowserManagerError('TIMEOUT', message);
  }
  throw new BrowserManagerError('EXECUTION_ERROR', message);
}

export interface ActionResult extends BrowserSessionSnapshot {
  action: string;
  diagnostics: BrowserDiagnostics;
}

function diagnostics(session: SessionRecord): BrowserDiagnostics {
  return snapshotDiagnostics(session.diag);
}

async function finish(session: SessionRecord, action: string): Promise<ActionResult> {
  return { action, ...(await describeAsync(session)), diagnostics: diagnostics(session) };
}

export async function navigate(opts: { sessionId?: string; url: string; timeoutMs?: number }): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  const url = validateNavigationUrl(opts.url);
  try {
    const response = await session.page.goto(url.toString(), {
      timeout: resolveTimeout(opts.timeoutMs),
      waitUntil: 'domcontentloaded',
    });
    if (response && !response.ok()) {
      record(session, 'failedRequests', `GET ${url.toString()} — HTTP ${response.status()}`);
    }
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'navigate');
}

export async function click(opts: { sessionId?: string; selector: string; timeoutMs?: number }): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  try {
    await session.page.click(opts.selector, { timeout: resolveTimeout(opts.timeoutMs) });
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'click');
}

export async function fill(opts: {
  sessionId?: string;
  selector: string;
  value: string;
  timeoutMs?: number;
}): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  try {
    await session.page.fill(opts.selector, opts.value, { timeout: resolveTimeout(opts.timeoutMs) });
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'fill');
}

export async function press(opts: {
  sessionId?: string;
  key: string;
  selector?: string;
  timeoutMs?: number;
}): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  const timeout = resolveTimeout(opts.timeoutMs);
  try {
    if (opts.selector) await session.page.press(opts.selector, opts.key, { timeout });
    else await session.page.keyboard.press(opts.key);
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'press');
}

export async function waitFor(opts: {
  sessionId?: string;
  selector: string;
  timeoutMs?: number;
}): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  try {
    await session.page.waitForSelector(opts.selector, { timeout: resolveTimeout(opts.timeoutMs) });
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'wait_for');
}

export interface TextResult extends ActionResult {
  text: string;
}

export async function readText(opts: { sessionId?: string; selector?: string; limit?: number }): Promise<TextResult> {
  const session = requireSession(opts.sessionId);
  const limit = Math.min(Math.max(Number(opts.limit ?? 4_000), 100), 32_000);
  let text: string;
  try {
    text = opts.selector
      ? ((await session.page.textContent(opts.selector, { timeout: DEFAULT_TIMEOUT_MS })) ?? '')
      : await session.page.innerText('body');
  } catch (error) {
    wrapActionError(error);
  }
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  return {
    ...(await finish(session, 'text')),
    text: normalized.length > limit ? `${normalized.slice(0, limit)}\n… (truncated)` : normalized,
  };
}

export interface ScreenshotResult extends ActionResult {
  buffer: Buffer;
}

export async function screenshot(opts: {
  sessionId?: string;
  fullPage?: boolean;
  selector?: string;
  timeoutMs?: number;
}): Promise<ScreenshotResult> {
  const session = requireSession(opts.sessionId);
  const timeout = resolveTimeout(opts.timeoutMs);
  let buffer: Buffer;
  try {
    buffer = opts.selector
      ? await session.page.locator(opts.selector).screenshot({ timeout, type: 'png' })
      : await session.page.screenshot({ timeout, type: 'png', fullPage: opts.fullPage === true });
  } catch (error) {
    wrapActionError(error);
  }
  return { ...(await finish(session, 'screenshot')), buffer };
}

export function listSessions(): BrowserSessionSnapshot[] {
  return [...sessions.values()].map(describe);
}

export async function closeSession(sessionId?: string): Promise<{ sessionId: string; closed: boolean }> {
  const session = requireSession(sessionId);
  sessions.delete(session.sessionId);
  for (const off of session.cleanup) off();
  if (session.attached) {
    // 面板里的页面属于用户：只解绑监听，绝不关闭 context/浏览器。
    return { sessionId: session.sessionId, closed: true };
  }
  await session.context.close().catch(() => {});
  if (sessions.size === 0 && browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close().catch(() => {});
  }
  return { sessionId: session.sessionId, closed: true };
}

/** 全局退出清理:关闭所有页面与浏览器进程。幂等。 */
export async function closeAllBrowsers(): Promise<void> {
  for (const session of [...sessions.values()]) {
    sessions.delete(session.sessionId);
    for (const off of session.cleanup) off();
    // attach 的页面不归我们所有，只解绑；否则关一次会话就把用户的面板页关了。
    if (session.attached) continue;
    await session.context.close().catch(() => {});
  }
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  const browser = await pending.catch(() => null);
  await browser?.close().catch(() => {});
  // CDP 连接是「连到别人的浏览器」，断开即可，不 close。
  const attached = attachPromise;
  attachPromise = null;
  const remote = await attached?.catch(() => null);
  await remote?.close().catch(() => {});
}
