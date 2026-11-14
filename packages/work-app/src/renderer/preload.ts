import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { RecoverySnapshot } from '../recovery-log.js';
import type { AttachmentResult, WorkAttachment } from '../attachment-types.js';

type HistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string; name?: string; arguments?: string; attachments?: WorkAttachment[] };

type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type Project = { id: string; name: string; root: string; branch: string; auto?: boolean; sessionCount?: number };
type Task = { id: string; projectId: string; title: string; status: string; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string; plan?: { title: string; done: number; total: number; allDone: boolean } };
type ProjectState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };
type GitTarget = { taskId?: string; projectId?: string; repoRoot?: string };
/** 历史视图一行：字段与 git.ts 的 GitCommitSummary 对齐。 */
type GitCommitLogEntry = { sha: string; shortSha: string; parents: string[]; author: string; email: string; date: string; refs: string[]; subject: string };
/** 历史视图里一个提交改动的文件。 */
type GitCommitFileEntry = { path: string; previousPath?: string; code: string };
type ModelDraft = { provider: 'openai' | 'anthropic'; baseURL: string; apiKey: string; model: string; contextWindow: number; anthropicPromptCache: boolean };
type ModelPresetDetail = ModelDraft & { name: string };
type CatalogEntryView = {
  providerId: string; providerName: string; modelId: string; name?: string;
  contextWindow: number; reasoning: boolean; toolCall: boolean; attachment: boolean; releaseDate?: string;
};
type CatalogPrefill = { provider: 'openai' | 'anthropic'; baseURL: string; model: string; contextWindow: number; anthropicPromptCache: boolean };
type SkillItem = { name: string; description: string; version?: string; dir: string; origin: 'user' | 'claude' | 'project'; modelInvocable: boolean; allowedTools?: string[] };
type ImportResult = { ok: boolean; message?: string; installed: Array<{ name: string; dir: string; updated: boolean }> };
type MarketSkills = { ok: boolean; message?: string; skills: Array<{ name: string; description: string; version?: string; relDir: string }> };
type McpServerView = {
  name: string; transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
  requestTimeoutMs?: number; disabled: boolean;
};
type McpDraft = {
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string; argsText?: string; envText?: string;
  url?: string; headersText?: string; requestTimeoutMs?: number;
};
type VoiceStatus = { ready: boolean; bytes: number; dir: string; downloading?: boolean };
type VoiceProgress = { receivedBytes: number; totalBytes: number; percent: number; file: string };
/** 主进程推来的浏览器面板状态（browser-host.ts 的 BrowserViewState）。 */
type BrowserViewState = {
  projectId?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
};

contextBridge.exposeInMainWorld('mocodeWork', {
  // 渲染层拿它决定快捷键文案里的修饰键写法(Windows/Linux → Ctrl,macOS → Command)。
  // 渲染进程没有 process,只能由 preload 透出。
  platform: process.platform,
  getState: (): Promise<ProjectState> => ipcRenderer.invoke('work:get-state'),
  pickProject: (): Promise<ProjectState | null> => ipcRenderer.invoke('work:pick-project'),
  selectProject: (id: string): Promise<ProjectState> => ipcRenderer.invoke('work:select-project', id),
  createTask: (title: string, projectId?: string): Promise<{ state: ProjectState; task: Task }> => ipcRenderer.invoke('work:create-task', title, projectId),
  setTaskProject: (id: string, projectId: string): Promise<{ ok: boolean; message?: string; state?: ProjectState; task?: Task }> => ipcRenderer.invoke('work:set-task-project', id, projectId),
  selectTask: (id: string): Promise<{ state: ProjectState; task: Task; history: HistoryItem[]; recovery: RecoverySnapshot | null } | null> => ipcRenderer.invoke('work:select-task', id),
  clearTasks: (projectId?: string): Promise<ProjectState> => ipcRenderer.invoke('work:clear-tasks', projectId),
  deleteTask: (id: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:delete-task', id),
  renameTask: (id: string, title: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:rename-task', id, title),
  renameProject: (id: string, name: string): Promise<ProjectState | null> => ipcRenderer.invoke('work:rename-project', id, name),
  openFolder: (projectId: string): Promise<boolean> => ipcRenderer.invoke('work:open-folder', projectId),
  removeProject: (projectId: string): Promise<{ state: ProjectState; removed: string } | null> => ipcRenderer.invoke('work:remove-project', projectId),
  projectOverview: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:project-overview'),
  // 某个空间里 mocode 终端留下的历史会话（只读列表），以及把其中一条接管成本空间的任务。
  projectSessions: (projectId: string): Promise<Array<{ id: string; createdAt: string; model: string; firstUser: string }>> =>
    ipcRenderer.invoke('work:project-sessions', projectId),
  adoptSession: (payload: { projectId: string; sessionId: string; title?: string }): Promise<{ ok: boolean; message?: string; state?: ProjectState; task?: Task; history?: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }> }> =>
    ipcRenderer.invoke('work:adopt-session', payload),
  readFile: (file: string): Promise<{ path?: string; content?: string; error?: string }> => ipcRenderer.invoke('work:read-file', file),
  fileDiff: (file: string): Promise<{ path?: string; content?: string; error?: string }> => ipcRenderer.invoke('work:file-diff', file),
  gitRepos: (target?: GitTarget): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:git-repos', { ...target }),
  gitStatus: (target?: GitTarget): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:git-status', { ...target }),
  gitDiff: (target: GitTarget, path: string, staged: boolean): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:git-diff', { ...target, path, staged }),
  gitStage: (target: GitTarget, paths?: string[]): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:git-stage', { ...target, paths }),
  gitUnstage: (target: GitTarget, paths?: string[]): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:git-unstage', { ...target, paths }),
  gitCommit: (target: GitTarget, message: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('work:git-commit', { ...target, message }),
  /** 历史视图：提交列表（分页，skip 用于「加载更多」）。 */
  gitLog: (target: GitTarget, options?: { limit?: number; skip?: number }): Promise<{ ok: boolean; commits: GitCommitLogEntry[]; truncated: boolean; message?: string }> =>
    ipcRenderer.invoke('work:git-log', { ...target, ...options }),
  /** 历史视图：某个提交改了哪些文件。 */
  gitCommitFiles: (target: GitTarget, sha: string): Promise<{ ok: boolean; files: GitCommitFileEntry[]; message?: string }> =>
    ipcRenderer.invoke('work:git-commit-files', { ...target, sha }),
  /** 历史视图：某个提交里某个文件的内容 + 该文件在这个提交里的 diff。 */
  gitCommitFile: (target: GitTarget, sha: string, path: string): Promise<{ ok: boolean; content?: string; diff?: string; binary?: boolean; truncated?: boolean; message?: string }> =>
    ipcRenderer.invoke('work:git-commit-file', { ...target, sha, path }),
  /** 「改动」面板：本任务的 changedFiles + 每文件相对 HEAD 的增删行数。 */
  taskChanges: (payload: { taskId?: string }): Promise<{ ok: boolean; files: Array<{ path: string; added: number; removed: number; untracked: boolean }>; truncated?: boolean; message?: string }> =>
    ipcRenderer.invoke('work:task-changes', payload),
  /** 「改动」面板里展开单个文件（与列表同一基准：HEAD）。 */
  taskChangeDiff: (payload: { taskId?: string; path: string }): Promise<{ ok: boolean; content?: string; truncated?: boolean; message?: string }> =>
    ipcRenderer.invoke('work:task-change-diff', payload),
  /** 「检查」面板：从 package.json 发现的校验命令（只读，点击后填进终端）。 */
  checks: (payload: { taskId?: string }): Promise<{ ok: boolean; packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun'; groups?: Array<{ label: string; dir: string; packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'; scripts: Array<{ name: string; command: string }> }>; message?: string }> =>
    ipcRenderer.invoke('work:checks', payload),
  pickAttachment: (): Promise<AttachmentResult[]> => ipcRenderer.invoke('work:pick-attachment'),
  readAttachments: (paths: string[]): Promise<AttachmentResult[]> => ipcRenderer.invoke('work:read-attachments', paths),
  droppedFilePaths: (files: File[]): string[] => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  getConfig: (): Promise<{ model: string; label: string; provider: 'openai' | 'anthropic'; promptCache: boolean; baseUrl: string; contextWindow: number | null; language: string; theme: string }> => ipcRenderer.invoke('work:get-config'),
  listModels: (): Promise<Array<{ name: string; label: string; provider: 'openai' | 'anthropic'; promptCache: boolean; baseURL: string; providerHost: string; contextWindow: number; isActive: boolean }>> => ipcRenderer.invoke('work:list-models'),
  switchModel: (name: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:switch-model', name),
  // 预设的增删改查。getModel 会返回 apiKey 明文（编辑表单需要回填），
  // 但只在主进程与本应用渲染层之间流转，不落日志。
  getModel: (name: string): Promise<{ ok: boolean; message?: string; preset?: ModelPresetDetail }> => ipcRenderer.invoke('work:get-model', name),
  saveModel: (payload: { name: string; originalName?: string; draft: ModelDraft; activate?: boolean }): Promise<{ ok: boolean; message: string; name?: string }> => ipcRenderer.invoke('work:save-model', payload),
  deleteModel: (name: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:delete-model', name),
  // 模型目录（models.dev）：load 拉全部可直发条目（refresh=true 强制联网刷新），
  // prefill 把选中条目变成表单预填草稿（apiKeySeed 已按 provider.env 从主进程 env 探测）。
  catalogLoad: (options?: { refresh?: boolean }): Promise<{ ok: boolean; message?: string; source?: string; fetchedAt?: string; total?: number; providerCount?: number; entries?: CatalogEntryView[] }> => ipcRenderer.invoke('work:catalog-load', options ?? {}),
  catalogPrefill: (pick: { providerId: string; modelId: string }): Promise<{ ok: boolean; message?: string; prefill?: CatalogPrefill; suggestedName?: string; providerName?: string; envKeys?: string[]; apiKeySeed?: string }> => ipcRenderer.invoke('work:catalog-prefill', pick),
  getSettings: (): Promise<Record<string, boolean | string>> => ipcRenderer.invoke('work:get-settings'),
  setSettings: (patch: Record<string, boolean | string>): Promise<Record<string, boolean | string>> => ipcRenderer.invoke('work:set-settings', patch),
  // ── 语音输入（本地 ASR）──
  // 模型 226MB，不进安装包：用户开启后由主进程下载到 userData。返回的都是「最新状态」快照，
  // 渲染层不需要自己维护权威状态，只按返回值重画。
  voiceStatus: (): Promise<VoiceStatus> => ipcRenderer.invoke('work:voice-status'),
  voiceDownload: (): Promise<{ ok: boolean; cancelled?: boolean; message?: string; status: VoiceStatus }> => ipcRenderer.invoke('work:voice-model-download'),
  voiceCancelDownload: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('work:voice-model-cancel'),
  voiceRemoveModel: (): Promise<{ ok: boolean; status: VoiceStatus }> => ipcRenderer.invoke('work:voice-model-remove'),
  voiceTranscribe: (payload: { samples: Float32Array; sampleRate: number }): Promise<{ ok: boolean; text?: string; message?: string }> => ipcRenderer.invoke('work:voice-transcribe', payload),
  onVoiceProgress: (callback: (progress: VoiceProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: VoiceProgress) => callback(payload);
    ipcRenderer.on('work:voice-progress', listener);
    return () => ipcRenderer.removeListener('work:voice-progress', listener);
  },
  // ── Skill 市场 / 扩展 ──
  skillsList: (projectRoot?: string): Promise<SkillItem[]> => ipcRenderer.invoke('work:skills-list', projectRoot),
  skillImportFolder: (): Promise<ImportResult> => ipcRenderer.invoke('work:skill-import-folder'),
  skillImportZip: (): Promise<ImportResult> => ipcRenderer.invoke('work:skill-import-zip'),
  skillImportGit: (url: string): Promise<ImportResult> => ipcRenderer.invoke('work:skill-import-git', url),
  skillsMarketLoad: (url: string, refresh?: boolean): Promise<MarketSkills> => ipcRenderer.invoke('work:skills-market-load', { url, refresh }),
  skillInstallMarket: (url: string, relDir: string): Promise<ImportResult> => ipcRenderer.invoke('work:skill-install-market', { url, relDir }),
  skillDelete: (dir: string, projectRoot?: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('work:skill-delete', dir, projectRoot),
  skillOpen: (dir: string): Promise<boolean> => ipcRenderer.invoke('work:skill-open', dir),
  // ── MCP 接入 ──
  mcpList: (): Promise<McpServerView[]> => ipcRenderer.invoke('work:mcp-list'),
  mcpSave: (payload: { name: string; originalName?: string; draft: McpDraft }): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:mcp-save', payload),
  mcpDelete: (name: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:mcp-delete', name),
  mcpToggle: (name: string, disabled: boolean): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:mcp-toggle', name, disabled),
  mcpImportJson: (text: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('work:mcp-import-json', text),
  mcpConfigPath: (): Promise<string> => ipcRenderer.invoke('work:mcp-config-path'),
  listBranches: (): Promise<{ ok: boolean; message: string; current: string; branches: string[] }> => ipcRenderer.invoke('work:list-branches'),
  switchBranch: (branch: string): Promise<{ ok: boolean; message: string; branch?: string }> => ipcRenderer.invoke('work:switch-branch', branch),
  setTheme: (theme: 'light' | 'dark' | 'system'): void => ipcRenderer.send('work:set-theme', theme),
  setTitleBarOverlay: (colors: { bg?: string; symbol: string }): void => ipcRenderer.send('work:set-titlebar-overlay', colors),
  setLanguage: (language: string): Promise<{ ok: boolean; language?: string; message?: string }> => ipcRenderer.invoke('work:set-language', language),
  // 回滚对话:把会话截断到指定用户消息之前(id + 该消息在当前会话里的序号)。
  rollback: (value: { id: string; userIndex: number }): Promise<{ ok: boolean; message?: string; state?: ProjectState; history?: HistoryItem[]; recovery?: RecoverySnapshot | null }> => ipcRenderer.invoke('work:rollback', value.id, value.userIndex),
  /**
   * 分叉会话：复制当前会话并在第 userIndex 轮之后截断，建一个绑到副本的新任务。
   * 返回的是**新任务**的 state / task / history，调用方据此直接跳过去。
   */
  forkTask: (value: { id: string; userIndex: number }): Promise<{ ok: boolean; message?: string; state?: ProjectState; task?: Task; history?: HistoryItem[]; recovery?: RecoverySnapshot | null }> =>
    ipcRenderer.invoke('work:fork-task', value.id, value.userIndex),
  send: (value: Record<string, unknown>): void => ipcRenderer.send('work:agent-send', value),
  /** 面板命令（会话 / 回滚 / 改动 / 用量 / 记忆 / 设置）；id 由渲染层生成，回执经 onAgentEvent 同 id 返回。 */
  panel: (value: Record<string, unknown>): Promise<{ ok: boolean; id?: string; message?: string }> =>
    ipcRenderer.invoke('work:panel', value),
  // ── 浏览器面板 ──
  // 页面本身是主进程的 WebContentsView（agent 要能通过 CDP 接管它），渲染层只送 bounds、
  // 画工具栏；状态（url/title/loading/前后退能力）由主进程推回来。
  browserShow: (payload: { projectId?: string; bounds: { x: number; y: number; width: number; height: number } }): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('work:browser-show', payload),
  browserHide: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('work:browser-hide'),
  browserNavigate: (url: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('work:browser-navigate', url),
  browserCommand: (command: 'back' | 'forward' | 'reload'): Promise<{ ok: boolean }> => ipcRenderer.invoke('work:browser-command', command),
  onBrowserState: (callback: (state: BrowserViewState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: BrowserViewState) => callback(payload);
    ipcRenderer.on('work:browser-state', listener);
    return () => ipcRenderer.removeListener('work:browser-state', listener);
  },
  // ── 终端面板 ──
  // PTY 在主进程（node-pty 是原生模块，渲染进程开着 contextIsolation + sandbox）；
  // 这里只收发字符串：按键过去、输出回来。
  terminalOpen: (payload: { projectId?: string; cols: number; rows: number }): Promise<{ ok: boolean; shell?: string; cwd?: string; cols?: number; rows?: number; reused?: boolean; replay?: string; message?: string }> =>
    ipcRenderer.invoke('work:terminal-open', payload),
  terminalWrite: (payload: { projectId?: string; data: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('work:terminal-write', payload),
  terminalResize: (payload: { projectId?: string; cols: number; rows: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('work:terminal-resize', payload),
  terminalClose: (payload: { projectId?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('work:terminal-close', payload),
  onTerminalData: (callback: (payload: { projectId: string; chunk: string }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: { projectId: string; chunk: string }) => callback(payload);
    ipcRenderer.on('work:terminal-data', listener);
    return () => ipcRenderer.removeListener('work:terminal-data', listener);
  },
  onTerminalExit: (callback: (payload: { projectId: string; exitCode: number }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: { projectId: string; exitCode: number }) => callback(payload);
    ipcRenderer.on('work:terminal-exit', listener);
    return () => ipcRenderer.removeListener('work:terminal-exit', listener);
  },
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
