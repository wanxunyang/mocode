import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.mocode', 'node_modules', 'dist', 'coverage', '.next', '.cache']);

type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface Project { id: string; name: string; root: string; branch: string; }
interface TaskRecord {
  id: string; projectId: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string;
  sessionId?: string; changedFiles: string[]; lastError?: string;
}
interface StoredState { version: 1; projects: Project[]; selectedProjectId: string; tasks: TaskRecord[]; selectedTaskId?: string; }
interface CommandResult { ok: boolean; stdout: string; stderr: string; }

let windowRef: BrowserWindow | null = null;
let state: StoredState;
let agent: LocalAgent | null = null;
let activeTaskId: string | null = null;

function statePath(): string { return path.join(app.getPath('userData'), 'work-projects.json'); }
function pushRenderer(channel: string, payload: unknown): void { windowRef?.webContents.send(channel, payload); }
function broadcastState(): void { pushRenderer('work:state', state); }

function runCommand(root: string, executable: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => execFile(executable, args, { cwd: root, windowsHide: true, maxBuffer: 1_024 * 1_024 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
  }));
}

async function branchAt(root: string): Promise<string> {
  const result = await runCommand(root, 'git', ['branch', '--show-current']);
  return result.ok ? (result.stdout || 'detached') : '本地';
}

async function projectFor(root: string): Promise<Project> {
  const normalized = path.resolve(root);
  return { id: normalized.toLowerCase(), name: path.basename(normalized) || normalized, root: normalized, branch: await branchAt(normalized) };
}

function normalizeState(value: unknown): StoredState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<StoredState>;
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) return null;
  const projects = raw.projects.filter((item): item is Project => !!item && typeof item.id === 'string' && typeof item.root === 'string')
    .map((item) => ({ ...item, name: item.name || path.basename(item.root), branch: item.branch || '本地' }));
  if (!projects.length) return null;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter((item): item is TaskRecord => !!item && typeof item.id === 'string' && typeof item.projectId === 'string')
    .map((item) => ({ ...item, changedFiles: Array.isArray(item.changedFiles) ? item.changedFiles : [], status: item.status || 'completed' })) : [];
  return { version: 1, projects, tasks, selectedProjectId: projects.some((item) => item.id === raw.selectedProjectId) ? raw.selectedProjectId! : projects[0].id, selectedTaskId: typeof raw.selectedTaskId === 'string' ? raw.selectedTaskId : undefined };
}

async function loadState(): Promise<StoredState> {
  try { const loaded = normalizeState(JSON.parse(readFileSync(statePath(), 'utf8'))); if (loaded) return loaded; } catch { /* First launch. */ }
  const project = await projectFor(path.resolve(process.env.MOCODE_WORK_PROJECT ?? path.join(__dirname, '..', '..', '..')));
  return { version: 1, projects: [project], selectedProjectId: project.id, tasks: [] };
}

function saveState(): void {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
}
function selectedProject(): Project { return state.projects.find((item) => item.id === state.selectedProjectId) ?? state.projects[0]; }
function taskById(id?: string): TaskRecord | undefined { return state.tasks.find((item) => item.id === id); }

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return value == null ? '' : JSON.stringify(value);
}

function sessionHistory(project: Project, sessionId?: string): Array<{ role: 'user' | 'assistant' | 'tool'; text: string }> {
  if (!sessionId) return [];
  const candidates = [path.join(project.root, '.mocode', 'sessions', sessionId, 'session.json'), path.join(project.root, '.mocode', 'sessions', `${sessionId}.json`)];
  for (const candidate of candidates) {
    try {
      const record = JSON.parse(readFileSync(candidate, 'utf8')) as { history?: Array<Record<string, unknown>> };
      if (!Array.isArray(record.history)) continue;
      return record.history.flatMap((message) => {
        const role = message.role;
        if (role === 'system') return [];
        const text = contentText(message.content) || (Array.isArray(message.tool_calls) ? `调用工具：${message.tool_calls.map((call) => String((call as { function?: { name?: string } }).function?.name ?? 'tool')).join(', ')}` : '');
        if (!text) return [];
        return [{ role: role === 'tool' ? 'tool' : role === 'assistant' ? 'assistant' : 'user', text }];
      });
    } catch { /* Try old session layout. */ }
  }
  return [];
}

function listFiles(root: string, directory = root, entries: string[] = []): string[] {
  if (entries.length >= 180) return entries;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) listFiles(root, absolute, entries);
      else if (entry.isFile() && statSync(absolute).size <= 1_000_000) entries.push(relative);
      if (entries.length >= 180) break;
    }
  } catch { /* Unreadable directories are omitted. */ }
  return entries.sort((left, right) => left.localeCompare(right));
}

function resolvedProjectFile(project: Project, relativePath: string): string | null {
  const resolved = path.resolve(project.root, relativePath);
  const relative = path.relative(project.root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null;
}

async function projectOverview(project: Project): Promise<Record<string, unknown>> {
  const [branch, status, diffStat, commit] = await Promise.all([
    branchAt(project.root), runCommand(project.root, 'git', ['status', '--short']), runCommand(project.root, 'git', ['diff', '--stat']), runCommand(project.root, 'git', ['log', '-1', '--oneline']),
  ]);
  project.branch = branch;
  saveState();
  return { project, branch, status: status.ok ? status.stdout.split('\n').filter(Boolean) : [], diffStat: diffStat.ok ? diffStat.stdout : '', lastCommit: commit.ok ? commit.stdout : '', files: listFiles(project.root) };
}

async function pullRequests(project: Project): Promise<Record<string, unknown>> {
  const result = await runCommand(project.root, 'gh', ['pr', 'list', '--limit', '20', '--json', 'number,title,state,headRefName,url']);
  if (!result.ok) return { available: false, message: result.stderr || '未检测到 GitHub CLI 登录状态。' };
  try { return { available: true, items: JSON.parse(result.stdout || '[]') }; }
  catch { return { available: false, message: 'GitHub CLI 返回了无法读取的数据。' }; }
}

function updateTaskFromAgent(envelope: Record<string, unknown>): void {
  const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : activeTaskId ?? undefined;
  const task = taskById(requestId);
  if (!task) return;
  const event = envelope.event;
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
  if (event === 'run_started') { task.status = 'running'; if (typeof payload.sessionId === 'string') task.sessionId = payload.sessionId; }
  if (event === 'approval_requested') task.status = 'waiting';
  if (event === 'status') task.status = 'running';
  if (event === 'run_aborted') task.status = 'cancelled';
  if (event === 'run_failed') { task.status = 'failed'; task.lastError = String(payload.message ?? '运行失败'); activeTaskId = null; }
  if (event === 'run_completed') {
    task.changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles.filter((item): item is string => typeof item === 'string') : [];
    task.status = payload.terminationReason === 'aborted' ? 'cancelled' : payload.terminationReason === 'completed' ? 'completed' : 'failed';
    activeTaskId = null;
  }
  task.updatedAt = new Date().toISOString();
  saveState();
  broadcastState();
}

class LocalAgent {
  private child: ReturnType<typeof spawn> | null = null;
  private buffer = '';

  async start(project: Project): Promise<void> {
    this.stop();
    const hostFile = process.env.MOCODE_HOST_PATH ?? path.resolve(__dirname, '..', '..', '..', 'dist', 'host', 'stdio.js');
    if (!existsSync(hostFile)) return this.receive({ type: 'error', error: `Agent Host 未构建：${hostFile}` });
    this.child = spawn(process.execPath, [hostFile], {
      cwd: project.root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (message: string) => this.receive({ type: 'event', event: 'host_log', payload: { message } }));
    this.child.once('exit', (code) => { this.receive({ type: 'event', event: 'host_exit', payload: { code } }); this.child = null; });
  }

  send(value: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return this.receive({ type: 'error', error: 'Agent Host 尚未就绪。' });
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  stop(): void { this.child?.kill(); this.child = null; this.buffer = ''; }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) { try { this.receive(JSON.parse(line) as Record<string, unknown>); } catch { this.receive({ type: 'error', error: `Agent Host 输出格式错误：${line}` }); } }
      newline = this.buffer.indexOf('\n');
    }
  }

  private receive(envelope: Record<string, unknown>): void {
    if (envelope.type === 'event') updateTaskFromAgent(envelope);
    pushRenderer('work:agent-event', envelope);
  }
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 620, title: 'Mocode Work', backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'renderer', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  void windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function currentTaskWorkspace(task: TaskRecord): Record<string, unknown> {
  const project = state.projects.find((item) => item.id === task.projectId);
  return { task, history: project ? sessionHistory(project, task.sessionId) : [] };
}

function attachmentFor(filePath: string): { name: string; dataUrl: string } | null {
  try {
    const data = readFileSync(filePath);
    if (data.byteLength > MAX_ATTACHMENT_BYTES) return null;
    const extension = path.extname(filePath).toLowerCase();
    const mime = extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.gif' ? 'image/gif' : extension === '.webp' ? 'image/webp' : null;
    return mime ? { name: path.basename(filePath), dataUrl: `data:${mime};base64,${data.toString('base64')}` } : null;
  } catch { return null; }
}

function installIpc(): void {
  ipcMain.handle('work:get-state', () => state);
  ipcMain.handle('work:pick-project', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = await projectFor(result.filePaths[0]);
    const existing = state.projects.find((item) => item.id === project.id);
    if (existing) Object.assign(existing, project); else state.projects.push(project);
    state.selectedProjectId = project.id; state.selectedTaskId = undefined; saveState(); broadcastState(); await agent?.start(project); return state;
  });
  ipcMain.handle('work:select-project', async (_event, projectId: string) => {
    if (!state.projects.some((item) => item.id === projectId) || activeTaskId) return state;
    state.selectedProjectId = projectId; state.selectedTaskId = undefined; saveState(); broadcastState(); await agent?.start(selectedProject()); return state;
  });
  ipcMain.handle('work:create-task', (_event, title: string) => {
    const project = selectedProject(); const now = new Date().toISOString();
    const task: TaskRecord = { id: randomUUID(), projectId: project.id, title: title.slice(0, 160), status: 'queued', createdAt: now, updatedAt: now, changedFiles: [] };
    state.tasks.unshift(task); state.selectedTaskId = task.id; saveState(); broadcastState(); return { state, task };
  });
  ipcMain.handle('work:select-task', async (_event, taskId: string) => {
    const task = taskById(taskId); if (!task || (activeTaskId && activeTaskId !== taskId)) return null;
    const project = state.projects.find((item) => item.id === task.projectId); if (!project) return null;
    state.selectedTaskId = task.id; state.selectedProjectId = project.id; saveState(); broadcastState(); await agent?.start(project);
    return { state, ...currentTaskWorkspace(task) };
  });
  ipcMain.handle('work:clear-tasks', () => {
    const projectId = state.selectedProjectId; state.tasks = state.tasks.filter((task) => task.projectId !== projectId); state.selectedTaskId = undefined; saveState(); broadcastState(); return state;
  });
  ipcMain.handle('work:project-overview', async () => projectOverview(selectedProject()));
  ipcMain.handle('work:read-file', (_event, relativePath: string) => {
    const target = resolvedProjectFile(selectedProject(), relativePath); if (!target) return { error: '不允许读取项目目录外的文件。' };
    try { return { path: relativePath, content: readFileSync(target, 'utf8').slice(0, 200_000) }; } catch { return { error: '文件不可读取或不是文本文件。' }; }
  });
  ipcMain.handle('work:file-diff', async (_event, relativePath: string) => {
    const target = resolvedProjectFile(selectedProject(), relativePath); if (!target) return { error: '不允许读取项目目录外的文件。' };
    const result = await runCommand(selectedProject().root, 'git', ['diff', '--', relativePath]); return { path: relativePath, content: result.ok ? result.stdout || '该文件没有已跟踪的 Git Diff。' : result.stderr };
  });
  ipcMain.handle('work:pull-requests', async () => pullRequests(selectedProject()));
  ipcMain.handle('work:pick-attachment', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    return result.canceled || !result.filePaths[0] ? null : attachmentFor(result.filePaths[0]);
  });
  ipcMain.on('work:agent-send', (_event, value: Record<string, unknown>) => {
    const id = typeof value.id === 'string' ? value.id : randomUUID();
    if (value.type === 'run') { activeTaskId = id; const task = taskById(id); if (task) { task.status = 'running'; task.updatedAt = new Date().toISOString(); saveState(); broadcastState(); } }
    agent?.send({ ...value, id });
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ role: 'close', label: '关闭窗口' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }] },
    { label: '帮助', submenu: [{ label: 'Mocode Work' }] },
  ]));
  state = await loadState(); agent = new LocalAgent(); installIpc(); createWindow(); await agent.start(selectedProject());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { agent?.stop(); if (process.platform !== 'darwin') app.quit(); });
