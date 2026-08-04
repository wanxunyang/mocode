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

export type BrowserErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'SANDBOX_DENIED'
  | 'TIMEOUT'
  | 'EXECUTION_ERROR';

export class BrowserManagerError extends Error {
  constructor(public readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = 'BrowserManagerError';
  }
}

export interface BrowserDiagnostics {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface BrowserSessionSnapshot {
  sessionId: string;
  url: string;
  title: string;
  headed: boolean;
  viewport: { width: number; height: number };
}

interface SessionRecord {
  sessionId: string;
  context: BrowserContext;
  page: Page;
  headed: boolean;
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
}

const sessions = new Map<string, SessionRecord>();
const DIAGNOSTIC_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

let browserPromise: Promise<Browser> | null = null;
let launchedHeaded = false;

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
    throw new BrowserManagerError(
      'SANDBOX_DENIED',
      `Only http and https URLs are allowed (received ${url.protocol}).`,
    );
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

async function launchBrowser(headed: boolean): Promise<Browser> {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch (error) {
    throw new BrowserManagerError(
      'EXECUTION_ERROR',
      `Playwright is not available: ${errorMessage(error)}. Run "npm install" first.`,
    );
  }
  try {
    return await playwright.chromium.launch({ headless: !headed });
  } catch (error) {
    throw new BrowserManagerError(
      'EXECUTION_ERROR',
      `Unable to launch Chromium: ${errorMessage(error)}. If the browser binary is missing, run "npx playwright install chromium".`,
    );
  }
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
  const target = session[bucket];
  target.push(line);
  if (target.length > DIAGNOSTIC_LIMIT) target.splice(0, target.length - DIAGNOSTIC_LIMIT);
}

export async function openSession(opts: { headed?: boolean } = {}): Promise<BrowserSessionSnapshot> {
  const headed = opts.headed === true;
  const browser = await getBrowser(headed);
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

  const session: SessionRecord = {
    sessionId: `page-${randomBytes(3).toString('hex')}`,
    context,
    page,
    headed,
    console: [],
    pageErrors: [],
    failedRequests: [],
  };

  page.on('console', (message: ConsoleMessage) => {
    record(session, 'console', `[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => record(session, 'pageErrors', errorMessage(error)));
  page.on('requestfailed', (request) => {
    record(session, 'failedRequests', `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
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
  return {
    console: session.console.slice(-20),
    pageErrors: session.pageErrors.slice(-20),
    failedRequests: session.failedRequests.slice(-20),
  };
}

async function finish(session: SessionRecord, action: string): Promise<ActionResult> {
  return { action, ...(await describeAsync(session)), diagnostics: diagnostics(session) };
}

export async function navigate(
  opts: { sessionId?: string; url: string; timeoutMs?: number },
): Promise<ActionResult> {
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

export async function click(
  opts: { sessionId?: string; selector: string; timeoutMs?: number },
): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  try {
    await session.page.click(opts.selector, { timeout: resolveTimeout(opts.timeoutMs) });
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'click');
}

export async function fill(
  opts: { sessionId?: string; selector: string; value: string; timeoutMs?: number },
): Promise<ActionResult> {
  const session = requireSession(opts.sessionId);
  try {
    await session.page.fill(opts.selector, opts.value, { timeout: resolveTimeout(opts.timeoutMs) });
  } catch (error) {
    wrapActionError(error);
  }
  return finish(session, 'fill');
}

export async function press(
  opts: { sessionId?: string; key: string; selector?: string; timeoutMs?: number },
): Promise<ActionResult> {
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

export async function waitFor(
  opts: { sessionId?: string; selector: string; timeoutMs?: number },
): Promise<ActionResult> {
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

export async function readText(
  opts: { sessionId?: string; selector?: string; limit?: number },
): Promise<TextResult> {
  const session = requireSession(opts.sessionId);
  const limit = Math.min(Math.max(Number(opts.limit ?? 4_000), 100), 32_000);
  let text: string;
  try {
    text = opts.selector
      ? (await session.page.textContent(opts.selector, { timeout: DEFAULT_TIMEOUT_MS })) ?? ''
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

export async function screenshot(
  opts: { sessionId?: string; fullPage?: boolean; selector?: string; timeoutMs?: number },
): Promise<ScreenshotResult> {
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
    await session.context.close().catch(() => {});
  }
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  const browser = await pending.catch(() => null);
  await browser?.close().catch(() => {});
}
