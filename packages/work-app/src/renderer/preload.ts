import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type Project = { id: string; name: string; root: string; branch: string };
type Task = { id: string; projectId: string; title: string; status: string; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string };
type ProjectState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };

contextBridge.exposeInMainWorld('mocodeWork', {
  getState: (): Promise<ProjectState> => ipcRenderer.invoke('work:get-state'),
  pickProject: (): Promise<ProjectState | null> => ipcRenderer.invoke('work:pick-project'),
  selectProject: (id: string): Promise<ProjectState> => ipcRenderer.invoke('work:select-project', id),
  createTask: (title: string): Promise<{ state: ProjectState; task: Task }> => ipcRenderer.invoke('work:create-task', title),
  selectTask: (id: string): Promise<{ state: ProjectState; task: Task; history: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }> } | null> => ipcRenderer.invoke('work:select-task', id),
  clearTasks: (): Promise<ProjectState> => ipcRenderer.invoke('work:clear-tasks'),
  deleteTask: (id: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:delete-task', id),
  projectOverview: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:project-overview'),
  readFile: (file: string): Promise<{ path?: string; content?: string; error?: string }> => ipcRenderer.invoke('work:read-file', file),
  fileDiff: (file: string): Promise<{ path?: string; content?: string; error?: string }> => ipcRenderer.invoke('work:file-diff', file),
  pullRequests: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:pull-requests'),
  pickAttachment: (): Promise<{ name: string; dataUrl: string } | null> => ipcRenderer.invoke('work:pick-attachment'),
  getConfig: (): Promise<{ model: string; baseUrl: string; contextWindow: number | null; language: string; theme: string }> => ipcRenderer.invoke('work:get-config'),
  setTheme: (theme: 'light' | 'dark'): void => ipcRenderer.send('work:set-theme', theme),
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
