import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type Project = { id: string; name: string; root: string; branch: string };
type Task = { id: string; projectId: string; title: string; status: string; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string };
type ProjectState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };

contextBridge.exposeInMainWorld('mocodeWork', {
  getState: (): Promise<ProjectState> => ipcRenderer.invoke('work:get-state'),
  pickProject: (): Promise<ProjectState | null> => ipcRenderer.invoke('work:pick-project'),
  selectProject: (id: string): Promise<ProjectState> => ipcRenderer.invoke('work:select-project', id),
  createTask: (title: string, projectId?: string): Promise<{ state: ProjectState; task: Task }> => ipcRenderer.invoke('work:create-task', title, projectId),
  selectTask: (id: string): Promise<{ state: ProjectState; task: Task; history: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }> } | null> => ipcRenderer.invoke('work:select-task', id),
  clearTasks: (projectId?: string): Promise<ProjectState> => ipcRenderer.invoke('work:clear-tasks', projectId),
  deleteTask: (id: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:delete-task', id),
  renameTask: (id: string, title: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:rename-task', id, title),
  renameProject: (id: string, name: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:rename-project', id, name),
  openFolder: (projectId: string): Promise<boolean> => ipcRenderer.invoke('work:open-folder', projectId),
  removeProject: (projectId: string): Promise<{ state: ProjectState; removed: string } | null> => ipcRenderer.invoke('work:remove-project', projectId),
  projectOverview: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:project-overview'),
  readFile: (file: string): Promise<{ path?: string; content?: string; error?: string }> => ipcRenderer.invoke('work:read-file', file),
  fileDiff: (file: string): Promise<{ path?: string; content?: string; error?: string }> => ipcRenderer.invoke('work:file-diff', file),
  pullRequests: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:pull-requests'),
  pickAttachment: (): Promise<{ name: string; dataUrl: string } | null> => ipcRenderer.invoke('work:pick-attachment'),
  getConfig: (): Promise<{ model: string; label: string; provider: 'openai' | 'anthropic'; promptCache: boolean; baseUrl: string; contextWindow: number | null; language: string; theme: string }> => ipcRenderer.invoke('work:get-config'),
  listModels: (): Promise<Array<{ name: string; label: string; provider: 'openai' | 'anthropic'; promptCache: boolean; baseURL: string; contextWindow: number; isActive: boolean }>> => ipcRenderer.invoke('work:list-models'),
  switchModel: (name: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:switch-model', name),
  listBranches: (): Promise<{ ok: boolean; message: string; current: string; branches: string[] }> => ipcRenderer.invoke('work:list-branches'),
  switchBranch: (branch: string): Promise<{ ok: boolean; message: string; branch?: string }> => ipcRenderer.invoke('work:switch-branch', branch),
  setTheme: (theme: 'light' | 'dark' | 'system'): void => ipcRenderer.send('work:set-theme', theme),
  send: (value: Record<string, unknown>): void => ipcRenderer.send('work:agent-send', value),
  onAgentEvent: (callback: (event: AgentEnvelope) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEnvelope) => callback(payload);
    ipcRenderer.on('work:agent-event', listener);
    return () => ipcRenderer.removeListener('work:agent-event', listener);
  },
  onState: (callback: (state: ProjectState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: ProjectState) => callback(payload);
    ipcRenderer.on('work:state', listener);
    return () => ipcRenderer.removeListener('work:state', listener);
  },
});
