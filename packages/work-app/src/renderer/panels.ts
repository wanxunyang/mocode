/**
 * 面板视图（会话 / 用量 / 记忆）—— 对齐终端的 /sessions、/usage、/memory。
 *
 * 回滚**不是**面板：它是「回到这条消息之前」，语义绑在某条具体消息上，
 * 所以入口只有用户消息气泡上的回滚按钮（renderer.ts 的 wireMessageActions），
 * 侧栏不给独立入口 —— 否则同一个动作两个位置、两套实现，行为还会不一致。
 *
 * 为什么单独一个模块：renderer.ts 已经 4500 行，而这几块共享同一套「发命令 → 等回执 →
 * 渲染」骨架。放在这里可以一处实现骨架，几块只写各自的展示。
 *
 * 依赖注入而不是直接 import：这些面板要用 renderer 里的 t / icon / escapeHtml / toast，
 * 但 renderer 又要 import 本模块的渲染入口 —— 直接互相 import 就成环了。
 *
 * 协议约定（host 侧见 src/host/stdio.ts）：
 *   - 请求 = 一条普通 HostCommand，但 **id 由渲染层生成**（不是任务 id）；
 *   - 回执 = 一个带同一 requestId 的事件（sessions_report / usage_report / …）；
 *   - 失败 = 带同一 requestId 的 error 信封。
 * 所以这里的 pending 表按 requestId 索引，与任务事件流完全隔离。
 */
import type { LocaleKey } from '../i18n/index.js';

export type PanelKind = 'sessions' | 'usage' | 'memory';

export interface PanelEnvelope {
  type: string;
  event?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface PanelDeps {
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string;
  icon: (name: string) => string;
  escapeHtml: (value: string) => string;
  toast: (level: 'info' | 'success' | 'warn' | 'error', text: string, durationMs?: number) => void;
  /** 当前查看的任务 id（面板命令都发到它的 host 上）。 */
  currentTaskId: () => string | undefined;
  /**
   * 当前任务的会话 id。session 口径的用量必须显式带上它：
   * 面板命令由懒启动的 host 处理，那时 host 进程内的 sessionId 还是空串。
   */
  currentSessionId: () => string | undefined;
  /** 会话被恢复/回滚后，让 renderer 重新按磁盘回放这个任务。 */
  reloadTask: (taskId: string) => void;
  /** 把命令发到主进程（main 负责补 host 侧需要的路由，见 work:panel）。 */
  send: (command: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * 面板回执事件名 —— 它们不归属任何任务，必须先于任务事件分发被拦下。
 *
 * rollback_report / rollback_applied 不在这里：GUI 的回滚只回滚对话，入口是消息气泡上的
 * 按钮（走主进程 rollbackSession，不经 host changeset），所以这两个回执没人等。
 */
const PANEL_EVENTS = new Set([
  'sessions_report',
  'session_resumed',
  'session_forked',
  'changes_report',
  'usage_report',
  'context_usage',
  'memory_report',
  'settings_state',
  'commit_message_report',
]);

/** 正在等回执的请求。key = 渲染层生成的 requestId。 */
const pending = new Map<
  string,
  { resolve: (envelope: PanelEnvelope) => void; timer: ReturnType<typeof setTimeout>; cleanup?: () => void }
>();
const REQUEST_TIMEOUT_MS = 20_000;
// 提交流程之外还有模型网络重试；真实 LLM 不能套用普通面板查询的 20 秒预算。
const COMMIT_MESSAGE_TIMEOUT_MS = 120_000;

let deps: PanelDeps | null = null;
let activeKind: PanelKind | null = null;

export function initPanels(injected: PanelDeps): void {
  deps = injected;
}

function need(): PanelDeps {
  if (!deps) throw new Error('Panels are not initialized.');
  return deps;
}

export function isPanelEvent(envelope: PanelEnvelope): boolean {
  if (typeof envelope.requestId !== 'string' || !pending.has(envelope.requestId)) return false;
  return envelope.type === 'error' || (typeof envelope.event === 'string' && PANEL_EVENTS.has(envelope.event));
}

/**
 * 分发面板回执。只认 pending 里的 requestId —— 别的（含任务事件）一律返回 false，
 * 调用方据此继续走任务事件流，不会把两套通道搅在一起。
 */
export function handlePanelEvent(envelope: PanelEnvelope): boolean {
  const id = envelope.requestId;
  if (typeof id !== 'string') return false;
  const waiter = pending.get(id);
  if (!waiter) return false;
  pending.delete(id);
  clearTimeout(waiter.timer);
  waiter.cleanup?.();
  waiter.resolve(envelope);
  return true;
}

/**
 * 发一条面板命令并等回执。
 *
 * 超时必须有：host 崩了 / 命令没被识别时不会有任何回执，没有兜底的话
 *「正在加载…」会永久挂在面板上。
 */
async function request(command: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<PanelEnvelope> {
  const api = need();
  const id = `panel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const cancel = (envelope: PanelEnvelope): void => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.cleanup?.();
    if (command.type === 'commit_message') {
      // 回执取消是尽力而为；关闭面板后没有接收错误提示的上下文。
      void api.send({ type: 'cancel_commit_message', id: `${id}-cancel`, targetId: id }).catch(() => {});
    }
    waiter.resolve(envelope);
  };
  if (options?.signal?.aborted) return { type: 'cancelled', requestId: id };
  const signal = options?.signal;
  const onAbort = (): void => cancel({ type: 'cancelled', requestId: id });
  const promise = new Promise<PanelEnvelope>((resolve) => {
    const timer = setTimeout(() => cancel({ type: 'error', error: api.t('panel.timeout'), requestId: id }),
      command.type === 'commit_message' ? COMMIT_MESSAGE_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  const sent = await api.send({ ...command, id });
  if (!sent.ok) {
    const waiter = pending.get(id);
    if (waiter) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.cleanup?.();
      waiter.resolve({ type: 'error', error: sent.message ?? api.t('panel.failed'), requestId: id });
    }
  }
  return promise;
}

/** 输入栏上下文快照复用面板请求/回执配对，但不进入任何整页面板。 */
export function requestPanelCommand(command: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<PanelEnvelope> {
  return request(command, options);
}

function payloadOf(envelope: PanelEnvelope): Record<string, unknown> {
  return envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
}

/** 统一错误出口：面板里任何一个请求失败，都在容器顶部留一条可读的红色说明。 */
function errorOf(envelope: PanelEnvelope): string | null {
  if (envelope.type !== 'error') return null;
  return envelope.error ?? need().t('panel.failed');
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tokenText(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function whenText(iso: string): string {
  if (!iso) return '';
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return iso;
  const diff = Date.now() - stamp;
  if (diff < 60_000) return need().t('panel.justNow');
  if (diff < 3_600_000) return need().t('panel.minutesAgo', { n: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return need().t('panel.hoursAgo', { n: Math.round(diff / 3_600_000) });
  return new Date(stamp).toLocaleDateString();
}

/** 面板骨架：顶部说明 + 内容区。四块面板共用。 */
function shell(title: string, hint: string, extra = ''): string {
  const api = need();
  return `<div class="settings-block panel-head"><div class="settings-block-head"><b>${api.escapeHtml(title)}</b><span>${api.escapeHtml(hint)}</span></div>${extra}</div>`;
}

function loading(): string {
  return `<p class="inspector-loading">${need().t('panel.loading')}</p>`;
}

function errorBlock(message: string): string {
  return `<p class="panel-error">${need().escapeHtml(message)}</p>`;
}

function emptyBlock(message: string): string {
  return `<p class="inspector-empty">${need().escapeHtml(message)}</p>`;
}/* ────────────────────────────── 会话面板 ────────────────────────────── */

/** 会话列表里的一行。当前会话不给「恢复」，给「分叉」——回到当前会话是无操作。 */
function sessionRow(session: Record<string, unknown>): string {
  const api = need();
  const id = str(session.id);
  const current = session.current === true;
  const archived = session.archived === true;
  const firstUser = str(session.firstUser) || id.slice(0, 8);
  // 跨工作空间列表里同名的会话很多（都是「hi」），不带工作空间就分不清是哪条。
  const workspaceName = str(session.workspaceName);
  return `<div class="panel-row${current ? ' is-current' : ''}">
    <div class="panel-row-body">
      <span class="panel-row-title">${api.escapeHtml(firstUser.slice(0, 120))}</span>
      <span class="panel-row-sub">${api.escapeHtml(str(session.model))} · ${api.escapeHtml(whenText(str(session.createdAt)))}${workspaceName ? ` · ${api.escapeHtml(workspaceName)}` : ''}${archived ? ` · ${api.escapeHtml(api.t('sessions.archived'))}` : ''}${current ? ` · ${api.escapeHtml(api.t('sessions.current'))}` : ''}</span>
    </div>
    <div class="panel-row-actions">
      ${current ? '' : `<button class="btn-ghost" data-restore="${api.escapeHtml(id)}" data-workspace="${api.escapeHtml(str(session.workspace))}">${api.t('sessions.restore')}</button>`}
      ${archived ? '' : `<button class="btn-ghost" data-fork="${api.escapeHtml(id)}" data-workspace="${api.escapeHtml(str(session.workspace))}">${api.t('sessions.fork')}</button>`}
    </div>
  </div>`;
}

/**
 * 会话面板。两种范围：
 *   current —— 本 host 工作空间（= 终端 /sessions，也 = 当前任务能直接续上的那些）
 *   all     —— 全局工作空间注册表里所有目录（终端在 F:\mocode 留的会话也在内）
 *
 * 跨工作空间的会话**不能**直接 resume：resume 只切 host 内存里的当前会话，
 * 文件仍属于本工作空间。所以那种行只给「分叉不了」的提示，避免用户以为恢复了。
 */
async function renderSessions(container: HTMLElement, scope: 'current' | 'all' = 'current'): Promise<void> {
  const api = need();
  container.innerHTML = loading();
  const env = await request({ type: 'sessions', action: 'list', limit: 50, scope });
  const failure = errorOf(env);
  if (failure) return void (container.innerHTML = shell(api.t('sessions.title'), api.t('sessions.hint')) + errorBlock(failure));
  const data = payloadOf(env);
  const sessions = Array.isArray(data.sessions) ? (data.sessions as Array<Record<string, unknown>>) : [];
  const currentWorkspace = str(data.currentWorkspace);
  container.innerHTML =
    shell(
      api.t('sessions.title'),
      api.t('sessions.hint'),
      `<div class="panel-tabs">
        <button class="${scope === 'current' ? 'active' : ''}" data-scope="current">${api.t('sessions.scopeCurrent')}</button>
        <button class="${scope === 'all' ? 'active' : ''}" data-scope="all">${api.t('sessions.scopeAll')}</button>
      </div>
      <div class="panel-search"><input id="panel-session-query" class="field-input" type="text" placeholder="${api.escapeHtml(api.t('sessions.searchPlaceholder'))}" autocomplete="off" spellcheck="false" /><button class="btn-ghost" id="panel-session-search">${api.t('sessions.search')}</button></div>
      ${scope === 'all' && currentWorkspace ? `<p class="panel-note">${api.escapeHtml(api.t('sessions.currentWorkspace', { path: currentWorkspace }))}</p>` : ''}`,
    ) +
    `<div id="panel-session-list" class="settings-block">${sessions.length ? sessions.map(sessionRow).join('') : emptyBlock(scope === 'current' ? api.t('sessions.none') : api.t('sessions.noneAnywhere'))}</div>` +
    `<div id="panel-session-hits" class="settings-block"></div>`;

  const list = container.querySelector<HTMLElement>('#panel-session-list');
  const hitsBox = container.querySelector<HTMLElement>('#panel-session-hits');

  /** 这条会话属于哪个工作空间；不是本工作空间的就不能 resume/fork（文件不在这里）。 */
  const foreign = (button: HTMLButtonElement): boolean => {
    const workspace = button.dataset.workspace ?? '';
    return scope === 'all' && !!workspace && !!currentWorkspace && workspace !== currentWorkspace;
  };

  const restore = async (button: HTMLButtonElement, id: string): Promise<void> => {
    if (foreign(button)) { api.toast('warn', api.t('sessions.foreignWorkspace'), 6000); return; }
    const taskId = api.currentTaskId();
    const result = await request({ type: 'sessions', action: 'resume', sessionId: id });
    const error = errorOf(result);
    if (error) { api.toast('error', error, 6000); return; }
    api.toast('success', api.t('sessions.restored'));
    // 会话换了：任务的历史必须按磁盘重新回放，否则界面还挂着旧对话。
    if (taskId) api.reloadTask(taskId);
    void renderSessions(container, scope);
  };
  const fork = async (button: HTMLButtonElement, id: string): Promise<void> => {
    if (foreign(button)) { api.toast('warn', api.t('sessions.foreignWorkspace'), 6000); return; }
    const result = await request({ type: 'sessions', action: 'fork', sessionId: id });
    const error = errorOf(result);
    if (error) { api.toast('error', error, 6000); return; }
    api.toast('success', api.t('sessions.forked'));
    void renderSessions(container, scope);
  };

  container.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((button) =>
    button.addEventListener('click', () => {
      const next = button.dataset.scope === 'all' ? 'all' : 'current';
      if (next !== scope) void renderSessions(container, next);
    }),
  );

  list?.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((button) =>
    button.addEventListener('click', () => void restore(button, button.dataset.restore ?? '')),
  );
  list?.querySelectorAll<HTMLButtonElement>('[data-fork]').forEach((button) =>
    button.addEventListener('click', () => void fork(button, button.dataset.fork ?? '')),
  );

  const input = container.querySelector<HTMLInputElement>('#panel-session-query');
  const runSearch = async (): Promise<void> => {
    const query = input?.value.trim() ?? '';
    if (!query || !hitsBox) return;
    hitsBox.innerHTML = loading();
    const result = await request({ type: 'sessions', action: 'search', query, limit: 10 });
    const error = errorOf(result);
    if (error) { hitsBox.innerHTML = errorBlock(error); return; }
    const payload = payloadOf(result);
    const hits = Array.isArray(payload.hits) ? (payload.hits as Array<Record<string, unknown>>) : [];
    hitsBox.innerHTML =
      `<div class="settings-block-head"><b>${api.t('sessions.searchResults')}</b><span>${api.escapeHtml(query)}</span></div>` +
      (hits.length
        ? hits
            .map((hit) => {
              // purged 的归档只剩摘要：正文已删，恢复按钮点了也只会失败，不如不给。
              const purged = hit.purgedAt != null;
              const id = str(hit.id);
              return `<div class="panel-row">
                <div class="panel-row-body">
                  <span class="panel-row-title">${api.escapeHtml(str(hit.summary ?? hit.firstUser ?? id).slice(0, 160))}</span>
                  <span class="panel-row-sub">${api.escapeHtml(str(hit.model))} · ${api.escapeHtml(whenText(str(hit.createdAt)))}${purged ? ` · ${api.escapeHtml(api.t('sessions.purged'))}` : ''}</span>
                </div>
                <div class="panel-row-actions">${purged ? '' : `<button class="btn-ghost" data-restore="${api.escapeHtml(id)}">${api.t('sessions.restore')}</button>`}</div>
              </div>`;
            })
            .join('')
        : emptyBlock(api.t('sessions.noHits')));
    hitsBox.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((button) =>
      button.addEventListener('click', () => void restore(button, button.dataset.restore ?? '')),
    );
  };
  container.querySelector<HTMLButtonElement>('#panel-session-search')?.addEventListener('click', () => void runSearch());
  input?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void runSearch(); } });
}

/* ────────────────────────────── 用量面板 ────────────────────────────── */

function usageTable(rows: Array<[string, string]>): string {
  const api = need();
  return `<div class="panel-kv">${rows
    .map(([label, value]) => `<div class="panel-kv-row"><span>${api.escapeHtml(label)}</span><b>${api.escapeHtml(value)}</b></div>`)
    .join('')}</div>`;
}

/** 大数字块：比键值行更适合「一眼看总量」，一块一个指标。 */
function usageTiles(tiles: Array<{ label: string; value: string; hint?: string }>): string {
  const api = need();
  return `<div class="usage-tiles">${tiles
    .map(
      (tile) =>
        `<div class="usage-tile"><span class="usage-tile-label">${api.escapeHtml(tile.label)}</span><b class="usage-tile-value">${api.escapeHtml(tile.value)}</b>${tile.hint ? `<span class="usage-tile-hint">${api.escapeHtml(tile.hint)}</span>` : ''}</div>`,
    )
    .join('')}</div>`;
}

/** 横向条形表：模型 / 工作空间 / 按天的对比，长度按各自最大值归一。 */
function usageBars(rows: Array<{ label: string; value: number; sub?: string }>): string {
  const api = need();
  if (!rows.length) return '';
  const max = rows.reduce((most, row) => Math.max(most, row.value), 0) || 1;
  return `<div class="usage-bars">${rows
    .map((row) => {
      const width = Math.max(2, Math.round((row.value / max) * 100));
      return `<div class="usage-bar-row"><span class="usage-bar-label" title="${api.escapeHtml(row.label)}">${api.escapeHtml(row.label)}</span><span class="usage-bar-track"><span class="usage-bar-fill" style="width:${width}%"></span></span><span class="usage-bar-value">${api.escapeHtml(tokenText(row.value))}</span>${row.sub ? `<span class="usage-bar-sub">${api.escapeHtml(row.sub)}</span>` : ''}</div>`;
    })
    .join('')}</div>`;
}

/** 热力图窗口档位：方块数与统计窗口完全一致（一格 = 一天）。 */
const USAGE_WINDOWS = [7, 30, 180, 365] as const;

/** 日格明细卡片：点方块后显示当天各项消耗，复用 usageTiles 的视觉。 */
function usageDayDetail(day: Record<string, unknown> | null): string {
  const api = need();
  if (!day) return `<p class="inspector-empty">${api.escapeHtml(api.t('usage.dayPick'))}</p>`;
  const input = num(day.input);
  const output = num(day.output);
  const cached = num(day.cached);
  const calls = num(day.calls);
  const head = `<div class="usage-day-head"><b>${api.escapeHtml(str(day.day))}</b><span>${api.escapeHtml(api.t('usage.dayTotal'))} ${api.escapeHtml(tokenText(input + output))}</span></div>`;
  if (calls === 0 && input + output === 0) {
    return head + `<p class="inspector-empty">${api.escapeHtml(api.t('usage.dayEmpty'))}</p>`;
  }
  const hit = input > 0 && cached > 0 ? `${((cached / input) * 100).toFixed(1)}%` : '';
  return (
    head +
    usageTiles([
      { label: api.t('usage.records'), value: String(calls) },
      { label: api.t('usage.input'), value: tokenText(input) },
      { label: api.t('usage.output'), value: tokenText(output) },
      { label: api.t('usage.cached'), value: tokenText(cached), ...(hit ? { hint: hit } : {}) },
      { label: api.t('usage.reasoning'), value: tokenText(num(day.reasoning)) },
    ]) +
    `<p class="usage-day-foot">${api.escapeHtml(api.t('usage.sessions', { n: num(day.sessions) }))}</p>`
  );
}

/**
 * 日格 token 热力图（**一格 = 一天**，窗口 7 / 30 / 180 / 365 天）。
 *
 * 两个不能省的细节：
 *  1. 格子尺寸跟着窗口伸缩。7 天只有 1~2 列，仍用 11px 会挤成一根竖线；365 天 53 列，
 *     放大到 24px 就必须横向滚到底。所以按列数选尺寸，而不是写死一个值。
 *  2. 方块是 `<button>` 而不是 `<span>`：需求是「点方块看当天消耗」，span 挂 click 之后
 *     键盘/焦点语义全丢（Tab 走不到、回车不响应），按钮只需清掉默认边框与 padding。
 *
 * 每天的量取 input+output；分级用平方根而不是线性，否则一次巨型会话会把其余全压成最浅一级。
 */
function usageHeatmap(days: Array<Record<string, unknown>>, selectedDay: string): string {
  const api = need();
  if (!days.length) return '';
  const totals = days.map((row) => num(row.input) + num(row.output));
  const max = Math.max(0, ...totals);
  const levelOf = (value: number): number => {
    if (value <= 0) return 0;
    const ratio = Math.sqrt(value / (max || 1));
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };
  // 首格对齐到周一：GitHub 图的行是「星期几」，不是「第几天」。
  const first = new Date(`${str(days[0]!.day)}T00:00:00`);
  const lead = Number.isFinite(first.getTime()) ? (first.getDay() + 6) % 7 : 0;
  const cells: Array<{ day: string; value: number; calls: number } | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (const row of days) {
    cells.push({ day: str(row.day), value: num(row.input) + num(row.output), calls: num(row.calls) });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: Array<Array<{ day: string; value: number; calls: number } | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // 列少 → 大格，列多 → 小格：7 天约 2 列、30 天约 5 列、180 天约 27 列、365 天 53 列，
  // 四档各给一个尺寸，否则 180 天用 11px 会显得比 365 天还挤。
  const cellSize = weeks.length <= 8 ? 24 : weeks.length <= 16 ? 16 : weeks.length <= 32 ? 13 : 11;
  const gap = cellSize >= 16 ? 4 : 3;

  const monthOf = (iso: string): string => iso.slice(0, 7);
  let lastMonth = '';
  const weekColumns = weeks
    .map((week) => {
      const firstDay = week.find((cell) => cell);
      let label = '';
      if (firstDay && monthOf(firstDay.day) !== lastMonth) {
        lastMonth = monthOf(firstDay.day);
        // 只显示月份数字，窄列宽下仍可读。
        label = `<span class="usage-heat-month">${Number(lastMonth.slice(5, 7))}</span>`;
      }
      const column = week
        .map((cell) => {
          if (!cell) return '<span class="usage-heat-cell is-blank"></span>';
          const title = `${cell.day} · ${tokenText(cell.value)} tokens · ${cell.calls} ${api.t('usage.calls')}`;
          const selected = cell.day === selectedDay ? ' is-selected' : '';
          return `<button class="usage-heat-cell${selected}" data-day="${api.escapeHtml(cell.day)}" data-level="${levelOf(cell.value)}" title="${api.escapeHtml(title)}" aria-label="${api.escapeHtml(title)}"></button>`;
        })
        .join('');
      return `<div class="usage-heat-col"><div class="usage-heat-months">${label}</div>${column}</div>`;
    })
    .join('');

  const legend = [0, 1, 2, 3, 4]
    .map((level) => `<span class="usage-heat-cell" data-level="${level}"></span>`)
    .join('');
  return `<div class="settings-block usage-heat"><div class="settings-block-head"><b>${api.t('usage.heatmap')}</b><span>${api.escapeHtml(api.t('usage.heatmapHint'))}</span></div><div class="usage-heat-scroll"><div class="usage-heat-grid" style="--heat-cell:${cellSize}px;--heat-gap:${gap}px">${weekColumns}</div></div><div class="usage-heat-legend"><span>${api.escapeHtml(api.t('usage.less'))}</span>${legend}<span>${api.escapeHtml(api.t('usage.more'))}</span></div><div class="usage-day-detail" data-usage-day-detail>${usageDayDetail(days.find((row) => str(row.day) === selectedDay) ?? null)}</div></div>`;
}

/**
 * 给热力图的方块挂点击：只重绘底部明细卡片，不重新请求、不重画整张图。
 * `onPick` 把选中的日期回传给 renderUsage —— 切窗口后仍能停在同一天（若该天在新窗口内）。
 */
function attachHeatmap(
  container: HTMLElement,
  days: Array<Record<string, unknown>>,
  onPick: (day: string) => void,
): void {
  const box = container.querySelector<HTMLElement>('[data-usage-day-detail]');
  if (!box) return;
  const byDay = new Map(days.map((row) => [str(row.day), row]));
  const cells = Array.from(container.querySelectorAll<HTMLButtonElement>('.usage-heat-cell[data-day]'));
  cells.forEach((cell) =>
    cell.addEventListener('click', () => {
      const day = cell.dataset.day ?? '';
      box.innerHTML = usageDayDetail(byDay.get(day) ?? null);
      for (const other of cells) other.classList.toggle('is-selected', other === cell);
      onPick(day);
    }),
  );
}

async function renderUsage(container: HTMLElement): Promise<void> {
  const api = need();
  /**
   * 「本会话」页签需要一条会话：它的命令打到那个任务的 host，读的是该会话自己的
   * usage.jsonl。没有选中任务时（例如刚启动就想看总用量）这一页签无处可去，直接不画 ——
   * 画出来再点了报错，比不显示更让人困惑。global 口径任何时候都在。
   */
  const sessionAvailable = !!api.currentTaskId();
  /**
   * 页签监听必须在**每个**分支都挂上，包括空态和错误态。
   *
   * 这正是这次的坑：session 口径没有用量（新任务 / 没带 sessionId）时会 early return，
   * 页签画出来了却点不动 —— 用户看到「暂无用量记录」+ 三个死按钮，永远切不到跨项目视图。
   * 所以统一收敛成一个 attach()，谁写完 innerHTML 谁调它。
   */
  const attachTabs = (draw: (scope: 'session' | 'global', days: number) => Promise<void>): void => {
    container.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((button) =>
      button.addEventListener('click', () => void draw(button.dataset.scope === 'global' ? 'global' : 'session', Number(button.dataset.days ?? 7))),
    );
  };
  /** 选中的日期跨重绘保留：切窗口后若该天仍在新窗口内，明细箱继续显示它。 */
  let selectedDay = '';
  const windowLabel = (n: number): string =>
    n === 180 ? api.t('usage.lastHalfYear') : n === 365 ? api.t('usage.lastYear') : api.t('usage.lastDays', { n });
  const draw = async (scope: 'session' | 'global', days = 7): Promise<void> => {
    // 没有任务时「本会话」无从查起：任何调用方（包括旧的页签点击）都退到 global。
    if (scope === 'session' && !sessionAvailable) scope = 'global';
    container.innerHTML = loading();
    // session 口径必须显式带 sessionId：面板命令可能落到一个刚懒启动的 host 上，
    // 那时它进程内的 sessionId 还是空串，查出来永远是 empty。
    const sessionId = api.currentSessionId();
    const env = await request({ type: 'usage', scope, days, ...(sessionId ? { sessionId } : {}) });
    const failure = errorOf(env);
    const head = shell(
      api.t('usage.title'),
      api.t('usage.hint'),
      `<div class="panel-tabs">
        ${sessionAvailable ? `<button class="${scope === 'session' ? 'active' : ''}" data-scope="session">${api.t('usage.session')}</button>` : ''}
        ${USAGE_WINDOWS.map(
          (n) =>
            `<button class="${scope === 'global' && days === n ? 'active' : ''}" data-scope="global" data-days="${n}">${windowLabel(n)}</button>`,
        ).join('')}
      </div>`,
    );
    if (failure) { container.innerHTML = head + errorBlock(failure); attachTabs(draw); return; }
    const payload = payloadOf(env);
    const summary = payload.summary as Record<string, unknown> | undefined;
    const total = (summary?.total ?? {}) as Record<string, unknown>;
    // 空判定必须按口径分开：global 的 GlobalUsageSummary 没有 records 字段（只有 total.calls），
    // 统一读 summary.records 会把「13879 次调用」也判成空 —— 这就是用量面板恒为空的原因。
    const calls = scope === 'global' ? num(total.calls) : num(summary?.records);
    if (!summary || payload.empty === true || calls === 0) {
      container.innerHTML = head + emptyBlock(api.t('usage.empty'));
      attachTabs(draw);
      return;
    }
    // 缓存命中率：两个口径的字段名不同 —— session 口径由 summarizeUsage 直接给
    // cacheHitRate；global 口径（GlobalUsageSummary）只在 total 里有 cached/input。
    const hit = scope === 'global'
      ? (num(total.input) > 0 && num(total.cached) > 0 ? num(total.cached) / num(total.input) : null)
      : (typeof summary.cacheHitRate === 'number' ? summary.cacheHitRate : null);
    const tiles = usageTiles([
      { label: api.t('usage.records'), value: String(calls) },
      { label: api.t('usage.input'), value: tokenText(num(total.input)) },
      { label: api.t('usage.output'), value: tokenText(num(total.output)) },
      { label: api.t('usage.cached'), value: tokenText(num(total.cached)), hint: hit == null ? undefined : `${(hit * 100).toFixed(1)}%` },
      { label: api.t('usage.reasoning'), value: tokenText(num(total.reasoning)) },
    ]);
    if (scope === 'global') {
      // byModel / byDay 嵌在 summary 里（summarizeGlobalUsage 的返回值），不在 payload 顶层。
      const byModel = Array.isArray(summary.byModel) ? (summary.byModel as Array<Record<string, unknown>>) : [];
      const byDay = Array.isArray(summary.byDay) ? (summary.byDay as Array<Record<string, unknown>>) : [];
      const byWorkspace = Array.isArray(summary.byWorkspace) ? (summary.byWorkspace as Array<Record<string, unknown>>) : [];
      const calendar = (payload.calendar ?? {}) as Record<string, unknown>;
      const calendarDays = Array.isArray(calendar.days) ? (calendar.days as Array<Record<string, unknown>>) : [];
      const barRows = (rows: Array<Record<string, unknown>>, labelKey: string): Array<{ label: string; value: number; sub?: string }> =>
        rows
          .slice(0, 8)
          .map((row) => ({
            label: str(row[labelKey]),
            value: num(row.input) + num(row.output),
            sub: api.t('usage.sessions', { n: num(row.sessions) }),
          }))
          // 工作空间显示目录名而不是完整路径（侧栏宽度有限，完整路径放到 title 里）。
          .map((row) => ({ ...row, label: row.label.includes('\\') || row.label.includes('/') ? row.label.split(/[\\/]/).filter(Boolean).pop() ?? row.label : row.label }));
      const windowHint = api.t('usage.windowHint', { label: windowLabel(days) });
      const section = (title: string, hint: string, body: string): string =>
        `<div class="settings-block"><div class="settings-block-head"><b>${api.escapeHtml(title)}</b><span>${api.escapeHtml(hint)}</span></div>${body}</div>`;
      // 选中的那天可能落在新窗口外（例如从一年切到 7 天）：此时清掉，明细箱回到「点一格看当天」。
      if (selectedDay && !calendarDays.some((row) => str(row.day) === selectedDay)) selectedDay = '';
      // 按天条形最多 14 行（再多就成了一张不 readable 的长表）；窗口内天数不足时全列。
      const dayRows = byDay
        .slice(-Math.min(14, Math.max(7, byDay.length)))
        .map((row) => ({
          label: str(row.day).slice(5),
          value: num(row.input) + num(row.output),
          sub: api.t('usage.sessions', { n: num(row.sessions) }),
        }));
      container.innerHTML =
        head +
        usageHeatmap(calendarDays, selectedDay) +
        `<div class="settings-block">${tiles}</div>` +
        section(api.t('usage.byModel'), windowHint, byModel.length ? usageBars(barRows(byModel, 'key')) : emptyBlock(api.t('usage.empty'))) +
        section(api.t('usage.byWorkspace'), windowHint, byWorkspace.length ? usageBars(barRows(byWorkspace, 'key')) : emptyBlock(api.t('usage.empty'))) +
        section(api.t('usage.byDay'), windowHint, byDay.length ? usageBars(dayRows) : emptyBlock(api.t('usage.empty')));
      attachHeatmap(container, calendarDays, (day) => { selectedDay = day; });
    } else {
      const main = (summary.main ?? {}) as Record<string, unknown>;
      const compact = (summary.compact ?? {}) as Record<string, unknown>;
      const split = usageBars([
        { label: api.t('usage.mainCalls'), value: num(main.calls) },
        { label: api.t('usage.compactCalls'), value: num(compact.calls) },
      ]);
      container.innerHTML =
        head +
        `<div class="settings-block">${tiles}</div>` +
        `<div class="settings-block"><div class="settings-block-head"><b>${api.t('usage.split')}</b><span>${api.t('usage.compactShare', { n: num(compact.calls) })}</span></div>${split}</div>` +
        `<div class="settings-block">${usageTable([
          [api.t('usage.input'), tokenText(num(total.input))],
          [api.t('usage.output'), tokenText(num(total.output))],
          [api.t('usage.cached'), tokenText(num(total.cached))],
          [api.t('usage.reasoning'), tokenText(num(total.reasoning))],
          [api.t('usage.cacheHit'), hit == null ? 'n/a' : `${(hit * 100).toFixed(1)}%`],
        ])}</div>`;
    }
    container.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((button) =>
      button.addEventListener('click', () => void draw(button.dataset.scope === 'global' ? 'global' : 'session', Number(button.dataset.days ?? 7))),
    );
  };
  // 首屏永远进「近一年（跨项目）」：
  //   1) 热力图是跨项目的年视图，只有 global 口径才拿得到 calendar；
  //   2) 刚新建 / 刚切换的任务本会话还没有用量，进来先看到一个空白页 + 死页签，
  //      用户会以为「用量根本查不到」（这正是反馈里那条）；
  //   3) 进来就是想看「一共用了多少」，7 天窗口把历史都藏在页签后面（用户要求默认一年）。
  // 本会话仍是一个页签，一处不漏。
  await draw('global', 365);
}

/* ────────────────────────────── 记忆面板 ────────────────────────────── */

function memoryEntryRow(entry: Record<string, unknown>): string {
  const api = need();
  const id = str(entry.id);
  const pinned = entry.pinned === true;
  return `<div class="panel-row">
    <div class="panel-row-body">
      <span class="panel-row-title">${pinned ? '📌 ' : ''}${api.escapeHtml(str(entry.name) || str(entry.summary).slice(0, 60))}</span>
      <span class="panel-row-sub">${api.escapeHtml(str(entry.type))} · ${api.escapeHtml(str(entry.scope))} · ${api.escapeHtml(str(entry.summary).slice(0, 140))}</span>
    </div>
    <div class="panel-row-actions"><button class="btn-ghost danger" data-forget="${api.escapeHtml(id)}">${api.t('memory.forget')}</button></div>
  </div>`;
}

function profileEdgeRow(edge: Record<string, unknown>, action: 'confirm' | 'drop' | null): string {
  const api = need();
  const id = str(edge.id);
  const confidence = typeof edge.confidence === 'number' ? edge.confidence.toFixed(2) : '—';
  const evidence = edge.evidence as Record<string, unknown> | undefined;
  const detail = evidence ? ` · ${num(evidence.confirmed)}+/${num(evidence.contradicted)}-` : '';
  return `<div class="panel-row">
    <div class="panel-row-body">
      <span class="panel-row-title">${api.escapeHtml(str(edge.text).slice(0, 160))}</span>
      <span class="panel-row-sub">${api.escapeHtml(str(edge.relation))} · ${api.escapeHtml(api.t('memory.confidence'))} ${api.escapeHtml(confidence)}${detail}</span>
    </div>
    ${action ? `<div class="panel-row-actions"><button class="btn-ghost" data-${action === 'confirm' ? 'confirm' : 'drop'}="${api.escapeHtml(id)}">${api.t(action === 'confirm' ? 'memory.confirm' : 'memory.drop')}</button></div>` : ''}
  </div>`;
}

async function renderMemory(container: HTMLElement): Promise<void> {
  const api = need();
  type MemoryTab = 'overview' | 'profile' | 'health' | 'audit';
  const draw = async (tab: MemoryTab, query = ''): Promise<void> => {
    container.innerHTML = loading();
    const minAction = tab === 'audit' ? 'audit' : tab === 'health' ? 'health' : tab === 'profile' ? 'profile' : 'overview';
    const env = await request({ type: 'memory', action: minAction, limit: 50 });
    const failure = errorOf(env);
    const payload = payloadOf(env);
    const enabled = payload.enabled !== false;
    const paused = payload.paused === true;
    const head = shell(
      api.t('memory.title'),
      api.t('memory.hint'),
      `<div class="panel-tabs">
        <button class="${tab === 'overview' ? 'active' : ''}" data-tab="overview">${api.t('memory.overview')}</button>
        <button class="${tab === 'profile' ? 'active' : ''}" data-tab="profile">${api.t('memory.profile')}</button>
        <button class="${tab === 'health' ? 'active' : ''}" data-tab="health">${api.t('memory.health')}</button>
        <button class="${tab === 'audit' ? 'active' : ''}" data-tab="audit">${api.t('memory.audit')}</button>
      </div>` +
      `<div class="panel-search"><input id="panel-memory-query" class="field-input" type="text" value="${api.escapeHtml(query)}" placeholder="${api.escapeHtml(api.t('memory.searchPlaceholder'))}" autocomplete="off" spellcheck="false" /><button class="btn-ghost" id="panel-memory-search">${api.t('memory.search')}</button><button class="btn-ghost" id="panel-memory-reflect">${api.t('memory.reflect')}</button></div>`,
    );
    const banner = !enabled
      ? `<p class="panel-note">${api.escapeHtml(api.t('memory.disabled'))}</p>`
      : paused
        ? `<p class="panel-note">${api.escapeHtml(api.t('memory.paused'))}</p>`
        : '';
    if (failure) { container.innerHTML = head + banner + errorBlock(failure); return; }

    let body = '';
    if (tab === 'overview') {
      const counts = (payload.counts ?? {}) as Record<string, unknown>;
      const entries = Array.isArray(payload.entries) ? (payload.entries as Array<Record<string, unknown>>) : [];
      body =
        `<div class="settings-block">${usageTable([
          [api.t('memory.total'), String(num(counts.total))],
          [api.t('memory.active'), String(num(counts.active))],
          [api.t('memory.archived'), String(num(counts.archived))],
          [api.t('memory.superseded'), String(num(counts.superseded))],
        ])}</div>` +
        `<div class="settings-block"><div class="settings-block-head"><b>${api.t('memory.entries')}</b></div>${
          entries.length ? entries.map(memoryEntryRow).join('') : emptyBlock(api.t('memory.none'))
        }</div>`;
    } else if (tab === 'profile') {
      const internalized = Array.isArray(payload.internalized) ? (payload.internalized as Array<Record<string, unknown>>) : [];
      const candidates = Array.isArray(payload.candidates) ? (payload.candidates as Array<Record<string, unknown>>) : [];
      const primary = payload.primary as Record<string, unknown> | null;
      body =
        `<div class="settings-block"><div class="settings-block-head"><b>${api.t('memory.primary')}</b><span>${api.escapeHtml(primary ? str(primary.name) : api.t('memory.none'))}</span></div>${
          internalized.length ? internalized.map((edge) => profileEdgeRow(edge, null)).join('') : emptyBlock(api.t('memory.noInternalized'))
        }</div>` +
        `<div class="settings-block"><div class="settings-block-head"><b>${api.t('memory.candidates')}</b></div>${
          candidates.length ? candidates.map((edge) => profileEdgeRow(edge, 'confirm')).join('') : emptyBlock(api.t('memory.noCandidates'))
        }</div>`;
    } else if (tab === 'health') {
      const lines = Array.isArray(payload.lines) ? (payload.lines as string[]) : [];
      body = `<div class="settings-block"><pre class="status-output">${api.escapeHtml(lines.join('\n'))}</pre></div>`;
    } else {
      const records = Array.isArray(payload.records) ? (payload.records as Array<Record<string, unknown>>) : [];
      body = `<div class="settings-block">${
        records.length
          ? records.map((record) => `<div class="panel-row"><div class="panel-row-body"><span class="panel-row-title">${api.escapeHtml(str(record.action) || str(record.op))}</span><span class="panel-row-sub">${api.escapeHtml(str(record.entryId ?? record.id))} · ${api.escapeHtml(whenText(str(record.at ?? record.ts)))}</span></div></div>`).join('')
          : emptyBlock(api.t('memory.noAudit'))
      }</div>`;
    }

    container.innerHTML = head + banner + body;

    container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) =>
      button.addEventListener('click', () => void draw(button.dataset.tab as MemoryTab, query)),
    );
    const input = container.querySelector<HTMLInputElement>('#panel-memory-query');
    const doSearch = async (): Promise<void> => {
      const text = input?.value.trim() ?? '';
      if (!text) return;
      const result = await request({ type: 'memory', action: 'search', query: text, limit: 20 });
      const error = errorOf(result);
      if (error) { api.toast('error', error, 6000); return; }
      const hits = Array.isArray(payloadOf(result).entries) ? (payloadOf(result).entries as Array<Record<string, unknown>>) : [];
      container.innerHTML =
        head +
        `<div class="settings-block"><div class="settings-block-head"><b>${api.t('memory.searchResults')}</b><span>${api.escapeHtml(text)}</span></div>${
          hits.length ? hits.map(memoryEntryRow).join('') : emptyBlock(api.t('memory.noHits'))
        }</div>`;
      bindForget();
      container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) =>
        button.addEventListener('click', () => void draw(button.dataset.tab as MemoryTab, text)),
      );
    };
    container.querySelector<HTMLButtonElement>('#panel-memory-search')?.addEventListener('click', () => void doSearch());
    input?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void doSearch(); } });
    container.querySelector<HTMLButtonElement>('#panel-memory-reflect')?.addEventListener('click', async () => {
      const result = await request({ type: 'memory', action: 'reflect' });
      const error = errorOf(result);
      if (error) { api.toast('error', error, 6000); return; }
      api.toast('success', api.t('memory.reflected'));
    });

    /**
     * 遗忘需要二次确认：记忆库是用户长期资产，误删一条要走反思重新长出来。
     * 协议侧也要求 confirm:true —— 两边各挡一次，任何一边漏了都不会静默删除。
     */
    function bindForget(): void {
      container.querySelectorAll<HTMLButtonElement>('[data-forget]').forEach((button) =>
        button.addEventListener('click', async () => {
          if (button.dataset.armed !== '1') {
            button.dataset.armed = '1';
            button.textContent = api.t('memory.forgetConfirm');
            setTimeout(() => {
              if (button.dataset.armed === '1' && button.isConnected) {
                button.dataset.armed = '';
                button.textContent = api.t('memory.forget');
              }
            }, 5000);
            return;
          }
          const result = await request({ type: 'memory', action: 'forget', entryId: button.dataset.forget ?? '', confirm: true });
          const error = errorOf(result);
          if (error) { api.toast('error', error, 6000); return; }
          api.toast('success', api.t('memory.forgotten'));
          void draw(tab, query);
        }),
      );
    }
    bindForget();

    container.querySelectorAll<HTMLButtonElement>('[data-confirm]').forEach((button) =>
      button.addEventListener('click', async () => {
        const result = await request({ type: 'memory', action: 'confirm', entryId: button.dataset.confirm ?? '', confirm: true });
        const error = errorOf(result);
        if (error) { api.toast('error', error, 6000); return; }
        api.toast('success', api.t('memory.confirmed'));
        void draw('profile', query);
      }),
    );
    container.querySelectorAll<HTMLButtonElement>('[data-drop]').forEach((button) =>
      button.addEventListener('click', async () => {
        const result = await request({ type: 'memory', action: 'drop', entryId: button.dataset.drop ?? '', confirm: true });
        const error = errorOf(result);
        if (error) { api.toast('error', error, 6000); return; }
        api.toast('success', api.t('memory.dropped'));
        void draw('profile', query);
      }),
    );
  };
  await draw('overview');
}

/** 面板入口：renderer 调它把整页内容渲染进容器。 */
export async function renderPanel(kind: PanelKind, container: HTMLElement): Promise<void> {
  activeKind = kind;
  if (kind === 'sessions') return renderSessions(container);
  if (kind === 'usage') return renderUsage(container);
  return renderMemory(container);
}



/** 当前展示的是哪块面板（切语言时 renderer 据此重绘）。 */
export function activePanelKind(): PanelKind | null {
  return activeKind;
}