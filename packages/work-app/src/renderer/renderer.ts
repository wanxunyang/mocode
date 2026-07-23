import { renderMarkdown, enhanceCodeBlocks } from './markdown.js';
import { mountIcons, icon } from './icons.js';

export {};

type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type Project = { id: string; name: string; root: string; branch: string };
type Task = { id: string; projectId: string; title: string; status: TaskStatus; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string };
type WorkState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };
type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type HistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string };
type Attachment = { name: string; dataUrl: string };

declare global {
  interface Window {
    mocodeWork: {
      getState: () => Promise<WorkState>;
      pickProject: () => Promise<WorkState | null>;
      selectProject: (id: string) => Promise<WorkState>;
      createTask: (title: string) => Promise<{ state: WorkState; task: Task }>;
      selectTask: (id: string) => Promise<{ state: WorkState; task: Task; history: HistoryItem[] } | null>;
      clearTasks: () => Promise<WorkState>;
      deleteTask: (id: string) => Promise<WorkState | null>;
      projectOverview: () => Promise<Record<string, unknown>>;
      readFile: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      fileDiff: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      pullRequests: () => Promise<Record<string, unknown>>;
      pickAttachment: () => Promise<Attachment | null>;
      getConfig: () => Promise<{ model: string; baseUrl: string; contextWindow: number | null; language: string; theme: string }>;
      setTheme: (theme: 'light' | 'dark') => void;
      send: (value: Record<string, unknown>) => void;
      onAgentEvent: (callback: (event: AgentEnvelope) => void) => () => void;
      onState: (callback: (state: WorkState) => void) => () => void;
    };
  }
}

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const projectList = $('#project-list'); const taskList = $('#task-list'); const conversation = $('#conversation');
const emptyState = $('#empty-state'); const approvalPanel = $('#approval-panel'); const promptInput = $('#prompt') as HTMLTextAreaElement;
const sendButton = $('#send-button') as HTMLButtonElement; const inspector = $('#inspector'); const inspectorContent = $('#inspector-content');
const inspectorTitle = $('#inspector-title'); const attachmentList = $('#attachment-list'); const searchPanel = $('#search-panel'); const searchInput = $('#search-input') as HTMLInputElement;

let state: WorkState | null = null;
let activeRunId: string | null = null;
let activeAssistant: HTMLElement | null = null;
let attachments: Attachment[] = [];
let activeInspectorTab: 'overview' | 'files' | 'prs' = 'overview';

function selectedProject(): Project | undefined { return state?.projects.find((project) => project.id === state?.selectedProjectId); }
function selectedTask(): Task | undefined { return state?.tasks.find((task) => task.id === state?.selectedTaskId); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!)); }
function statusText(status: TaskStatus): string { return ({ queued: '等待开始', running: '正在运行', waiting: '等待确认', completed: '已完成', failed: '运行失败', cancelled: '已停止' })[status]; }

/**
 * 把 Agent Host / LLM 流冒上来的原始错误翻成一句用户能看懂的话。
 * 屏蔽 node-fetch / undici 的 ERR_STREAM_PREMATURE_CLOSE、网络断开、JSON 解析栈等
 * 内部噪音,只保留"重试/换模型/查配置"这类可执行建议。
 */
function humanizeError(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/Premature close|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(text)) {
    return '与 AI 服务的连接中断了，请稍后重试或检查网络/模型配置。';
  }
  if (/Invalid Mocode Work host command|Invalid JSON command|输出格式错误/.test(text)) {
    return 'Agent Host 输出了无法识别的数据，请重试一次。';
  }
  if (/Session .* could not be restored/.test(text)) return `历史会话丢失，已开启新会话。`;
  if (/already active/.test(text)) return '当前还有任务在跑，请先等它结束或点停止。';
  if (/Approval request has expired/.test(text)) return '上一次的确认请求已过期，请重新发起任务。';
  if (/Agent Host 未构建/.test(text)) return 'Agent Host 还没有构建，请先在 mocode 仓库根目录运行 npm run build。';
  if (/Agent Host 尚未就绪/.test(text)) return 'Agent Host 还没准备好，请稍候再发。';
  if (/LLM_BASE_URL|LLM_API_KEY|baseURL|apiKey/i.test(text)) return '模型未配置：请运行 /model 或设置 LLM_BASE_URL / LLM_API_KEY 后重试。';
  // 命中的是用户已经能看懂的原文,直接展示
  return text;
}

function renderProjects(): void {
  const current = state; if (!current) return;
  const folder = icon('folder');
  const folderOpen = icon('folder-open');
  projectList.innerHTML = current.projects.map((project) => {
    const isSelected = project.id === current.selectedProjectId;
    return `<button class="project-item ${isSelected ? 'selected' : ''}" data-project="${escapeHtml(project.id)}"><span class="folder-icon">${isSelected ? folderOpen : folder}</span><span>${escapeHtml(project.name)}</span></button>`;
  }).join('');
  projectList.querySelectorAll<HTMLButtonElement>('[data-project]').forEach((button) => button.addEventListener('click', async () => {
    const next = await window.mocodeWork.selectProject(button.dataset.project!); updateState(next); clearWorkspace();
  }));
  const project = selectedProject();
  const ctx = $('#context-project');
  if (ctx) ctx.innerHTML = `${icon('home')}<span>${escapeHtml(project?.name ?? '项目')}</span>`;
  const branch = $('#context-branch');
  if (branch) branch.innerHTML = `${icon('branch')}<span>${escapeHtml(project?.branch ?? '本地')}</span>`;
}

function renderTasks(): void {
  const current = state; if (!current) return;
  const tasks = current.tasks.filter((task) => task.projectId === current.selectedProjectId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  taskList.innerHTML = tasks.length ? tasks.map((task) => {
    const id = escapeHtml(task.id);
    const deleteTitle = task.status === 'running' || task.status === 'waiting' ? '停止并删除任务' : '删除任务';
    // 正在跑 / 等待中的任务,状态文字始终显示;其余 hover 才显示
    const alwaysShow = task.status === 'running' || task.status === 'waiting' || task.id === current.selectedTaskId;
    return `<div class="task-item ${task.status} ${task.id === current.selectedTaskId ? 'selected' : ''}" data-task-id="${id}"><button class="task-open" data-task="${id}" title="打开 ${escapeHtml(task.title)}"><span class="task-spark">${icon('sparkles')}</span><span class="task-copy"><b>${escapeHtml(task.title)}</b><small ${alwaysShow ? 'data-always="1"' : ''}>${statusText(task.status)}</small></span><span class="task-dot"></span></button><button class="task-delete" data-delete-task="${id}" aria-label="${deleteTitle} ${escapeHtml(task.title)}" title="${deleteTitle}">${icon('close')}</button></div>`;
  }).join('') : '<p class="empty-tasks">无任务</p>';
  taskList.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((button) => button.addEventListener('click', () => void openTask(button.dataset.task!)));
  taskList.querySelectorAll<HTMLButtonElement>('[data-delete-task]').forEach((button) => button.addEventListener('click', () => {
    const taskId = button.dataset.deleteTask!;
    const task = state?.tasks.find((item) => item.id === taskId);
    if (task && (task.status === 'running' || task.status === 'waiting')) {
      showToast('info', `正在停止任务 “${task.title}”…`);
    }
    void deleteTask(taskId);
  }));
  const running = tasks.filter((task) => task.status === 'running' || task.status === 'waiting').length;
  const total = tasks.length;
  $('#usage').textContent = total ? `${total} 任务${running ? ` · ${running} 运行中` : ''}` : '0%';
}

function updateState(next: WorkState): void { state = next; renderProjects(); renderTasks(); }
function clearWorkspace(): void { conversation.innerHTML = ''; emptyState.classList.remove('hidden'); activeAssistant = null; activeRunId = null; attachments = []; renderAttachments(); }

function addMessage(kind: 'user' | 'assistant', text = ''): HTMLElement {
  emptyState.classList.add('hidden');
  const message = document.createElement('article'); message.className = `message ${kind}`;
  const label = kind === 'user' ? '你' : 'Mocode';
  const avatarIcon = kind === 'assistant' ? icon('spark-bot') : icon('user');
  message.innerHTML = `<div class="message-avatar">${avatarIcon}</div><div class="message-content"><div class="message-label"><span>${label}</span><div class="message-actions"></div></div><div class="message-body"></div></div>`;
  const body = message.querySelector('.message-body') as HTMLElement;
  // 助手消息流式时只放纯文本,完成后再走 markdown 渲染,避免每 chunk 重排版。
  body.textContent = text;
  conversation.append(message);
  smartScrollToBottom();
  return message;
}
const activeTools = new Map<string, HTMLDetailsElement>();

function toolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function toolCallSummary(value: unknown): string {
  const raw = toolText(value).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hint = ['path', 'file', 'command', 'query', 'pattern'].map((key) => parsed[key]).find((item) => typeof item === 'string');
    if (typeof hint === 'string') return hint.length > 100 ? `${hint.slice(0, 99)}…` : hint;
  } catch { /* Non-JSON arguments are summarized as plain text. */ }
  const compact = raw.replace(/\s+/g, ' ');
  return compact.length > 100 ? `${compact.slice(0, 99)}…` : compact;
}
function addTool(payload: Record<string, unknown>, completed = false): void {
  emptyState.classList.add('hidden');
  const id = payload.id == null ? '' : String(payload.id);
  const existing = completed && id ? activeTools.get(id) : undefined;
  const entry = existing?.isConnected ? existing : document.createElement('details');
  const isNew = !entry.isConnected;
  const name = String(payload.name ?? 'tool');
  const args = toolText(payload.arguments ?? entry.dataset.toolArguments).trim();
  const output = toolText(payload.output).trim();
  if (!completed && args) entry.dataset.toolArguments = args;
  const summary = toolCallSummary(args);
  const detail = [
    args ? `<section><span>调用</span><pre>${escapeHtml(args.slice(0, 6000))}</pre></section>` : '',
    output ? `<section><span>结果</span><pre>${escapeHtml(output.slice(0, 12000))}</pre></section>` : '',
  ].join('');

  entry.className = `tool-entry ${completed ? 'tool-done' : 'tool-running'}${detail ? '' : ' tool-empty'}`;
  entry.innerHTML = `<summary><span class="tool-state">${completed ? '●' : '◇'}</span><span class="tool-name">${escapeHtml(name)}</span>${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ''}<span class="tool-meta">${completed ? '完成' : '执行中'}</span></summary>${detail ? `<div class="tool-detail">${detail}</div>` : ''}`;
  if (completed) entry.open = false;
  if (isNew) conversation.append(entry);
  if (id) completed ? activeTools.delete(id) : activeTools.set(id, entry);
  smartScrollToBottom();
}
function appendText(text: string): void {
  // 复用当前气泡:仅当它仍是对话流末尾时(本轮尚未插入工具)。
  if (activeAssistant && activeAssistant.isConnected && activeAssistant === conversation.lastElementChild) {
    // 继续往当前气泡追加文字
  } else {
    // 新建气泡:新轮次首个气泡显示 ✦Mocode 头像;工具之后的续接气泡隐藏头像(data-continued)。
    const continued = activeAssistant && activeAssistant.isConnected;
    activeAssistant = addMessage('assistant'); activeAssistant.classList.add('is-streaming');
    if (continued) activeAssistant.dataset.continued = '1';
  }
  const body = activeAssistant.querySelector('.message-body') as HTMLElement;
  body.textContent = `${body.textContent ?? ''}${text}`;
  smartScrollToBottom();
}
function renderHistory(history: HistoryItem[]): void {
  conversation.innerHTML = ''; activeAssistant = null;
  if (!history.length) { emptyState.classList.remove('hidden'); return; }
  // 连续的 assistant 文字段视为同一轮输出:仅首段带头像,后续段标记为续接(隐藏 ✦Mocode)。
  let prevRole: HistoryItem['role'] | null = null;
  for (const item of history) {
    if (item.role === 'tool') { addTool({ name: '工具结果', output: item.text }, true); }
    else {
      const el = addMessage(item.role, item.text);
      // 历史消息(已结束)直接走 markdown 渲染
      if (item.role === 'assistant') {
        el.classList.remove('is-streaming');
        renderMessageBody(el.querySelector('.message-body') as HTMLElement, item.text);
        wireMessageActions(el, item.text);
      }
      if (item.role === 'assistant' && prevRole === 'assistant') el.dataset.continued = '1';
    }
    prevRole = item.role;
  }
}

/**
 * 把一段文本用 markdown 渲染到 .message-body 内,挂上交互。
 * 助手消息流结束后调用,以及历史消息回放时调用。
 */
function renderMessageBody(body: HTMLElement, text: string): void {
  body.classList.add('md-rendered');
  body.innerHTML = renderMarkdown(text);
  enhanceCodeBlocks(body);
}

async function openTask(taskId: string): Promise<void> {
  const workspace = await window.mocodeWork.selectTask(taskId);
  if (!workspace) return;
  updateState(workspace.state); renderHistory(workspace.history); attachments = []; renderAttachments(); promptInput.focus();
}

async function deleteTask(taskId: string): Promise<void> {
  const task = state?.tasks.find((item) => item.id === taskId);
  // 非运行中任务加一个轻量二次确认
  if (task && task.status !== 'running' && task.status !== 'waiting') {
    const ok = window.confirm(`删除任务 “${task.title}”?此操作不可撤销。`);
    if (!ok) return;
  }
  const deletingSelectedTask = state?.selectedTaskId === taskId;
  const next = await window.mocodeWork.deleteTask(taskId);
  if (!next) return;
  updateState(next);
  if (deletingSelectedTask && next.selectedTaskId !== taskId) clearWorkspace();
  showToast('info', '已删除任务');
}

function showApproval(payload: Record<string, unknown>): void {
  const approvalId = String(payload.approvalId ?? ''); const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  approvalPanel.classList.remove('hidden');
  const buttons = options.length ? options.map((option, index) => `<button data-approval="${escapeHtml(option)}" class="${index === 0 ? 'approve' : ''}">${escapeHtml(option)}</button>`).join('') : `<button data-approval="approve" class="approve">${icon('check')}确认</button>`;
  approvalPanel.innerHTML = `<div class="approval-title">${icon('warn')}<span>需要你的确认</span></div><p>${escapeHtml(String(payload.title ?? '允许此操作？'))}</p><pre>${escapeHtml(String(payload.detail ?? ''))}</pre><div class="approval-actions">${buttons}<button data-cancel>${icon('close')}拒绝</button></div>`;
  approvalPanel.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach((button) => button.addEventListener('click', () => {
    window.mocodeWork.send({ type: 'approval', approvalId, action: 'selected', value: button.dataset.approval }); approvalPanel.classList.add('hidden');
  }));
  approvalPanel.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', () => { window.mocodeWork.send({ type: 'approval', approvalId, action: 'cancelled' }); approvalPanel.classList.add('hidden'); });
}
function setRunning(running: boolean): void { sendButton.innerHTML = icon(running ? 'square' : 'paper-airplane'); sendButton.classList.toggle('stop', running); sendButton.title = running ? '停止运行 (⌘.)' : '发送 (⌘⏎)'; sendButton.setAttribute('aria-label', running ? '停止运行' : '发送'); }
function resizePrompt(): void { promptInput.style.height = 'auto'; promptInput.style.height = `${Math.min(promptInput.scrollHeight, 128)}px`; }
function renderAttachments(): void {
  attachmentList.innerHTML = attachments.map((attachment, index) => `<span class="attachment-chip">${icon('image')}<span class="attachment-name">${escapeHtml(attachment.name)}</span><button class="attachment-remove" data-attachment="${index}" title="移除" aria-label="移除附件"><svg class="icon" data-icon="close"></svg></button></span>`).join('');
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

/* ── Per-message actions (copy / regenerate / edit-resend) ── */
function wireMessageActions(message: HTMLElement, text: string): void {
  const actions = message.querySelector('.message-actions') as HTMLElement;
  if (!actions || actions.childElementCount) return;
  const isAssistant = message.classList.contains('assistant');
  const isUser = message.classList.contains('user');
  if (isAssistant) {
    actions.innerHTML = `<button data-act="copy" title="复制内容" aria-label="复制内容">${icon('copy')}</button><button data-act="regen" title="基于这条重新生成" aria-label="基于这条重新生成">${icon('regen')}</button>`;
  } else if (isUser) {
    actions.innerHTML = `<button data-act="copy" title="复制内容" aria-label="复制内容">${icon('copy')}</button><button data-act="edit" title="编辑并重新发送" aria-label="编辑并重新发送">${icon('edit')}</button>`;
  }
  actions.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(text); showToast('info', '已复制到剪贴板'); }
      catch { showToast('error', '复制失败'); }
      return;
    }
    if (act === 'regen') { void regenerate(); return; }
    if (act === 'edit') { promptInput.value = text; resizePrompt(); promptInput.focus(); return; }
  });
}

/**
 * 重新生成:从这条 assistant 之前的最后一条 user 消息,重发。
 * 删掉本条及之后的所有 assistant/tool 消息,重发。
 */
async function regenerate(): Promise<void> {
  if (activeRunId) { showToast('warn', '当前还有任务在跑,请先停止。'); return; }
  const task = selectedTask();
  if (!task?.sessionId) { showToast('warn', '这条消息没有可用的会话,无法重新生成。'); return; }
  const messages = Array.from(conversation.querySelectorAll<HTMLElement>('.message'));
  const target = activeMessage;
  if (!target) return;
  const index = messages.indexOf(target);
  let userIndex = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]!.classList.contains('user')) { userIndex = i; break; }
  }
  if (userIndex < 0) { showToast('warn', '找不到可重新生成的用户消息。'); return; }
  const userText = messages[userIndex]!.querySelector('.message-body')?.textContent ?? '';
  // 删 target 起所有后续消息(包括本条)
  for (let i = messages.length - 1; i >= index; i -= 1) messages[i]!.remove();
  // 直接重发(不再 addMessage,user 消息已经存在)
  activeRunId = task.id;
  setRunning(true);
  window.mocodeWork.send({ type: 'run', id: task.id, prompt: userText, sessionId: task.sessionId, attachments: [] });
  showToast('info', '已重新生成');
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
    ['⌘ K', '打开搜索'],
    ['⌘ /', '切换助手模式'],
    ['⌘ ⏎', '发送消息'],
    ['⇧ ⏎', '在输入框换行'],
    ['⌘ .', '停止当前任务'],
    ['⌘ F', '在对话中搜索'],
    ['Esc', '关闭弹窗 / 取消输入焦点'],
    ['?', '显示 / 隐藏此快捷键面板'],
  ];
  const overlay = document.createElement('div');
  overlay.className = 'cheatsheet hidden';
  overlay.innerHTML = `<div class="cheatsheet-card">
    <header><b>快捷键</b><button data-close title="关闭">×</button></header>
    <div class="cheatsheet-grid">${rows.map(([key, desc]) => `<div class="cheatsheet-row"><kbd>${key}</kbd><span>${desc}</span></div>`).join('')}</div>
    <footer>提示:大多数快捷键在 Mac 上是 ⌘,Windows/Linux 是 Ctrl。</footer>
  </div>`;
  document.body.append(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || (e.target as HTMLElement).dataset.close !== undefined) hideCheatsheet(); });
  cheatsheetEl = overlay;
  return overlay;
}
function showCheatsheet(): void { ensureCheatsheet()!.classList.remove('hidden'); }
function hideCheatsheet(): void { cheatsheetEl?.classList.add('hidden'); }

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
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) {
      if (file.size > 4 * 1024 * 1024) { showToast('error', `${file.name} 超过 4MB 限制`); continue; }
      if (!/^image\//.test(file.type)) { showToast('warn', `${file.name} 不是图片,已跳过`); continue; }
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      attachments.push({ name: file.name, dataUrl });
    }
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
    <input type="text" placeholder="在当前对话中搜索…" />
    <span class="conv-search-status"></span>
    <button data-prev title="上一个 (Shift+Enter)">↑</button>
    <button data-next title="下一个 (Enter)">↓</button>
    <button data-close title="关闭 (Esc)">×</button>
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
    if (!hits.length) { status.textContent = '无匹配'; return; }
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

async function submit(): Promise<void> {
  if (activeRunId) { window.mocodeWork.send({ type: 'cancel', id: activeRunId }); return; }
  const prompt = promptInput.value.trim(); if (!prompt) return;
  let task = selectedTask();
  if (!task || !task.sessionId) {
    const created = await window.mocodeWork.createTask(prompt.replace(/\s+/g, ' ').slice(0, 160)); updateState(created.state); task = created.task; conversation.innerHTML = ''; activeAssistant = null;
  }
  activeRunId = task.id; addMessage('user', prompt); promptInput.value = ''; resizePrompt(); setRunning(true);
  window.mocodeWork.send({ type: 'run', id: task.id, prompt, sessionId: task.sessionId, attachments }); attachments = []; renderAttachments();
}

function finish(): void {
  if (activeAssistant) {
    activeAssistant.classList.remove('is-streaming');
    const body = activeAssistant.querySelector('.message-body') as HTMLElement;
    const raw = body.textContent ?? '';
    renderMessageBody(body, raw);
    wireMessageActions(activeAssistant, raw);
  }
  activeRunId = null; activeAssistant = null; setRunning(false);
}
function handleAgentEvent(envelope: AgentEnvelope): void {
  if (envelope.type === 'error') {
    const message = humanizeError(envelope.error ?? '');
    if (message) { console.error('[Agent]', message); showToast('error', message); }
    finish();
    return;
  }
  const payload = envelope.payload ?? {};
  if (envelope.requestId && activeRunId && envelope.requestId !== activeRunId) return;
  switch (envelope.event) {
    case 'text_delta': appendText(String(payload.text ?? '')); break;
    case 'tool_started': addTool(payload); break;
    case 'tool_completed': addTool(payload, true); break;
    case 'validation_started':
    case 'validation_completed': break;
    case 'approval_requested': showApproval(payload); break;
    case 'run_aborted': finish(); break;
    case 'run_completed': finish(); break;
    case 'host_log': {
      const raw = String(payload.message ?? '').trim();
      if (!raw) break;
      // 内部日志只进开发者控制台，绝不进入用户对话。
      if (/^\(?node:\d+\)? \[DEP\d{4}\]/.test(raw)) break;
      console.debug('[Agent Host]', raw);
      // 关键启动 / 配置提示用 toast 提示用户(避免淹没在控制台)
      if (/Agent Host 未构建|配置缺少|连续崩溃|未找到系统 node/.test(raw)) {
        showToast('warn', raw.replace(/^\[mocode-work\]\s*/, ''), 6000);
      }
      break;
    }
    case 'run_failed': {
      const message = humanizeError(String(payload.message ?? '运行失败。'));
      if (message) { console.error('[Agent]', message); showToast('error', message, 5000); }
      finish();
      break;
    }
    case 'host_exit': {
      if (activeRunId) {
        const code = typeof payload.code === 'number' ? payload.code : null;
        console.error(`[Agent Host] 已退出（退出码 ${code ?? '?'}）`);
        finish();
      }
      break;
    }
  }
}

function openInspector(tab: 'overview' | 'files' | 'prs'): void {
  activeInspectorTab = tab; inspector.classList.remove('hidden'); void refreshInspector();
}
function setInspectorTab(tab: 'overview' | 'files' | 'prs'): void {
  activeInspectorTab = tab; document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.classList.toggle('selected', button.dataset.tab === tab));
}
function inspectorButton(label: string, action: string, path?: string): string { return `<button class="inspector-row" data-action="${action}"${path ? ` data-path="${escapeHtml(path)}"` : ''}>${escapeHtml(label)}<span>›</span></button>`; }
async function refreshInspector(): Promise<void> {
  setInspectorTab(activeInspectorTab); inspectorContent.innerHTML = '<p class="inspector-loading">正在读取…</p>';
  if (activeInspectorTab === 'overview') {
    inspectorTitle.textContent = '项目概览'; const overview = await window.mocodeWork.projectOverview();
    const status = Array.isArray(overview.status) ? overview.status.map(String) : []; const files = Array.isArray(overview.files) ? overview.files.map(String) : [];
    inspectorContent.innerHTML = `<section class="overview-card"><b>${escapeHtml(String(overview.branch ?? '本地'))}</b><span>${escapeHtml(String(overview.lastCommit ?? '尚无 Git 提交'))}</span></section><h3>工作区变更</h3>${status.length ? `<pre class="status-output">${escapeHtml(status.join('\n'))}</pre>` : '<p class="inspector-empty">工作区干净</p>'}${overview.diffStat ? `<pre class="status-output">${escapeHtml(String(overview.diffStat))}</pre>` : ''}<h3>最近文件</h3>${files.slice(0, 12).map((file) => inspectorButton(file, 'file', file)).join('') || '<p class="inspector-empty">未发现可预览的文件</p>'}`;
  } else if (activeInspectorTab === 'files') {
    inspectorTitle.textContent = '文件'; const overview = await window.mocodeWork.projectOverview(); const files = Array.isArray(overview.files) ? overview.files.map(String) : [];
    inspectorContent.innerHTML = files.map((file) => inspectorButton(file, 'file', file)).join('') || '<p class="inspector-empty">未发现可预览的文件</p>';
  } else {
    inspectorTitle.textContent = '拉取请求'; const result = await window.mocodeWork.pullRequests();
    const items = Array.isArray(result.items) ? result.items as Array<{ number?: number; title?: string; state?: string; headRefName?: string; url?: string }> : [];
    inspectorContent.innerHTML = result.available ? (items.length ? items.map((item) => `<a class="pr-row" href="${escapeHtml(String(item.url ?? '#'))}"><b>#${item.number ?? ''} ${escapeHtml(String(item.title ?? '未命名 PR'))}</b><span>${escapeHtml(String(item.state ?? ''))} · ${escapeHtml(String(item.headRefName ?? ''))}</span></a>`).join('') : '<p class="inspector-empty">没有打开的拉取请求</p>') : `<p class="inspector-empty">${escapeHtml(String(result.message ?? 'GitHub CLI 不可用。'))}</p>`;
  }
  inspectorContent.querySelectorAll<HTMLButtonElement>('[data-action="file"]').forEach((button) => button.addEventListener('click', () => void previewFile(button.dataset.path!)));
}
async function previewFile(file: string): Promise<void> {
  const [content, diff] = await Promise.all([window.mocodeWork.readFile(file), window.mocodeWork.fileDiff(file)]); inspectorTitle.textContent = file;
  inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-files">← 文件</button><button id="show-diff">Git Diff</button></div><pre class="file-preview">${escapeHtml(content.error ?? content.content ?? '')}</pre>`;
  $('#back-to-files').addEventListener('click', () => { activeInspectorTab = 'files'; void refreshInspector(); });
  $('#show-diff').addEventListener('click', () => { inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-files">← 文件</button></div><pre class="file-preview diff-preview">${escapeHtml(diff.error ?? diff.content ?? '')}</pre>`; $('#back-to-files').addEventListener('click', () => void previewFile(file)); });
}

function refreshSearch(query = ''): void {
  if (!state) return; const needle = query.trim().toLocaleLowerCase();
  const projects = state.projects.filter((project) => project.name.toLocaleLowerCase().includes(needle)); const tasks = state.tasks.filter((task) => task.title.toLocaleLowerCase().includes(needle));
  const projectResults = projects.map((project) => `<button data-search-project="${escapeHtml(project.id)}">项目 · ${escapeHtml(project.name)}</button>`).join('');
  const taskResults = tasks.map((task) => `<button data-search-task="${escapeHtml(task.id)}">任务 · ${escapeHtml(task.title)}</button>`).join('');
  $('#search-results').innerHTML = projectResults || taskResults ? `${projectResults}${taskResults}` : '<p>无匹配结果</p>';
  document.querySelectorAll<HTMLButtonElement>('[data-search-project]').forEach((button) => button.addEventListener('click', async () => { updateState(await window.mocodeWork.selectProject(button.dataset.searchProject!)); searchPanel.classList.add('hidden'); }));
  document.querySelectorAll<HTMLButtonElement>('[data-search-task]').forEach((button) => button.addEventListener('click', () => { searchPanel.classList.add('hidden'); void openTask(button.dataset.searchTask!); }));
}

$('#add-project').addEventListener('click', async () => { const next = await window.mocodeWork.pickProject(); if (next) { updateState(next); clearWorkspace(); } });
$('#new-task').addEventListener('click', () => { if (state) updateState({ ...state, selectedTaskId: undefined }); clearWorkspace(); promptInput.focus(); });
$('#clear-task').addEventListener('click', async () => { if (activeRunId) return; updateState(await window.mocodeWork.clearTasks()); clearWorkspace(); });
$('#add-attachment').addEventListener('click', async () => { const attachment = await window.mocodeWork.pickAttachment(); if (attachment) { attachments.push(attachment); renderAttachments(); } });
$('#skill-button').addEventListener('click', () => { promptInput.value = `${promptInput.value}${promptInput.value ? '\n' : ''}请先分析现有代码和约束，然后实现并验证。`; resizePrompt(); promptInput.focus(); });
$('#toggle-inspector').addEventListener('click', () => inspector.classList.contains('hidden') ? openInspector('overview') : inspector.classList.add('hidden'));
$('#show-files').addEventListener('click', () => openInspector('files'));
$('#close-inspector').addEventListener('click', () => inspector.classList.add('hidden'));
$('#pull-requests').addEventListener('click', () => openInspector('prs'));
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => { activeInspectorTab = button.dataset.tab as 'overview' | 'files' | 'prs'; void refreshInspector(); }));
$('#search-button').addEventListener('click', () => { searchPanel.classList.remove('hidden'); searchInput.value = ''; refreshSearch(); searchInput.focus(); });
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mocode-work-theme', next); } catch { /* 无 localStorage 则仅本次生效 */ }
  window.mocodeWork.setTheme(next);
  showToast('info', `已切换到${next === 'dark' ? '黑夜' : '浅色'}主题`, 1600);
});
$('#mode-button')?.addEventListener?.('click', async () => {
  const config = await window.mocodeWork.getConfig();
  const detail = [
    config.model ? `模型: ${config.model}` : '模型: 未配置 (请在终端跑 /model)',
    config.baseUrl ? `API: ${config.baseUrl}` : null,
    config.contextWindow ? `上下文: ${(config.contextWindow / 1000).toFixed(0)}k tokens` : null,
  ].filter(Boolean).join('\n');
  showToast('info', `当前助手配置\n${detail}`, 5000);
});
void window.mocodeWork.getConfig().then((config) => {
  if (!config.model) return;
  const model = config.model.split('/').pop() ?? config.model;
  const short = model.length > 18 ? `${model.slice(0, 17)}…` : model;
  const button = $('#mode-button');
  if (button) {
    button.innerHTML = `${escapeHtml(short)} <span>⌄</span>`;
    button.title = `${config.model}\nAPI: ${config.baseUrl || '未知'}\n上下文: ${config.contextWindow ? `${(config.contextWindow / 1000).toFixed(0)}k` : '默认'}`;
  }
});
searchInput.addEventListener('input', () => refreshSearch(searchInput.value));
searchPanel.addEventListener('click', (event) => { if (event.target === searchPanel) searchPanel.classList.add('hidden'); });
sendButton.addEventListener('click', () => void submit());
promptInput.addEventListener('input', resizePrompt);
promptInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } });
window.addEventListener('keydown', (event) => {
  const cmd = event.ctrlKey || event.metaKey;
  // ? 打开 cheatsheet(Shift + / 在大多数键盘上是 ?)
  if (event.key === '?' && !(event.target instanceof HTMLElement && (event.target.matches('input, textarea') || event.target.isContentEditable))) { event.preventDefault(); cheatsheetEl?.classList.contains('hidden') ? showCheatsheet() : hideCheatsheet(); return; }
  if (event.key === 'Escape') {
    if (!cheatsheetEl?.classList.contains('hidden')) { hideCheatsheet(); return; }
    if (!searchOverlay?.classList.contains('hidden')) { closeConvSearch(); return; }
    searchPanel.classList.add('hidden'); approvalPanel.classList.add('hidden');
    return;
  }
  if (cmd && event.key.toLowerCase() === 'k') { event.preventDefault(); searchPanel.classList.remove('hidden'); searchInput.value = ''; searchInput.focus(); refreshSearch(); return; }
  if (cmd && event.key.toLowerCase() === '/') {
    event.preventDefault();
    if (activeRunId) { showToast('warn', '当前还有任务在跑,无法切换。'); return; }
    showToast('info', '助手模式: Mocode Agent (暂未开放多模型切换)');
    return;
  }
  if (cmd && event.key === '.') {
    event.preventDefault();
    if (activeRunId) { window.mocodeWork.send({ type: 'cancel', id: activeRunId }); showToast('info', '已停止当前任务'); }
    return;
  }
  if (cmd && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    if (!conversation.querySelector('.message')) { showToast('info', '当前没有对话可搜索'); return; }
    openConvSearch();
    return;
  }
});

window.mocodeWork.onAgentEvent(handleAgentEvent);
window.mocodeWork.onState((next) => updateState(next));
void window.mocodeWork.getState().then(updateState);

// Empty state hint chips
document.querySelectorAll<HTMLButtonElement>('.empty-hint').forEach((button) => {
  button.addEventListener('click', () => {
    const hint = button.dataset.hint;
    switch (hint) {
      case 'new-task': $('#new-task').click(); break;
      case 'cheatsheet': showCheatsheet(); break;
      case 'pr': $('#pull-requests').click(); break;
      case 'search': openConvSearch(); break;
    }
  });
});

// 把所有 [data-icon] 占位元素替换为 SVG
mountIcons();
