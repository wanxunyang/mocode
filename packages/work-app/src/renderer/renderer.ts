import { renderMarkdown, enhanceCodeBlocks, setMarkdownLabels } from './markdown.js';
import { mountIcons, icon } from './icons.js';
import { t, getLang, setLang, onLangChange, applyStaticI18n, initLangFromConfig, SUPPORTED_LANGS, LANG_NAMES, type LocaleKey, type SupportedLang } from '../i18n/index.js';

export {};

// 尽早把 HTML 里所有 data-icon 占位替换为 SVG,避免 first paint 看到空 icon。
mountIcons();

/* ── i18n 引导 ─────────────────────────────────────────────
 * 三步：①把 markdown 代码块按钮文案注入渲染器；②刷一遍 index.html 上的 data-i18n* 静态标记；
 * ③订阅语言变更，切语言时重刷静态文案 + 重建依赖语言的缓存节点（cheatsheet / 模板下拉）。
 * 动态渲染的部分（会话流、侧栏、设置页）由各 render 函数自行按当前语言生成 —— 切语言后
 * 统一调 applyLanguage() 整体重绘一次即可，不必逐个改渲染函数。 */
function syncMarkdownLabels(): void {
  setMarkdownLabels({
    copy: t('md.copy'),
    copied: t('md.copied'),
    copyFailed: t('md.copyFailed'),
    expand: (n) => t('md.expand', { n: n }),
    collapse: t('md.collapse'),
  });
}
syncMarkdownLabels();
applyStaticI18n();

/**
 * 切语言后整体重绘。凡是「按当前语言生成过一次就缓存住」的地方都必须在这里重建：
 * cheatsheet 弹窗（缓存 DOM）、模型模板下拉（optgroup 文案）、模型列表缓存 label 不涉文案但分组名要重算。
 */
function applyLanguage(): void {
  document.documentElement.lang = getLang();
  syncMarkdownLabels();
  applyStaticI18n();
  // cheatsheet / 会话搜索浮层的 DOM 是懒建 + 缓存的，直接丢掉让下次重建。
  if (cheatsheetEl) { cheatsheetEl.remove(); cheatsheetEl = null; }
  if (searchOverlay) { searchOverlay.remove(); searchOverlay = null; }
  if (modelFormEl) rebuildModelTemplates();
  // 视图层整体按新语言重生成。
  renderProjects();
  renderTasks();
  renderEmptyChips();
  // 设置页自己会判断「没开着就跳过」—— 不能在这里用 modelList.length 当开关：
  // 「外观」「关于」两个分类不依赖模型列表，一个预设都没配时也得跟着切语言。
  renderSettingsSectionCacheOnLang();
  renderModelPickerIfOpen();
  setModeButtonFromCache();
  // 会话流不重放（消息内容与语言无关），只重画状态行与输入区。
  renderStatusCacheOnLang();
  setRunning(isRunning(viewingTaskId()));
  renderAttachments();
}
onLangChange(() => applyLanguage());



type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type Project = { id: string; name: string; root: string; branch: string };
type Task = { id: string; projectId: string; title: string; status: TaskStatus; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string };
type WorkState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };
type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type HistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string; name?: string; arguments?: string };
type Attachment = { name: string; dataUrl: string };
type LlmProvider = 'openai' | 'anthropic';
type ModelConfig = { model: string; label: string; provider: LlmProvider; promptCache: boolean; baseUrl: string; contextWindow: number | null; language: string; theme: string };
type ModelItem = { name: string; label: string; provider: LlmProvider; promptCache: boolean; baseURL: string; providerHost: string; contextWindow: number; isActive: boolean };
type ModelDraft = { provider: LlmProvider; baseURL: string; apiKey: string; model: string; contextWindow: number; anthropicPromptCache: boolean };
type ModelPresetDetail = ModelDraft & { name: string };

declare global {
  interface Window {
    mocodeWork: {
      getState: () => Promise<WorkState>;
      pickProject: () => Promise<WorkState | null>;
      selectProject: (id: string) => Promise<WorkState>;
      createTask: (title: string, projectId?: string) => Promise<{ state: WorkState; task: Task }>;
      setTaskProject: (id: string, projectId: string) => Promise<{ ok: boolean; message?: string; state?: WorkState; task?: Task }>;
      selectTask: (id: string) => Promise<{ state: WorkState; task: Task; history: HistoryItem[] } | null>;
      /** 回滚对话:会话截断到「第 userIndex 条用户消息」之前。 */
      rollback: (value: { id: string; userIndex: number }) => Promise<{ ok: boolean; message?: string; state?: WorkState; history?: HistoryItem[] }>;
      clearTasks: (projectId?: string) => Promise<WorkState>;
      deleteTask: (id: string) => Promise<WorkState | null>;
      renameTask: (id: string, title: string) => Promise<WorkState | null>;
      renameProject: (id: string, name: string) => Promise<WorkState | null>;
      openFolder: (projectId: string) => Promise<boolean>;
      removeProject: (projectId: string) => Promise<{ state: WorkState; removed: string } | null>;
      projectOverview: () => Promise<Record<string, unknown>>;
      readFile: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      fileDiff: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      pickAttachment: () => Promise<Attachment | null>;
      getConfig: () => Promise<ModelConfig>;
      listModels: () => Promise<ModelItem[]>;
      switchModel: (name: string) => Promise<{ ok: boolean; message: string }>;
      getModel: (name: string) => Promise<{ ok: boolean; message?: string; preset?: ModelPresetDetail }>;
      saveModel: (payload: { name: string; originalName?: string; draft: ModelDraft; activate?: boolean }) => Promise<{ ok: boolean; message: string; name?: string }>;
      deleteModel: (name: string) => Promise<{ ok: boolean; message: string }>;
      getSettings: () => Promise<Record<string, boolean>>;
      setSettings: (patch: Record<string, boolean>) => Promise<Record<string, boolean>>;
      listBranches: () => Promise<{ ok: boolean; message: string; current: string; branches: string[] }>;
      switchBranch: (branch: string) => Promise<{ ok: boolean; message: string; branch?: string }>;
      setTheme: (theme: 'light' | 'dark' | 'system') => void;
      setLanguage: (language: string) => Promise<{ ok: boolean; language?: string; message?: string }>;
      send: (value: Record<string, unknown>) => void;
      onAgentEvent: (callback: (event: AgentEnvelope) => void) => () => void;
      onState: (callback: (state: WorkState) => void) => () => void;
    };
  }
}

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const taskList = $('#task-list'); const conversation = $('#conversation');
const emptyState = $('#empty-state'); const approvalPanel = $('#approval-panel'); const promptInput = $('#prompt') as HTMLTextAreaElement;
const sendButton = $('#send-button') as HTMLButtonElement; const inspector = $('#inspector'); const inspectorContent = $('#inspector-content');
const inspectorTitle = $('#inspector-title'); const attachmentList = $('#attachment-list'); const searchPanel = $('#search-panel'); const searchInput = $('#search-input') as HTMLInputElement;
const contextUsageEl = $('#context-usage');

let state: WorkState | null = null;
let collapsedProjects: Set<string> = new Set();
let collapsedSections: Set<string> = new Set();
let activeAssistant: HTMLElement | null = null;
let activeTextBlock: HTMLElement | null = null;
let attachments: Attachment[] = [];
let activeInspectorTab: 'overview' | 'files' = 'overview';

/* ── 多任务并行:每个任务一份事件流缓冲,后台任务照常累积,随时切换查看 ── */
type StreamItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; output: string; done: boolean }
  | { kind: 'error'; message: string };
interface TaskStream {
  items: StreamItem[];
  running: boolean;
  usagePercent: number | null;
  pendingApproval: Record<string, unknown> | null;
  /** 最近一次 agent 状态 —— 切回这个任务时状态行按它还原(见 renderStatus)。 */
  status: AgentStatusState | null;
  /** 本轮起点,用于终态里的「用时 Ns」。 */
  startedAt: number | null;
}
const streams = new Map<string, TaskStream>();

function streamFor(taskId: string): TaskStream {
  let stream = streams.get(taskId);
  if (!stream) { stream = { items: [], running: false, usagePercent: null, pendingApproval: null, status: null, startedAt: null }; streams.set(taskId, stream); }
  return stream;
}
function isRunning(taskId: string | undefined): boolean { return !!taskId && streams.get(taskId)?.running === true; }
/** 当前正在查看的任务 id(= 选中任务),事件与渲染按它路由。 */
function viewingTaskId(): string | undefined { return state?.selectedTaskId; }

/* ── Agent 状态行 ─────────────────────────────────────────
 * 单一真源:agentStatus。它是「agent 此刻在干什么」的现场指示,渲染在会话流**末尾**
 * —— 即 agent 输出内容的最下面:内容往下长它就被顶下去,跟着一起滚(不是悬浮层,
 * 不做 sticky,别把它变成盖在内容上的浮标)。
 *
 * 生命期严格绑在运行期上(见 renderStatus / clearStatusRow):
 *   · tone 'busy'  —— 显示,一直更到本轮结束(1s 心跳,秒数在走 = 还活着);
 *   · 运行终态     —— 「已完成 · 用时 Ns」/「运行失败」停一下让用户看清,然后淡出移除,
 *                     任务完了就不该再有东西赖在输出下面;
 *   · 等待确认 / 空闲 —— 不显示(审批卡本身就是更强的「等你」信号)。
 *
 * 存在的理由:按下发送到首个 token 之间隔着「工具组路由 + 首次 LLM 调用」两跳,
 * 好几秒里界面原本毫无反应,用户无从判断指令发出去没有、agent 在不在干活。 */
type AgentPhase = 'idle' | 'starting' | 'thinking' | 'tool' | 'speaking' | 'waiting' | 'compacting' | 'stopping' | 'done' | 'failed' | 'stopped';
type StatusTone = 'idle' | 'busy' | 'ok' | 'warn' | 'fail';
interface AgentStatusState {
  phase: AgentPhase;
  /** 主文案:「思考中」「正在执行 联网搜索」。由 labelKey 渲染而来（切语言时可重算）。 */
  label: string;
  /** 弱化后缀:工具名等补充信息。 */
  detail: string;
  tone: StatusTone;
  /** busy 状态的计时起点(null = 不计时)。 */
  since: number | null;
  /** 文案 key + 插值 —— 切语言时据此重算 label（否则缓存住的旧语言文案会留在界面上）。 */
  labelKey?: LocaleKey;
  labelVars?: Record<string, string | number>;
}

/** 按 key 重算状态行主文案（t() 读当前语言）。 */
function relabelStatus(state: AgentStatusState): AgentStatusState {
  if (!state.labelKey) return state;
  return { ...state, label: t(state.labelKey, state.labelVars) };
}

/** 运行中状态:带计时起点,状态行每秒重绘一次,让"它还在动"肉眼可见。 */
function busyStatus(phase: AgentPhase, labelKey: LocaleKey, labelVars?: Record<string, string | number>): AgentStatusState {
  return { phase, labelKey, labelVars, label: t(labelKey, labelVars), detail: '', tone: 'busy', since: Date.now() };
}
/** 终态 / 空闲态:不计时。 */
function settledStatus(phase: AgentPhase, labelKey: LocaleKey, tone: StatusTone, detail = ''): AgentStatusState {
  return { phase, labelKey, label: t(labelKey), detail, tone, since: null };
}

const IDLE_STATUS: AgentStatusState = settledStatus('idle', 'status.idle', 'idle');
const STATUS_ICON: Record<StatusTone, string> = { idle: 'dot-running', busy: 'loader', ok: 'check', warn: 'warn', fail: 'fail' };
/** 终态(已完成 / 运行失败)停留时长:够看清「用时 Ns」,又不至于赖着不走。 */
const STATUS_LINGER_MS = 1500;
/** 淡出时长,与 style.css 的 .agent-status 过渡一致。 */
const STATUS_FADE_MS = 160;

let agentStatus: AgentStatusState = IDLE_STATUS;
let statusRowEl: HTMLElement | null = null;
let statusTicker: ReturnType<typeof setInterval> | null = null;
let statusLingerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 状态行 DOM:**按需创建**,每次创建 / 取出都保证它是会话流倒数第一 ——
 * 内容之后又追加了消息的话,它会被重新挪回末尾,永远压在输出内容最下面。
 */
function ensureStatusRow(): HTMLElement {
  if (!statusRowEl) {
    statusRowEl = document.createElement('div');
    statusRowEl.className = 'agent-status';
    statusRowEl.setAttribute('role', 'status');
    statusRowEl.setAttribute('aria-live', 'polite');
    statusRowEl.innerHTML = '<span class="agent-status-icon"></span><span class="agent-status-label"></span><span class="agent-status-detail"></span>';
  }
  if (conversation.lastElementChild !== statusRowEl) conversation.append(statusRowEl);
  return statusRowEl;
}

function paintStatus(): void {
  const row = ensureStatusRow();
  const { tone, label, detail, since } = agentStatus;
  const seconds = tone === 'busy' && since !== null ? `${Math.max(1, Math.round((Date.now() - since) / 1000))}s` : '';
  row.className = `agent-status status-${tone}`;
  (row.querySelector('.agent-status-icon') as HTMLElement).innerHTML = icon(STATUS_ICON[tone]);
  (row.querySelector('.agent-status-label') as HTMLElement).textContent = label;
  (row.querySelector('.agent-status-detail') as HTMLElement).textContent = [detail, seconds].filter(Boolean).join(' · ');
}

/** 只有运行中需要心跳;空闲 / 终态一律停表,不留定时器。 */
function syncStatusTicker(): void {
  if (agentStatus.tone === 'busy') {
    if (!statusTicker) statusTicker = setInterval(paintStatus, 1000);
  } else if (statusTicker) {
    clearInterval(statusTicker);
    statusTicker = null;
  }
}

/** 取消「终态停留」计时(新状态一来就作废)。淡出后的移除计时不可取消,否则会留下一个隐形空行。 */
function cancelStatusLinger(): void {
  if (statusLingerTimer) { clearTimeout(statusLingerTimer); statusLingerTimer = null; }
}

/** 撤掉状态行:淡出 → 从 DOM 摘掉 → 引用清空(下次要显示时重建)。 */
function clearStatusRow(): void {
  cancelStatusLinger();
  if (statusTicker) { clearInterval(statusTicker); statusTicker = null; }
  agentStatus = IDLE_STATUS;
  const row = statusRowEl;
  if (!row) return;
  statusRowEl = null;
  row.classList.add('is-leaving');
  setTimeout(() => row.remove(), STATUS_FADE_MS);
}

/**
 * 写入状态行(视图侧)。计时起点由状态本身携带 —— 不跨任务复用,秒数不会张冠李戴。
 * 只有运行中(busy)常驻;终态闪一下再撤;等待确认 / 空闲根本不存在。
 * 切任务时传 replay:连终态也不重现 —— 那一屏属于当时的现场,不属于现在的这一次。
 */
function renderStatus(next: AgentStatusState, options: { replay?: boolean } = {}): void {
  cancelStatusLinger();
  agentStatus = next;
  syncStatusTicker();
  const transient = next.tone === 'ok' || next.tone === 'fail';
  if (next.tone !== 'busy' && !(transient && !options.replay)) { clearStatusRow(); return; }
  paintStatus();
  if (transient) statusLingerTimer = setTimeout(clearStatusRow, STATUS_LINGER_MS);
}

/** 状态事件的统一落点:写事件缓冲(切回来要还原)+ 写视图(仅当正在查看该任务)。 */
function applyStatus(stream: TaskStream, viewing: boolean, next: AgentStatusState): void {
  stream.status = next;
  if (viewing) renderStatus(next);
}

/** 切语言后重画状态行（label 由 key 重算，detail / 计时起点保留）。 */
function renderStatusCacheOnLang(): void {
  agentStatus = relabelStatus(agentStatus);
  const viewing = viewingTaskId();
  const stream = viewing ? streams.get(viewing) : undefined;
  if (stream?.status) stream.status = relabelStatus(stream.status);
  if (statusRowEl) paintStatus();
}

/** host status 事件 → 状态行文案。取值清单见 src/host/stdio.ts 的 hooksFor()。 */
function statusFromHostEvent(value: string, tool: string): AgentStatusState {
  const label = tool ? toolMeta(tool).label : '';
  if (value === 'preparing_tool') return busyStatus('tool', label ? 'status.preparingTool' : 'status.preparingToolGeneric', label ? { tool: label } : {});
  if (value === 'running_tool') return busyStatus('tool', label ? 'status.runningTool' : 'status.runningToolGeneric', label ? { tool: label } : undefined);
  if (value === 'compacting') return busyStatus('compacting', 'status.compacting');
  // 'thinking' 及其它未认知取值:onStepStart 已触发,正文 / 工具调用都还没到。
  return busyStatus('thinking', 'status.thinking');
}

/** 没有事件缓冲时(重启后打开旧任务)按任务记录兜底一个状态文案。 */
function statusFromTask(task: Task | undefined): AgentStatusState {
  if (!task) return IDLE_STATUS;
  if (task.status === 'completed') return settledStatus('done', 'status.completed', 'ok');
  if (task.status === 'failed') return settledStatus('failed', 'status.failed', 'fail');
  if (task.status === 'cancelled') return settledStatus('stopped', 'status.cancelled', 'idle');
  if (task.status === 'running' || task.status === 'waiting') return busyStatus('starting', 'status.running');
  return IDLE_STATUS;
}

/** 本轮跑了多久 —— 终态文案里给个「用时 Ns」,用户据此确认"确实跑完了一轮"。 */
function elapsedDetail(startedAt: number | null): string {
  if (!startedAt) return '';
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return seconds >= 1 ? t('status.elapsed', { s: seconds }) : '';
}

/* ── 启动看门狗 ──────────────────────────────────────────
 * 提交到首个事件之间隔着重启 host 的冷启动（实测 ~8s，开 MCP 更久）—— 慢是正常的，
 * 「永远没动静」不是。看门狗只认一件事：这一轮提交后有没有收到**任何**归属本任务的事件。
 * 一条都没收到、又过了上限 → 就地判定失败、写进对话流、收掉状态行。
 * 主进程侧已经做到「任何一条指令都不会被静默丢弃」（agent-send 会补 agent 实例、起不来必报错），
 * 这一层是最后一道兜底：宁可多报一次，也不能让界面一直用一个走着的秒数骗人。 */
const RUN_START_TIMEOUT_MS = 45_000;
const runStartTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearRunWatchdog(taskId: string): void {
  const timer = runStartTimers.get(taskId);
  if (timer) { clearTimeout(timer); runStartTimers.delete(taskId); }
}

function armRunWatchdog(taskId: string): void {
  clearRunWatchdog(taskId);
  runStartTimers.set(
    taskId,
    setTimeout(() => {
      runStartTimers.delete(taskId);
      const stream = streams.get(taskId);
      if (!stream?.running) return;
      const message = t('status.startTimeout', { s: RUN_START_TIMEOUT_MS / 1000 });
      stream.items.push({ kind: 'error', message });
      const viewing = viewingTaskId() === taskId;
      applyStatus(stream, viewing, settledStatus('failed', 'status.startFailed', 'fail', elapsedDetail(stream.startedAt)));
      endTaskRun(taskId);
      if (viewing) { console.error('[Agent]', message); showTurnError(message); showToast('error', message, 7000); finish(); }
      else notifyBackground(taskId, t('status.startFailed'));
    }, RUN_START_TIMEOUT_MS),
  );
}

/** 把失败写进**对话流**（不只是 3 秒 toast）：翻回来看得见，也能顺手点重新生成。 */
function showTurnError(message: string): void {
  const messageEl = activeAssistant;
  const content = messageEl?.querySelector('.message-content');
  if (!content || content.querySelector('.message-error')) return;
  const block = document.createElement('div');
  block.className = 'message-error';
  block.textContent = message;
  content.append(block);
  if (isAtBottom()) smartScrollToBottom(true);
}

function selectedProject(): Project | undefined { return state?.projects.find((project) => project.id === state?.selectedProjectId); }
function selectedTask(): Task | undefined { return state?.tasks.find((task) => task.id === state?.selectedTaskId); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!)); }
function statusText(status: TaskStatus): string { return ({ queued: t('status.queued'), running: t('status.running'), waiting: t('status.waiting'), completed: t('status.completed'), failed: t('status.failed'), cancelled: t('status.cancelled') })[status]; }
/** 未命名的任务（新建后还没发第一条指令）在侧栏显示占位标题。 */
function taskTitle(task: Task): string { return task.title.trim() || t('empty.draft'); }

/**
 * 落盘的错误文案 → 当前语言。主进程存的是稳定标记（`__stale_run__` / `__run_failed__`），
 * 因为 state 会写进 work-projects.json —— 存译文会让用户切语言后看到旧语言永久残留。
 */
function taskErrorText(task: Task): string {
  const raw = task.lastError ?? '';
  if (raw === '__stale_run__') return t('main.task.staleRun');
  if (raw === '__run_failed__') return t('main.task.runFailed');
  return raw;
}

/** 更新输入栏的上下文占比显示。pct=null 表示未知/无会话。 */
function updateContextUsage(pct: number | null): void {
  if (pct === null || !contextUsageEl) { if (contextUsageEl) contextUsageEl.textContent = '--'; return; }
  contextUsageEl.textContent = `${pct}%`;
  // 超过阈值标红提醒
  contextUsageEl.classList.toggle('usage-high', pct >= 70);
}

/**
 * 把 Agent Host / LLM 流冒上来的原始错误翻成一句用户能看懂的话。
 * 屏蔽 node-fetch / undici 的 ERR_STREAM_PREMATURE_CLOSE、网络断开、JSON 解析栈等
 * 内部噪音,只保留"重试/换模型/查配置"这类可执行建议。
 */
function humanizeError(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/Premature close|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(text)) {
    return t('err.connectionLost');
  }
  if (/Invalid MoCode Work host command|Invalid JSON command/.test(text)) {
    return t('err.unrecognized');
  }
  if (/Session .* could not be restored/.test(text)) return t('err.sessionLost');
  if (/already active/.test(text)) return t('err.alreadyActive');
  if (/Approval request has expired/.test(text)) return t('err.approvalExpired');
  // 这两条来自 @mocode/runtime 的 host-client（英文 en 文案），主进程与渲染层都不过手 ——
  // 匹配裸英文，不要匹配本地化后的中文（本地化在 tMain 里做，原文永远是英文）。
  if (/Agent Host does not exist|Cannot locate mocode-agent-host/.test(text)) return t('toast.hostNotBuilt');
  if (/Agent Host has not been started|Agent Host is not writable/.test(text)) return t('err.hostNotReady');
  if (/LLM_BASE_URL|LLM_API_KEY|baseURL|apiKey/i.test(text)) return t('err.modelNotConfigured');
  // 命中的是用户已经能看懂的原文,直接展示
  return text;
}

function renderProjects(): void {
  const current = state; if (!current) return;
  const project = selectedProject();
  const ctx = $('#context-project');
  if (ctx) ctx.innerHTML = `${icon('home')}<span>${escapeHtml(project?.name ?? t('empty.project'))}</span>`;
  const branch = $('#context-branch');
  // branch 为空 = 非 git 仓库 / 无分支（主进程存空串，不存译文）。
  if (branch) branch.innerHTML = `${icon('branch')}<span>${escapeHtml(project?.branch || t('git.local'))}</span>`;
}

function timeAgo(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t('time.monthsAgo', { n: months });
  const years = Math.floor(months / 12);
  return t('time.yearsAgo', { n: years });
}

function renderTasks(): void {
  const current = state; if (!current) return;
  const byUpdatedDesc = (left: Task, right: Task) => right.updatedAt.localeCompare(left.updatedAt);
  // 普通任务：projectId 为空，平铺在「任务」分组下；加入项目文件夹的任务归在「空间」分组对应文件夹下
  const normalTasks = current.tasks.filter((task) => !task.projectId).sort(byUpdatedDesc);
  const spaces = current.projects.map((project) => ({
    project,
    tasks: current.tasks.filter((task) => task.projectId === project.id).sort(byUpdatedDesc),
  }));

  const taskItemHtml = (task: Task): string => {
    const id = escapeHtml(task.id);
    const isRunning = task.status === 'running' || task.status === 'waiting';
    const meta = isRunning ? `<span class="task-spinner">${icon('loader')}</span>` : `<small data-always="1">${timeAgo(task.updatedAt)}</small>`;
    // 失败原因只挂在 title 上：侧栏一行放不下长文案，而 lastError 里存的是稳定标记，
    // 必须过一层 taskErrorText 才能按当前语言显示。
    const error = task.lastError ? ` title="${escapeHtml(taskErrorText(task))}"` : '';
    return `<div class="task-item ${task.status} ${task.id === current.selectedTaskId ? 'selected' : ''}" data-task-id="${id}"${error}><button class="task-open" data-task="${id}" title="${t('task.open', { name: escapeHtml(taskTitle(task)) })}"><span class="task-title" title="${t('task.dblclickRename')}">${escapeHtml(taskTitle(task))}</span><span class="task-meta">${meta}</span></button><button class="task-menu-btn" data-task-menu="${id}" aria-label="${t('task.menu')}" title="${t('sidebar.moreActions')}">${icon('more')}</button></div>`;
  };

  const tasksCollapsed = collapsedSections.has('tasks');
  const spacesCollapsed = collapsedSections.has('spaces');
  const sectionHeading = (key: string, title: string, count: number, collapsed: boolean, action?: { kind: string; title: string; label: string }): string =>
    `<div class="sidebar-group-heading" data-toggle-section="${key}" title="${t('sidebar.toggleSection')}" aria-expanded="${!collapsed}"><span class="sidebar-group-title">${title}</span><span class="sidebar-group-count">(${count})</span><span class="sidebar-group-chevron">${icon(collapsed ? 'chevron-right' : 'chevron-down')}</span>${action ? `<button class="sidebar-group-action" data-group-action="${action.kind}" title="${action.title}" aria-label="${action.title}">${icon(action.label)}</button>` : ''}</div>`;

  taskList.innerHTML = `<div class="sidebar-group ${tasksCollapsed ? 'collapsed' : ''}">
  ${sectionHeading('tasks', t('sidebar.tasks'), normalTasks.length, tasksCollapsed, { kind: 'new-task', title: t('sidebar.newTaskNoSpace'), label: 'plus' })}
  <div class="sidebar-group-body">${normalTasks.length ? normalTasks.map(taskItemHtml).join('') : `<p class="empty-tasks">${t('sidebar.emptyTasks')}</p>`}</div>
</div>
<div class="sidebar-group ${spacesCollapsed ? 'collapsed' : ''}">
  ${sectionHeading('spaces', t('sidebar.spaces'), spaces.length, spacesCollapsed)}
  <div class="sidebar-group-body">${spaces.map(({ project, tasks }) => {
    const isSelectedProject = project.id === current.selectedProjectId;
    const projectId = escapeHtml(project.id);
    const isCollapsed = collapsedProjects.has(project.id);
    return `<div class="project-group ${isCollapsed ? 'collapsed' : ''}">
  <div class="project-group-heading ${isSelectedProject ? 'selected' : ''}" data-toggle-project="${projectId}" title="${t('sidebar.toggleSection')}" aria-expanded="${!isCollapsed}">
    <span class="project-group-icon">${icon('folder')}</span>
    <span class="project-group-name" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</span>
    <span class="project-group-chevron">${icon(isCollapsed ? 'chevron-right' : 'chevron-down')}</span>
    <span class="project-group-actions"><button class="project-menu-btn icon-button-square" data-new-task-project="${projectId}" title="${t('sidebar.newTaskInSpace')}" aria-label="${t('sidebar.newTaskInProject', { name: escapeHtml(project.name) })}">${icon('plus')}</button><button class="project-menu-btn icon-button-square" data-project-menu="${projectId}" title="${t('sidebar.moreActions')}" aria-label="${t('sidebar.moreActionsFor', { name: escapeHtml(project.name) })}">${icon('more')}</button></span>
  </div>
  <div class="project-group-tasks">${tasks.length ? tasks.map(taskItemHtml).join('') : `<p class="empty-tasks">${t('sidebar.emptyTasks')}</p>`}</div>
</div>`;
  }).join('')}</div>
</div>`;

  taskList.querySelectorAll<HTMLElement>('[data-toggle-section]').forEach((heading) => {
    const key = heading.dataset.toggleSection!;
    heading.addEventListener('click', () => {
      if (collapsedSections.has(key)) collapsedSections.delete(key);
      else collapsedSections.add(key);
      persistCollapsedSections();
      const collapsed = collapsedSections.has(key);
      heading.closest('.sidebar-group')?.classList.toggle('collapsed', collapsed);
      const chevron = heading.querySelector<HTMLElement>('.sidebar-group-chevron');
      if (chevron) chevron.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down');
      heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });

  // 分组标题右侧的快捷动作（目前只有「任务」分组的新建无空间任务）：
  // 阻止冒泡，否则会连带触发整行的折叠/展开。
  taskList.querySelectorAll<HTMLButtonElement>('[data-group-action]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (button.dataset.groupAction === 'new-task') void startNewTask('');
  }));

  taskList.querySelectorAll<HTMLElement>('[data-toggle-project]').forEach((heading) => {
    const projectId = heading.dataset.toggleProject!;
    heading.addEventListener('click', () => {
      if (collapsedProjects.has(projectId)) collapsedProjects.delete(projectId);
      else collapsedProjects.add(projectId);
      persistCollapsedProjects();
      const collapsed = collapsedProjects.has(projectId);
      const group = heading.closest('.project-group');
      if (group) group.classList.toggle('collapsed', collapsed);
      const chevron = heading.querySelector<HTMLElement>('.project-group-chevron');
      if (chevron) chevron.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down');
      heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });

  taskList.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((button) => {
    button.addEventListener('click', () => void openTask(button.dataset.task!));
    button.querySelector<HTMLElement>('.task-title')?.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); void startTaskRename(button.dataset.task!); });
    // 右键 = 「...」菜单:重命名/删除不用先去找 hover 才出现的小按钮
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTaskMenu(button.dataset.task!, (event.target as HTMLElement).getBoundingClientRect());
    });
  });

  const openTaskMenu = (taskId: string, anchor: DOMRect): void => {
    const existing = document.getElementById('task-context-menu');
    if (existing) existing.remove();
    const task = state?.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const isRunning = task.status === 'running' || task.status === 'waiting';
    // 归属只能在任务跑起来之前改（host cwd 固化 + 会话按目录落盘）。
    const canMove = !task.sessionId && !isRunning;
    const projects = state?.projects ?? [];
    const moveItems = canMove && projects.length
      ? `<div class="project-context-divider"></div><div class="project-context-label">${t('menu.moveTo')}</div>${!task.projectId ? '' : `<button class="project-context-item" data-action="move" data-tid="${taskId}" data-target=""><span class="project-context-icon">${icon('folder')}</span>${t('menu.noWorkspace')}</button>`}${projects.filter((p) => p.id !== task.projectId).map((p) => `<button class="project-context-item" data-action="move" data-tid="${taskId}" data-target="${escapeHtml(p.id)}"><span class="project-context-icon">${icon('folder')}</span>${escapeHtml(p.name)}</button>`).join('')}`
      : '';
    const menu = document.createElement('div');
    menu.id = 'task-context-menu';
    menu.className = 'project-context-menu';
    menu.innerHTML = `<button class="project-context-item" data-action="rename" data-tid="${taskId}"><span class="project-context-icon">${icon('edit')}</span>${t('menu.rename')}</button>${moveItems}<div class="project-context-divider"></div><button class="project-context-item" data-action="delete" data-tid="${taskId}"${isRunning ? ' data-running="1"' : ''}><span class="project-context-icon">${icon('trash')}</span>${isRunning ? t('menu.stopAndDelete') : t('menu.delete')}</button>`;
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    let left = anchor.right - menuRect.width;
    let top = anchor.bottom + 4;
    if (left < 4) left = 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const close = () => { menu.remove(); document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
    requestAnimationFrame(() => { document.addEventListener('click', close); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }); });
    menu.querySelectorAll<HTMLButtonElement>('.project-context-item').forEach((item) => item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action!;
      const tid = item.dataset.tid!;
      menu.remove(); document.removeEventListener('click', close); document.removeEventListener('keydown', close);
      if (action === 'rename') {
        void startTaskRename(tid);
      } else if (action === 'delete') {
        void deleteTask(tid);
      } else if (action === 'move') {
        const target = item.dataset.target ?? '';
        const result = await window.mocodeWork.setTaskProject(tid, target);
        if (!result.ok) { showToast('warn', result.message ?? t('toast.cannotMoveTask')); return; }
        if (result.state) updateState(result.state);
        const label = target ? state?.projects.find((p) => p.id === target)?.name ?? target : t('menu.noWorkspace');
        showToast('success', t('toast.movedTo', { label: label }));
      }
    }));
  };

  taskList.querySelectorAll<HTMLButtonElement>('[data-task-menu]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    openTaskMenu(button.dataset.taskMenu!, button.getBoundingClientRect());
  }));

  // 空间行「+」：在该空间下新建任务（归属显式绑定，不再依赖"跟随当前选中空间"）。
  taskList.querySelectorAll<HTMLButtonElement>('[data-new-task-project]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    void startNewTask(button.dataset.newTaskProject!);
  }));

  // 项目行「...」菜单：打开文件夹 / 从列表移除
  taskList.querySelectorAll<HTMLButtonElement>('[data-project-menu]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const existing = document.getElementById('project-context-menu');
    if (existing) existing.remove();
    const projectId = button.dataset.projectMenu!;
    const project = state?.projects.find((p) => p.id === projectId);
    if (!project) return;
    const rect = button.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'project-context-menu';
    menu.className = 'project-context-menu';
    menu.innerHTML = `<button class="project-context-item" data-action="open-folder" data-pid="${projectId}"><span class="project-context-icon">${icon('folder-open')}</span>${t('menu.openFolder')}</button><button class="project-context-item" data-action="remove" data-pid="${projectId}"><span class="project-context-icon">${icon('close')}</span>${t('menu.removeFromList')}</button>`;
    document.body.appendChild(menu);
    // 定位：按钮右下方弹出
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    let top = rect.bottom + 4;
    if (left < 4) left = 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    // 点击外部关闭
    const close = () => { menu.remove(); document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
    requestAnimationFrame(() => { document.addEventListener('click', close); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }); });
    // 菜单项事件
    menu.querySelectorAll<HTMLButtonElement>('.project-context-item').forEach((item) => item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action!;
      const pid = item.dataset.pid!;
      menu.remove(); document.removeEventListener('click', close); document.removeEventListener('keydown', close);
      if (action === 'open-folder') {
        await window.mocodeWork.openFolder(pid);
      } else if (action === 'remove') {
        const hasRunning = (state?.tasks ?? []).some((task) => task.projectId === pid && (task.status === 'running' || task.status === 'waiting'));
        if (hasRunning) { showToast('warn', t('toast.cannotRemoveSpace')); return; }
        const result = await window.mocodeWork.removeProject(pid);
        if (result) { updateState(result.state); clearWorkspace(); showToast('info', t('toast.removedSpace', { removed: result.removed })); }
      }
    }));
  }));
}

function updateState(next: WorkState): void { state = next; renderProjects(); renderTasks(); renderEmptyChips(); }
function clearWorkspace(): void { conversation.innerHTML = ''; userTurnIndex = 0; emptyState.classList.remove('hidden'); activeAssistant = null; activeTextBlock = null; activeToolGroup = null; setRunning(false); attachments = []; renderAttachments(); renderStatus(IDLE_STATUS); }

/**
 * 一轮 assistant 输出 = 一条 message 内的**有序 block 流**:
 *   .message-body.text-block   ← 模型文字段
 *   details.tool-entry         ← 工具调用(默认折叠)
 *   .message-body.text-block   ← 工具之后继续说的话,新开一段
 *   …
 * 文字与工具都 append 进 .message-content,谁先发生谁在前 —— 即 Claude Code / Cursor /
 * Codex 那种「正文与工具按时间顺序交织」的展示,而不是把工具统一挂在正文前或正文后。
 *
 * 创建时机:**run 一开始就建**(submit / regenerate / 切回运行中的任务),不等首个 token。
 * 否则「工具组路由 + 首次 LLM 调用」那几秒里会话区只有用户气泡和状态行 —— 头像和
 * "MoCode" 标签要等第一个 text_delta 才凭空冒出来,还会把状态行顶到它上面跳一次位。
 * 代价:可能出现「一个字都没吐」的空轮次(失败 / 中止),由 finalizeTurn 负责收掉。
 */
function startAssistantTurn(): HTMLElement {
  activeAssistant = addMessage('assistant');
  activeAssistant.classList.add('is-streaming');
  activeToolGroup = null;
  return activeAssistant;
}

/** 当前仍在文档里的助手轮次;没有则 null。(包成函数,避免调用点被 TS 收窄成 never。) */
function currentTurn(): HTMLElement | null {
  const turn: HTMLElement | null = activeAssistant;
  return turn && turn.isConnected ? turn : null;
}

/** 当前可写入的文字段。若最后一个 block 已不是文字段(刚插入了工具行),新开一段。 */
function ensureTextBlock(): HTMLElement {
  const current = currentTurn() ?? startAssistantTurn();
  const content = current.querySelector('.message-content') as HTMLElement | null;
  if (activeTextBlock?.isConnected && content?.lastElementChild === activeTextBlock) return activeTextBlock;
  const block = document.createElement('div');
  block.className = 'message-body text-block';
  (content ?? current).append(block);
  activeTextBlock = block;
  // 文字打断工具集合:之后到来的工具另起一个新集合。
  activeToolGroup = null;
  return block;
}

/**
 * 当前会话里已渲染的用户消息条数 —— 也就是下一条用户消息的序号。
 * 主进程的回滚靠这个序号在会话文件里定位「第几条 user」(见 main.ts 的 rollbackSession),
 * 所以它必须跟 DOM 同源:切任务 / 清空工作区重建会话时一并归零。
 */
let userTurnIndex = 0;

function addMessage(kind: 'user' | 'assistant', text = ''): HTMLElement {
  emptyState.classList.add('hidden');
  const message = document.createElement('article'); message.className = `message ${kind}`;
  if (kind === 'user') {
    // 一条用户消息 = 新一轮的起点：必须先闭合上一轮的助手消息。
    // 否则后续 text / tool 会被 ensureTextBlock / addTool 挂回上一条 assistant 消息里
    // （它们只认 activeAssistant）—— 症状是两轮 AI 输出并进同一条消息，
    // 而新用户气泡被 append 到最底部，顺序错成 user, ai(两轮), user。
    // 实时路径靠 finish() 天然闭合看不出来，切任务后的缓冲重放最容易踩。
    finalizeTurn(activeAssistant);
    activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
    // 用户消息：纯气泡，无头像/标签，灰色背景右对齐
    const wrapper = document.createElement('div'); wrapper.className = 'message-content';
    const body = document.createElement('div'); body.className = 'message-body';
    body.textContent = text;
    const label = document.createElement('div'); label.className = 'message-label';
    label.innerHTML = '<div class="message-actions"></div>';
    wrapper.append(body, label);
    message.append(wrapper);
    // 用户消息的「复制 + 回滚」:userIndex 是它在会话里的序号,回滚时靠它告诉主进程截到哪儿。
    message.dataset.userIndex = String(userTurnIndex);
    userTurnIndex += 1;
    wireMessageActions(message, text);
    activeTextBlock = null;
  } else {
    const label = 'MoCode';
    const avatarIcon = '<img class="app-avatar" src="../assets/icon.png" alt="MoCode">';
    // 操作按钮(复制 / 重新生成)是 .message 的第二个 grid 行:落在正文下沿、左对齐(见 style.css)。
    // 不能塞进 .message-content:那里最后一子元素必须是"正在写的文字段",
    // 否则 ensureTextBlock 的 lastElementChild 判断会把每个 chunk 都当成新段。
    message.innerHTML = `<div class="message-avatar">${avatarIcon}</div><div class="message-content"><div class="message-label"><span>${label}</span></div><div class="message-body"></div></div><div class="message-actions"></div>`;
    const body = message.querySelector('.message-body') as HTMLElement;
    // 助手消息流式时只放纯文本,完成后再走 markdown 渲染,避免每 chunk 重排版。
    body.textContent = text;
    activeTextBlock = body;
  }
  conversation.append(message);
  smartScrollToBottom();
  return message;
}
const activeTools = new Map<string, HTMLDetailsElement>();
/** 工具 id → 开始时间,用于完成后显示耗时。 */
const toolStartTimes = new Map<string, number>();
/** 文件编辑类工具不进「工具调用集合」:改了什么必须让用户第一眼看到,不能埋进组里。 */
const STANDALONE_TOOLS = new Set(['write_file', 'edit_file']);

/** 工具名 → 折叠行上的图标。标签在调用时按当前语言实时翻译（见 toolMeta），保证切语言即时生效。 */
const TOOL_ICONS: Record<string, string> = {
  read_file: 'files', write_file: 'edit', edit_file: 'edit', run_command: 'terminal',
  grep: 'search', glob: 'search', web_search: 'globe', web_fetch: 'globe',
  browser: 'layout', computer: 'layout', screenshot: 'image', view_image: 'image',
  'sub-agent': 'spark-bot', use_skill: 'sparkles', run_skill: 'sparkles',
  plan_update: 'check', note_append: 'edit', ask_human: 'user', dev_server: 'loader',
};
/** 工具名 → 折叠行上的动词。标签随语言切换实时更新。 */
function toolMeta(name: string): { label: string; icon: string } {
  if (name.startsWith('memory_')) return { label: t('tool.memory'), icon: 'sparkles' };
  if (name in TOOL_ICONS) return { label: t(`tool.${name}` as LocaleKey), icon: TOOL_ICONS[name]! };
  return { label: name, icon: 'wrench' };
}
/** 每个工具最有信息量的那个入参 key —— 折叠行上展示的值。 */
const TOOL_ARG_KEYS: Record<string, string[]> = {
  read_file: ['path', 'file_path', 'file'],
  write_file: ['path', 'file_path', 'file'],
  edit_file: ['path', 'file_path', 'file'],
  run_command: ['command'],
  grep: ['pattern'],
  glob: ['pattern'],
  web_search: ['query'],
  web_fetch: ['url'],
};
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/** 折叠行上的"对象"文本:路径 / 命令 / 关键词等,让工具行不只是一个工具名。 */
function toolTargetText(name: string, args: string): string {
  const raw = args.trim();
  if (!raw) return '';
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* 非 JSON 入参按纯文本处理 */ }
  if (parsed) {
    for (const key of TOOL_ARG_KEYS[name] ?? ['path', 'file', 'filePath', 'command', 'query', 'pattern', 'url', 'name', 'target']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) return clip(value, 120);
    }
    const first = Object.values(parsed).find((value) => typeof value === 'string' && value);
    if (typeof first === 'string' && first) return clip(first, 120);
  }
  return clip(raw, 120);
}

function toolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

let activeToolGroup: HTMLElement | null = null;
/** 有效的当前工具组:必须在文档里,且仍是消息内容区的最后一个 block(被文字打断后即失效)。 */
function currentToolGroup(content: HTMLElement): HTMLElement | null {
  return activeToolGroup?.isConnected && content.lastElementChild === activeToolGroup ? activeToolGroup : null;
}
/**
 * 连续的工具调用折叠成两级集合(对齐 mocode 终端的做法):
 * 外层一行「执行了 N 个工具调用」,展开后是原来的单行工具卡;
 * 智能体输出文字会把集合打断 —— 文字之后的新工具另起一个集合。
 */
function ensureToolGroup(content: HTMLElement): HTMLElement {
  const existing = currentToolGroup(content);
  if (existing) return existing;
  const group = document.createElement('details');
  group.className = 'tool-group';
  group.innerHTML = '<summary></summary><div class="tool-group-body"></div>';
  content.append(group);
  activeToolGroup = group;
  refreshToolGroup(group);
  return group;
}
/** 重算集合行:名称(执行中/完成)、工具类型短语(读取文件 ×2 · 运行命令 ×3)、进度与总耗时。 */
function refreshToolGroup(group: HTMLElement): void {
  const entries = Array.from(group.querySelectorAll<HTMLDetailsElement>(':scope > .tool-group-body > details.tool-entry'));
  if (!entries.length) return;
  const running = entries.filter((entry) => entry.classList.contains('tool-running'));
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = entry.dataset.toolLabel ?? t('status.toolGeneric');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const phrase = clip([...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · '), 64);
  const current = running.find((entry) => entry.dataset.toolLabel);
  let meta: string;
  if (running.length) {
    meta = `<span class="tool-dot"></span>${entries.length - running.length}/${entries.length} · ${escapeHtml(current?.dataset.toolLabel ?? t('status.toolGeneric'))}…`;
  } else {
    const startedAt = Number(group.dataset.startTime ?? 0);
    const elapsed = startedAt && group.dataset.hadRunning === '1' ? Date.now() - startedAt : null;
    const timing = elapsed !== null && elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s · ` : '';
    meta = `${timing}${t('tool.groupItems', { n: entries.length })}`;
  }
  const summary = group.querySelector('summary') as HTMLElement;
  summary.innerHTML = `<span class="tool-chevron" data-icon="chevron-right"></span>
  <span class="tool-kind" data-icon="wrench"></span>
  <span class="tool-name">${running.length ? t('status.runningToolGeneric') : t('status.ranTools', { n: entries.length })}</span>
  ${phrase ? `<span class="tool-target" title="${escapeHtml(phrase)}">${escapeHtml(phrase)}</span>` : ''}
  <span class="tool-meta">${meta}</span>`;
  mountIcons(summary);
  group.classList.toggle('tool-group-running', running.length > 0);
}

/**
 * 追加 / 更新一条工具行。
 * - 工具行一律 append 到当前助手轮次的末尾 —— 顺序 = 发生顺序;
 * - 默认折叠(details 关闭),只显示「动词 + 对象 + 状态/耗时」一行;
 * - 同一 id 的 tool_started → tool_completed 原地更新,不新增行。
 */
function addTool(payload: Record<string, unknown>, completed = false): void {
  emptyState.classList.add('hidden');
  // 工具事件可能早于首个文字到达：先确保存在活跃的助手消息，工具行挂在其内容区内部
  const current = currentTurn() ?? startAssistantTurn();
  const id = payload.id == null ? '' : String(payload.id);
  const existing = id ? activeTools.get(id) : undefined;
  const entry = existing?.isConnected ? existing : document.createElement('details');
  const isNew = !entry.isConnected;
  const name = String(payload.name ?? 'tool');
  const args = toolText(payload.arguments ?? entry.dataset.toolArguments).trim();
  const output = toolText(payload.output).trim();
  if (!completed && args) entry.dataset.toolArguments = args;
  const meta = toolMeta(name);
  const target = toolTargetText(name, args);
  const startedAt = id ? toolStartTimes.get(id) : undefined;
  const elapsed = completed && startedAt !== undefined ? Date.now() - startedAt : null;
  const lines = output ? output.split('\n').length : 0;
  const status = completed ? (lines > 1 ? t('tool.lines', { n: lines }) : t('tool.done')) : t('tool.running');
  const timing = elapsed !== null && elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s · ` : '';
  const detail = [
    args ? `<section><span>${t('tool.args')}</span><pre>${escapeHtml(args.slice(0, 2000))}</pre></section>` : '',
    output ? `<section><span>${t('tool.result')}</span><pre>${escapeHtml(output.slice(0, 6000))}${output.length > 6000 ? `\n${t('tool.truncated')}` : ''}</pre></section>` : '',
  ].join('');

  entry.className = `tool-entry ${completed ? 'tool-done' : 'tool-running'}${detail ? '' : ' tool-empty'}`;
  entry.dataset.toolLabel = meta.label;
  entry.innerHTML = `<summary>
  <span class="tool-chevron" data-icon="chevron-right"></span>
  <span class="tool-kind" data-icon="${escapeHtml(meta.icon)}"></span>
  <span class="tool-name">${escapeHtml(meta.label)}</span>
  ${target ? `<span class="tool-target" title="${escapeHtml(target)}">${escapeHtml(target)}</span>` : ''}
  <span class="tool-meta">${completed ? '' : '<span class="tool-dot"></span>'}${timing}${status}</span>
</summary>${detail ? `<div class="tool-detail">${detail}</div>` : ''}`;
  mountIcons(entry);
  // 折叠优先：完成即收起。运行中的行也默认收起（用户手动展开过则保留其状态）。
  if (completed) entry.open = false;
  if (id) {
    if (completed) { activeTools.delete(id); toolStartTimes.delete(id); }
    else if (isNew) { activeTools.set(id, entry); toolStartTimes.set(id, Date.now()); }
  }
  if (isNew) {
    const content = (current.querySelector('.message-content') ?? current) as HTMLElement;
    if (STANDALONE_TOOLS.has(name)) {
      // 文件编辑独立成行展示(不进集合):编辑内容用户必须能直接找到。
      content.append(entry);
      activeToolGroup = null;
    } else {
      const group = ensureToolGroup(content);
      (group.querySelector('.tool-group-body') as HTMLElement).append(entry);
      if (!completed) {
        group.dataset.hadRunning = '1';
        if (!group.dataset.startTime) group.dataset.startTime = String(Date.now());
      }
      refreshToolGroup(group);
    }
    // 工具之后的文字必须排在工具行下面 —— 强制下一段文字新开一个 block
    activeTextBlock = null;
  } else {
    // 原地更新(运行中 → 完成):同步刷新所属集合行的进度/耗时。
    const group = entry.closest<HTMLElement>('.tool-group');
    if (group) refreshToolGroup(group);
  }
  smartScrollToBottom();
}
/* ── 流式 markdown 渲染 ─────────────────────────────────
   流式期间不再展示裸 markdown 源码:文字段每 120ms 节流重渲染一次,
   结束时 finalizeTurn 再做最终渲染。原始文本存 WeakMap —— innerHTML
   渲染会丢掉 markdown 语法,不能再用 textContent 当数据源。 */
const MD_RENDER_INTERVAL = 120;
let mdRenderTimer: ReturnType<typeof setTimeout> | null = null;
const textBlockRaw = new WeakMap<HTMLElement, string>();
const pendingMdBlocks = new Set<HTMLElement>();

/** 补齐未闭合的围栏代码:流式输出经常在 ``` 中途截断,不补会导致代码块整段渲染不出来。 */
function closeOpenFence(text: string): string {
  const fences = text.match(/^[ \t]{0,3}(```|~~~)/gm) ?? [];
  return fences.length % 2 === 1 ? `${text}\n\`\`\`` : text;
}
/** 按块调度渲染 —— 工具事件可能在定时器触发前把 activeTextBlock 置空,所以要捕获块本身。 */
function scheduleMdRender(block: HTMLElement): void {
  pendingMdBlocks.add(block);
  if (mdRenderTimer !== null) return;
  mdRenderTimer = setTimeout(() => {
    mdRenderTimer = null;
    // 渲染前记录是否贴底:重渲染会让视口上方的块变高(代码块加头等),把底部推远,
    // 渲染后再判断 isAtBottom 已经是 false —— 必须用渲染前的状态决定要不要跟上。
    const pinned = isAtBottom();
    for (const pending of pendingMdBlocks) {
      if (pending.isConnected) renderMessageBody(pending, closeOpenFence(textBlockRaw.get(pending) ?? ''));
    }
    pendingMdBlocks.clear();
    if (pinned) smartScrollToBottom(true);
  }, MD_RENDER_INTERVAL);
}
function appendText(text: string): void {
  const block = ensureTextBlock();
  textBlockRaw.set(block, (textBlockRaw.get(block) ?? '') + text);
  scheduleMdRender(block);
  smartScrollToBottom();
}
function renderHistory(history: HistoryItem[]): void {
  conversation.innerHTML = ''; activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  if (!history.length) { emptyState.classList.remove('hidden'); return; }
  // 一条 user 消息之后的所有 assistant / tool 片段归为同一轮,按原始顺序铺成 block 流。
  for (const item of history) {
    if (item.role === 'user') {
      finalizeTurn(activeAssistant);
      activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
      addMessage('user', item.text);
      continue;
    }
    // 模块级 let 在本函数内被赋过 null 后 TS 会收窄成 never,统一走 currentTurn()。
    if (!currentTurn()) startAssistantTurn();
    if (item.role === 'assistant') {
      const block = ensureTextBlock();
      textBlockRaw.set(block, item.text);
      block.textContent = item.text;
      activeTextBlock = null;
    } else {
      addTool({ name: item.name ?? 'tool', arguments: item.arguments ?? '', output: item.text }, true);
    }
  }
  finalizeTurn(activeAssistant);
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
}

/**
 * 把一段文本用 markdown 渲染到 .message-body 内,挂上交互。
 * 助手消息流结束后调用,以及历史消息回放时调用。
 */
function renderMessageBody(body: HTMLElement, text: string): void {
  body.classList.add('md-rendered');
  body.innerHTML = renderMarkdown(closeOpenFence(text));
  enhanceCodeBlocks(body);
}

/**
 * 一轮输出收尾:逐段渲染 markdown(一段文字 = 一个 block,中间的折叠工具行保持不变),
 * 丢掉空文字段,最后挂上复制 / 重新生成。
 */
function finalizeTurn(message: HTMLElement | null): void {
  if (!message) return;
  message.classList.remove('is-streaming');
  // 待执行的节流渲染不再需要 —— 下面马上做最终渲染
  if (mdRenderTimer !== null) { clearTimeout(mdRenderTimer); mdRenderTimer = null; pendingMdBlocks.clear(); }
  const parts: string[] = [];
  // 同理:渲染前的贴底状态才算数(见 scheduleMdRender 注释)
  const pinned = isAtBottom();
  for (const block of Array.from(message.querySelectorAll<HTMLElement>('.message-body'))) {
    // textContent 在 md 渲染后会丢 markdown 语法,原始文本以 WeakMap 为准
    const text = textBlockRaw.get(block) ?? block.textContent ?? '';
    if (!text.trim()) { block.remove(); continue; }
    parts.push(text);
    renderMessageBody(block, text);
  }
  // 空轮次:既没有文字、也没有工具行、也没有错误行（启动失败 / 被中止 / 一个 token 都没吐）。
  // 助手消息是 run 一开始就建好的,不收掉就会留下一个只有头像和 "MoCode" 的空气泡；
  // 但**带错误行时必须留着** —— 那行是唯一能在会话里看到失败的东西。
  if (!parts.length && !message.querySelector('.tool-entry') && !message.querySelector('.message-error')) {
    message.remove();
    if (activeAssistant === message) { activeAssistant = null; activeTextBlock = null; activeToolGroup = null; }
    if (pinned) smartScrollToBottom(true);
    return;
  }
  if (pinned) smartScrollToBottom(true);
  wireMessageActions(message, parts.join('\n\n'));
}

async function openTask(taskId: string): Promise<void> {
  const workspace = await window.mocodeWork.selectTask(taskId);
  if (!workspace) return;
  updateState(workspace.state);
  // 运行中/本周期跑过的任务用事件缓冲重放;旧任务(重启后)用 session 历史回放。
  switchToTask(taskId, workspace.history);
}

async function deleteTask(taskId: string): Promise<void> {
  const task = state?.tasks.find((item) => item.id === taskId);
  // 非运行中任务加一个轻量二次确认
  if (task && task.status !== 'running' && task.status !== 'waiting') {
    const ok = window.confirm(t('confirm.deleteTask', { title: taskTitle(task) }));
    if (!ok) return;
  }
  const deletingSelectedTask = state?.selectedTaskId === taskId;
  const next = await window.mocodeWork.deleteTask(taskId);
  if (!next) return;
  streams.delete(taskId);
  updateState(next);
  if (deletingSelectedTask && next.selectedTaskId !== taskId) clearWorkspace();
  showToast('info', t('toast.deletedTask'));
}

function showApproval(taskId: string, payload: Record<string, unknown>): void {
  const approvalId = String(payload.approvalId ?? ''); const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  approvalPanel.classList.remove('hidden');
  const buttons = options.length ? options.map((option, index) => `<button data-approval="${escapeHtml(option)}" class="${index === 0 ? 'approve' : ''}">${escapeHtml(option)}</button>`).join('') : `<button data-approval="approve" class="approve">${icon('check')}${t('approval.confirm')}</button>`;
  approvalPanel.innerHTML = `<div class="approval-title">${icon('warn')}<span>${t('approval.title')}</span></div><p>${escapeHtml(String(payload.title ?? t('approval.default')))}</p><pre>${escapeHtml(String(payload.detail ?? ''))}</pre><div class="approval-actions">${buttons}<button data-cancel>${icon('close')}${t('approval.reject')}</button></div>`;
  const resolve = (value: Record<string, unknown>): void => {
    window.mocodeWork.send({ type: 'approval', id: taskId, approvalId, ...value });
    approvalPanel.classList.add('hidden');
    const stream = streams.get(taskId);
    if (stream) stream.pendingApproval = null;
  };
  approvalPanel.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach((button) => button.addEventListener('click', () => resolve({ action: 'selected', value: button.dataset.approval })));
  approvalPanel.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', () => resolve({ action: 'cancelled' }));
}
function setRunning(running: boolean): void { sendButton.innerHTML = icon(running ? 'square' : 'paper-airplane'); sendButton.classList.toggle('stop', running); sendButton.title = running ? t('composer.stop') : t('composer.send'); sendButton.setAttribute('aria-label', running ? t('composer.stopAria') : t('composer.sendAria')); }
function resizePrompt(): void { promptInput.style.height = 'auto'; promptInput.style.height = `${Math.min(promptInput.scrollHeight, 128)}px`; }
function renderAttachments(): void {
  attachmentList.innerHTML = attachments.map((attachment, index) => `<span class="attachment-chip">${icon('image')}<span class="attachment-name">${escapeHtml(attachment.name)}</span><button class="attachment-remove" data-attachment="${index}" title="${t('composer.attachment')}" aria-label="${t('composer.attachmentRemove')}"><svg class="icon" data-icon="close"></svg></button></span>`).join('');
  mountIcons(attachmentList);
  attachmentList.querySelectorAll<HTMLButtonElement>('[data-attachment]').forEach((button) => button.addEventListener('click', () => { attachments.splice(Number(button.dataset.attachment), 1); renderAttachments(); }));
}

/* ── Smart scroll ──────────────────────────────────────── */
/**
 * 用户没在底部时不再强制跳到底,长任务翻历史时不会被打断。
 * 距离底部 < 96px 视为"在底部",继续跟随;否则不打扰。
 */
function isAtBottom(): boolean {
  const distance = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  return distance < 96;
}
function smartScrollToBottom(force = false): void {
  if (force || isAtBottom()) conversation.scrollTop = conversation.scrollHeight;
}
// 用户主动滚动:离开底部超过阈值,直到再次回到底之前都不再自动跟。
conversation.addEventListener('scroll', () => { userScrolled = !isAtBottom(); }, { passive: true });
let userScrolled = false;

/* ── Per-message actions (copy / regenerate / rollback) ── */
function wireMessageActions(message: HTMLElement, text: string): void {
  const actions = message.querySelector('.message-actions') as HTMLElement;
  if (!actions || actions.childElementCount) return;
  const isAssistant = message.classList.contains('assistant');
  // 失败轮次可能只有一行错误、没有正文:那就没有可复制的东西,只留「重新生成」。
  const copy = text.trim() ? `<button data-act="copy" title="${t('msg.copy')}" aria-label="${t('msg.copy')}">${icon('copy')}</button>` : '';
  if (isAssistant) {
    actions.innerHTML = `${copy}<button data-act="regen" title="${t('msg.regenerate')}" aria-label="${t('msg.regenerate')}">${icon('regen')}</button>`;
  } else {
    actions.innerHTML = `<button data-act="copy" title="${t('msg.copy')}" aria-label="${t('msg.copy')}">${icon('copy')}</button><button data-act="rollback" title="${t('msg.rollback')}" aria-label="${t('msg.rollback')}">${icon('rollback')}</button>`;
  }
  actions.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(text); showToast('info', t('msg.copied')); }
      catch { showToast('error', t('msg.copyFailed')); }
      return;
    }
    if (act === 'regen') { void regenerate(); return; }
    if (act === 'rollback') { void handleRollbackClick(message, button); return; }
  });
}

/** 「回滚?」的二次确认停留时长 —— 之后自动复位，避免按钮一直挂 Armed 态。 */
const ROLLBACK_ARM_MS = 3500;
const rollbackArmTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

function disarmRollback(button: HTMLButtonElement): void {
  const timer = rollbackArmTimers.get(button);
  if (timer) { clearTimeout(timer); rollbackArmTimers.delete(button); }
  if (button.dataset.armed !== '1') return;
  button.dataset.armed = '0';
  button.classList.remove('armed');
  button.innerHTML = icon('rollback');
}

/**
 * 回滚会删掉这段对话,所以首次点击只进入确认态 —— 抹掉历史不该一鼠标就发生。
 */
function armRollback(button: HTMLButtonElement): void {
  for (const other of Array.from(rollbackArmTimers.keys())) disarmRollback(other);
  button.dataset.armed = '1';
  button.classList.add('armed');
  button.innerHTML = `<span class="armed-label">${t('msg.rollbackArm')}</span>`;
  rollbackArmTimers.set(button, setTimeout(() => disarmRollback(button), ROLLBACK_ARM_MS));
}

async function handleRollbackClick(message: HTMLElement, button: HTMLButtonElement): Promise<void> {
  if (button.dataset.armed !== '1') { armRollback(button); return; }
  disarmRollback(button);
  const viewing = viewingTaskId();
  const userIndex = Number(message.dataset.userIndex ?? '');
  if (!viewing || !Number.isInteger(userIndex)) { showToast('warn', t('toast.cannotRollback')); return; }
  // 回滚会连这条用户消息一起抹掉 —— 先把原文捞出来,成功后回填输入框,改完就能直接重发。
  // 用户消息是纯文本气泡(.message-body 的 textContent),没有 markdown 渲染,取到的就是原文。
  const rolledBackText = (message.querySelector('.message-body')?.textContent ?? '').trim();
  const result = await window.mocodeWork.rollback({ id: viewing, userIndex });
  if (!result.ok) { showToast('error', result.message ?? t('toast.rollbackFail')); return; }
  // 本周期的事件缓冲已经不可信 —— 落盘的会话才是新真相,作废后按它重放。
  streams.delete(viewing);
  approvalPanel.classList.add('hidden');
  if (result.state) updateState(result.state);
  setRunning(false);
  switchToTask(viewing, result.history ?? []);
  if (rolledBackText) {
    // 输入框已有草稿时**不覆盖**:把回滚的原文接在后面(空行隔开),两种意图都不丢。
    const draft = promptInput.value.trim();
    promptInput.value = draft ? `${draft}\n\n${rolledBackText}` : rolledBackText;
    resizePrompt();
    // 光标落到末尾,用户接着改就行。
    promptInput.focus();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    showToast('info', t('toast.rolledBackRefill'));
    return;
  }
  showToast('info', t('toast.rolledBack'));
}

/**
 * 重新生成:从这条 assistant 之前的最后一条 user 消息,重发。
 * 删掉本条及之后的所有 assistant/tool 消息,重发。
 */
async function regenerate(): Promise<void> {
  const viewing = viewingTaskId();
  if (isRunning(viewing)) { showToast('warn', t('toast.taskRunning')); return; }
  const task = selectedTask();
  if (!task?.sessionId) { showToast('warn', t('toast.noSession')); return; }
  const messages = Array.from(conversation.querySelectorAll<HTMLElement>('.message'));
  const target = activeMessage;
  if (!target) return;
  const index = messages.indexOf(target);
  let userIndex = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]!.classList.contains('user')) { userIndex = i; break; }
  }
  if (userIndex < 0) { showToast('warn', t('toast.noUserMsg')); return; }
  const userText = messages[userIndex]!.querySelector('.message-body')?.textContent ?? '';
  // 删 target 起所有后续消息(包括本条)
  for (let i = messages.length - 1; i >= index; i -= 1) messages[i]!.remove();
  // 直接重发(不再 addMessage,user 消息已经存在);缓冲里同样截掉被重发之后的段。
  if (viewing) {
    const stream = streamFor(viewing);
    const lastUser = [...stream.items].map((item, i) => ({ item, i })).filter(({ item }) => item.kind === 'user').pop();
    if (lastUser) stream.items.length = lastUser.i + 1;
    stream.running = true;
    stream.startedAt = Date.now();
    // 与 submit 同:重发的这一轮也先把助手消息建出来(思考阶段就有头像/标签)。
    startAssistantTurn();
    applyStatus(stream, true, busyStatus('starting', 'status.starting'));
  }
  setRunning(true);
  armRunWatchdog(task.id);
  window.mocodeWork.send({ type: 'run', id: task.id, prompt: userText, sessionId: task.sessionId, attachments: [] });
  showToast('info', t('toast.regenerated'));
}

function setActiveMessage(message: HTMLElement | null): void {
  if (activeMessage) activeMessage.classList.remove('is-active');
  activeMessage = message;
  if (activeMessage) activeMessage.classList.add('is-active');
}
let activeMessage: HTMLElement | null = null;

conversation.addEventListener('mousemove', (event) => {
  const target = event.target as HTMLElement;
  const message = target.closest<HTMLElement>('.message');
  setActiveMessage(message);
});
conversation.addEventListener('mouseleave', () => setActiveMessage(null));

/* ── Toast ─────────────────────────────────────────────── */
type ToastLevel = 'info' | 'success' | 'warn' | 'error';
let toastHost: HTMLElement | null = null;
function ensureToastHost(): HTMLElement {
  if (toastHost) return toastHost;
  toastHost = document.createElement('div');
  toastHost.className = 'toast-host';
  document.body.append(toastHost);
  return toastHost;
}
function showToast(level: ToastLevel, text: string, durationMs = 3200): void {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  const levelIcon = level === 'success' ? 'check' : level === 'warn' ? 'warn' : level === 'error' ? 'fail' : 'info';
  el.innerHTML = `<span class="toast-icon">${icon(levelIcon)}</span><span class="toast-text">${escapeHtml(text)}</span>`;
  host.append(el);
  // 强制 reflow + 入场
  el.getBoundingClientRect();
  el.classList.add('toast-in');
  const timer = setTimeout(() => dismiss(), durationMs);
  function dismiss(): void { clearTimeout(timer); el.classList.remove('toast-in'); el.classList.add('toast-out'); setTimeout(() => el.remove(), 220); }
  el.addEventListener('click', dismiss);
}

/* ── Cheatsheet ────────────────────────────────────────── */
let cheatsheetEl: HTMLElement | null = null;
function ensureCheatsheet(): HTMLElement {
  if (cheatsheetEl) return cheatsheetEl;
  const rows: Array<[string, string]> = [
    ['⌘ K', t('cheatsheet.search')],
    ['⌘ ⇧ N', t('nav.newTask')],
    ['⌘ /', t('cheatsheet.toggleAssistant')],
    ['⌘ ⏎', t('cheatsheet.send')],
    ['⇧ ⏎', t('cheatsheet.newline')],
    ['⌘ .', t('cheatsheet.stop')],
    ['⌘ F', t('cheatsheet.searchConv')],
    ['Esc', t('cheatsheet.esc')],
    ['?', t('cheatsheet.help')],
  ];
  const overlay = document.createElement('div');
  overlay.className = 'cheatsheet hidden';
  overlay.innerHTML = `<div class="cheatsheet-card">
    <header><b>${t('cheatsheet.title')}</b><button data-close title="${t('cheatsheet.close')}">×</button></header>
    <div class="cheatsheet-grid">${rows.map(([key, desc]) => `<div class="cheatsheet-row"><kbd>${key}</kbd><span>${desc}</span></div>`).join('')}</div>
    <footer>${t('cheatsheet.footer')}</footer>
  </div>`;
  document.body.append(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || (e.target as HTMLElement).dataset.close !== undefined) hideCheatsheet(); });
  cheatsheetEl = overlay;
  return overlay;
}
function showCheatsheet(): void { ensureCheatsheet()!.classList.remove('hidden'); }
function hideCheatsheet(): void { cheatsheetEl?.classList.add('hidden'); }

/* ── 图片附件：拖入 / 粘贴共用同一套入队逻辑 ───────────── */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** 把一张图片加入待发送附件。非图片或超限会提示并跳过，返回是否入队成功。 */
async function addImageFile(file: File, fallbackName = t('composer.imageFallback')): Promise<boolean> {
  const label = file.name || fallbackName;
  if (file.type && !/^image\//.test(file.type)) { showToast('warn', t('toast.imageNotImage', { label: label })); return false; }
  if (file.size > MAX_ATTACHMENT_BYTES) { showToast('error', t('toast.imageTooLarge', { label: label })); return false; }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    attachments.push({ name: label, dataUrl });
    return true;
  } catch {
    showToast('error', t('toast.imageReadFail', { label: label }));
    return false;
  }
}

/** 粘贴图片（Ctrl/⌘+V）—— 剪贴板里的位图没有文件名,按时间戳生成一个。 */
function setupPasteImage(): void {
  promptInput.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && /^image\//.test(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    // 没有图片就走浏览器默认粘贴(纯文本),不拦截
    if (files.length === 0) return;
    event.preventDefault();
    const now = new Date();
    const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, '0')).join('');
    void (async () => {
      let added = 0;
      for (const file of files) if (await addImageFile(file, t('composer.pastedImage', { stamp: stamp }))) added += 1;
      if (added === 0) return;
      renderAttachments();
      promptInput.focus();
      showToast('info', t('toast.imageAdded', { n: added }));
    })();
  });
}
setupPasteImage();

/* ── Drag & drop files into composer ──────────────────── */
function setupDragDrop(): void {
  const composer = $('.composer');
  const area = $('.composer-area');
  if (!composer || !area) return;
  let depth = 0;
  area.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    depth += 1;
    composer.classList.add('composer-drag');
  });
  area.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) composer.classList.remove('composer-drag');
  });
  area.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
  area.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    depth = 0;
    composer.classList.remove('composer-drag');
    for (const file of Array.from(event.dataTransfer.files)) await addImageFile(file);
    renderAttachments();
    promptInput.focus();
  });
}
setupDragDrop();

/* ── Conversation search (⌘F) ─────────────────────────── */
let searchOverlay: HTMLElement | null = null;
function ensureSearchOverlay(): HTMLElement {
  if (searchOverlay) return searchOverlay;
  const overlay = document.createElement('div');
  overlay.className = 'conv-search hidden';
  overlay.innerHTML = `<div class="conv-search-bar">
    <input type="text" placeholder="${t('search.convPlaceholder')}" />
    <span class="conv-search-status"></span>
    <button data-prev title="${t('search.prev')}">↑</button>
    <button data-next title="${t('search.next')}">↓</button>
    <button data-close title="${t('cheatsheet.close')} (Esc)">×</button>
  </div>`;
  document.body.append(overlay);
  searchOverlay = overlay;
  return overlay;
}
function openConvSearch(): void {
  const overlay = ensureSearchOverlay();
  const input = overlay.querySelector('input') as HTMLInputElement;
  const status = overlay.querySelector('.conv-search-status') as HTMLElement;
  let hits: HTMLElement[] = [];
  let cursor = 0;

  overlay.classList.remove('hidden');
  input.focus();
  input.select();

  function clearHits(): void {
    conversation.querySelectorAll<HTMLElement>('.conv-search-hit').forEach((el) => {
      el.replaceWith(document.createTextNode(el.textContent ?? ''));
    });
    conversation.querySelectorAll<HTMLElement>('.conv-search-current').forEach((el) => el.classList.remove('conv-search-current'));
  }
  function runSearch(): void {
    clearHits(); hits = []; cursor = 0;
    const needle = input.value.trim();
    if (!needle) { status.textContent = ''; return; }
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    conversation.querySelectorAll<HTMLElement>('.message-body').forEach((body) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      let node: Node | null; while ((node = walker.nextNode())) texts.push(node as Text);
      for (const text of texts) {
        const value = text.nodeValue ?? '';
        if (!re.test(value)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let last = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(value))) {
          if (match.index > last) fragment.append(document.createTextNode(value.slice(last, match.index)));
          const mark = document.createElement('mark');
          mark.className = 'conv-search-hit';
          mark.textContent = match[0];
          fragment.append(mark);
          hits.push(mark);
          last = match.index + match[0].length;
        }
        if (last < value.length) fragment.append(document.createTextNode(value.slice(last)));
        text.replaceWith(fragment);
      }
    });
    if (!hits.length) { status.textContent = t('search.noMatch'); return; }
    status.textContent = `1 / ${hits.length}`;
    goTo(0);
  }
  function goTo(index: number): void {
    if (!hits.length) return;
    cursor = ((index % hits.length) + hits.length) % hits.length;
    hits.forEach((el) => el.classList.remove('conv-search-current'));
    const current = hits[cursor]!;
    current.classList.add('conv-search-current');
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    status.textContent = `${cursor + 1} / ${hits.length}`;
  }

  input.oninput = runSearch;
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); goTo(cursor + (event.shiftKey ? -1 : 1)); }
    if (event.key === 'Escape') { event.preventDefault(); closeConvSearch(); }
  };
  overlay.querySelector('[data-prev]')!.addEventListener('click', () => goTo(cursor - 1));
  overlay.querySelector('[data-next]')!.addEventListener('click', () => goTo(cursor + 1));
  overlay.querySelector('[data-close]')!.addEventListener('click', closeConvSearch);
}
function closeConvSearch(): void {
  if (!searchOverlay) return;
  searchOverlay.classList.add('hidden');
  searchOverlay.querySelectorAll<HTMLElement>('.conv-search-hit').forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent ?? ''));
  });
  searchOverlay.querySelectorAll<HTMLElement>('.conv-search-current').forEach((el) => el.classList.remove('conv-search-current'));
}

// 只剥「帮我」这类不会构成实词的引导语；「请」不动（请求体…会被切坏）。
const TITLE_FILLERS = [/^(?:请帮我|请帮忙|麻烦帮我|麻烦你|帮忙|帮我看一下|帮我看下|帮我看看|帮我分析一下|帮我分析|帮我改一下|帮我|我想让你|我需要你)/];
/** CJK / 全角字符按 2 个宽度计，与侧栏实际显示宽度一致。 */
function charWidth(char: string): number { return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1; }
function truncateByWidth(text: string, maxWidth: number): string {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += charWidth(text.charAt(i));
    if (width <= maxWidth) continue;
    return `${text.slice(0, i).trimEnd()}…`;
  }
  return text;
}
/**
 * 用第一条指令自动生成任务标题：取首行有效内容 → 去掉 Markdown 噪声和「帮我/请」这类
 * 引导词 → 按显示宽度截断。纯本地规则，不额外消耗一次模型调用。
 */
function summarizePrompt(prompt: string, maxWidth = 40): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  let text = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  for (let round = 0; round < 2; round++) {
    for (const filler of TITLE_FILLERS) {
      const next = text.replace(filler, '').trim();
      if (next && next !== text) { text = next; break; }
    }
  }
  text = text.replace(/[。！？!?；;，,、:：~～\s]+$/, '');
  if (!text) text = prompt.replace(/\s+/g, ' ').trim();
  return text ? truncateByWidth(text, maxWidth) : t('empty.draft');
}
async function submit(): Promise<void> {
  const viewing = viewingTaskId();
  // 正在查看的任务在跑:点击 = 停止它(其它后台任务不受影响)。
  if (isRunning(viewing)) { window.mocodeWork.send({ type: 'cancel', id: viewing }); return; }
  const prompt = promptInput.value.trim(); if (!prompt) return;
  let task = selectedTask();
  // 只有在完全没有选中的任务时才新建；若已选中（含「新建任务」预建的 queued 任务，尚无 session），直接续用，避免重复建任务。
  if (!task) {
    // undefined 归属 = 跟随当前选中空间（全局默认）；纯任务走「任务」分组的 + 或 chip 解除关联。
    const created = await window.mocodeWork.createTask('', undefined); updateState(created.state); task = created.task;
  }
  // 标题自动摘要：新建后还没命名的任务，用这一条指令就地命名（用户手动改过就不动）。
  if (!task.title.trim() && !task.sessionId) {
    const next = await window.mocodeWork.renameTask(task.id, summarizePrompt(prompt));
    if (next) updateState(next);
  }
  const stream = streamFor(task.id);
  stream.items.push({ kind: 'user', text: prompt });
  stream.running = true;
  stream.startedAt = Date.now();
  addMessage('user', prompt); promptInput.value = ''; resizePrompt(); setRunning(true);
  // 助手消息就地建好:思考阶段就能看到头像与 "MoCode",状态行也稳定落在这条消息下面。
  startAssistantTurn();
  // 立刻上状态:此刻到首个 token 之间可能好几秒(工具组路由 + 首次 LLM 调用),
  // 状态行是这段时间里界面唯一的"收到了、在干活"证据。
  applyStatus(stream, true, busyStatus('starting', 'status.starting'));
  // 同时挂看门狗:好几秒可以，一直没有动静不行（见 armRunWatchdog）。
  armRunWatchdog(task.id);
  window.mocodeWork.send({ type: 'run', id: task.id, prompt, sessionId: task.sessionId, attachments }); attachments = []; renderAttachments();
}

function endTaskRun(taskId: string): void {
  clearRunWatchdog(taskId);
  const stream = streams.get(taskId);
  if (stream) stream.running = false;
  if (viewingTaskId() === taskId) setRunning(false);
}

function finish(): void {
  finalizeTurn(activeAssistant);
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null; setRunning(false);
}

/** 后台任务结束时的轻提示（不在前台也能知道它跑完了）。 */
function notifyBackground(taskId: string, note: string): void {
  if (viewingTaskId() === taskId) return;
  const task = state?.tasks.find((item) => item.id === taskId);
  showToast('info', t('toast.backgroundNote', { name: task ? taskTitle(task) : t('toast.backgroundTask'), note: note }), 3200);
}

function handleAgentEvent(envelope: AgentEnvelope): void {
  if (envelope.type === 'error') {
    const message = humanizeError(envelope.error ?? '') ?? t('err.agentCommsFailed');
    console.error('[Agent]', message);
    // 主进程的错误都带 requestId(= 任务 id)：按它归属，不再靠「当前在看哪个任务」猜
    // —— 切过任务时猜错，会把别处的失败写到当前这条会话上。
    const taskId = typeof envelope.requestId === 'string' && envelope.requestId ? envelope.requestId : viewingTaskId();
    if (!taskId) { showToast('error', message, 5000); return; }
    clearRunWatchdog(taskId);
    const stream = streamFor(taskId);
    const viewing = viewingTaskId() === taskId;
    if (!stream.running) {
      // 不是这一轮的事（例如手动压缩失败）：只提示，别把会话状态改成「运行失败」。
      showToast('error', message, 5000);
      if (viewing && stream.status?.tone === 'busy') applyStatus(stream, viewing, statusFromTask(selectedTask()));
      return;
    }
    stream.items.push({ kind: 'error', message });
    applyStatus(stream, viewing, settledStatus('failed', 'status.failed', 'fail', elapsedDetail(stream.startedAt)));
    endTaskRun(taskId);
    if (viewing) { showTurnError(message); showToast('error', message, 6000); finish(); }
    else notifyBackground(taskId, message);
    return;
  }
  const payload = envelope.payload ?? {};
  const taskId = envelope.requestId;
  // host_log 等无归属事件走全局通道
  if (!taskId) {
    if (envelope.event === 'host_log') handleHostLog(payload);
    return;
  }
  // 收到任何一条归属本任务的事件 = 「它活着」，看门狗下岗。
  clearRunWatchdog(taskId);
  const stream = streamFor(taskId);
  const viewing = viewingTaskId() === taskId;
  switch (envelope.event) {
    case 'run_started':
      // 「工具组路由」本身就是一次 LLM 调用 —— 首个 thinking 到来前的空窗必须有人交代。
      applyStatus(stream, viewing, busyStatus('starting', 'status.analyzing'));
      break;
    case 'tool_route':
      applyStatus(stream, viewing, busyStatus('thinking', 'status.thinking'));
      break;
    case 'status': {
      const tool = payload.tool ? String(payload.tool) : '';
      applyStatus(stream, viewing, statusFromHostEvent(String(payload.value ?? ''), tool));
      break;
    }
    case 'cancelling':
      applyStatus(stream, viewing, busyStatus('stopping', 'status.stopping'));
      break;
    case 'text_delta': {
      const text = String(payload.text ?? '');
      const last = stream.items[stream.items.length - 1];
      if (last && last.kind === 'text') last.text += text;
      else stream.items.push({ kind: 'text', text });
      if (stream.status?.phase !== 'speaking') applyStatus(stream, viewing, busyStatus('speaking', 'status.speaking'));
      if (viewing) appendText(text);
      break;
    }
    case 'tool_started':
    case 'tool_completed': {
      const completed = envelope.event === 'tool_completed';
      const id = payload.id == null ? '' : String(payload.id);
      const args = toolText(payload.arguments).trim();
      const output = toolText(payload.output).trim();
      const existing = id ? [...stream.items].reverse().find((item) => item.kind === 'tool' && item.id === id) : undefined;
      if (existing && existing.kind === 'tool') {
        existing.done = completed;
        if (output) existing.output = output;
        if (args) existing.args = args;
      } else {
        stream.items.push({ kind: 'tool', id, name: String(payload.name ?? 'tool'), args, output, done: completed });
      }
      if (viewing) addTool(payload, completed);
      break;
    }
    case 'approval_requested': {
      stream.pendingApproval = payload;
      applyStatus(stream, viewing, settledStatus('waiting', 'status.waitingLabel', 'warn'));
      if (viewing) showApproval(taskId, payload);
      else notifyBackground(taskId, t('status.approvalWait'));
      break;
    }
    case 'run_aborted':
      applyStatus(stream, viewing, settledStatus('stopped', 'status.cancelled', 'idle'));
      endTaskRun(taskId);
      if (viewing) finish();
      break;
    case 'run_completed': {
      if (typeof payload.usagePercent === 'number') stream.usagePercent = payload.usagePercent;
      const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : null;
      const created = typeof usage?.cacheCreationTokens === 'number' ? usage.cacheCreationTokens : 0;
      const cached = typeof usage?.cachedTokens === 'number' ? usage.cachedTokens : 0;
      if ((created > 0 || cached > 0) && viewing) {
        const details = [
          created > 0 ? t('toast.cacheCreated', { n: Math.round(created).toLocaleString() }) : null,
          cached > 0 ? t('toast.cacheHit', { n: Math.round(cached).toLocaleString() }) : null,
        ].filter(Boolean).join(' · ');
        showToast('success', t('toast.promptCache', { details: details }), 3500);
      }
      applyStatus(stream, viewing, settledStatus('done', 'status.completed', 'ok', elapsedDetail(stream.startedAt)));
      endTaskRun(taskId);
      if (viewing) { updateContextUsage(stream.usagePercent); finish(); }
      else notifyBackground(taskId, t('status.completed'));
      break;
    }
    case 'compact_done': {
      const pct = typeof payload.usagePercent === 'number' ? payload.usagePercent : null;
      if (pct !== null) stream.usagePercent = pct;
      const before = typeof payload.beforeTokens === 'number' ? Math.round(payload.beforeTokens / 1000) : '?';
      const after = typeof payload.afterTokens === 'number' ? Math.round(payload.afterTokens / 1000) : '?';
      showToast('success', t('toast.compactDone', { before: before, after: after, pct: pct !== null ? ` (${pct}%)` : '' }), 4000);
      // 压缩不改变任务本身的终态,收尾回落到任务记录对应的状态。
      applyStatus(stream, viewing, statusFromTask(selectedTask()));
      if (viewing) updateContextUsage(pct);
      break;
    }
    case 'host_log':
      handleHostLog(payload);
      break;
    case 'run_failed': {
      const message = humanizeError(String(payload.message ?? t('err.runFailed'))) ?? t('err.runFailed');
      stream.items.push({ kind: 'error', message });
      applyStatus(stream, viewing, settledStatus('failed', 'status.failed', 'fail', elapsedDetail(stream.startedAt)));
      endTaskRun(taskId);
      if (viewing) { console.error('[Agent]', message); showTurnError(message); showToast('error', message, 6000); finish(); }
      else { console.error('[Agent]', message); notifyBackground(taskId, t('status.failed')); }
      break;
    }
    case 'host_exit': {
      if (!stream.running) break;
      const code = typeof payload.code === 'number' ? payload.code : null;
      const message = t('status.hostExit', { code: code ?? '?' });
      console.error('[Agent Host]', message);
      stream.items.push({ kind: 'error', message });
      applyStatus(stream, viewing, settledStatus('failed', 'status.failed', 'fail'));
      endTaskRun(taskId);
      if (viewing) { showTurnError(message); finish(); }
      break;
    }
    // host_stopped = 我们主动停的（切模型重启 / 被新一次启动打断），不是故障：不报错、不动会话，
    // 那一轮要么马上被新 host 接着跑，要么调用方自己收敛了状态。
    case 'host_stopped':
      break;
  }
}
/**
 * 需要弹 toast 的 host_log 白名单（稳定 code，与语言无关）。
 * 为什么不匹配文案：主进程按**当前语言**生成 message，用中文关键词去匹配，
 * 用户切成英文后这几条关键提示（配置缺失 / 没找到 node / 连续崩溃）就再也不弹了。
 */
const HOST_LOG_CODES = new Set(['config_missing', 'host_electron_node']);

function handleHostLog(payload: Record<string, unknown>): void {
  const raw = String(payload.message ?? '').trim();
  if (!raw) return;
  // 内部日志只进开发者控制台，绝不进入用户对话。
  if (/^\(?node:\d+\)? \[DEP\d{4}\]/.test(raw)) return;
  console.debug('[Agent Host]', raw);
  // 关键启动 / 配置提示用 toast 提示用户(避免淹没在控制台)
  if (HOST_LOG_CODES.has(String(payload.code ?? ''))) {
    showToast('warn', raw.replace(/^\[mocode-work\]\s*/, ''), 6000);
  }
}

/**
 * 切换查看的任务。三种来源,渲染优先级:
 * 1. 本周期内跑过(streams 里有缓冲) → 从事件缓冲全量重建,顺序与实时渲染一致;
 * 2. 否则用 select-task 返回的 session 历史(重启后打开旧任务)。
 */
function switchToTask(taskId: string, history?: HistoryItem[]): void {
  conversation.innerHTML = '';
  // 会话 DOM 重来一遍,用户消息序号跟着回到 0(回滚靠它对上会话文件里的第几条 user)。
  userTurnIndex = 0;
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  const stream = streams.get(taskId);
  if (stream && stream.items.length) {
    for (const item of stream.items) {
      if (item.kind === 'user') addMessage('user', item.text);
      else if (item.kind === 'text') appendText(item.text);
      else if (item.kind === 'tool') addTool({ id: item.id, name: item.name, arguments: item.args, output: item.output }, item.done);
      else if (item.kind === 'error') {
        // 失败行在会话里留痕(不只是 toast):这一轮没有正文(启动就失败)时,
        // 就地补一条助手消息来承载它 —— 尾部 finish() 会照常给它挂上「重新生成」。
        if (!currentTurn()) startAssistantTurn();
        showTurnError(item.message);
      }
    }
    if (!stream.running) finish();
    else {
      setRunning(true);
      // 运行中的任务切回来:重放完缓冲若还没有助手消息(还在思考阶段),补建一条 ——
      // 与实时路径一致,首个 token 到达时不会再凭空插一条把状态行顶上去。
      if (!currentTurn()) startAssistantTurn();
    }
    updateContextUsage(stream.usagePercent);
    if (stream.running && stream.pendingApproval) showApproval(taskId, stream.pendingApproval);
  } else if (history) {
    renderHistory(history);
    updateContextUsage(null);
  }
  // 还在跑的任务 → 恢复它的运行态状态行(压在输出最下面);已结束的 → 不重现终态。
  renderStatus(stream?.status ?? statusFromTask(selectedTask()), { replay: true });
  // 切进任务一律落在最底部最新消息(回放/finalize 之后高度已定,强制校一次)
  smartScrollToBottom(true);
  // 切换任务清空附件草稿 —— 附件属于「当前正在编辑的这条消息」，不属于任务。
  attachments = []; renderAttachments();
  emptyState.classList.toggle('hidden', conversation.querySelector('.message') != null);
  promptInput.focus();
}

function openInspector(tab: 'overview' | 'files'): void {
  activeInspectorTab = tab; inspector.classList.remove('hidden'); void refreshInspector();
}
function setInspectorTab(tab: 'overview' | 'files'): void {
  activeInspectorTab = tab; document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.classList.toggle('selected', button.dataset.tab === tab));
}
function inspectorButton(label: string, action: string, path?: string): string { return `<button class="inspector-row" data-action="${action}"${path ? ` data-path="${escapeHtml(path)}"` : ''}>${escapeHtml(label)}<span>›</span></button>`; }

/**
 * 文件树的展开状态按 **项目根** 持久化在 localStorage。
 * 必要性：每次 refreshInspector 都是整块 innerHTML 重建，没有这份状态的话，
 * 面板一刷新（切 tab、预览文件后返回、任务切换回来）用户刚展开的目录会全部塌回去。
 */
const FILE_TREE_KEY = 'mocode-work-filetree';
function fileTreeOpenSet(root: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${FILE_TREE_KEY}:${root}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch { return new Set(); }
}
function saveFileTreeOpenSet(root: string, open: Set<string>): void {
  try { localStorage.setItem(`${FILE_TREE_KEY}:${root}`, JSON.stringify([...open])); } catch { /* 隐私模式/配额：退化成不记忆 */ }
}
/** 当前文件树的归属根与展开集（模块级：折叠监听器只绑一次，必须读得到最新值）。 */
let fileTreeRoot = '';
let fileTreeOpen: Set<string> = new Set();
// 原生 <details> 的 toggle 事件不冒泡，只能在容器上捕获；容器本身不重建，所以只绑一次。
inspectorContent.addEventListener('toggle', (event) => {
  const node = event.target as HTMLDetailsElement;
  if (!node.classList.contains('tree-dir') || !fileTreeRoot) return;
  const path = node.dataset.path ?? '';
  if (!path) return;
  if (node.open) fileTreeOpen.add(path); else fileTreeOpen.delete(path);
  saveFileTreeOpenSet(fileTreeRoot, fileTreeOpen);
}, true);

/**
 * 把后端拍平的相对路径列表重建成 IDE 风格目录树：
 * 目录在前、文件在后，各自按名排序；同名「目录 / 文件」并存时目录优先。
 * **目录默认折叠**（`<details>` 不带 open，与 VS Code 初始态一致）——全展开会把上千节点
 * 糊在 280px 面板里；用户展开过的目录由 openPaths 还原。
 * **单链压缩**：只有唯一子目录、且自己没有文件的目录链（如 `packages/work-app/src`）
 * 合并成一行，省掉逐层点击，这是 VS Code 的文件树行为。
 * 建树时把完整相对路径存到每个节点，点击/折叠都直接可用。
 */
function renderFileTree(files: string[], openPaths: Set<string>): string {
  interface TreeNode { name: string; path: string; children: Map<string, TreeNode>; file: boolean; }
  const root: TreeNode = { name: '', path: '', children: new Map(), file: false };
  for (const file of files) {
    let node = root;
    const parts = file.split('/');
    parts.forEach((part, index) => {
      let next = node.children.get(part);
      if (!next) {
        const parentPath = node.path;
        next = { name: part, path: parentPath ? `${parentPath}/${part}` : part, children: new Map(), file: index === parts.length - 1 };
        node.children.set(part, next);
      }
      node = next;
    });
  }
  const byName = (left: TreeNode, right: TreeNode): number => left.name.localeCompare(right.name);
  /** 沿「唯一子目录且自身无文件」的链一路下潜，返回链条末端与合并后的显示名。 */
  const compress = (node: TreeNode): { head: TreeNode; label: string } => {
    let head = node; let label = node.name;
    for (;;) {
      const kids = [...head.children.values()];
      const dirs = kids.filter((child) => !child.file);
      if (dirs.length === 1 && dirs.length === kids.length) {
        head = dirs[0];
        label = label ? `${label}/${head.name}` : head.name;
        continue;
      }
      break;
    }
    return { head, label };
  };
  const render = (node: TreeNode, depth: number): string => {
    // 当前节点自己已经由调用方渲染成 <summary>，这里只负责它的**子项**。
    const children = [...node.children.values()];
    const dirs = children.filter((child) => !child.file).sort(byName);
    const fileNodes = children.filter((child) => child.file).sort(byName);
    let html = '';
    for (const dir of dirs) {
      const { head: tip, label } = compress(dir);
      const open = openPaths.has(dir.path) ? ' open' : '';
      html += `<details class="tree-dir"${open} data-path="${escapeHtml(dir.path)}" style="--depth:${depth}"><summary>${escapeHtml(label)}</summary>${render(tip, depth + 1)}</details>`;
    }
    for (const file of fileNodes) {
      html += `<button class="inspector-row tree-file" data-action="file" data-path="${escapeHtml(file.path)}" style="--depth:${depth}">${escapeHtml(file.name)}</button>`;
    }
    return html;
  };
  const { head, label } = compress(root);
  return label
    ? `<details class="tree-dir" data-path="${escapeHtml(head.path)}" style="--depth:0"><summary>${escapeHtml(label)}</summary>${render(head, 1)}</details>`
    : render(root, 0);
}
async function refreshInspector(): Promise<void> {
  setInspectorTab(activeInspectorTab); inspectorContent.innerHTML = `<p class="inspector-loading">${t('inspector.loading')}</p>`;
  if (activeInspectorTab === 'overview') {
    inspectorTitle.textContent = t('inspector.overview'); const overview = await window.mocodeWork.projectOverview();
    // 纯任务没有工作空间：明说，别让用户对着一堆"未发现文件"猜哪里出了问题。
    if (overview.noWorkspace) {
      inspectorContent.innerHTML = `<p class="inspector-empty">${t('inspector.noWorkspaceHint')}</p>`;
      return;
    }
    const status = Array.isArray(overview.status) ? overview.status.map(String) : []; const files = Array.isArray(overview.files) ? overview.files.map(String) : [];
    inspectorContent.innerHTML = `<section class="overview-card"><b>${escapeHtml(String(overview.branch || t('git.local')))}</b><span>${escapeHtml(String(overview.lastCommit ?? t('empty.lastCommit')))}</span></section><h3>${t('inspector.workChanges')}</h3>${status.length ? `<pre class="status-output">${escapeHtml(status.join('\n'))}</pre>` : `<p class="inspector-empty">${t('inspector.clean')}</p>`}${overview.diffStat ? `<pre class="status-output">${escapeHtml(String(overview.diffStat))}</pre>` : ''}<h3>${t('inspector.recentFiles')}</h3>${files.slice(0, 12).map((file) => inspectorButton(file, 'file', file)).join('') || `<p class="inspector-empty">${t('inspector.noFiles')}</p>`}`;
  } else {
    inspectorTitle.textContent = t('inspector.files'); const overview = await window.mocodeWork.projectOverview();
    if (overview.noWorkspace) { inspectorContent.innerHTML = `<p class="inspector-empty">${t('inspector.noWorkspace')}</p>`; return; }
    const files = Array.isArray(overview.files) ? overview.files.map(String) : [];
    // IDE 风格目录树：不是拍平的路径列表 —— 目录可折叠、文件按名落位、单链目录压缩。
    // 触到后端上限时明说"还有更多"，别让截断看起来像"项目里没这些文件"。
    const truncated = overview.filesTruncated === true;
    const root = String((overview.project as { root?: string } | undefined)?.root ?? '');
    const openPaths = fileTreeOpenSet(root);
    fileTreeRoot = root; fileTreeOpen = openPaths;
    inspectorContent.innerHTML = (files.length ? `<p class="tree-note">${escapeHtml(t('inspector.fileCount', { n: String(files.length) }))}</p>${renderFileTree(files, openPaths)}` : `<p class="inspector-empty">${t('inspector.noFiles')}</p>`)
      + (truncated ? `<p class="inspector-empty">${t('inspector.filesTruncated')}</p>` : '');
  }
  inspectorContent.querySelectorAll<HTMLButtonElement>('[data-action="file"]').forEach((button) => button.addEventListener('click', () => void previewFile(button.dataset.path!)));
}
async function previewFile(file: string): Promise<void> {
  const [content, diff] = await Promise.all([window.mocodeWork.readFile(file), window.mocodeWork.fileDiff(file)]); inspectorTitle.textContent = file;
  inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-files">${t('inspector.backToFiles')}</button><button id="show-diff">${t('inspector.gitDiff')}</button></div><pre class="file-preview">${escapeHtml(content.error ?? content.content ?? '')}</pre>`;
  $('#back-to-files').addEventListener('click', () => { activeInspectorTab = 'files'; void refreshInspector(); });
  $('#show-diff').addEventListener('click', () => { inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-files">${t('inspector.backToFiles')}</button></div><pre class="file-preview diff-preview">${escapeHtml(diff.error ?? diff.content ?? '')}</pre>`; $('#back-to-files').addEventListener('click', () => void previewFile(file)); });
}

function refreshSearch(query = ''): void {
  if (!state) return; const needle = query.trim().toLocaleLowerCase();
  const projects = state.projects.filter((project) => project.name.toLocaleLowerCase().includes(needle)); const tasks = state.tasks.filter((task) => task.title.toLocaleLowerCase().includes(needle));
  const projectResults = projects.map((project) => `<button data-search-project="${escapeHtml(project.id)}">${t('search.project', { name: escapeHtml(project.name) })}</button>`).join('');
  const taskResults = tasks.map((task) => `<button data-search-task="${escapeHtml(task.id)}">${t('sidebar.tasks')} · ${escapeHtml(taskTitle(task))}</button>`).join('');
  $('#search-results').innerHTML = projectResults || taskResults ? `${projectResults}${taskResults}` : `<p>${t('search.noMatch')}</p>`;
  document.querySelectorAll<HTMLButtonElement>('[data-search-project]').forEach((button) => button.addEventListener('click', async () => { updateState(await window.mocodeWork.selectProject(button.dataset.searchProject!)); searchPanel.classList.add('hidden'); }));
  document.querySelectorAll<HTMLButtonElement>('[data-search-task]').forEach((button) => button.addEventListener('click', () => { searchPanel.classList.add('hidden'); void openTask(button.dataset.searchTask!); }));
}

$('#add-project').addEventListener('click', async () => {
  const before = state?.selectedProjectId;
  let next: WorkState | null = null;
  try { next = await window.mocodeWork.pickProject(); }
  catch { showToast('error', t('toast.openProjectFailed')); return; }
  if (!next) return;
  updateState(next); clearWorkspace();
  const project = selectedProject();
  if (project && project.id !== before) showToast('success', t('toast.switchedProject', { name: project.name }));
});
$('#new-task').addEventListener('click', () => void startNewTask());

/**
 * 新建任务：不弹窗、不填表。直接建一个空任务（标题留空 → 侧栏显示「新任务」），
 * 工作区清空并把焦点交给输入框；标题等用户发出第一条指令后由 summarizePrompt 自动生成。
 *
 * projectId：'' = 纯任务（落「任务」分组）；项目 id = 归入该空间；undefined = 跟随当前选中空间。
 */
async function startNewTask(projectId?: string): Promise<void> {
  // 并行友好:别的任务在后台跑也可以继续开新任务。
  const current = selectedTask();
  // 已经有一个「刚新建、还没发过消息、且归属相同」的任务时直接续用，避免连点堆出一串空任务。
  // 归属不同不能续用 —— 否则点了「任务」分组的 + 却复用了空间里的草稿，用户会以为按钮坏了。
  const sameScope = current && (projectId === undefined || (current.projectId || '') === projectId);
  if (current && sameScope && !current.sessionId && !conversation.querySelector('.message')) { promptInput.focus(); return; }
  const created = await window.mocodeWork.createTask('', projectId);
  updateState(created.state);
  clearWorkspace();
  promptInput.value = ''; resizePrompt(); updateContextUsage(null);
  promptInput.focus();
}

/* ── 重命名任务弹窗（侧栏双击任务标题触发） ─────────────── */
let taskModalEl: HTMLElement | null = null;
let renameTaskId: string | undefined;

function ensureTaskModal(): HTMLElement {
  if (taskModalEl) return taskModalEl;
  taskModalEl = $('#task-modal');
  return taskModalEl!;
}
function openRenameModal(taskId: string): void {
  const task = state?.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const el = ensureTaskModal();
  renameTaskId = taskId;
  ($('#task-modal-title') as HTMLElement).textContent = t('taskModal.title');
  ($('#task-modal-create') as HTMLButtonElement).textContent = t('modelForm.save');
  const nameInput = $('#task-name-input') as HTMLInputElement;
  nameInput.value = task.title;
  el.classList.remove('hidden');
  requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
}
function closeTaskModal(): void { ensureTaskModal().classList.add('hidden'); renameTaskId = undefined; }
async function submitRenameModal(): Promise<void> {
  const nameInput = $('#task-name-input') as HTMLInputElement;
  const name = nameInput.value.trim();
  if (!name) { nameInput.classList.remove('shake'); void nameInput.offsetWidth; nameInput.classList.add('shake'); nameInput.focus(); return; }
  if (renameTaskId) {
    const next = await window.mocodeWork.renameTask(renameTaskId, name.slice(0, 160));
    if (next) updateState(next);
    showToast('success', t('taskModal.renamed', { name: name }));
  }
  closeTaskModal();
}
// 侧栏双击任务标题 → 打开重命名弹窗
function startTaskRename(taskId: string): void { openRenameModal(taskId); }

// 弹窗交互：保存、关闭、遮罩点击、回车快捷键
$('#task-modal-create')?.addEventListener('click', () => void submitRenameModal());
ensureTaskModal().querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeTaskModal));
ensureTaskModal().addEventListener('click', (event) => { if (event.target === ensureTaskModal()) closeTaskModal(); });
$('#task-name-input')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void submitRenameModal();
});
$('#add-attachment').addEventListener('click', async () => { const attachment = await window.mocodeWork.pickAttachment(); if (attachment) { attachments.push(attachment); renderAttachments(); } });
$('#compact-button').addEventListener('click', () => {
  const viewing = viewingTaskId();
  if (!viewing) return;
  window.mocodeWork.send({ type: 'compact', id: viewing });
});
// 唯一的文件面板入口（原来 toggle-inspector/show-files 两个按钮开同一个面板，已合并）：
// 关着 → 打开文件 tab；开着但在别的 tab → 切到文件；已在文件 tab → 收起面板。
$('#show-files').addEventListener('click', () => {
  if (inspector.classList.contains('hidden')) { openInspector('files'); return; }
  if (activeInspectorTab !== 'files') { setInspectorTab('files'); void refreshInspector(); return; }
  inspector.classList.add('hidden');
});
$('#close-inspector').addEventListener('click', () => inspector.classList.add('hidden'));
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => { activeInspectorTab = button.dataset.tab as 'overview' | 'files'; void refreshInspector(); }));
$('#search-button').addEventListener('click', () => { searchPanel.classList.remove('hidden'); searchInput.value = ''; refreshSearch(); searchInput.focus(); });
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast('info', t('toast.themeSwitched', { theme: next === 'dark' ? t('appearance.themeDark') : t('appearance.themeLight') }), 1600);
});

/** 应用并持久化主题。saved 可为 light/dark/system; dataset 始终写入实际生效的 light/dark。 */
function applyTheme(saved: 'light' | 'dark' | 'system'): void {
  const effective = saved === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : saved;
  document.documentElement.dataset.theme = effective;
  try { localStorage.setItem('mocode-work-theme', saved); } catch { /* 无 localStorage 则仅本次生效 */ }
  window.mocodeWork.setTheme(saved);
  refreshThemeSegmented();
}

const settingsButton = $('#settings-button') as HTMLButtonElement | null;
const settingsModal = $('#settings-modal');
const settingsNav = settingsModal?.querySelector<HTMLElement>('.settings-nav') ?? null;
const settingsSection = $('#settings-section');
const settingsSectionTitle = $('#settings-section-title');

/* ── 主题色(accent):与深浅主题正交 → 2 × 6 = 12 套外观 ─────────
 * 这里只改 documentElement.dataset.accent,整套色板由 tokens.css 的 oklch 派生式换算
 * (accent 系列色都写成 oklch(L C var(--brand-h))),新增一套主题色 = tokens 加一行 + 这里加一项。
 * 与 theme 一样存 localStorage,首屏脚本(index.html)会先落地,避免加载闪色。 */
type AccentId = 'moss' | 'indigo' | 'ocean' | 'clay' | 'violet' | 'graphite';
const ACCENTS: Array<{ id: AccentId; labelKey: LocaleKey; hue: number; chroma: number }> = [
  { id: 'moss', labelKey: 'appearance.accentMoss', hue: 158, chroma: 0.098 },
  { id: 'indigo', labelKey: 'appearance.accentIndigo', hue: 272, chroma: 0.135 },
  { id: 'ocean', labelKey: 'appearance.accentOcean', hue: 228, chroma: 0.115 },
  { id: 'clay', labelKey: 'appearance.accentClay', hue: 48, chroma: 0.115 },
  { id: 'violet', labelKey: 'appearance.accentViolet', hue: 322, chroma: 0.125 },
  { id: 'graphite', labelKey: 'appearance.accentGraphite', hue: 265, chroma: 0.008 },
];
const ACCENT_KEY = 'mocode-work-accent';
const DEFAULT_ACCENT: AccentId = 'moss';

function currentAccent(): AccentId {
  try {
    const saved = localStorage.getItem(ACCENT_KEY);
    if (saved && ACCENTS.some((item) => item.id === saved)) return saved as AccentId;
  } catch { /* 无 localStorage 则走默认色 */ }
  return DEFAULT_ACCENT;
}

function applyAccent(id: AccentId): void {
  document.documentElement.dataset.accent = id;
  try { localStorage.setItem(ACCENT_KEY, id); } catch { /* 无 localStorage 则仅本次生效 */ }
  refreshAccentChips();
}

/** 色板选中态:选中的色点加 .selected(CSS 画一圈描边),aria-checked 只管无障碍。 */
function refreshAccentChips(): void {
  const current = currentAccent();
  document.querySelectorAll<HTMLButtonElement>('.accent-chip').forEach((chip) => {
    const active = chip.dataset.accent === current;
    chip.setAttribute('aria-checked', String(active));
    chip.classList.toggle('selected', active);
  });
}

function currentSavedTheme(): 'light' | 'dark' | 'system' {
  try { return (localStorage.getItem('mocode-work-theme') as 'light' | 'dark' | 'system') || 'system'; }
  catch { return 'system'; }
}
function refreshThemeSegmented(): void {
  const saved = currentSavedTheme();
  document.querySelectorAll<HTMLButtonElement>('.settings-theme').forEach((button) => {
    const active = button.dataset.theme === saved;
    button.setAttribute('aria-checked', String(active));
    // 视觉选中态靠 .active（radio 填充 + 文字加深），aria-checked 只管无障碍。
    button.classList.toggle('active', active);
  });
}

/** 语言行的选中态与主题行同理：切换后立刻反色，不必关掉设置再进来。 */
function refreshLanguageSegmented(): void {
  document.querySelectorAll<HTMLButtonElement>('.settings-language').forEach((button) => {
    const active = button.dataset.lang === getLang();
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  });
}

/* ── 设置弹窗:左侧分类导航 + 右侧内容 ─────────────────────── */
type SettingsSectionId = 'model' | 'behavior' | 'appearance' | 'about';
/** 分类元数据存 i18n key（不存译文）—— 模块级常量在启动时求值一次，存译文会锁死语言。 */
const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; labelKey: LocaleKey; icon: string; descKey: LocaleKey }> = [
  { id: 'model', labelKey: 'settings.model', icon: 'spark-bot', descKey: 'settings.modelDesc' },
  { id: 'behavior', labelKey: 'settings.behavior', icon: 'wrench', descKey: 'settings.behaviorDesc' },
  { id: 'appearance', labelKey: 'settings.appearance', icon: 'sun', descKey: 'settings.appearanceDesc' },
  { id: 'about', labelKey: 'settings.about', icon: 'info', descKey: 'settings.aboutDesc' },
];
let settingsActiveSection: SettingsSectionId = 'model';
const SETTING_ITEMS: Array<{ key: string; labelKey: LocaleKey; hintKey: LocaleKey }> = [
  { key: 'autoCompact', labelKey: 'setting.autoCompact', hintKey: 'setting.autoCompactHint' },
  { key: 'memory', labelKey: 'setting.memory', hintKey: 'setting.memoryHint' },
  { key: 'subAgent', labelKey: 'setting.subAgent', hintKey: 'setting.subAgentHint' },
  { key: 'autoReflect', labelKey: 'setting.autoReflect', hintKey: 'setting.autoReflectHint' },
];
let settingsState: Record<string, boolean> = {};

/* ── 模型分组:按 API 地址归类到「提供商」 ────────────────────
 * 预设文件的 provider 字段只有 openai/anthropic 两种协议名,无法区分
 * DeepSeek / Kimi / 火山 这些真实厂商;而 baseURL 的 host 天然唯一标识厂商。
 * 所以分组一律以 host 为准(main 侧已剥掉 api./www. 这类前缀保证同厂商同键)。
 * 品牌名走 i18n：存 key 不存译文，切语言时组名随之更新。 */
type ProviderRule = { match: RegExp; key?: LocaleKey; literal?: string };
const KNOWN_PROVIDERS: ProviderRule[] = [
  { match: /(^|\.)deepseek\.(com|cn)$/, literal: 'DeepSeek' },
  { match: /(^|\.)moonshot\.(cn|com)$/, literal: 'Moonshot' },
  { match: /(^|\.)anthropic\.com$/, literal: 'Anthropic' },
  { match: /(^|\.)openai\.com$/, literal: 'OpenAI' },
  { match: /(^|\.)siliconflow\.(cn|com)$/, literal: 'SiliconFlow' },
  { match: /(^|\.)(volces|volcengine)\.com$/, key: 'provider.volcengine' },
  { match: /(^|\.)dashscope\.aliyuncs\.com$/, key: 'provider.dashscope' },
  { match: /(^|\.)(bigmodel|zhipuai)\.cn$/, key: 'provider.zhipu' },
  { match: /(^|\.)(qianfan|baidubce)\.com$/, key: 'provider.qianfan' },
  { match: /(^|\.)(hunyuan\.tencent|tencentcloudapi)\.com$/, key: 'provider.hunyuan' },
  { match: /(^|\.)minimax(chat)?\.(com|cn)$/, literal: 'MiniMax' },
  { match: /(^|\.)modelscope\.cn$/, literal: 'ModelScope' },
  { match: /(^|\.)openrouter\.ai$/, literal: 'OpenRouter' },
  { match: /(^|\.)groq\.com$/, literal: 'Groq' },
  { match: /^local(host)?$|^127\.0\.0\.1$|^0\.0\.0\.0$|^\[::1\]$/, key: 'provider.local' },
];

/** host → 展示名。已知厂商给品牌名,未知则回退裸主机名。 */
function providerNameOf(host: string): string {
  const bare = (host || '').split(':')[0]!.toLowerCase();
  if (!bare) return t('provider.unconfiguredHost');
  for (const item of KNOWN_PROVIDERS) {
    if (!item.match.test(bare)) continue;
    return item.key ? t(item.key) : item.literal!;
  }
  return bare;
}

/** 稳定色相:同一个提供商任何时候都拿到同一个颜色,不随列表顺序漂移。 */
/** 组头副标题：带上端口，避免两个自建网关都显示成 `localhost` 分不清。 */
function displayHost(url: string): string {
  return (url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
}

/** 未知厂商时组名就是裸主机名，再显示一遍 host 纯属噪声 —— 只在两者不同时才作为副标题。 */
function groupHostLabel(group: ModelGroup): string {
  return group.host && group.host !== group.name ? group.host : '';
}

/** 未知厂商时用主机名首字母做标记,补足「一眼分辨哪一组」的诉求。 */
function providerInitial(name: string): string {
  const first = (name || '').trim()[0];
  return first ? first.toUpperCase() : '•';
}

type ModelGroup = { key: string; name: string; host: string; items: ModelItem[] };

/** 按提供商分组:组内激活项置顶,其余按模型名排序;组间按名称排序。 */
function groupModelsByProvider(list: ModelItem[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const model of list) {
    const key = (model.providerHost || '').toLowerCase() || '__none__';
    let group = map.get(key);
    if (!group) {
      group = { key, name: providerNameOf(model.providerHost), host: displayHost(model.baseURL), items: [] };
      map.set(key, group);
    }
    group.items.push(model);
  }
  for (const group of map.values()) {
    group.items.sort((a, b) => (a.isActive === b.isActive ? a.label.localeCompare(b.label) : a.isActive ? -1 : 1));
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 设置页的模型行(分组内复用)。 */
function settingsModelRow(model: ModelItem): string {
  const meta = [
    t('settings.presetOf', { name: escapeHtml(model.name) }),
    model.provider === 'anthropic' ? 'anthropic' : null,
    model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}k` : null,
    model.provider === 'anthropic' && model.promptCache ? 'cache' : null,
  ].filter(Boolean).join(' · ');
  return `
    <div class="settings-row-wrap">
      <button class="settings-row settings-model ${model.isActive ? 'active' : ''}" data-model="${escapeHtml(model.name)}" role="option" aria-selected="${model.isActive}">
        <span class="settings-row-radio">${model.isActive ? icon('check') : ''}</span>
        <span class="settings-row-body">
          <span class="settings-row-title">${escapeHtml(model.label)}</span>
          <span class="settings-row-sub">${meta}</span>
        </span>
        ${model.isActive ? `<span class="settings-row-tag">${t('settings.current')}</span>` : ''}
      </button>
      <button class="settings-row-act icon-button muted" data-edit="${escapeHtml(model.name)}" title="${t('menu.edit')} ${escapeHtml(model.name)}" aria-label="${t('modelForm.edit')} ${escapeHtml(model.name)}">${icon('edit')}</button>
    </div>`;
}

/** 「模型」分类：模型预设列表 + 当前生效配置摘要。 */
async function renderSettingsModelSection(): Promise<void> {
  if (!settingsSection) return;
  // 空态也要能添加 —— 这正是「一个预设都没有」时用户最需要的那颗按钮。
  if (!modelList.length) {
    settingsSection.innerHTML = `
      <div class="settings-block">
        <div class="settings-empty">${icon('warn')}<div><b>${t('settings.noModelPresets')}</b><p>${t('settings.noModelPresetsHint')}</p></div></div>
        <button class="settings-add" id="model-add">
          <span class="settings-add-icon">${icon('plus')}</span>
          <span class="settings-row-body"><span class="settings-row-title">${t('settings.addModel')}</span><span class="settings-row-sub">${t('settings.addModelSub')}</span></span>
        </button>
      </div>`;
    settingsSection.querySelector<HTMLButtonElement>('#model-add')?.addEventListener('click', () => openModelForm());
    return;
  }
  let config: ModelConfig | null = null;
  try { config = await window.mocodeWork.getConfig(); } catch { /* 忽略 */ }
  const active = modelList.find((m) => m.isActive) ?? null;
  const provider = config?.provider ?? active?.provider ?? '';
  const contextWindow = config?.contextWindow ?? (active?.contextWindow || null);
  const kv: Array<[string, string]> = [
    [t('settings.kvProtocol'), provider || t('settings.kvUnknown')],
    [t('settings.kvContext'), contextWindow ? `${(contextWindow / 1000).toFixed(0)}k tokens` : t('settings.kvUnset')],
    [t('settings.kvPromptCache'), provider === 'anthropic' ? ((config?.promptCache ?? active?.promptCache) ? t('settings.toggleOn') : t('settings.toggleOff')) : t('settings.kvNA')],
    [t('settings.kvApiUrl'), config?.baseUrl || active?.baseURL || t('settings.kvNotConfigured')],
  ];
  const groups = groupModelsByProvider(modelList);
  settingsSection.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head">
        <b>${t('about.modelPresets')}</b>
        <span>${t('picker.count', { groups: groups.length, models: modelList.length })} · ${t('picker.effectiveAfter')}</span>
      </div>
      <button class="settings-add" id="model-add">
        <span class="settings-add-icon">${icon('plus')}</span>
        <span class="settings-row-body"><span class="settings-row-title">${t('settings.addModel')}</span><span class="settings-row-sub">${t('settings.addModelSub')}</span></span>
      </button>
      <div class="settings-providers">
        ${groups.map((group) => `
          <div class="settings-provider">
            <div class="settings-provider-head">
              <span class="settings-provider-avatar">${escapeHtml(providerInitial(group.name))}</span>
              <b>${escapeHtml(group.name)}</b>
              ${groupHostLabel(group) ? `<code title="${escapeHtml(group.host)}">${escapeHtml(groupHostLabel(group))}</code>` : ''}
              <span class="settings-provider-count">${t('settings.providerCount', { n: group.items.length })}</span>
            </div>
            <div class="settings-list" role="listbox" aria-label="${t('settings.providerModels', { name: escapeHtml(group.name) })}">
              ${group.items.map(settingsModelRow).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('settings.currentConfig')}</b><span>${t('settings.fromConfig')}</span></div>
      <div class="settings-kv">${kv.map(([k, v]) => `<div class="settings-kv-row"><span>${escapeHtml(k)}</span><b title="${escapeHtml(v)}">${escapeHtml(v)}</b></div>`).join('')}</div>
    </div>
  `;
  settingsSection.querySelectorAll<HTMLButtonElement>('.settings-model').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.model;
      if (!name || button.classList.contains('active')) return;
      const result = await window.mocodeWork.switchModel(name);
      if (!result.ok) { showToast('error', result.message); return; }
      showToast('success', result.message);
      await refreshModelList();
      // 底部输入框上的模型按钮同步刷新
      try { setModeButton(await window.mocodeWork.getConfig()); } catch { /* 忽略 */ }
      await renderSettingsModelSection();
    });
  });
  settingsSection.querySelectorAll<HTMLButtonElement>('.settings-row-act').forEach((button) => {
    button.addEventListener('click', (event) => {
      // 编辑按钮与「切换」同行：必须拦掉冒泡，否则点编辑会顺手切成那个模型。
      event.stopPropagation();
      const name = button.dataset.edit;
      if (name) openModelForm(name);
    });
  });
  settingsSection.querySelector<HTMLButtonElement>('#model-add')?.addEventListener('click', () => openModelForm());
}

/* ── 模型预设编辑器（添加 / 编辑 / 删除） ─────────────────────
 * 与 mocode 终端的 /model 向导等价，但表单化：字段一一对应
 * ~/.mocode/models/<name>.json。写文件走主进程，renderer 只递草稿。 */

/** 提供商预设模板 —— 与 src/repl/commands.ts 的 MODEL_PRESETS 同步。
 *  选一个自动填 baseURL/model/window/provider，用户仍可逐项改。
 *  label 为 i18n key（divider 等纯标识符除外），切语言后重建下拉即可更新。 */
const MODEL_TEMPLATES: Array<{ label: string; provider: LlmProvider; baseURL: string; model: string; contextWindow: number; promptCache: boolean }> = [
  { label: 'Anthropic Claude', provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', contextWindow: 200000, promptCache: true },
  { label: 'DeepSeek', provider: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', contextWindow: 256000, promptCache: false },
  { label: 'modelTemplate.glm', provider: 'openai', baseURL: 'https://open.bigmodel.cn/api/v3', model: 'glm-4.6', contextWindow: 256000, promptCache: false },
  { label: 'modelTemplate.qwen', provider: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', contextWindow: 256000, promptCache: false },
  { label: 'modelTemplate.kimi', provider: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview', contextWindow: 256000, promptCache: false },
  { label: 'MiniMax', provider: 'openai', baseURL: 'https://api.minimax.io/v1', model: 'MiniMax-M3', contextWindow: 256000, promptCache: false },
  { label: 'modelTemplate.volcengine', provider: 'openai', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6', contextWindow: 256000, promptCache: false },
  { label: 'OpenRouter', provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, promptCache: false },
  { label: 'modelTemplate.ollama', provider: 'openai', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', contextWindow: 128000, promptCache: false },
  { label: 'modelTemplate.vllm', provider: 'openai', baseURL: 'http://localhost:8000/v1', model: 'default', contextWindow: 256000, promptCache: false },
];

/** 模板名 → 当前语言展示名（非 key 的纯品牌名原样返回）。 */
function templateLabel(label: string): string {
  return label.startsWith('modelTemplate.') ? t(label as LocaleKey) : label;
}

let modelFormEl: HTMLElement | null = null;
/** 编辑态：被编辑预设的原始名。undefined = 新增。 */
let modelFormEditing: string | undefined;
/** 表单里新建时的默认「立即启用」值（沿用上次选择，避免每次都重新勾）。 */
let modelFormActivate = true;

const modelFormField = <T extends HTMLElement>(id: string): T => modelFormEl!.querySelector(`#${id}`) as T;

/** 重建模板下拉（切语言时也要重建：选项文案是本地化的）。保留当前选中项。 */
function rebuildModelTemplates(): void {
  const select = modelFormField<HTMLSelectElement>('model-form-template');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = t('modelForm.custom');
  select.append(custom);
  for (const [index, template] of MODEL_TEMPLATES.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${templateLabel(template.label)} · ${template.model}`;
    select.append(option);
  }
  if (previous && select.querySelector(`option[value="${previous}"]`)) select.value = previous;
}

function ensureModelForm(): HTMLElement {
  if (modelFormEl) return modelFormEl;
  const el = $('#model-form-modal') as HTMLElement;
  modelFormEl = el;
  rebuildModelTemplates();
  const select = modelFormField<HTMLSelectElement>('model-form-template');
  select.addEventListener('change', () => {
    if (select.value === '') return;
    const template = MODEL_TEMPLATES[Number(select.value)];
    if (!template) return;
    modelFormField<HTMLSelectElement>('model-form-provider').value = template.provider;
    modelFormField<HTMLInputElement>('model-form-baseurl').value = template.baseURL;
    modelFormField<HTMLInputElement>('model-form-model').value = template.model;
    modelFormField<HTMLInputElement>('model-form-window').value = String(template.contextWindow);
    setFormToggle('model-form-cache', template.promptCache);
    syncFormVisibility();
    // 只在用户没自己填过预设名时才带出建议名，避免覆盖手输内容。
    const nameInput = modelFormField<HTMLInputElement>('model-form-name');
    if (!nameInput.value.trim() || nameInput.dataset.auto === '1') {
      nameInput.value = suggestPresetName(template.model);
      nameInput.dataset.auto = '1';
    }
  });
  modelFormField<HTMLInputElement>('model-form-name').addEventListener('input', (event) => {
    (event.target as HTMLInputElement).dataset.auto = '0';
  });
  // 用户开始改任何一格就把上一次的报错收掉：错误提示挂着不动会让人以为还没修好。
  el.querySelector('.model-form-body')?.addEventListener('input', () => clearFormError());
  modelFormField<HTMLSelectElement>('model-form-provider').addEventListener('change', syncFormVisibility);
  modelFormField<HTMLElement>('model-form-cache').addEventListener('click', () => {
    setFormToggle('model-form-cache', modelFormField<HTMLElement>('model-form-cache').getAttribute('aria-checked') !== 'true');
  });
  modelFormField<HTMLElement>('model-form-activate').addEventListener('click', () => {
    modelFormActivate = modelFormField<HTMLElement>('model-form-activate').getAttribute('aria-checked') !== 'true';
    setFormToggle('model-form-activate', modelFormActivate);
  });
  $('#model-form-save')?.addEventListener('click', () => void submitModelForm());
  el.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeModelForm));
  el.addEventListener('click', (event) => { if (event.target === el) closeModelForm(); });
  $('#model-form-delete')?.addEventListener('click', () => void deleteEditingModel());
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'TEXTAREA') { event.preventDefault(); void submitModelForm(); }
  });
  return el;
}

/** 模型名 → 合法预设名建议（点号/斜杠归一到连字符）。 */
function suggestPresetName(model: string): string {
  const sanitized = (model || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!sanitized) return '';
  // 已存在同名预设时加 -2/-3 后缀，避免用户还没保存就先吃一个「已存在同名」。
  const taken = new Set(modelList.map((item) => item.name));
  if (!taken.has(sanitized)) return sanitized;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${sanitized.slice(0, 32 - String(i).length - 1)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return sanitized;
}

function setFormToggle(id: string, on: boolean): void {
  const el = modelFormField<HTMLElement>(id);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

/** anthropic 才显示 Prompt Cache 开关（openai 下它无意义，core 也会落 false）。 */
function syncFormVisibility(): void {
  const isAnthropic = modelFormField<HTMLSelectElement>('model-form-provider').value === 'anthropic';
  modelFormField<HTMLElement>('model-form-cache').classList.toggle('field-hidden', !isAnthropic);
}

function showFormError(message: string): void {
  const el = modelFormField<HTMLElement>('model-form-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearFormError(): void {
  const el = modelFormField<HTMLElement>('model-form-error');
  el.textContent = '';
  el.classList.add('hidden');
  // shake 是「一次性」反馈：不清掉的话，下一次打开表单那个红框还挂着，看起来像仍在校验失败。
  modelFormEl?.querySelectorAll('.field-input.shake').forEach((input) => input.classList.remove('shake'));
}

function clearModelFormFields(): void {
  modelFormField<HTMLSelectElement>('model-form-template').value = '';
  modelFormField<HTMLSelectElement>('model-form-template').disabled = false;
  modelFormField<HTMLSelectElement>('model-form-provider').value = 'openai';
  const nameInput = modelFormField<HTMLInputElement>('model-form-name');
  nameInput.value = '';
  nameInput.dataset.auto = '0';
  modelFormField<HTMLInputElement>('model-form-baseurl').value = '';
  modelFormField<HTMLInputElement>('model-form-model').value = '';
  modelFormField<HTMLInputElement>('model-form-apikey').value = '';
  modelFormField<HTMLInputElement>('model-form-window').value = t('modelForm.contextWindowPlaceholder');
  setFormToggle('model-form-cache', false);
  syncFormVisibility();
  clearFormError();
  modelFormField<HTMLButtonElement>('model-form-save').disabled = false;
}

/** 打开编辑器。传 name = 编辑既有预设（回读完整字段含 apiKey）；不传 = 新增。 */
function openModelForm(name?: string): void {
  const el = ensureModelForm();
  modelFormEditing = name;
  const isEdit = !!name;
  const title = el.querySelector('#model-form-title') as HTMLElement;
  const saveButton = el.querySelector('#model-form-save') as HTMLButtonElement;
  const deleteButton = el.querySelector('#model-form-delete') as HTMLButtonElement;
  // 先按模式定好表单骨架，再清字段 —— clearModelFormFields 会重置 disabled，
  // 顺序反了会让「编辑态禁用模板」被悄悄解开，用户一选模板就把正在编辑的预设冲掉。
  deleteButton.dataset.armed = '0';
  deleteButton.textContent = t('modelForm.delete');
  deleteButton.hidden = !isEdit;
  // 预设模板只在新增时有意义（编辑时清空字段是灾难）。
  const templateSelect = modelFormField<HTMLSelectElement>('model-form-template');
  modelFormField<HTMLElement>('model-form-activate').classList.toggle('field-hidden', isEdit);
  title.textContent = isEdit ? t('modelForm.edit') : t('settings.addModel');
  saveButton.textContent = t('modelForm.save');
  clearModelFormFields();
  templateSelect.disabled = isEdit;
  el.classList.remove('hidden');

  if (!isEdit) {
    modelFormField<HTMLInputElement>('model-form-name').focus();
    return;
  }
  void (async () => {
    const detail = await window.mocodeWork.getModel(name!);
    if (!detail.ok || !detail.preset) {
      deleteButton.hidden = true;
      saveButton.disabled = true;
      showFormError(detail.message ?? t('modelForm.errorRead', { name: name }));
      return;
    }
    saveButton.disabled = false;
    const preset = detail.preset;
    modelFormField<HTMLInputElement>('model-form-name').value = preset.name;
    modelFormField<HTMLSelectElement>('model-form-provider').value = preset.provider;
    modelFormField<HTMLInputElement>('model-form-baseurl').value = preset.baseURL;
    modelFormField<HTMLInputElement>('model-form-model').value = preset.model;
    modelFormField<HTMLInputElement>('model-form-apikey').value = preset.apiKey;
    modelFormField<HTMLInputElement>('model-form-window').value = String(preset.contextWindow);
    setFormToggle('model-form-cache', preset.anthropicPromptCache);
    syncFormVisibility();
    modelFormField<HTMLInputElement>('model-form-name').focus();
  })();
}

function closeModelForm(): void {
  modelFormEl?.classList.add('hidden');
  modelFormEditing = undefined;
}

function collectModelDraft(): ModelDraft | null {
  const nameInput = modelFormField<HTMLInputElement>('model-form-name');
  const name = nameInput.value.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    nameInput.classList.remove('shake'); void nameInput.offsetWidth; nameInput.classList.add('shake');
    showFormError(t('modelForm.errorName'));
    nameInput.focus();
    return null;
  }
  const provider = modelFormField<HTMLSelectElement>('model-form-provider').value as LlmProvider;
  const baseURL = modelFormField<HTMLInputElement>('model-form-baseurl').value.trim();
  const apiKey = modelFormField<HTMLInputElement>('model-form-apikey').value.trim();
  const model = modelFormField<HTMLInputElement>('model-form-model').value.trim();
  const windowValue = modelFormField<HTMLInputElement>('model-form-window').value.trim();
  const contextWindow = Number(windowValue);
  // 每个失败分支都把红框打在对应输入框上 —— 只弹文字的话，用户还得自己找是哪一格错了。
  const flag = (id: string, message: string): null => {
    const el = modelFormField<HTMLInputElement>(id);
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    showFormError(message);
    el.focus();
    return null;
  };
  if (!baseURL) return flag('model-form-baseurl', t('modelForm.errorBaseUrl'));
  if (!apiKey) return flag('model-form-apikey', t('modelForm.errorApiKey'));
  if (!model) return flag('model-form-model', t('modelForm.errorModel'));
  if (!windowValue || !Number.isFinite(contextWindow) || contextWindow <= 0) return flag('model-form-window', t('modelForm.errorWindow'));
  return {
    provider,
    baseURL,
    apiKey,
    model,
    contextWindow: Math.floor(contextWindow),
    anthropicPromptCache: provider === 'anthropic' && modelFormField<HTMLElement>('model-form-cache').getAttribute('aria-checked') === 'true',
  };
}

async function submitModelForm(): Promise<void> {
  clearFormError();
  const draft = collectModelDraft();
  if (!draft) return;
  const name = modelFormField<HTMLInputElement>('model-form-name').value.trim();
  const saveButton = modelFormField<HTMLButtonElement>('model-form-save');
  saveButton.disabled = true;
  try {
    const result = await window.mocodeWork.saveModel({
      name,
      originalName: modelFormEditing,
      draft,
      activate: modelFormEditing ? false : modelFormActivate,
    });
    if (!result.ok) { showFormError(result.message); return; }
    showToast('success', result.message);
    closeModelForm();
    await refreshModelList();
    try { setModeButton(await window.mocodeWork.getConfig()); } catch { /* 忽略 */ }
    await renderSettingsModelSection();
  } catch (error) {
    showFormError(t('modelForm.saveFailed', { msg: (error as Error).message }));
  } finally {
    saveButton.disabled = false;
  }
}

async function deleteEditingModel(): Promise<void> {
  const name = modelFormEditing;
  if (!name) return;
  const button = modelFormField<HTMLButtonElement>('model-form-delete');
  // 两步确认：预设里有 apiKey，误删后要重填，成本比多一次点击高。
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = t('modelForm.confirmDelete');
    setTimeout(() => { button.dataset.armed = '0'; button.textContent = t('modelForm.delete'); }, 3200);
    return;
  }
  const result = await window.mocodeWork.deleteModel(name);
  if (!result.ok) { showFormError(result.message); return; }
  showToast('success', result.message);
  closeModelForm();
  await refreshModelList();
  try { setModeButton(await window.mocodeWork.getConfig()); } catch { /* 忽略 */ }
  await renderSettingsModelSection();
}

/** 「行为」分类：mocode 终端斜杠命令对应的开关。 */
function renderSettingsBehaviorSection(): void {
  if (!settingsSection) return;
  settingsSection.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('settings.agentBehavior')}</b><span>${t('settings.agentBehaviorHint')}</span></div>
      <div class="settings-list">
        ${SETTING_ITEMS.map((item) => `
          <button class="settings-row settings-toggle" data-setting="${item.key}" role="switch" aria-checked="${settingsState[item.key] ? 'true' : 'false'}">
            <span class="settings-row-body"><span class="settings-row-title">${escapeHtml(t(item.labelKey))}</span><span class="settings-row-sub">${escapeHtml(t(item.hintKey))}</span></span>
            <span class="settings-switch" aria-hidden="true"></span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  settingsSection.querySelectorAll<HTMLButtonElement>('.settings-toggle').forEach((button) => {
    button.addEventListener('click', async () => {
      const key = button.dataset.setting;
      if (!key) return;
      const next = !settingsState[key];
      try { settingsState = await window.mocodeWork.setSettings({ [key]: next }); }
      catch (error) { console.error('[settings]', error); showToast('error', t('toast.settingsSaveFailed')); return; }
      renderSettingsBehaviorSection();
      const hasRunning = (state?.tasks ?? []).some((task) => task.status === 'running' || task.status === 'waiting');
      const item = SETTING_ITEMS.find((entry) => entry.key === key);
      const label = item ? t(item.labelKey) : key;
      const stateText = next ? t('settings.enableVerb') : t('settings.disableVerb');
      showToast('success', `${t('settings.toggled', { label: label, state: stateText })}${hasRunning ? t('settings.restartNote') : ''}`);
    });
  });
}

/** 「外观」分类：主题 + 界面语言。 */
function renderSettingsAppearanceSection(): void {
  if (!settingsSection) return;
  const themes: Array<['light' | 'dark' | 'system', string, string, string]> = [
    ['light', t('appearance.themeLight'), 'sun', t('appearance.themeLightHint')],
    ['dark', t('appearance.themeDark'), 'moon', t('appearance.themeDarkHint')],
    ['system', t('appearance.themeSystem'), 'layout', t('appearance.themeSystemHint')],
  ];
  const languages: Array<{ code: SupportedLang; label: string; sub: string }> = SUPPORTED_LANGS.map((code) => ({
    code,
    label: LANG_NAMES[code] ?? code,
    sub: code,
  }));
  settingsSection.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('appearance.theme')}</b><span>${t('appearance.themeHint')}</span></div>
      <div class="settings-list">
        ${themes.map(([value, label, iconName, hint]) => `
          <button class="settings-row settings-theme" data-theme="${value}" role="radio" aria-checked="false">
            <span class="settings-row-radio"></span>
            <span class="settings-row-icon">${icon(iconName)}</span>
            <span class="settings-row-body"><span class="settings-row-title">${label}</span><span class="settings-row-sub">${hint}</span></span>
          </button>
        `).join('')}
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('appearance.accent')}</b><span>${t('appearance.accentHint')}</span></div>
      <div class="accent-grid" role="radiogroup" aria-label="${t('appearance.accent')}">
        ${ACCENTS.map(({ id, labelKey, hue, chroma }) => `
          <button class="accent-chip" data-accent="${id}" role="radio" aria-checked="false" title="${t(labelKey)}" aria-label="${t(labelKey)}">
            <span class="accent-dot" style="--sw-h:${hue};--sw-c:${chroma}"></span>
            <span class="accent-name">${t(labelKey)}</span>
          </button>
        `).join('')}
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('appearance.language')}</b><span>${t('appearance.languageHint')}</span></div>
      <div class="settings-list">
        ${languages.map(({ code, label, sub }) => `
          <button class="settings-row settings-language" data-lang="${code}" role="radio" aria-checked="${getLang() === code}">
            <span class="settings-row-radio"></span>
            <span class="settings-row-icon">${icon('globe')}</span>
            <span class="settings-row-body"><span class="settings-row-title">${label}</span><span class="settings-row-sub">${sub}</span></span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  refreshThemeSegmented();
  refreshLanguageSegmented();
  refreshAccentChips();
  settingsSection.querySelectorAll<HTMLButtonElement>('.settings-theme').forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.theme as 'light' | 'dark' | 'system');
      refreshThemeSegmented();
    });
  });
  settingsSection.querySelectorAll<HTMLButtonElement>('.accent-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.accent as AccentId | undefined;
      if (!id) return;
      applyAccent(id);
      const meta = ACCENTS.find((item) => item.id === id);
      showToast('info', t('toast.accentApplied', { accent: meta ? t(meta.labelKey) : id }), 1600);
    });
  });
  settingsSection.querySelectorAll<HTMLButtonElement>('.settings-language').forEach((button) => {
    button.addEventListener('click', () => {
      const code = button.dataset.lang as SupportedLang | undefined;
      if (!code || code === getLang()) return;
      setLang(code);
      // setLang 会触发 onLangChange → applyLanguage()，整页重绘时这句会被覆盖成新语言，
      // 所以顺序上先切再提示，避免 toast 文案还是旧语言。
      showToast('success', t('toast.languageSwitched', { lang: LANG_NAMES[code] ?? code }));
    });
  });
}

/** 「关于」分类：版本信息 + 快捷入口。 */
function renderSettingsAboutSection(): void {
  if (!settingsSection) return;
  const kv: Array<[string, string]> = [
    [t('about.version'), '1.0.0'],
    [t('about.configFile'), '~/.mocode/config'],
    [t('about.modelPresets'), '~/.mocode/models'],
    [t('about.sessionDir'), t('about.sessionDirValue')],
  ];
  settingsSection.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('about.title')}</b><span>${t('about.subtitle')}</span></div>
      <div class="settings-kv">${kv.map(([k, v]) => `<div class="settings-kv-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('about.shortcuts')}</b></div>
      <div class="settings-list">
        <button class="settings-row settings-link" data-action="shortcuts"><span class="settings-row-icon">${icon('keyboard')}</span><span class="settings-row-body"><span class="settings-row-title">${t('about.shortcutsTitle')}</span><span class="settings-row-sub">${t('about.shortcutsSub')}</span></span><span class="settings-row-chevron">${icon('chevron-right')}</span></button>
      </div>
    </div>
  `;
  settingsSection.querySelectorAll<HTMLButtonElement>('.settings-link').forEach((button) => {
    button.addEventListener('click', () => { if (button.dataset.action === 'shortcuts') showCheatsheet(); });
  });
}

/** 切语言后重画设置页（当前分类的内容 + 左侧导航文案）。 */
function renderSettingsSectionCacheOnLang(): void {
  if (!settingsSection || settingsModal?.classList.contains('hidden')) return;
  // 左侧导航分类名缓存翻译过，需重建（ensureSettingsNav 只在无节点时才建，这里先清空）。
  settingsNav?.querySelectorAll('.settings-nav-item').forEach((item) => item.remove());
  ensureSettingsNav();
  void renderSettingsSection();
}

async function renderSettingsSection(): Promise<void> {
  if (!settingsSection) return;
  const meta = SETTINGS_SECTIONS.find((item) => item.id === settingsActiveSection) ?? SETTINGS_SECTIONS[0]!;
  if (settingsSectionTitle) settingsSectionTitle.textContent = t(meta.labelKey);
  settingsNav?.querySelectorAll<HTMLButtonElement>('.settings-nav-item').forEach((button) => {
    const active = button.dataset.section === settingsActiveSection;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  // 按需渲染当前分类，避免一次性拉全部数据
  if (settingsActiveSection === 'model') await renderSettingsModelSection();
  else if (settingsActiveSection === 'behavior') renderSettingsBehaviorSection();
  else if (settingsActiveSection === 'appearance') renderSettingsAppearanceSection();
  else renderSettingsAboutSection();
}

/** 左侧分类导航只建一次。 */
function ensureSettingsNav(): void {
  if (!settingsNav || settingsNav.querySelector('.settings-nav-item')) return;
  for (const section of SETTINGS_SECTIONS) {
    const button = document.createElement('button');
    button.className = 'settings-nav-item';
    button.dataset.section = section.id;
    button.setAttribute('role', 'tab');
    button.innerHTML = `<span class="settings-nav-icon">${icon(section.icon)}</span><span>${t(section.labelKey)}</span>`;
    button.title = t(section.descKey);
    button.addEventListener('click', () => { settingsActiveSection = section.id; void renderSettingsSection(); });
    settingsNav.append(button);
  }
}

function openSettings(section?: SettingsSectionId): void {
  ensureSettingsNav();
  if (section) settingsActiveSection = section;
  settingsModal?.classList.remove('hidden');
  settingsButton?.setAttribute('aria-expanded', 'true');
  void (async () => {
    await refreshModelList();
    try { settingsState = await window.mocodeWork.getSettings(); }
    catch (error) { console.error('[settings]', error); settingsState = {}; }
    await renderSettingsSection();
  })();
}
function closeSettings(): void {
  settingsModal?.classList.add('hidden');
  settingsButton?.setAttribute('aria-expanded', 'false');
}

settingsButton?.addEventListener('click', () => {
  if (settingsModal?.classList.contains('hidden') ?? true) openSettings();
  else closeSettings();
});
$('#settings-close')?.addEventListener('click', closeSettings);
settingsModal?.addEventListener('click', (event) => { if (event.target === settingsModal) closeSettings(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsModal?.classList.contains('hidden')) closeSettings();
});
refreshThemeSegmented();
// 主题色:index.html 的首屏脚本已按 localStorage 落过一次,这里再对齐一遍并刷新色板选中态。
document.documentElement.dataset.accent = currentAccent();
refreshAccentChips();

/* ── Sidebar collapse ─────────────────────────────────── */
// 关键:不依赖 #sidebar-toggle 引用,也不依赖 button 元素 —— 改用 data-attr + 事件代理 + 每次现查 DOM,
// 这样即便 setIcon() 后续又把 button 替换成 svg (或任何原因 DOM 变了) 也不会失效。
const SIDEBAR_KEY = 'mocode-work-sidebar';
const COLLAPSED_PROJECTS_KEY = 'mocode-work-collapsed-projects';
const COLLAPSED_SECTIONS_KEY = 'mocode-work-collapsed-sections';
const SIDEBAR_TOGGLE_SEL = '[data-sidebar-toggle]';
const appBody = document.querySelector('.app-body') as HTMLElement;
function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  if (!appBody) return;
  appBody.classList.toggle('sidebar-collapsed', collapsed);
  // 每次重新查 —— 永远拿到当前 DOM 里真实的 button (即使是 setIcon 替换过的新 svg 也照样能找到)
  document.querySelectorAll<HTMLElement>(SIDEBAR_TOGGLE_SEL).forEach((btn) => {
    btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    btn.title = collapsed ? t('sidebar.expand') : t('sidebar.collapse');
    btn.setAttribute('aria-label', collapsed ? t('sidebar.expand') : t('sidebar.collapse'));
  });
  if (persist) { try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch { /* 忽略 */ } }
}
function persistCollapsedProjects(): void {
  try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsedProjects])); } catch { /* 忽略 */ }
}
function persistCollapsedSections(): void {
  try { localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsedSections])); } catch { /* 忽略 */ }
}
function toggleSidebar(): void {
  const next = !(appBody?.classList.contains('sidebar-collapsed') ?? false);
  console.log('[sidebar] toggle ->', next ? 'collapse' : 'expand');
  setSidebarCollapsed(next);
}
// 主路径:document 上的事件代理(click + pointerdown 双重保险,捕获阶段)
// 不用 closest('#sidebar-toggle') —— 改用 data-sidebar-toggle 属性,button 被 setIcon 替换后属性也跟着丢,
// 但我们绑在 document 上,即使中间元素换了也不影响冒泡。
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && target.closest && target.closest(SIDEBAR_TOGGLE_SEL)) {
    event.preventDefault();
    toggleSidebar();
  }
}, true);
document.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && target.closest && target.closest(SIDEBAR_TOGGLE_SEL)) {
    event.preventDefault();
    toggleSidebar();
  }
}, true);
// 启动时恢复用户上次的偏好
try { if (localStorage.getItem(SIDEBAR_KEY) === '1') setSidebarCollapsed(true, false); } catch { /* 忽略 */ }
try {
  const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
  if (raw) collapsedProjects = new Set<string>(JSON.parse(raw) as string[]);
} catch { /* 忽略 */ }
try {
  const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
  if (raw) collapsedSections = new Set<string>(JSON.parse(raw) as string[]);
} catch { /* 忽略 */ }
/* ── Sidebar resize (拖拽调宽度) ───────────────────────── */
const SIDEBAR_WIDTH_KEY = 'mocode-work-sidebar-width';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 240;
const sidebarResize = $('#sidebar-resize') as HTMLElement;
function applySidebarWidth(width: number): void {
  if (!appBody) return;
  // 只设 CSS var;不要 inline 改 .sidebar.width —— 窄屏 @media 媒体查询的 56px
  // 会跟 var 一起被 CSS 解析,媒体查询后定义会赢,所以窄屏下不会被用户拖动覆盖。
  appBody.style.setProperty('--sidebar-width', `${width}px`);
}
function getSavedSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
    }
  } catch { /* 忽略 */ }
  return SIDEBAR_DEFAULT;
}
function saveSidebarWidth(width: number): void {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch { /* 忽略 */ }
}
// 启动时恢复
applySidebarWidth(getSavedSidebarWidth());
// 拖拽
if (sidebarResize) {
  let resizing = false;
  let startX = 0;
  let startWidth = SIDEBAR_DEFAULT;
  sidebarResize.addEventListener('pointerdown', (event) => {
    resizing = true;
    startX = event.clientX;
    const sidebar = appBody?.querySelector<HTMLElement>('.sidebar');
    startWidth = sidebar?.offsetWidth ?? SIDEBAR_DEFAULT;
    try { sidebarResize.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    document.body.classList.add('sidebar-resizing');
    event.preventDefault();
  });
  sidebarResize.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    const delta = event.clientX - startX;
    const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + delta));
    applySidebarWidth(next);
  });
  const endResize = (event: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    try { sidebarResize.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
    document.body.classList.remove('sidebar-resizing');
    // 持久化最终宽度
    const sidebar = appBody?.querySelector<HTMLElement>('.sidebar');
    if (sidebar) saveSidebarWidth(sidebar.offsetWidth);
  };
  sidebarResize.addEventListener('pointerup', endResize);
  sidebarResize.addEventListener('pointercancel', endResize);
  // 双击 reset 到默认宽度
  sidebarResize.addEventListener('dblclick', () => {
    applySidebarWidth(SIDEBAR_DEFAULT);
    saveSidebarWidth(SIDEBAR_DEFAULT);
  });
}
/* ── Model picker ─────────────────────────────────────── */
let modelPickerEl: HTMLElement | null = null;
let modelList: ModelItem[] = [];
/** 最近一次 getConfig 的结果 —— 切语言时用它原地重画按钮（不再多发一次 IPC）。 */
let lastModelConfig: ModelConfig | null = null;

function shortModelName(text: string): string {
  if (!text) return t('composer.noModel');
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

function setModeButton(config: ModelConfig): void {
  lastModelConfig = config;
  const button = $('#mode-button');
  if (!button) return;
  const display = config.label || config.model;
  const label = config.model ? shortModelName(display) : t('composer.noModel');
  // 按钮上只留模型名（+ anthropic 的 cache 标记）；协议/openai 之类的信息挪进 title 与下拉列表，别占按钮宽度。
  const cacheBadge = config.provider === 'anthropic' && config.promptCache
    ? '<span class="model-picker-cache">cache</span>'
    : '';
  button.innerHTML = `<span class="mode-label">${escapeHtml(label)}</span>${cacheBadge}<svg class="icon icon-inline" data-icon="chevron-down"></svg>`;
  mountIcons(button);
  const detail = [
    config.model ? `${t('modelDetail.alias')}: ${config.model}` : null,
    config.label && config.label !== config.model ? `${t('settings.model')}: ${config.label}` : null,
    `${t('modelDetail.protocol')}: ${config.provider}`,
    config.provider === 'anthropic' ? t('toast.promptCache', { details: config.promptCache ? 'on' : 'off' }) : null,
    config.baseUrl ? `API: ${config.baseUrl}` : null,
    config.contextWindow ? `${t('modelDetail.context')}: ${(config.contextWindow / 1000).toFixed(0)}k tokens` : null,
  ].filter(Boolean).join('\n');
  button.title = detail || t('composer.switchModel');
}

/** 切语言后原地重画模型按钮（title / 未配置文案都带语言）。 */
function setModeButtonFromCache(): void {
  if (lastModelConfig) setModeButton(lastModelConfig);
}

/** 下拉开着的话按新语言重画（分组名 / 行内元信息都本地化）。 */
function renderModelPickerIfOpen(): void {
  if (modelPickerEl && !modelPickerEl.classList.contains('hidden')) {
    renderModelPicker();
    positionModelPicker();
  }
}

async function refreshModelList(): Promise<void> {
  try { modelList = await window.mocodeWork.listModels(); }
  catch (error) { modelList = []; console.error('[models]', error); }
}

function ensureModelPicker(): HTMLElement {
  if (modelPickerEl) return modelPickerEl;
  const el = $('#model-picker') as HTMLElement;
  modelPickerEl = el;
  return el;
}

/* 下拉里的模型行：组头已经给了提供商，行内只留预设别名/上下文/cache，避免重复占宽。 */
function modelPickerItem(model: ModelItem): string {
  const meta = [
    `<span class="model-picker-alias">${t('picker.alias', { name: escapeHtml(model.name) })}</span>`,
    model.contextWindow ? `<span class="model-picker-ctx">${(model.contextWindow / 1000).toFixed(0)}k ${t('modelDetail.context')}</span>` : '',
    model.provider === 'anthropic' && model.promptCache ? '<span class="model-picker-cache">cache</span>' : '',
  ].filter(Boolean).join('');
  return `
    <button class="model-picker-item ${model.isActive ? 'active' : ''}" data-model="${escapeHtml(model.name)}" role="option" aria-selected="${model.isActive}" title="${escapeHtml(model.label)}">
      <span class="model-picker-radio">${model.isActive ? icon('check') : ''}</span>
      <span class="model-picker-body">
        <span class="model-picker-name">${escapeHtml(model.label)}</span>
        <span class="model-picker-meta">${meta}</span>
      </span>
    </button>`;
}

function renderModelPicker(): void {
  const el = ensureModelPicker();
  if (!modelList.length) {
    el.innerHTML = `<div class="model-picker-empty">${icon('warn')}<span>${t('settings.noModelPresets')}</span></div><div class="model-picker-hint">${t('picker.hint')}</div><div class="model-picker-foot"><button class="model-picker-add" id="picker-add-model">${icon('plus')}<span>${t('settings.addModel')}</span></button></div>`;
    el.querySelector<HTMLButtonElement>('#picker-add-model')?.addEventListener('click', () => {
      hideModelPicker();
      openSettings('model');
      openModelForm();
    });
    return;
  }
  const groups = groupModelsByProvider(modelList);
  el.innerHTML = `
    <div class="model-picker-head">
      <span>${t('picker.selectModel')}</span>
      <span class="model-picker-count">${t('picker.count', { groups: groups.length, models: modelList.length })}</span>
    </div>
    <div class="model-picker-list" role="listbox">
      ${groups.map((group) => `
        <div class="model-picker-group">
          <div class="model-picker-group-head">
            <span class="model-picker-group-mark">${escapeHtml(providerInitial(group.name))}</span>
            <b>${escapeHtml(group.name)}</b>
            ${groupHostLabel(group) ? `<span class="model-picker-group-host" title="${escapeHtml(group.host)}">${escapeHtml(groupHostLabel(group))}</span>` : ''}
          </div>
          ${group.items.map(modelPickerItem).join('')}
        </div>
      `).join('')}
    </div>
    <div class="model-picker-foot">
      <button class="model-picker-add" id="picker-add-model">${icon('plus')}<span>${t('settings.addModel')}</span></button>
      <button class="model-picker-add" id="picker-manage-model">${icon('wrench')}<span>${t('picker.manage')}</span></button>
    </div>
  `;
  el.querySelector<HTMLButtonElement>('#picker-add-model')?.addEventListener('click', () => {
    hideModelPicker();
    openSettings('model');
    openModelForm();
  });
  // 「管理」= 打开设置到模型页：那里有每个预设的编辑入口（下拉本身太窄，塞不下编辑按钮）。
  el.querySelector<HTMLButtonElement>('#picker-manage-model')?.addEventListener('click', () => {
    hideModelPicker();
    openSettings('model');
  });
  el.querySelectorAll<HTMLButtonElement>('.model-picker-item').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.model;
      if (!name) return;
      const wasActive = button.classList.contains('active');
      hideModelPicker();
      if (wasActive) return;
      const result = await window.mocodeWork.switchModel(name);
      if (result.ok) {
        showToast('success', result.message);
        await refreshModelList();
        renderModelPicker();
        const config = await window.mocodeWork.getConfig();
        setModeButton(config);
      } else {
        showToast('error', result.message);
      }
    });
  });
}

/* 把下拉锚定在**模型按钮**正上方，而不是 .composer-area 那一整条。CSS 的
 * `right: 0; bottom: calc(100% + 6px)` 只能贴着 area 的右内沿（= 窗口右边缘，
 * 因为 .composer-area 横向 padding 是 --gutter-x），于是面板会飘到输入卡右外侧。
 * 这里按按钮实测 rect 反算偏移：绝对定位的基准是包含块(.composer-area)的 padding box，
 * 无边框时其右/下沿就等于 areaRect.right/bottom。
 * 不写成 CSS 常量是因为空态那条输入卡走 --empty-col-w 居中，右边界随窗口宽变化。 */
const PICKER_ANCHOR_GAP = 6;
function positionModelPicker(): void {
  const el = ensureModelPicker();
  const button = $('#mode-button') as HTMLElement | null;
  const area = el.parentElement;
  if (!button || !area) return;
  const btnRect = button.getBoundingClientRect();
  const areaRect = area.getBoundingClientRect();
  el.style.right = `${Math.max(0, areaRect.right - btnRect.right)}px`;
  const bottom = areaRect.bottom - btnRect.top + PICKER_ANCHOR_GAP;
  el.style.bottom = `${Math.max(0, bottom)}px`;
  // 上方空间不够时收窄面板，避免顶出窗口（空态输入卡在视口中央时尤其要注意）。
  const room = Math.max(140, btnRect.top - PICKER_ANCHOR_GAP - 12);
  el.style.maxHeight = `${Math.min(320, room)}px`;
}

function showModelPicker(): void {
  const el = ensureModelPicker();
  el.classList.remove('hidden');
  positionModelPicker();
  $('#mode-button')?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => el.classList.add('model-picker-in'));
}
function hideModelPicker(): void {
  const el = ensureModelPicker();
  el.classList.remove('model-picker-in');
  el.classList.add('hidden');
  $('#mode-button')?.setAttribute('aria-expanded', 'false');
}

$('#mode-button')?.addEventListener('click', async (event) => {
  event.stopPropagation();
  const el = ensureModelPicker();
  if (!el.classList.contains('hidden')) { hideModelPicker(); return; }
  hideWorkspacePicker();
  await refreshModelList();
  renderModelPicker();
  showModelPicker();
});
document.addEventListener('click', (event) => {
  if (!modelPickerEl || modelPickerEl.classList.contains('hidden')) return;
  const target = event.target as Node;
  if (modelPickerEl.contains(target)) return;
  if ($('#mode-button')?.contains(target)) return;
  hideModelPicker();
});

// init:刷新按钮显示当前模型 + 预热模型列表
void (async () => {
  try {
    const config = await window.mocodeWork.getConfig();
    // 语言来源优先级:localStorage(用户在本机切过) > ~/.mocode/config 的 MOCODE_LANGUAGE。
    // 必须在 setModeButton 之前跑 —— 否则首屏会先用旧语言渲染一遍再做一次重绘。
    initLangFromConfig(config.language);
    document.documentElement.lang = getLang();
    applyStaticI18n();
    setModeButton(config);
    await refreshModelList();
  } catch (error) { console.error('[config]', error); }
})();
searchInput.addEventListener('input', () => refreshSearch(searchInput.value));
searchPanel.addEventListener('click', (event) => { if (event.target === searchPanel) searchPanel.classList.add('hidden'); });
sendButton.addEventListener('click', () => void submit());
promptInput.addEventListener('input', resizePrompt);
promptInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } });
window.addEventListener('resize', () => {
  if (modelPickerEl && !modelPickerEl.classList.contains('hidden')) positionModelPicker();
});
window.addEventListener('keydown', (event) => {
  const cmd = event.ctrlKey || event.metaKey;
  // ? 打开 cheatsheet(Shift + / 在大多数键盘上是 ?)
  if (event.key === '?' && !(event.target instanceof HTMLElement && (event.target.matches('input, textarea') || event.target.isContentEditable))) { event.preventDefault(); cheatsheetEl?.classList.contains('hidden') ? showCheatsheet() : hideCheatsheet(); return; }
  if (event.key === 'Escape') {
    if (!cheatsheetEl?.classList.contains('hidden')) { hideCheatsheet(); return; }
    if (!searchOverlay?.classList.contains('hidden')) { closeConvSearch(); return; }
    if (modelPickerEl && !modelPickerEl.classList.contains('hidden')) { hideModelPicker(); return; }
    searchPanel.classList.add('hidden'); approvalPanel.classList.add('hidden');
    return;
  }
  if (cmd && event.key.toLowerCase() === 'k') { event.preventDefault(); searchPanel.classList.remove('hidden'); searchInput.value = ''; searchInput.focus(); refreshSearch(); return; }
  if (cmd && event.key.toLowerCase() === '/') {
    event.preventDefault();
    showToast('info', t('toast.assistantMode'));
    return;
  }
  if (cmd && event.key === '.') {
    event.preventDefault();
    const viewing = viewingTaskId();
    if (isRunning(viewing)) { window.mocodeWork.send({ type: 'cancel', id: viewing }); showToast('info', t('toast.stoppedTask')); }
    return;
  }
  if (cmd && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    if (!conversation.querySelector('.message')) { showToast('info', t('toast.noConvSearch')); return; }
    openConvSearch();
    return;
  }
  if (cmd && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (cmd && event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    void startNewTask();
    return;
  }
});

window.mocodeWork.onAgentEvent(handleAgentEvent);
window.mocodeWork.onState((next) => updateState(next));
void window.mocodeWork.getState().then(updateState);

// 状态行按需出现:空闲时不存在,不预建占位节点(空态下 .conversation 也是隐藏的)。

// Empty state hint chips
document.querySelectorAll<HTMLButtonElement>('.empty-hint').forEach((button) => {
  button.addEventListener('click', () => {
    const hint = button.dataset.hint;
    switch (hint) {
      case 'new-task': $('#new-task').click(); break;
      case 'cheatsheet': showCheatsheet(); break;
      case 'search': openConvSearch(); break;
    }
  });
});

// 末尾再 mount 一次,覆盖在 init 中通过 innerHTML 注入的 [data-icon](例如动态插的 SVG 占位)。
mountIcons();

/* ── 空状态 chip：工作空间下拉（选已有空间 / 打开新空间） ── */
let workspacePickerEl: HTMLElement | null = null;

/**
 * chip 反映的是**当前任务**的归属，而非全局浏览上下文 ——
 * 它挂在输入区正下方，用户读作「这个任务在哪个目录里干活」。
 * 当前任务已开始运行（有 session）时不可改：host 的 cwd 与会话历史都已按旧目录固化。
 */
function chipTask(): Task | undefined { return selectedTask(); }
function chipTaskFixed(): boolean {
  const task = chipTask();
  return !!task && (!!task.sessionId || task.status === 'running' || task.status === 'waiting');
}
function renderEmptyChips(): void {
  const task = chipTask();
  const project = task?.projectId ? state?.projects.find((p) => p.id === task.projectId) : undefined;
  const label = $('#empty-chip-project .empty-chip-label');
  const chip = $('#empty-chip-project');
  // 无任务在编辑（例如刚启动、还没选中任务）→ 退化成全局浏览上下文的展示。
  const fallback = state?.projects.find((p) => p.id === state?.selectedProjectId);
  const name = task ? (project?.name ?? t('workspace.none')) : (fallback?.name ?? t('workspace.selectSpace'));
  if (label) label.textContent = name;
  if (chip) {
    chip.classList.toggle('is-noworkspace', !!task && !project);
    chip.title = chipTaskFixed()
      ? t('workspace.fixedNote')
      : task ? t('workspace.chipHint') : t('workspace.clickToSelect');
    chip.setAttribute('aria-disabled', chipTaskFixed() ? 'true' : 'false');
  }
}

function workspacePicker(): HTMLElement | null {
  if (!workspacePickerEl) workspacePickerEl = $('#workspace-picker') as HTMLElement | null;
  return workspacePickerEl;
}

function renderWorkspacePicker(): void {
  const el = workspacePicker();
  if (!el) return;
  const projects = state?.projects ?? [];
  const task = chipTask();
  const currentId = task?.projectId ?? '';
  const fixed = chipTaskFixed();
  // 选中项 = 任务当前的归属空间；纯任务则选中「不使用工作空间」那一行。
  const items = projects.length
    ? projects.map((project) => `
        <button class="chip-picker-item ${project.id === currentId ? 'active' : ''}" data-workspace="${escapeHtml(project.id)}" role="option" aria-selected="${project.id === currentId}"${fixed ? ' disabled' : ''}>
          <span class="chip-picker-check">${project.id === currentId ? icon('check') : ''}</span>
          <span class="chip-picker-body">
            <span class="chip-picker-name">${escapeHtml(project.name)}</span>
            <span class="chip-picker-path" title="${escapeHtml(project.root)}">${escapeHtml(project.root)}</span>
          </span>
        </button>`).join('')
    : `<div class="chip-picker-empty">${t('workspace.noWorkspaces')}</div>`;
  const noWorkspaceRow = task ? `
      <button class="chip-picker-item ${currentId ? '' : 'active'}" data-workspace-clear role="option" aria-selected="${!currentId}"${fixed ? ' disabled' : ''}>
        <span class="chip-picker-check">${currentId ? '' : icon('check')}</span>
        <span class="chip-picker-body">
          <span class="chip-picker-name">${t('menu.noWorkspace')}</span>
          <span class="chip-picker-path">${t('workspace.pureTask')}</span>
        </span>
      </button>
      ${projects.length ? '<div class="chip-picker-divider"></div>' : ''}` : '';
  el.innerHTML = `
    <div class="chip-picker-head"><span>${task ? t('workspace.taskWorkspace') : t('workspace.title')}</span><span class="chip-picker-count">${t('workspace.count', { n: projects.length })}</span></div>
    <div class="chip-picker-list" role="listbox">${noWorkspaceRow}${items}</div>
    <div class="chip-picker-foot">
      ${fixed
        ? `<div class="chip-picker-note">${t('workspace.fixedNote')}</div>`
        : `<button class="chip-picker-item chip-picker-new" data-workspace-open>
        <span class="chip-picker-check">${icon('folder')}</span>
        <span class="chip-picker-body">
          <span class="chip-picker-name">${t('workspace.openNew')}</span>
          <span class="chip-picker-path">${t('workspace.pickFolder')}</span>
        </span>
      </button>`}
    </div>
  `;

  /** 归属变更后重新拉起当前任务（新 cwd 的 host + 会话区重放）。 */
  const applyProject = async (projectId: string, okMessage: string): Promise<void> => {
    const current = chipTask();
    if (!current) return;
    const result = await window.mocodeWork.setTaskProject(current.id, projectId);
    if (!result.ok) { showToast('warn', result.message ?? t('toast.cannotChangeWorkspace')); return; }
    if (result.state) updateState(result.state);
    const selected = await window.mocodeWork.selectTask(current.id);
    if (selected) { updateState(selected.state); switchToTask(selected.task.id, selected.history); }
    showToast('success', okMessage);
  };

  el.querySelectorAll<HTMLButtonElement>('[data-workspace]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.workspace;
      hideWorkspacePicker();
      if (!id || id === currentId) return;
      const project = state?.projects.find((p) => p.id === id);
      await applyProject(id, t('toast.associated', { name: project?.name ?? id }));
    });
  });
  el.querySelector<HTMLButtonElement>('[data-workspace-clear]')?.addEventListener('click', async () => {
    hideWorkspacePicker();
    if (!currentId) return;
    await applyProject('', t('toast.unassociated'));
  });
  el.querySelector<HTMLButtonElement>('[data-workspace-open]')?.addEventListener('click', async () => {
    hideWorkspacePicker();
    try {
      const next = await window.mocodeWork.pickProject();
      if (next) { updateState(next); showToast('success', t('toast.openedWorkspace')); }
    } catch (error) { showToast('error', (error as Error).message); }
  });
}

function showWorkspacePicker(): void {
  const el = workspacePicker();
  if (!el) return;
  el.classList.remove('hidden');
  $('#empty-chip-project')?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => el.classList.add('chip-picker-in'));
}
function hideWorkspacePicker(): void {
  const el = workspacePicker();
  if (!el || el.classList.contains('hidden')) return;
  el.classList.remove('chip-picker-in');
  el.classList.add('hidden');
  $('#empty-chip-project')?.setAttribute('aria-expanded', 'false');
}

$('#empty-chip-project')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const el = workspacePicker();
  if (!el) return;
  if (!el.classList.contains('hidden')) { hideWorkspacePicker(); return; }
  hideModelPicker();
  renderWorkspacePicker();
  showWorkspacePicker();
});
document.addEventListener('click', (event) => {
  const el = workspacePicker();
  if (!el || el.classList.contains('hidden')) return;
  const target = event.target as Node;
  if (el.contains(target) || $('#empty-chip-project')?.contains(target)) return;
  hideWorkspacePicker();
});
