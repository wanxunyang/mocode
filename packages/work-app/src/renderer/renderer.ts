import { renderMarkdown, enhanceCodeBlocks } from './markdown.js';
import { mountIcons, icon } from './icons.js';

export {};

// 尽早把 HTML 里所有 data-icon 占位替换为 SVG,避免 first paint 看到空 icon。
mountIcons();



type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type Project = { id: string; name: string; root: string; branch: string };
type Task = { id: string; projectId: string; title: string; status: TaskStatus; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string };
type WorkState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };
type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type HistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string; name?: string; arguments?: string };
type Attachment = { name: string; dataUrl: string };
type LlmProvider = 'openai' | 'anthropic';
type ModelConfig = { model: string; label: string; provider: LlmProvider; promptCache: boolean; baseUrl: string; contextWindow: number | null; language: string; theme: string };
type ModelItem = { name: string; label: string; provider: LlmProvider; promptCache: boolean; baseURL: string; contextWindow: number; isActive: boolean };

declare global {
  interface Window {
    mocodeWork: {
      getState: () => Promise<WorkState>;
      pickProject: () => Promise<WorkState | null>;
      selectProject: (id: string) => Promise<WorkState>;
      createTask: (title: string, projectId?: string) => Promise<{ state: WorkState; task: Task }>;
      selectTask: (id: string) => Promise<{ state: WorkState; task: Task; history: HistoryItem[] } | null>;
      clearTasks: (projectId?: string) => Promise<WorkState>;
      deleteTask: (id: string) => Promise<WorkState | null>;
      renameTask: (id: string, title: string) => Promise<WorkState | null>;
      renameProject: (id: string, name: string) => Promise<WorkState | null>;
      openFolder: (projectId: string) => Promise<boolean>;
      removeProject: (projectId: string) => Promise<{ state: WorkState; removed: string } | null>;
      projectOverview: () => Promise<Record<string, unknown>>;
      readFile: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      fileDiff: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      pullRequests: () => Promise<Record<string, unknown>>;
      pickAttachment: () => Promise<Attachment | null>;
      getConfig: () => Promise<ModelConfig>;
      listModels: () => Promise<ModelItem[]>;
      switchModel: (name: string) => Promise<{ ok: boolean; message: string }>;
      listBranches: () => Promise<{ ok: boolean; message: string; current: string; branches: string[] }>;
      switchBranch: (branch: string) => Promise<{ ok: boolean; message: string; branch?: string }>;
      setTheme: (theme: 'light' | 'dark' | 'system') => void;
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
let activeInspectorTab: 'overview' | 'files' | 'prs' = 'overview';

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
}
const streams = new Map<string, TaskStream>();

function streamFor(taskId: string): TaskStream {
  let stream = streams.get(taskId);
  if (!stream) { stream = { items: [], running: false, usagePercent: null, pendingApproval: null }; streams.set(taskId, stream); }
  return stream;
}
function isRunning(taskId: string | undefined): boolean { return !!taskId && streams.get(taskId)?.running === true; }
/** 当前正在查看的任务 id(= 选中任务),事件与渲染按它路由。 */
function viewingTaskId(): string | undefined { return state?.selectedTaskId; }

function selectedProject(): Project | undefined { return state?.projects.find((project) => project.id === state?.selectedProjectId); }
function selectedTask(): Task | undefined { return state?.tasks.find((task) => task.id === state?.selectedTaskId); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]!)); }
function statusText(status: TaskStatus): string { return ({ queued: '等待开始', running: '正在运行', waiting: '等待确认', completed: '已完成', failed: '运行失败', cancelled: '已停止' })[status]; }
/** 未命名的任务（新建后还没发第一条指令）在侧栏显示占位标题。 */
function taskTitle(task: Task): string { return task.title.trim() || '新任务'; }

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
  const project = selectedProject();
  const ctx = $('#context-project');
  if (ctx) ctx.innerHTML = `${icon('home')}<span>${escapeHtml(project?.name ?? '项目')}</span>`;
  const branch = $('#context-branch');
  if (branch) branch.innerHTML = `${icon('branch')}<span>${escapeHtml(project?.branch ?? '本地')}</span>`;
}

function timeAgo(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  const years = Math.floor(months / 12);
  return `${years}年前`;
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
    return `<div class="task-item ${task.status} ${task.id === current.selectedTaskId ? 'selected' : ''}" data-task-id="${id}"><button class="task-open" data-task="${id}" title="打开 ${escapeHtml(taskTitle(task))}"><span class="task-title" title="双击重命名">${escapeHtml(taskTitle(task))}</span><span class="task-meta">${meta}</span></button><button class="task-menu-btn" data-task-menu="${id}" aria-label="任务菜单" title="更多操作">${icon('more')}</button></div>`;
  };

  const tasksCollapsed = collapsedSections.has('tasks');
  const spacesCollapsed = collapsedSections.has('spaces');
  const sectionHeading = (key: string, title: string, count: number, collapsed: boolean): string =>
    `<div class="sidebar-group-heading" data-toggle-section="${key}" title="点击展开 / 折叠" aria-expanded="${!collapsed}"><span class="sidebar-group-title">${title}</span><span class="sidebar-group-count">(${count})</span><span class="sidebar-group-chevron">${icon(collapsed ? 'chevron-right' : 'chevron-down')}</span></div>`;

  taskList.innerHTML = `<div class="sidebar-group ${tasksCollapsed ? 'collapsed' : ''}">
  ${sectionHeading('tasks', '任务', normalTasks.length, tasksCollapsed)}
  <div class="sidebar-group-body">${normalTasks.map(taskItemHtml).join('')}</div>
</div>
<div class="sidebar-group ${spacesCollapsed ? 'collapsed' : ''}">
  ${sectionHeading('spaces', '空间', spaces.length, spacesCollapsed)}
  <div class="sidebar-group-body">${spaces.map(({ project, tasks }) => {
    const isSelectedProject = project.id === current.selectedProjectId;
    const projectId = escapeHtml(project.id);
    const isCollapsed = collapsedProjects.has(project.id);
    return `<div class="project-group ${isCollapsed ? 'collapsed' : ''}">
  <div class="project-group-heading ${isSelectedProject ? 'selected' : ''}" data-toggle-project="${projectId}" title="点击展开 / 折叠" aria-expanded="${!isCollapsed}">
    <span class="project-group-icon">${icon('folder')}</span>
    <span class="project-group-name" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</span>
    <span class="project-group-chevron">${icon(isCollapsed ? 'chevron-right' : 'chevron-down')}</span>
    <span class="project-group-actions"><button class="project-menu-btn icon-button-square" data-project-menu="${projectId}" title="更多操作" aria-label="${escapeHtml(project.name)} 更多操作">${icon('more')}</button></span>
  </div>
  <div class="project-group-tasks">${tasks.length ? tasks.map(taskItemHtml).join('') : '<p class="empty-tasks">无任务</p>'}</div>
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
  });

  taskList.querySelectorAll<HTMLButtonElement>('[data-task-menu]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const existing = document.getElementById('task-context-menu');
    if (existing) existing.remove();
    const taskId = button.dataset.taskMenu!;
    const task = state?.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const isRunning = task.status === 'running' || task.status === 'waiting';
    const rect = button.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'task-context-menu';
    menu.className = 'project-context-menu';
    menu.innerHTML = `<button class="project-context-item" data-action="rename" data-tid="${taskId}"><span class="project-context-icon">${icon('edit')}</span>重命名</button><button class="project-context-item" data-action="delete" data-tid="${taskId}"${isRunning ? ' data-running="1"' : ''}><span class="project-context-icon">${icon('trash')}</span>${isRunning ? '停止并删除' : '删除'}</button>`;
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    let top = rect.bottom + 4;
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
      }
    }));
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
    menu.innerHTML = `<button class="project-context-item" data-action="open-folder" data-pid="${projectId}"><span class="project-context-icon">${icon('folder-open')}</span>打开文件夹</button><button class="project-context-item" data-action="remove" data-pid="${projectId}"><span class="project-context-icon">${icon('close')}</span>从列表中移除</button>`;
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
        if (hasRunning) { showToast('warn', '该空间下有任务运行中，无法移除'); return; }
        const result = await window.mocodeWork.removeProject(pid);
        if (result) { updateState(result.state); clearWorkspace(); showToast('info', `已移除空间 "${result.removed}"`); }
      }
    }));
  }));

  const running = current.tasks.filter((task) => task.status === 'running' || task.status === 'waiting').length;
  const total = current.tasks.length;
  $('#usage').textContent = total ? `${total} 任务${running ? ` · ${running} 运行中` : ''}` : '0%';
}

function updateState(next: WorkState): void { state = next; renderProjects(); renderTasks(); renderEmptyChips(); }
function clearWorkspace(): void { conversation.innerHTML = ''; emptyState.classList.remove('hidden'); activeAssistant = null; activeTextBlock = null; activeToolGroup = null; setRunning(false); attachments = []; renderAttachments(); }

/**
 * 一轮 assistant 输出 = 一条 message 内的**有序 block 流**:
 *   .message-body.text-block   ← 模型文字段
 *   details.tool-entry         ← 工具调用(默认折叠)
 *   .message-body.text-block   ← 工具之后继续说的话,新开一段
 *   …
 * 文字与工具都 append 进 .message-content,谁先发生谁在前 —— 即 Claude Code / Cursor /
 * Codex 那种「正文与工具按时间顺序交织」的展示,而不是把工具统一挂在正文前或正文后。
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

function addMessage(kind: 'user' | 'assistant', text = ''): HTMLElement {
  emptyState.classList.add('hidden');
  const message = document.createElement('article'); message.className = `message ${kind}`;
  if (kind === 'user') {
    // 用户消息：纯气泡，无头像/标签，灰色背景右对齐
    const wrapper = document.createElement('div'); wrapper.className = 'message-content';
    const body = document.createElement('div'); body.className = 'message-body';
    body.textContent = text;
    const label = document.createElement('div'); label.className = 'message-label';
    label.innerHTML = '<div class="message-actions"></div>';
    wrapper.append(body, label);
    message.append(wrapper);
    activeTextBlock = null;
  } else {
    const label = 'Mocode';
    const avatarIcon = '<img class="app-avatar" src="../assets/icon.png" alt="Mocode">';
    message.innerHTML = `<div class="message-avatar">${avatarIcon}</div><div class="message-content"><div class="message-label"><span>${label}</span><div class="message-actions"></div></div><div class="message-body"></div></div>`;
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

/** 工具名 → 折叠行上的中文动词 + 图标。让"这一行在干什么"一眼可读。 */
const TOOL_META: Record<string, { label: string; icon: string }> = {
  read_file: { label: '读取文件', icon: 'files' },
  write_file: { label: '写入文件', icon: 'edit' },
  edit_file: { label: '编辑文件', icon: 'edit' },
  run_command: { label: '运行命令', icon: 'terminal' },
  grep: { label: '搜索代码', icon: 'search' },
  glob: { label: '查找文件', icon: 'search' },
  web_search: { label: '联网搜索', icon: 'globe' },
  web_fetch: { label: '抓取网页', icon: 'globe' },
  browser: { label: '浏览器', icon: 'layout' },
  computer: { label: '电脑操作', icon: 'layout' },
  screenshot: { label: '截图', icon: 'image' },
  view_image: { label: '查看图片', icon: 'image' },
  'sub-agent': { label: '子任务', icon: 'spark-bot' },
  use_skill: { label: '使用技能', icon: 'sparkles' },
  run_skill: { label: '运行技能', icon: 'sparkles' },
  plan_update: { label: '更新计划', icon: 'check' },
  note_append: { label: '记录笔记', icon: 'edit' },
  ask_human: { label: '向你提问', icon: 'user' },
  dev_server: { label: '开发服务器', icon: 'loader' },
};
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

function toolMeta(name: string): { label: string; icon: string } {
  return TOOL_META[name] ?? (name.startsWith('memory_') ? { label: '记忆', icon: 'sparkles' } : { label: name, icon: 'wrench' });
}
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
    const label = entry.dataset.toolLabel ?? '工具';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const phrase = clip([...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · '), 64);
  const current = running.find((entry) => entry.dataset.toolLabel);
  let meta: string;
  if (running.length) {
    meta = `<span class="tool-dot"></span>${entries.length - running.length}/${entries.length} · ${escapeHtml(current?.dataset.toolLabel ?? '工具')}…`;
  } else {
    const startedAt = Number(group.dataset.startTime ?? 0);
    const elapsed = startedAt && group.dataset.hadRunning === '1' ? Date.now() - startedAt : null;
    const timing = elapsed !== null && elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s · ` : '';
    meta = `${timing}${entries.length} 项`;
  }
  const summary = group.querySelector('summary') as HTMLElement;
  summary.innerHTML = `<span class="tool-chevron" data-icon="chevron-right"></span>
  <span class="tool-kind" data-icon="wrench"></span>
  <span class="tool-name">${running.length ? '正在执行工具' : `执行了 ${entries.length} 个工具调用`}</span>
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
  const status = completed ? (lines > 1 ? `${lines} 行` : '完成') : '执行中';
  const timing = elapsed !== null && elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s · ` : '';
  const detail = [
    args ? `<section><span>参数</span><pre>${escapeHtml(args.slice(0, 2000))}</pre></section>` : '',
    output ? `<section><span>结果</span><pre>${escapeHtml(output.slice(0, 6000))}${output.length > 6000 ? '\n…（输出过长已截断）' : ''}</pre></section>` : '',
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
function appendText(text: string): void {
  const block = ensureTextBlock();
  block.textContent = `${block.textContent ?? ''}${text}`;
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
      ensureTextBlock().textContent = item.text;
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
  body.innerHTML = renderMarkdown(text);
  enhanceCodeBlocks(body);
}

/**
 * 一轮输出收尾:逐段渲染 markdown(一段文字 = 一个 block,中间的折叠工具行保持不变),
 * 丢掉空文字段,最后挂上复制 / 重新生成。
 */
function finalizeTurn(message: HTMLElement | null): void {
  if (!message) return;
  message.classList.remove('is-streaming');
  const parts: string[] = [];
  for (const block of Array.from(message.querySelectorAll<HTMLElement>('.message-body'))) {
    const text = block.textContent ?? '';
    if (!text.trim()) { block.remove(); continue; }
    parts.push(text);
    renderMessageBody(block, text);
  }
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
    const ok = window.confirm(`删除任务 “${taskTitle(task)}”?此操作不可撤销。`);
    if (!ok) return;
  }
  const deletingSelectedTask = state?.selectedTaskId === taskId;
  const next = await window.mocodeWork.deleteTask(taskId);
  if (!next) return;
  updateState(next);
  if (deletingSelectedTask && next.selectedTaskId !== taskId) clearWorkspace();
  showToast('info', '已删除任务');
}

function showApproval(taskId: string, payload: Record<string, unknown>): void {
  const approvalId = String(payload.approvalId ?? ''); const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  approvalPanel.classList.remove('hidden');
  const buttons = options.length ? options.map((option, index) => `<button data-approval="${escapeHtml(option)}" class="${index === 0 ? 'approve' : ''}">${escapeHtml(option)}</button>`).join('') : `<button data-approval="approve" class="approve">${icon('check')}确认</button>`;
  approvalPanel.innerHTML = `<div class="approval-title">${icon('warn')}<span>需要你的确认</span></div><p>${escapeHtml(String(payload.title ?? '允许此操作？'))}</p><pre>${escapeHtml(String(payload.detail ?? ''))}</pre><div class="approval-actions">${buttons}<button data-cancel>${icon('close')}拒绝</button></div>`;
  const resolve = (value: Record<string, unknown>): void => {
    window.mocodeWork.send({ type: 'approval', id: taskId, approvalId, ...value });
    approvalPanel.classList.add('hidden');
    const stream = streams.get(taskId);
    if (stream) stream.pendingApproval = null;
  };
  approvalPanel.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach((button) => button.addEventListener('click', () => resolve({ action: 'selected', value: button.dataset.approval })));
  approvalPanel.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', () => resolve({ action: 'cancelled' }));
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
  const viewing = viewingTaskId();
  if (isRunning(viewing)) { showToast('warn', '当前还有任务在跑,请先停止。'); return; }
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
  // 直接重发(不再 addMessage,user 消息已经存在);缓冲里同样截掉被重发之后的段。
  if (viewing) {
    const stream = streamFor(viewing);
    const lastUser = [...stream.items].map((item, i) => ({ item, i })).filter(({ item }) => item.kind === 'user').pop();
    if (lastUser) stream.items.length = lastUser.i + 1;
    stream.running = true;
  }
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
    ['⌘ ⇧ N', '新建任务'],
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

/* ── 图片附件：拖入 / 粘贴共用同一套入队逻辑 ───────────── */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** 把一张图片加入待发送附件。非图片或超限会提示并跳过，返回是否入队成功。 */
async function addImageFile(file: File, fallbackName = '图片'): Promise<boolean> {
  const label = file.name || fallbackName;
  if (file.type && !/^image\//.test(file.type)) { showToast('warn', `${label} 不是图片,已跳过`); return false; }
  if (file.size > MAX_ATTACHMENT_BYTES) { showToast('error', `${label} 超过 4MB 限制`); return false; }
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
    showToast('error', `${label} 读取失败`);
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
      for (const file of files) if (await addImageFile(file, `粘贴图片-${stamp}.png`)) added += 1;
      if (added === 0) return;
      renderAttachments();
      promptInput.focus();
      showToast('info', `已添加 ${added} 张图片`);
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
  return text ? truncateByWidth(text, maxWidth) : '新任务';
}
async function submit(): Promise<void> {
  const viewing = viewingTaskId();
  // 正在查看的任务在跑:点击 = 停止它(其它后台任务不受影响)。
  if (isRunning(viewing)) { window.mocodeWork.send({ type: 'cancel', id: viewing }); return; }
  const prompt = promptInput.value.trim(); if (!prompt) return;
  let task = selectedTask();
  // 只有在完全没有选中的任务时才新建；若已选中（含「新建任务」预建的 queued 任务，尚无 session），直接续用，避免重复建任务。
  if (!task) {
    const created = await window.mocodeWork.createTask(''); updateState(created.state); task = created.task;
  }
  // 标题自动摘要：新建后还没命名的任务，用这一条指令就地命名（用户手动改过就不动）。
  if (!task.title.trim() && !task.sessionId) {
    const next = await window.mocodeWork.renameTask(task.id, summarizePrompt(prompt));
    if (next) updateState(next);
  }
  const stream = streamFor(task.id);
  stream.items.push({ kind: 'user', text: prompt });
  stream.running = true;
  addMessage('user', prompt); promptInput.value = ''; resizePrompt(); setRunning(true);
  window.mocodeWork.send({ type: 'run', id: task.id, prompt, sessionId: task.sessionId, attachments }); attachments = []; renderAttachments();
}

function endTaskRun(taskId: string): void {
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
  showToast('info', `「${taskTitle(task ?? ({} as Task))}」${note}`, 3200);
}

function handleAgentEvent(envelope: AgentEnvelope): void {
  if (envelope.type === 'error') {
    const message = humanizeError(envelope.error ?? '');
    if (message) { console.error('[Agent]', message); showToast('error', message); }
    return;
  }
  const payload = envelope.payload ?? {};
  const taskId = envelope.requestId;
  // host_log 等无归属事件走全局通道
  if (!taskId) {
    if (envelope.event === 'host_log') handleHostLog(payload);
    return;
  }
  const stream = streamFor(taskId);
  const viewing = viewingTaskId() === taskId;
  switch (envelope.event) {
    case 'text_delta': {
      const text = String(payload.text ?? '');
      const last = stream.items[stream.items.length - 1];
      if (last && last.kind === 'text') last.text += text;
      else stream.items.push({ kind: 'text', text });
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
      if (viewing) showApproval(taskId, payload);
      else notifyBackground(taskId, '在等待你确认操作');
      break;
    }
    case 'run_aborted':
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
          created > 0 ? `创建 ${Math.round(created).toLocaleString()} tokens` : null,
          cached > 0 ? `命中 ${Math.round(cached).toLocaleString()} tokens` : null,
        ].filter(Boolean).join(' · ');
        showToast('success', `Prompt Cache: ${details}`, 3500);
      }
      endTaskRun(taskId);
      if (viewing) { updateContextUsage(stream.usagePercent); finish(); }
      else notifyBackground(taskId, '已完成');
      break;
    }
    case 'compact_done': {
      const pct = typeof payload.usagePercent === 'number' ? payload.usagePercent : null;
      if (pct !== null) stream.usagePercent = pct;
      const before = typeof payload.beforeTokens === 'number' ? Math.round(payload.beforeTokens / 1000) : '?';
      const after = typeof payload.afterTokens === 'number' ? Math.round(payload.afterTokens / 1000) : '?';
      showToast('success', `上下文已压缩: ${before}k → ${after}k tokens${pct !== null ? ` (${pct}%)` : ''}`, 4000);
      if (viewing) updateContextUsage(pct);
      break;
    }
    case 'host_log':
      handleHostLog(payload);
      break;
    case 'run_failed': {
      const message = humanizeError(String(payload.message ?? '运行失败。')) ?? '运行失败。';
      stream.items.push({ kind: 'error', message });
      endTaskRun(taskId);
      if (viewing) { console.error('[Agent]', message); showToast('error', message, 5000); finish(); }
      else { console.error('[Agent]', message); notifyBackground(taskId, '运行失败'); }
      break;
    }
    case 'host_exit': {
      if (!stream.running) break;
      const code = typeof payload.code === 'number' ? payload.code : null;
      console.error(`[Agent Host] 已退出（退出码 ${code ?? '?'}）`);
      stream.items.push({ kind: 'error', message: `Agent Host 意外退出（退出码 ${code ?? '?'}），请重试。` });
      endTaskRun(taskId);
      if (viewing) finish();
      break;
    }
  }
}
function handleHostLog(payload: Record<string, unknown>): void {
  const raw = String(payload.message ?? '').trim();
  if (!raw) return;
  // 内部日志只进开发者控制台，绝不进入用户对话。
  if (/^\(?node:\d+\)? \[DEP\d{4}\]/.test(raw)) return;
  console.debug('[Agent Host]', raw);
  // 关键启动 / 配置提示用 toast 提示用户(避免淹没在控制台)
  if (/Agent Host 未构建|配置缺少|连续崩溃|未找到系统 node/.test(raw)) {
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
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  const stream = streams.get(taskId);
  if (stream && stream.items.length) {
    for (const item of stream.items) {
      if (item.kind === 'user') addMessage('user', item.text);
      else if (item.kind === 'text') appendText(item.text);
      else if (item.kind === 'tool') addTool({ id: item.id, name: item.name, arguments: item.args, output: item.output }, item.done);
      else if (item.kind === 'error') showToast('error', item.message, 5000);
    }
    if (!stream.running) finish();
    else setRunning(true);
    updateContextUsage(stream.usagePercent);
    if (stream.running && stream.pendingApproval) showApproval(taskId, stream.pendingApproval);
  } else if (history) {
    renderHistory(history);
    updateContextUsage(null);
  }
  // 切换任务清空附件草稿 —— 附件属于「当前正在编辑的这条消息」,不属于任务。
  attachments = []; renderAttachments();
  promptInput.focus();
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
  const taskResults = tasks.map((task) => `<button data-search-task="${escapeHtml(task.id)}">任务 · ${escapeHtml(taskTitle(task))}</button>`).join('');
  $('#search-results').innerHTML = projectResults || taskResults ? `${projectResults}${taskResults}` : '<p>无匹配结果</p>';
  document.querySelectorAll<HTMLButtonElement>('[data-search-project]').forEach((button) => button.addEventListener('click', async () => { updateState(await window.mocodeWork.selectProject(button.dataset.searchProject!)); searchPanel.classList.add('hidden'); }));
  document.querySelectorAll<HTMLButtonElement>('[data-search-task]').forEach((button) => button.addEventListener('click', () => { searchPanel.classList.add('hidden'); void openTask(button.dataset.searchTask!); }));
}

$('#add-project').addEventListener('click', async () => {
  const before = state?.selectedProjectId;
  let next: WorkState | null = null;
  try { next = await window.mocodeWork.pickProject(); }
  catch { showToast('error', '无法打开项目选择器'); return; }
  if (!next) return;
  updateState(next); clearWorkspace();
  const project = selectedProject();
  if (project && project.id !== before) showToast('success', `已切换到项目「${project.name}」`);
});
$('#new-task').addEventListener('click', () => void startNewTask());

/**
 * 新建任务：不弹窗、不填表。直接建一个空任务（标题留空 → 侧栏显示「新任务」），
 * 工作区清空并把焦点交给输入框；标题等用户发出第一条指令后由 summarizePrompt 自动生成。
 */
async function startNewTask(): Promise<void> {
  // 并行友好:别的任务在后台跑也可以继续开新任务。
  const current = selectedTask();
  // 已经有一个「刚新建、还没发过消息」的任务时直接续用，避免连点堆出一串空任务。
  if (current && !current.sessionId && !conversation.querySelector('.message')) { promptInput.focus(); return; }
  const created = await window.mocodeWork.createTask('');
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
  ($('#task-modal-title') as HTMLElement).textContent = '重命名任务';
  ($('#task-modal-create') as HTMLButtonElement).textContent = '保存';
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
    showToast('success', `已重命名为「${name}」`);
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
$('#toggle-inspector').addEventListener('click', () => inspector.classList.contains('hidden') ? openInspector('overview') : inspector.classList.add('hidden'));
$('#show-files').addEventListener('click', () => openInspector('files'));
$('#close-inspector').addEventListener('click', () => inspector.classList.add('hidden'));
$('#pull-requests').addEventListener('click', () => openInspector('prs'));
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => { activeInspectorTab = button.dataset.tab as 'overview' | 'files' | 'prs'; void refreshInspector(); }));
$('#search-button').addEventListener('click', () => { searchPanel.classList.remove('hidden'); searchInput.value = ''; refreshSearch(); searchInput.focus(); });
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast('info', `已切换到${next === 'dark' ? '黑夜' : '浅色'}主题`, 1600);
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
const settingsPopover = $('#settings-popover');
const themeSegmented = $('#theme-segmented');

function refreshThemeSegmented(): void {
  let saved: string;
  try { saved = localStorage.getItem('mocode-work-theme') || 'system'; } catch { saved = 'system'; }
  themeSegmented?.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    const active = button.dataset.theme === saved;
    button.setAttribute('aria-checked', String(active));
  });
}

function toggleSettingsPopover(show?: boolean): void {
  const next = show ?? settingsPopover?.classList.contains('hidden') ?? false;
  settingsPopover?.classList.toggle('hidden', !next);
  if (settingsButton) settingsButton.setAttribute('aria-expanded', String(next));
  if (next) refreshThemeSegmented();
}

settingsButton?.addEventListener('click', () => toggleSettingsPopover());

themeSegmented?.querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.addEventListener('click', () => {
  const theme = button.dataset.theme as 'light' | 'dark' | 'system';
  applyTheme(theme);
}));

$('#settings-shortcuts')?.addEventListener('click', () => {
  toggleSettingsPopover(false);
  showCheatsheet();
});

$('#settings-about')?.addEventListener('click', () => {
  toggleSettingsPopover(false);
  showToast('info', 'Mocode Work · 桌面客户端', 3000);
});

// 点击外部或按 Esc 关闭设置浮层
document.addEventListener('click', (event) => {
  if (!settingsPopover?.classList.contains('hidden') && event.target instanceof Node && !settingsPopover?.contains(event.target) && !settingsButton?.contains(event.target)) {
    toggleSettingsPopover(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsPopover?.classList.contains('hidden')) toggleSettingsPopover(false);
});
refreshThemeSegmented();
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
    btn.title = collapsed ? '展开侧栏' : '折叠侧栏';
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏');
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

function shortModelName(text: string): string {
  if (!text) return '未配置模型';
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

function setModeButton(config: ModelConfig): void {
  const button = $('#mode-button');
  if (!button) return;
  const display = config.label || config.model;
  const label = config.model ? shortModelName(display) : '未配置模型';
  // 按钮上只留模型名（+ anthropic 的 cache 标记）；协议/openai 之类的信息挪进 title 与下拉列表，别占按钮宽度。
  const cacheBadge = config.provider === 'anthropic' && config.promptCache
    ? '<span class="model-picker-cache">cache</span>'
    : '';
  button.innerHTML = `<span class="mode-label">${escapeHtml(label)}</span>${cacheBadge}<svg class="icon icon-inline" data-icon="chevron-down"></svg>`;
  mountIcons(button);
  const detail = [
    config.model ? `别名: ${config.model}` : null,
    config.label && config.label !== config.model ? `模型: ${config.label}` : null,
    `协议: ${config.provider}`,
    config.provider === 'anthropic' ? `Prompt Cache: ${config.promptCache ? 'on' : 'off'}` : null,
    config.baseUrl ? `API: ${config.baseUrl}` : null,
    config.contextWindow ? `上下文: ${(config.contextWindow / 1000).toFixed(0)}k tokens` : null,
  ].filter(Boolean).join('\n');
  button.title = detail || '点击切换模型';
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

function renderModelPicker(): void {
  const el = ensureModelPicker();
  if (!modelList.length) {
    el.innerHTML = `<div class="model-picker-empty">${icon('warn')}<span>未发现模型配置</span></div><div class="model-picker-hint">在终端运行 <code>mocode /model</code> 添加模型</div>`;
    return;
  }
  el.innerHTML = `
    <div class="model-picker-head">
      <span>选择模型</span>
      <span class="model-picker-count">${modelList.length} 个</span>
    </div>
    <div class="model-picker-list" role="listbox">
      ${modelList.map((m) => `
        <button class="model-picker-item ${m.isActive ? 'active' : ''}" data-model="${escapeHtml(m.name)}" role="option" aria-selected="${m.isActive}">
          <span class="model-picker-radio">${m.isActive ? icon('check') : ''}</span>
          <span class="model-picker-body">
            <span class="model-picker-name">${escapeHtml(m.label)}</span>
            <span class="model-picker-meta">
              <span class="model-picker-provider">${m.provider}</span>
              ${m.provider === 'anthropic' && m.promptCache ? '<span class="model-picker-cache">cache</span>' : ''}
              ${m.contextWindow ? `<span class="model-picker-ctx">${(m.contextWindow / 1000).toFixed(0)}k 上下文</span>` : ''}
            </span>
          </span>
        </button>
      `).join('')}
    </div>
  `;
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
    showToast('info', '助手模式: Mocode Agent (暂未开放多模型切换)');
    return;
  }
  if (cmd && event.key === '.') {
    event.preventDefault();
    const viewing = viewingTaskId();
    if (isRunning(viewing)) { window.mocodeWork.send({ type: 'cancel', id: viewing }); showToast('info', '已停止当前任务'); }
    return;
  }
  if (cmd && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    if (!conversation.querySelector('.message')) { showToast('info', '当前没有对话可搜索'); return; }
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

// 末尾再 mount 一次,覆盖在 init 中通过 innerHTML 注入的 [data-icon](例如动态插的 SVG 占位)。
mountIcons();

/* ── 空状态 chip：工作空间下拉（选已有空间 / 打开新空间） ── */
let workspacePickerEl: HTMLElement | null = null;

function renderEmptyChips(): void {
  const project = state?.projects.find((p) => p.id === state?.selectedProjectId) ?? state?.projects[0];
  const label = $('#empty-chip-project .empty-chip-label');
  if (label) label.textContent = project?.name ?? '选择工作空间';
}

function workspacePicker(): HTMLElement | null {
  if (!workspacePickerEl) workspacePickerEl = $('#workspace-picker') as HTMLElement | null;
  return workspacePickerEl;
}

function renderWorkspacePicker(): void {
  const el = workspacePicker();
  if (!el) return;
  const projects = state?.projects ?? [];
  const currentId = state?.selectedProjectId;
  const items = projects.length
    ? projects.map((project) => `
        <button class="chip-picker-item ${project.id === currentId ? 'active' : ''}" data-workspace="${escapeHtml(project.id)}" role="option" aria-selected="${project.id === currentId}">
          <span class="chip-picker-check">${project.id === currentId ? icon('check') : ''}</span>
          <span class="chip-picker-body">
            <span class="chip-picker-name">${escapeHtml(project.name)}</span>
            <span class="chip-picker-path" title="${escapeHtml(project.root)}">${escapeHtml(project.root)}</span>
          </span>
        </button>`).join('')
    : '<div class="chip-picker-empty">还没有工作空间，先打开一个文件夹。</div>';
  el.innerHTML = `
    <div class="chip-picker-head"><span>工作空间</span><span class="chip-picker-count">${projects.length} 个</span></div>
    <div class="chip-picker-list" role="listbox">${items}</div>
    <div class="chip-picker-foot">
      <button class="chip-picker-item chip-picker-new" data-workspace-open>
        <span class="chip-picker-check">${icon('folder')}</span>
        <span class="chip-picker-body">
          <span class="chip-picker-name">打开新的工作空间…</span>
          <span class="chip-picker-path">选择一个本地文件夹</span>
        </span>
      </button>
    </div>
  `;
  el.querySelectorAll<HTMLButtonElement>('[data-workspace]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.workspace;
      hideWorkspacePicker();
      if (!id || id === currentId) return;
      try {
        const next = await window.mocodeWork.selectProject(id);
        if (next) { updateState(next); showToast('success', '已切换工作空间'); }
      } catch (error) { showToast('error', (error as Error).message); }
    });
  });
  el.querySelector<HTMLButtonElement>('[data-workspace-open]')?.addEventListener('click', async () => {
    hideWorkspacePicker();
    try {
      const next = await window.mocodeWork.pickProject();
      if (next) { updateState(next); showToast('success', '已打开新的工作空间'); }
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
