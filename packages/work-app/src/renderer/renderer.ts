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
      projectOverview: () => Promise<Record<string, unknown>>;
      readFile: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      fileDiff: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      pullRequests: () => Promise<Record<string, unknown>>;
      pickAttachment: () => Promise<Attachment | null>;
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

function renderProjects(): void {
  const current = state; if (!current) return;
  projectList.innerHTML = current.projects.map((project) => `<button class="project-item ${project.id === current.selectedProjectId ? 'selected' : ''}" data-project="${escapeHtml(project.id)}"><span class="folder-icon">▱</span><span>${escapeHtml(project.name)}</span></button>`).join('');
  projectList.querySelectorAll<HTMLButtonElement>('[data-project]').forEach((button) => button.addEventListener('click', async () => {
    const next = await window.mocodeWork.selectProject(button.dataset.project!); updateState(next); clearWorkspace();
  }));
  const project = selectedProject(); $('#context-project').textContent = `⌂ ${project?.name ?? '项目'}`; $('#context-branch').textContent = `⌘ ${project?.branch ?? '本地'}`;
}

function renderTasks(): void {
  const current = state; if (!current) return;
  const tasks = current.tasks.filter((task) => task.projectId === current.selectedProjectId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  taskList.innerHTML = tasks.length ? tasks.map((task) => `<button class="task-item ${task.status} ${task.id === current.selectedTaskId ? 'selected' : ''}" data-task="${escapeHtml(task.id)}"><span class="task-spark">✦</span><span class="task-copy"><b>${escapeHtml(task.title)}</b><small>${statusText(task.status)}</small></span><span class="task-dot"></span></button>`).join('') : '<p class="empty-tasks">无任务</p>';
  taskList.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((button) => button.addEventListener('click', () => void openTask(button.dataset.task!)));
  const running = tasks.filter((task) => task.status === 'running' || task.status === 'waiting').length;
  $('#usage').textContent = `${running ? Math.min(99, running * 20) : 0}%`;
}

function updateState(next: WorkState): void { state = next; renderProjects(); renderTasks(); }
function clearWorkspace(): void { conversation.innerHTML = ''; emptyState.classList.remove('hidden'); activeAssistant = null; activeRunId = null; attachments = []; renderAttachments(); }

function addMessage(kind: 'user' | 'assistant' | 'system', text = ''): HTMLElement {
  emptyState.classList.add('hidden');
  const message = document.createElement('article'); message.className = `message ${kind}`;
  const label = kind === 'user' ? '你' : kind === 'assistant' ? 'Mocode' : '运行时';
  message.innerHTML = `<div class="message-avatar">${kind === 'assistant' ? '✦' : kind === 'user' ? '你' : 'i'}</div><div class="message-content"><div class="message-label">${label}</div><div class="message-body"></div></div>`;
  (message.querySelector('.message-body') as HTMLElement).textContent = text; conversation.append(message); conversation.scrollTop = conversation.scrollHeight; return message;
}
function addTool(payload: Record<string, unknown>, completed = false): void {
  emptyState.classList.add('hidden'); const name = String(payload.name ?? 'tool'); const output = typeof payload.output === 'string' ? payload.output : '';
  const card = document.createElement('details'); card.className = `tool-card ${completed ? 'tool-done' : ''}`; card.open = !completed;
  card.innerHTML = `<summary><span class="tool-state">${completed ? '✓' : '↻'}</span><span>${escapeHtml(name)}</span><span class="tool-meta">${completed ? '已完成' : '正在执行'}</span></summary>${output ? `<pre>${escapeHtml(output.slice(0, 6000))}</pre>` : ''}`;
  conversation.append(card); conversation.scrollTop = conversation.scrollHeight;
}
function appendText(text: string): void {
  if (!activeAssistant) activeAssistant = addMessage('assistant'); const body = activeAssistant.querySelector('.message-body') as HTMLElement;
  body.textContent = `${body.textContent ?? ''}${text}`; conversation.scrollTop = conversation.scrollHeight;
}
function renderHistory(history: HistoryItem[]): void {
  conversation.innerHTML = ''; activeAssistant = null;
  if (!history.length) { emptyState.classList.remove('hidden'); return; }
  history.forEach((item) => item.role === 'tool' ? addTool({ name: '工具结果', output: item.text }, true) : addMessage(item.role, item.text));
}

async function openTask(taskId: string): Promise<void> {
  const workspace = await window.mocodeWork.selectTask(taskId);
  if (!workspace) { addMessage('system', '任务正在运行，无法切换到其他项目。'); return; }
  updateState(workspace.state); renderHistory(workspace.history); attachments = []; renderAttachments(); promptInput.focus();
}

function showApproval(payload: Record<string, unknown>): void {
  const approvalId = String(payload.approvalId ?? ''); const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  approvalPanel.classList.remove('hidden');
  approvalPanel.innerHTML = `<div class="approval-title">需要你的确认</div><p>${escapeHtml(String(payload.title ?? '允许此操作？'))}</p><pre>${escapeHtml(String(payload.detail ?? ''))}</pre><div class="approval-actions">${options.map((option, index) => `<button data-approval="${escapeHtml(option)}" class="${index === 0 ? 'approve' : ''}">${escapeHtml(option)}</button>`).join('')}<button data-cancel>拒绝</button></div>`;
  approvalPanel.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach((button) => button.addEventListener('click', () => {
    window.mocodeWork.send({ type: 'approval', approvalId, action: 'selected', value: button.dataset.approval }); approvalPanel.classList.add('hidden');
  }));
  approvalPanel.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', () => { window.mocodeWork.send({ type: 'approval', approvalId, action: 'cancelled' }); approvalPanel.classList.add('hidden'); });
}
function setRunning(running: boolean): void { sendButton.textContent = running ? '■' : '↑'; sendButton.classList.toggle('stop', running); sendButton.title = running ? '停止运行' : '发送'; }
function resizePrompt(): void { promptInput.style.height = 'auto'; promptInput.style.height = `${Math.min(promptInput.scrollHeight, 128)}px`; }
function renderAttachments(): void {
  attachmentList.innerHTML = attachments.map((attachment, index) => `<span class="attachment-chip">▧ ${escapeHtml(attachment.name)}<button data-attachment="${index}" title="移除">×</button></span>`).join('');
  attachmentList.querySelectorAll<HTMLButtonElement>('[data-attachment]').forEach((button) => button.addEventListener('click', () => { attachments.splice(Number(button.dataset.attachment), 1); renderAttachments(); }));
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

function finish(): void { activeRunId = null; activeAssistant = null; setRunning(false); }
function handleAgentEvent(envelope: AgentEnvelope): void {
  if (envelope.type === 'error') { addMessage('system', envelope.error ?? 'Agent Host 发生错误。'); finish(); return; }
  const payload = envelope.payload ?? {};
  if (envelope.requestId && activeRunId && envelope.requestId !== activeRunId) return;
  switch (envelope.event) {
    case 'text_delta': appendText(String(payload.text ?? '')); break;
    case 'tool_started': addTool(payload); break;
    case 'tool_completed': addTool(payload, true); break;
    case 'validation_started': addMessage('system', `正在验证：${String(payload.command ?? '')}`); break;
    case 'validation_completed': addMessage('system', '验证完成。'); break;
    case 'approval_requested': showApproval(payload); break;
    case 'run_aborted': addMessage('system', '任务已停止。'); finish(); break;
    case 'run_completed': { const changed = Array.isArray(payload.changedFiles) ? payload.changedFiles.length : 0; if (changed) addMessage('system', `本轮完成，修改了 ${changed} 个文件。`); finish(); break; }
    case 'run_failed': addMessage('system', String(payload.message ?? '运行失败。')); finish(); break;
    case 'host_exit': if (activeRunId) { addMessage('system', 'Agent Host 已退出。'); finish(); } break;
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
searchInput.addEventListener('input', () => refreshSearch(searchInput.value));
searchPanel.addEventListener('click', (event) => { if (event.target === searchPanel) searchPanel.classList.add('hidden'); });
sendButton.addEventListener('click', () => void submit());
promptInput.addEventListener('input', resizePrompt);
promptInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { searchPanel.classList.add('hidden'); approvalPanel.classList.add('hidden'); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchPanel.classList.remove('hidden'); searchInput.focus(); refreshSearch(); } });

window.mocodeWork.onAgentEvent(handleAgentEvent);
window.mocodeWork.onState((next) => updateState(next));
void window.mocodeWork.getState().then(updateState);
