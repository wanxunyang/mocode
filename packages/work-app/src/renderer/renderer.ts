import { PET_CHARACTERS } from '../pet-characters.js';
import { renderMarkdown, enhanceCodeBlocks, setMarkdownLabels } from './markdown.js';
// 正文里的文件路径 → 可点击入口（点击后在本应用的右侧面板里预览）。
import { isArtifactPath, linkifyFilePaths } from './file-links.js';
import { buildFileChange, renderFileChangeHtml, summarizeFileChange, type FileChangeLabels } from './diff-view.js';
import { buildToolView, type ToolViewLabels } from './tool-view.js';
import { hasSubAgentProgressLine, isSubAgentProgressLine } from '../sub-agent-progress.js';
import { renderUnifiedDiff } from './unified-diff.js';
import { mountIcons, icon } from './icons.js';
import { initPanels, handlePanelEvent, renderPanel, requestPanelCommand, type PanelKind } from './panels.js';
import { initSourceControl, refreshSourceControl, reopenSourceControl, closeSourceControl, type GitRepoView, type GitStatusView, type SourceControlTarget } from './source-control.js';
// 历史视图（只读）：提交泳道图 + 某提交的文件 + 文件内容/diff。
import { initHistory, refreshHistory, closeHistory, repaintHistory } from './history-panel.js';
// 浏览器面板：页面是主进程的 WebContentsView（CDP 里必须是 page 目标，agent 才能接管）。
import { initBrowserPanel, showBrowserPanel, hideBrowserPanel, rememberDevServerUrl, refreshBrowserPanelProject, refreshBrowserPanelLabels, type BrowserViewState } from './browser-panel.js';
// 终端面板：PTY 在主进程（node-pty 是原生模块），这里是 xterm 显示层。
import { initTerminalPanel, showTerminalPanel, hideTerminalPanel, refreshTerminalProject, refreshTerminalTheme, refreshTerminalLabels, fillTerminalCommand } from './terminal-panel.js';
import { t, getLang, setLang, onLangChange, applyStaticI18n, initLangFromConfig, MOD, SUPPORTED_LANGS, LANG_NAMES, type LocaleKey, type SupportedLang } from '../i18n/index.js';
import type { RecoverySnapshot, StreamNotice } from '../recovery-log.js';
import type { WorkAttachment, AttachmentResult, AttachmentErrorCode } from '../attachment-types.js';
import { parsePlan, planForRestore, type PlanSnapshot } from '../plan.js';
import { pendingByProject, pendingTasks } from '../attention.js';
import { planPanelHtml } from './plan-panel.js';
// 一轮跑完后摆在会话下方的「本轮改动」长条列表（结构纯函数，事件与语言由本文件提供）。
import { changesBarHtml, type ChangesBarFile, type ChangesBarLabels } from './changes-bar.js';
// 「检查」面板把 `pm run x` 拼成命令行：与主进程用同一份纯函数，避免两处拼法漂移。
import { checkCommand, type PackageManager } from '../checks.js';
// 空间内联区/展开区都要把「任务」与「终端会话」按时间混排：规则单独成纯函数，可单测。
import { splitSpaceEntries, isActiveTaskStatus, type SpaceEntry } from './space-entries.js';
import {
  reasoningCapabilityForPreset,
  type EffortValue,
  type ReasoningCapability,
  type WorkPresetDraft,
  type WorkPresetFile,
} from '../model-capabilities.js';

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
  // 计划面板的标题 / 提示 / aria 都按语言现取 → 就地重画一次。
  const plannedTask = viewingTaskId();
  if (plannedTask) syncPlanPanel(plannedTask);
  setRunning(isRunning(viewingTaskId()));
  updateContextUsage(streams.get(viewingTaskId() ?? '')?.contextUsage ?? null);
  refreshTokenUsage();
  // 系统提示行（「上下文已压缩」）是生成时按当时语言写死的文案 —— 结构存在 data-notice 里，
  // 这里就地按新语言重算一次，否则切语言后会话流里会残留旧语言的句子。
  relabelNotices();
  renderAttachments();
  // 改动清单卡片的标题 / title / aria 也是生成时写死的 → 就地按新语言重画一遍
  // （卡片挂在各自那条助手消息尾部，没法靠「清签名 + 重建」统一重生成）。
  relabelTurnChanges();
  // 轨道点的 title / aria-label 是生成时按当时语言写死的 → 强制重建一次。
  scheduleConvRail(true);
  refreshBrowserPanelLabels();
  refreshTerminalLabels();
  if (!inspector.classList.contains('hidden')) {
    if (activeInspectorTab === 'source') reopenSourceControl(inspectorContent);
    // 历史视图要原地重绘：refreshInspector 会从仓库列表重来，把用户正在看的
    //「某提交 / 某文件」弹回顶部列表。
    else if (activeInspectorTab === 'history') repaintHistory(inspectorContent);
    else if (activeInspectorTab === 'browser') inspectorTitle.textContent = t('tools.browser');
    else if (activeInspectorTab === 'terminal') inspectorTitle.textContent = t('tools.terminal');
    else void refreshInspector();
  }
}
onLangChange(() => applyLanguage());



type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type Project = { id: string; name: string; root: string; branch: string; auto?: boolean; sessionCount?: number };
/** 终端留下的历史会话（work:project-sessions 的返回项）。 */
type ProjectSession = { id: string; createdAt: string; model: string; firstUser: string; lastActiveAt?: string };
/** 各空间最近会话的批量快照（work:space-recent-sessions 的返回项）。 */
type SpaceRecentSessions = Array<{ projectId: string; sessions: ProjectSession[] }>;
type Task = { id: string; projectId: string; title: string; status: TaskStatus; sessionId?: string; changedFiles: string[]; createdAt: string; updatedAt: string; lastError?: string; plan?: TaskPlanProgress };
/** 侧栏任务行显示的计划进度（主进程写入，见 updateTaskFromAgent）。 */
type TaskPlanProgress = { title: string; done: number; total: number; allDone: boolean };
type WorkState = { version: 1; projects: Project[]; selectedProjectId: string; tasks: Task[]; selectedTaskId?: string };
type AgentEnvelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type Attachment = WorkAttachment;
type ImageAttachment = WorkAttachment & { dataUrl: string };
type HistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string; name?: string; arguments?: string; attachments?: Attachment[] };
type LlmProvider = 'openai' | 'anthropic';
type ModelConfig = { model: string; label: string; provider: LlmProvider; promptCache: boolean; baseUrl: string; contextWindow: number | null; language: string; theme: string };
type ModelItem = {
  name: string; label: string; provider: WorkPresetFile['provider']; promptCache: boolean;
  baseURL: string; providerHost: string; contextWindow: number; maxTokens?: number;
  reasoningEffort: EffortValue; reasoning: ReasoningCapability; isActive: boolean;
};
type ModelDraft = WorkPresetDraft;
type ModelPresetDetail = WorkPresetFile;
type CatalogEntryView = {
  providerId: string; providerName: string; modelId: string; name?: string;
  contextWindow: number; reasoning: boolean; toolCall: boolean; attachment: boolean; releaseDate?: string;
};
type CatalogPrefill = import('../catalog.js').CatalogPrefill;
type SkillOrigin = 'user' | 'claude' | 'project';
type SkillItem = { name: string; description: string; version?: string; dir: string; origin: SkillOrigin; modelInvocable: boolean; allowedTools?: string[] };
type ImportResult = { ok: boolean; message?: string; installed: Array<{ name: string; dir: string; updated: boolean }> };
type MarketSkills = { ok: boolean; message?: string; skills: Array<{ name: string; description: string; version?: string; relDir: string }> };
type McpTransport = 'stdio' | 'sse' | 'streamable-http';
type McpServerView = {
  name: string; transport: McpTransport;
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
  requestTimeoutMs?: number; disabled: boolean;
};
type McpDraft = {
  transport: McpTransport;
  command?: string; argsText?: string; envText?: string;
  url?: string; headersText?: string; requestTimeoutMs?: number;
};
/** 语音模型状态快照（主进程 voice/asr.ts 的 VoiceModelStatus + downloading）。 */
type VoiceStatus = { ready: boolean; bytes: number; dir: string; downloading?: boolean };
/** 模型下载进度（主进程 work:voice-progress 推送）。 */
type VoiceProgress = { receivedBytes: number; totalBytes: number; percent: number; file: string };
/** 「改动」面板的一行：任务记录里的 changedFiles + 相对 HEAD 的增删行数。 */
type TaskChangeFile = { path: string; added: number; removed: number; untracked: boolean };
/** 「检查」面板的一组（根包或一个 workspace 子包）。见 packages/work-app/src/checks.ts。 */
type CheckGroupView = { label: string; dir: string; packageManager: PackageManager; scripts: Array<{ name: string; command: string }> };

declare global {
  interface Window {
    mocodeWork: {
      /** 宿主平台（preload 透出的 process.platform），用于快捷键文案的修饰键写法。 */
      platform: string;
      getState: () => Promise<WorkState>;
      pickProject: () => Promise<WorkState | null>;
      selectProject: (id: string) => Promise<WorkState>;
      createTask: (title: string, projectId?: string) => Promise<{ state: WorkState; task: Task }>;
      setTaskProject: (id: string, projectId: string) => Promise<{ ok: boolean; message?: string; state?: WorkState; task?: Task }>;
      selectTask: (id: string) => Promise<{ state: WorkState; task: Task; history: HistoryItem[]; recovery: RecoverySnapshot | null } | null>;
      /** 回滚对话:会话截断到「第 userIndex 条用户消息」之前。 */
      rollback: (value: { id: string; userIndex: number }) => Promise<{ ok: boolean; message?: string; state?: WorkState; history?: HistoryItem[]; recovery?: RecoverySnapshot | null }>;
      /** 分叉会话:复制会话并保留到第 userIndex 轮结束,建一个新任务（返回它的 state/task/history）。 */
      forkTask: (value: { id: string; userIndex: number }) => Promise<{ ok: boolean; message?: string; state?: WorkState; task?: Task; history?: HistoryItem[]; recovery?: RecoverySnapshot | null }>;
      clearTasks: (projectId?: string) => Promise<WorkState>;
      deleteTask: (id: string) => Promise<WorkState | null>;
      renameTask: (id: string, title: string) => Promise<WorkState | null>;
      renameProject: (id: string, name: string) => Promise<WorkState | null>;
      openFolder: (projectId: string) => Promise<boolean>;
      /** 在系统文件管理器里定位一个文件（相对当前任务工作区或绝对路径）。 */
      revealFile: (file: string) => Promise<{ ok: boolean; path?: string; message?: string }>;
      removeProject: (projectId: string) => Promise<{ state: WorkState; removed: string } | null>;
      projectOverview: () => Promise<Record<string, unknown>>;
      /** 某个空间里 mocode 终端留下的历史会话（只读列表）。 */
      projectSessions: (projectId: string) => Promise<ProjectSession[]>;
      /** 各空间最近会话的一次性批量快照（侧栏内联区按时间与任务混排要用）。 */
      spaceRecentSessions: () => Promise<SpaceRecentSessions>;
      /** 把一条终端历史会话接管成本空间的任务（绑定 sessionId，续同一会话）。 */
      adoptSession: (payload: { projectId: string; sessionId: string; title?: string }) => Promise<{ ok: boolean; message?: string; state?: WorkState; task?: Task; history?: HistoryItem[] }>;
      readFile: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      fileDiff: (path: string) => Promise<{ path?: string; content?: string; error?: string }>;
      gitRepos: (target?: SourceControlTarget) => Promise<{ ok: boolean; repos: GitRepoView[]; message?: string }>;
      gitStatus: (target?: SourceControlTarget) => Promise<GitStatusView>;
      gitDiff: (target: SourceControlTarget, path: string, staged: boolean) => Promise<{ ok: boolean; content?: string; truncated?: boolean; message?: string }>;
      gitStage: (target: SourceControlTarget, paths?: string[]) => Promise<{ ok: boolean; message?: string; status?: GitStatusView }>;
      gitUnstage: (target: SourceControlTarget, paths?: string[]) => Promise<{ ok: boolean; message?: string; status?: GitStatusView }>;
      gitCommit: (target: SourceControlTarget, message: string) => Promise<{ ok: boolean; message?: string; status?: GitStatusView; commit?: string }>;
      /** 历史视图：提交列表分页（只读）。 */
      gitLog: (target: SourceControlTarget, options?: { limit?: number; skip?: number }) => Promise<{ ok: boolean; commits: Array<{ sha: string; shortSha: string; parents: string[]; author: string; email: string; date: string; refs: string[]; subject: string }>; truncated: boolean; message?: string }>;
      /** 历史视图：某个提交改了哪些文件。 */
      gitCommitFiles: (target: SourceControlTarget, sha: string) => Promise<{ ok: boolean; files: Array<{ path: string; previousPath?: string; code: string }>; message?: string }>;
      /** 历史视图：某个提交里某个文件的内容 + diff。 */
      gitCommitFile: (target: SourceControlTarget, sha: string, path: string) => Promise<{ ok: boolean; content?: string; diff?: string; binary?: boolean; truncated?: boolean; message?: string }>;
      /** 「改动」面板：本任务的 changedFiles + 每文件相对 HEAD 的增删行数。 */
      taskChanges: (payload: { taskId?: string }) => Promise<{ ok: boolean; files: TaskChangeFile[]; truncated?: boolean; message?: string }>;
      /** 「改动」面板里展开单个文件（与列表同一基准：HEAD）。 */
      taskChangeDiff: (payload: { taskId?: string; path: string }) => Promise<{ ok: boolean; content?: string; truncated?: boolean; message?: string }>;
      /** 输入框下面那行「本会话」token 消耗（读该会话的 usage.jsonl，不经过 host）。 */
      sessionUsage: (payload: { taskId?: string }) => Promise<{ ok: boolean; usage: SessionUsageTotals | null; message?: string }>;
      /** 「检查」面板：从 package.json 发现的校验命令（只读，点击后填进终端）。 */
      checks: (payload: { taskId?: string }) => Promise<{ ok: boolean; packageManager?: string; groups?: CheckGroupView[]; message?: string }>;
      pickAttachment: () => Promise<AttachmentResult[]>;
      readAttachments: (paths: string[]) => Promise<AttachmentResult[]>;
      droppedFilePaths: (files: File[]) => string[];
      getConfig: () => Promise<ModelConfig>;
      listModels: () => Promise<ModelItem[]>;
      switchModel: (name: string) => Promise<{ ok: boolean; message: string }>;
      getModel: (name: string) => Promise<{ ok: boolean; message?: string; preset?: ModelPresetDetail; reasoning?: ReasoningCapability }>;
      saveModel: (payload: { name: string; originalName?: string; draft: ModelDraft; activate?: boolean }) => Promise<{ ok: boolean; message: string; name?: string }>;
      deleteModel: (name: string) => Promise<{ ok: boolean; message: string }>;
      /** 模型目录（models.dev，快照与 mocode 终端共用）。refresh=true 强制联网刷新。 */
      catalogLoad: (options?: { refresh?: boolean }) => Promise<{ ok: boolean; message?: string; source?: string; fetchedAt?: string; total?: number; providerCount?: number; entries?: CatalogEntryView[] }>;
      catalogPrefill: (pick: { providerId: string; modelId: string }) => Promise<{ ok: boolean; message?: string; prefill?: CatalogPrefill; suggestedName?: string; providerName?: string; envKeys?: string[]; apiKeySeed?: string }>;
      /** ── Skill 市场 / 扩展 ── */
      skillsList: (projectRoot?: string) => Promise<SkillItem[]>;
      skillImportFolder: () => Promise<ImportResult>;
      skillImportZip: () => Promise<ImportResult>;
      skillImportGit: (url: string) => Promise<ImportResult>;
      skillsMarketLoad: (url: string, refresh?: boolean) => Promise<MarketSkills>;
      skillInstallMarket: (url: string, relDir: string) => Promise<ImportResult>;
      skillDelete: (dir: string, projectRoot?: string) => Promise<{ ok: boolean; message?: string }>;
      skillOpen: (dir: string) => Promise<boolean>;
      /** ── MCP 接入 ── */
      mcpList: () => Promise<McpServerView[]>;
      mcpSave: (payload: { name: string; originalName?: string; draft: McpDraft }) => Promise<{ ok: boolean; message: string }>;
      mcpDelete: (name: string) => Promise<{ ok: boolean; message: string }>;
      mcpToggle: (name: string, disabled: boolean) => Promise<{ ok: boolean; message: string }>;
      mcpImportJson: (text: string) => Promise<{ ok: boolean; message: string }>;
      mcpConfigPath: () => Promise<string>;
      getSettings: () => Promise<Record<string, boolean | string>>;
      setSettings: (patch: Record<string, boolean | string>) => Promise<Record<string, boolean | string>>;
      /** ── 语音输入（本地 ASR）── */
      voiceStatus: () => Promise<VoiceStatus>;
      voiceDownload: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string; status: VoiceStatus }>;
      voiceCancelDownload: () => Promise<{ ok: boolean }>;
      voiceRemoveModel: () => Promise<{ ok: boolean; status: VoiceStatus }>;
      voiceTranscribe: (payload: { samples: Float32Array; sampleRate: number }) => Promise<{ ok: boolean; text?: string; message?: string }>;
      onVoiceProgress: (callback: (progress: VoiceProgress) => void) => () => void;
      listBranches: () => Promise<{ ok: boolean; message: string; current: string; branches: string[] }>;
      switchBranch: (branch: string) => Promise<{ ok: boolean; message: string; branch?: string }>;
      setTheme: (theme: 'light' | 'dark' | 'system') => void;
      setTitleBarOverlay: (colors: { bg?: string; symbol: string }) => void;
      setLanguage: (language: string) => Promise<{ ok: boolean; language?: string; message?: string }>;
      send: (value: Record<string, unknown>) => void;
      /** 面板命令（会话/回滚/改动/用量/记忆/设置）；id 由渲染层生成，回执经 onAgentEvent 同 id 返回。 */
      panel: (value: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; message?: string }>;
      onAgentEvent: (callback: (event: AgentEnvelope) => void) => () => void;
      onState: (callback: (state: WorkState) => void) => () => void;
      /** ── 浏览器面板（页面是主进程的 WebContentsView，这里只送 bounds 与命令）── */
      browserShow: (payload: { projectId?: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean; message?: string }>;
      browserHide: () => Promise<{ ok: boolean }>;
      browserNavigate: (url: string) => Promise<{ ok: boolean; message?: string }>;
      browserCommand: (command: 'back' | 'forward' | 'reload') => Promise<{ ok: boolean }>;
      onBrowserState: (callback: (state: BrowserViewState) => void) => () => void;
      /** ── 终端面板（PTY 在主进程，这里只收发字符串）── */
      terminalOpen: (payload: { projectId?: string; cols: number; rows: number }) => Promise<{ ok: boolean; shell?: string; cwd?: string; cols?: number; rows?: number; reused?: boolean; replay?: string; message?: string }>;
      terminalWrite: (payload: { projectId?: string; data: string }) => Promise<{ ok: boolean }>;
      terminalResize: (payload: { projectId?: string; cols: number; rows: number }) => Promise<{ ok: boolean }>;
      terminalClose: (payload: { projectId?: string }) => Promise<{ ok: boolean }>;
      /** 读系统剪贴板纯文本（终端面板右键粘贴用；渲染进程没有 clipboard-read 权限）。 */
      clipboardRead: () => Promise<string>;
      /** 写系统剪贴板（终端复制用；渲染层的 clipboard 写入在文档失焦时失败）。 */
      clipboardWrite: (text: string) => Promise<{ ok: boolean }>;
      onTerminalData: (callback: (payload: { projectId: string; chunk: string }) => void) => () => void;
      onTerminalExit: (callback: (payload: { projectId: string; exitCode: number }) => void) => () => void;
    };
  }
}

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const taskList = $('#task-list'); const conversation = $('#conversation');
const emptyState = $('#empty-state'); const approvalPanel = $('#approval-panel'); const promptInput = $('#prompt') as HTMLTextAreaElement;
const sendButton = $('#send-button') as HTMLButtonElement; const inspector = $('#inspector'); const inspectorContent = $('#inspector-content');
const inspectorTitle = $('#inspector-title'); const inspectorTabs = $('#inspector-tabs');
const attachmentList = $('#attachment-list'); const searchPanel = $('#search-panel'); const searchInput = $('#search-input') as HTMLInputElement;
const contextUsageEl = $('#context-usage') as HTMLButtonElement;
const contextUsagePopover = $('#context-usage-popover');
/** 输入框下方那行 token 消耗（本轮实时 + 本会话累计）。 */
const tokenUsageEl = $('#token-usage') as HTMLElement;
const convRail = $('#conv-rail') as HTMLElement;
const planPanel = $('#plan-panel') as HTMLElement;
const attentionBar = $('#attention-bar') as HTMLElement;
const attentionBadge = $('#attention-badge') as HTMLButtonElement;
/**
 * 收到 run_changed_files 时要挂卡片的那条助手消息。
 *
 * 为什么不在收到事件时取「最后一条 assistant」：改动清单是主进程跑完一次 git 统计之后
 * 才异步下发的，那期间用户可能已经发了下一轮、屏尾已经多出一条新的空消息 —— 卡片就会
 * 挂到错误的那一轮上。run_completed 那一刻先记住，回来时只认它。
 */
let pendingChangesTurn: HTMLElement | null = null;

let state: WorkState | null = null;
let collapsedProjects: Set<string> = new Set();
let collapsedSections: Set<string> = new Set();
let activeAssistant: HTMLElement | null = null;
let activeTextBlock: HTMLElement | null = null;
let attachments: Attachment[] = [];
/** 检查器视图：一个视图只承载一个工具，由工具箱菜单切换（不再有页签条）。 */
type InspectorTab = 'files' | 'source' | 'history' | 'browser' | 'terminal' | 'changes' | 'checks' | 'file';
let activeInspectorTab: InspectorTab = 'files';
/**
 * 当前预览的文件路径（activeInspectorTab === 'file' 时的事实源）。
 * 单独存一份的理由：refreshInspector 是「按 tab 重画」的，切语言、重开面板都会再进来一次，
 * 没有它就没法复原用户正在看的那份文档。
 */
let previewFilePath: string | null = null;
/**
 * 当前是否 plan 模式（只读探查 + 出方案）。事实源在 host（进程级状态），
 * 这里只是它推回来的镜像：切任务不回退、重启后回 auto（host 新建时即 auto）。
 */
let planMode = false;

/* ── 多任务并行:每个任务一份事件流缓冲,后台任务照常累积,随时切换查看 ── */
type StreamItem =
  | { kind: 'user'; text: string; attachments?: Attachment[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; output: string; done: boolean; payload?: Record<string, unknown> }
  | { kind: 'error'; message: string }
  /** 系统提示行（「上下文已压缩」等）：不是错误也不是模型输出，但必须在会话流里留痕。 */
  | { kind: 'notice'; notice: StreamNotice }
  /** 这一轮改过的文件：挂在那一轮助手消息的尾部，每轮各留一份。 */
  | { kind: 'changes'; files: ChangesBarFile[] };
interface ContextUsageSnapshot {
  tokens: number;
  window: number;
  remaining: number;
  percent: number;
  messages: number;
  cachedTokens?: number;
  source: 'measured' | 'estimated';
}
interface TaskStream {
  items: StreamItem[];
  running: boolean;
  contextUsage: ContextUsageSnapshot | null;
  /** 本轮（一次 run）累计消耗，live_usage 流式刷新；run 结束后保留最后一次的最终值。 */
  turnUsage: TurnUsage | null;
  /** 会话累计的文件快照（usage.jsonl，切任务与每轮结束后重取）。 */
  sessionUsage: SessionUsageTotals | null;
  /** 快照是否要比「本轮增量」再加一遍：只有本渲染层发起这一轮时才是 true（见 sessionDisplayTotals）。 */
  sessionAddsTurn: boolean;
  pendingApproval: Record<string, unknown> | null;
  /** 最近一次 agent 状态 —— 切回这个任务时状态行按它还原(见 renderStatus)。 */
  status: AgentStatusState | null;
  /** 本轮起点,用于终态里的「用时 Ns」。 */
  startedAt: number | null;
  /** 从崩溃/中止日志恢复的现场；只展示，不恢复可执行审批或自动重跑。 */
  interrupted?: boolean;
  /** 最新一份执行计划（plan_update 的入参解析结果）—— 顶部计划面板的唯一事实源。 */
  plan: PlanSnapshot | null;
  /** 用户手动关闭 / 完成后自动收起：同一份计划(identity)不再弹出，换新计划才重开。 */
  planDismissed?: boolean;
  /** 步骤清单是否展开。默认收起 —— 一行就够看清「在做什么」，细节按需展开。 */
  planExpanded?: boolean;
  /** 完成态的停留计时器：全部完成先展示再收起，不瞬间消失。 */
  planTimer?: ReturnType<typeof setTimeout> | null;
}
const streams = new Map<string, TaskStream>();

function streamFor(taskId: string): TaskStream {
  let stream = streams.get(taskId);
  if (!stream) {
    stream = {
      items: [], running: false, contextUsage: null, turnUsage: null, sessionUsage: null, sessionAddsTurn: false,
      pendingApproval: null, status: null, startedAt: null, plan: null,
    };
    streams.set(taskId, stream);
  }
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

/* ── 计划进度面板（plan_update）──────────────────────────────
 * 位置：.thread 内、#conversation 之上（不进滚动盒）—— 计划是「这次任务做到哪一步」的
 * 全局状态，跟着消息滚走就等于没有。切任务、崩溃恢复后都能一眼看到。
 *
 * 三条产品约束（用户定的）：
 *   1. 实时：tool_started 就按入参渲染，不等 tool_completed（工具的入参里已是完整计划）；
 *   2. 常驻：同一份计划反复更新只刷新同一块，不在会话流里堆一串卡片；
 *   3. 全部完成 → 先显示完成态，再自动关闭；用户手动关掉的计划不因进度更新再弹出来，
 *      只有换了一份新计划（identity 变化）才重新出现。
 */
/** 全部完成后完成态在屏幕上停留多久 —— 够看清「全绿了」，又不是赖着不走。 */
const PLAN_DONE_LINGER_MS = 2400;

/**
 * 吃一条 plan_update 的工具入参。name 不是 plan_update 或解析不出完整计划时直接忽略
 * （工具本身会以「steps 不能为空」失败，面板不该显示半份计划）。
 */
function ingestPlan(
  taskId: string,
  stream: TaskStream,
  viewing: boolean,
  payload: Record<string, unknown>,
  args: string,
): void {
  if (String(payload.name ?? '') !== 'plan_update') return;
  const parsed = parsePlan(args);
  if (!parsed || (stream.plan && stream.plan.signature === parsed.signature)) return;
  // 换了一份计划 → 之前的手动关闭作废；同一条计划只是进度变了，保持关闭状态不重开。
  if (!stream.plan || stream.plan.identity !== parsed.identity) stream.planDismissed = false;
  stream.plan = parsed;
  if (stream.planTimer) { clearTimeout(stream.planTimer); stream.planTimer = null; }
  if (parsed.allDone && !stream.planDismissed) {
    stream.planTimer = setTimeout(() => {
      stream.planTimer = null;
      stream.planDismissed = true;
      if (viewingTaskId() === taskId) syncPlanPanel(taskId);
    }, PLAN_DONE_LINGER_MS);
  }
  if (viewing) syncPlanPanel(taskId);
}

/** 从事件缓冲里找最后一份可解析的 plan_update（切任务 / 崩溃恢复用）。 */
function planFromItems(items: readonly StreamItem[] | undefined): PlanSnapshot | null {
  if (!items) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== 'tool' || item.name !== 'plan_update') continue;
    const plan = parsePlan(item.args);
    if (plan) return plan;
  }
  return null;
}

/** 从会话历史里找最后一份可解析的 plan_update（重启后打开旧任务，没有事件缓冲）。 */
function planFromHistory(history: HistoryItem[] | undefined): PlanSnapshot | null {
  if (!history) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    if (item.role !== 'tool' || item.name !== 'plan_update') continue;
    const plan = parsePlan(item.arguments ?? '');
    if (plan) return plan;
  }
  return null;
}

/** 面板显示与否的唯一判定点：写视图只从这里走，避免两处各判一半。 */
function syncPlanPanel(taskId: string): void {
  const stream = streams.get(taskId);
  const plan = stream?.plan ?? null;
  if (!stream || !plan || stream.planDismissed || viewingTaskId() !== taskId) {
    planPanel.classList.add('hidden');
    planPanel.innerHTML = '';
    return;
  }
  renderPlanPanel(taskId, stream, plan);
}

function renderPlanPanel(taskId: string, stream: TaskStream, plan: PlanSnapshot): void {
  const entering = planPanel.classList.contains('hidden');
  const expanded = stream.planExpanded === true;
  // 完成态与进行中都用同一行：标题（在做什么）+ 当前步 / 完成提示 + n/m。
  // 结构交给 plan-panel.ts 的纯函数（可单测），这里只负责语言、事件与显隐。
  planPanel.innerHTML = planPanelHtml(plan, expanded, {
    expand: t('plan.expand'),
    collapse: t('plan.collapse'),
    dismiss: t('plan.dismiss'),
    progress: t('plan.progress', { done: plan.done, total: plan.total }),
    subtitle: plan.allDone ? t('plan.doneHint', { n: plan.total }) : plan.currentLabel ?? '',
  });
  planPanel.classList.remove('hidden');
  // 入场动画只在这一块「刚出现」时播一次；进度更新会重建 innerHTML，否则每次都会闪。
  planPanel.classList.toggle('is-entering', entering);
  planPanel.querySelector('.plan-head-main')?.addEventListener('click', () => {
    stream.planExpanded = !stream.planExpanded;
    syncPlanPanel(taskId);
  });
  planPanel.querySelector('.plan-dismiss')?.addEventListener('click', () => {
    if (stream.planTimer) { clearTimeout(stream.planTimer); stream.planTimer = null; }
    stream.planDismissed = true;
    syncPlanPanel(taskId);
  });
}

/* ── 本轮改动清单（挂在每条助手消息的尾部）─────────────────────
 * 语义：每一轮 agent 跑完，把**这一轮**改过的文件一条条摆出来，点一条看该文件的 diff。
 * 为什么挂在消息里、而不是会话下方的一条全局卡片：只留最新一轮的话，问到第二轮时
 * 第一轮改了什么就查不到了 —— 而「这次回答顺手动了哪几个文件」本来属于那一条回答本身。
 * 逐轮保留之后，往回翻聊天记录就能看到每轮的手笔。
 *
 * 数据源：主进程在 run_completed 之后立刻取一次 gitFileStats 快照，作为 run_changed_files
 * 事件下发并落进恢复日志（见 main.ts 的 announceChangedFiles）。行数必须是「那一轮当时」的值 ——
 * 事后按 HEAD 重算出来的是累计差异，历史轮次甚至会因后续提交归零。
 */
const changesBarLabels = (): ChangesBarLabels => ({
  title: (n) => t('changesBar.title', { n: String(n) }),
  all: t('changesBar.all'),
  untracked: t('changes.untracked'),
  open: (path) => t('changesBar.open', { path }),
  collapse: t('changesBar.collapse'),
  expand: t('changesBar.expand'),
});

/** 会话流里最后一条助手消息 —— 本轮改动清单就挂在它尾部。 */
function lastAssistantTurn(): HTMLElement | null {
  const all = conversation.querySelectorAll<HTMLElement>('.message.assistant');
  return all[all.length - 1] ?? null;
}

/** 事件 / 恢复日志里的文件清单 → 卡片可用的形状（坏数据一律跳过）。 */
function changeFilesFrom(raw: unknown): ChangesBarFile[] {
  if (!Array.isArray(raw)) return [];
  const files: ChangesBarFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path) continue;
    files.push({
      path: record.path,
      added: typeof record.added === 'number' && Number.isFinite(record.added) ? record.added : 0,
      removed: typeof record.removed === 'number' && Number.isFinite(record.removed) ? record.removed : 0,
      untracked: record.untracked === true,
    });
  }
  return files;
}

/**
 * 画一张「本轮改动」卡片。
 *
 * `expanded` 存在容器自己的 dataset 上而不是模块级单例：每轮各一张卡片，收起 A 轮
 * 不该影响 B 轮（早先那条全局长条只有一个开关，是因为那时只显示最新一轮）。
 * 重画而非只切 class —— 开合状态同时决定 caret 方向与 aria-expanded。
 */
function paintTurnChanges(container: HTMLElement, taskId: string, files: ChangesBarFile[]): void {
  const expanded = container.dataset.expanded !== '0';
  container.innerHTML = changesBarHtml(files, expanded, changesBarLabels());
  mountIcons(container);
  container.querySelectorAll<HTMLButtonElement>('[data-change-path]').forEach((row) => {
    row.addEventListener('click', () => openChangeDiff(taskId, row.dataset.changePath ?? ''));
  });
  container.querySelector('[data-changes-all]')?.addEventListener('click', () => openInspector('changes'));
  // 标题行整行都是折叠开关（「全部改动」在它右边，不共用点击区）。
  container.querySelector('[data-changes-toggle]')?.addEventListener('click', () => {
    container.dataset.expanded = expanded ? '0' : '1';
    paintTurnChanges(container, taskId, files);
  });
}

/** 把改动清单挂到某条助手消息尾部；同一轮再次到来时原地重画，不叠第二张。 */
function attachTurnChanges(turn: HTMLElement | null, taskId: string, files: ChangesBarFile[]): void {
  if (!turn || !files.length) return;
  // 挂在正文容器里（正文 / 工具行之后）：它是这一轮回答的收尾，不是独立的一段消息。
  // 落到 .message 上会被 grid 摆到操作按钮那一行，还得为「没改文件的轮次」多留一个空行。
  const host = turn.querySelector<HTMLElement>('.message-content') ?? turn;
  let container = host.querySelector<HTMLElement>('.message-changes');
  if (!container) {
    container = document.createElement('div');
    container.className = 'message-changes is-entering';
    host.append(container);
    // 入场动画只播一次：折叠 / 展开与本轮重画都走 paintTurnChanges，不该再闪一遍。
    container.addEventListener('animationend', () => container!.classList.remove('is-entering'), { once: true });
  }
  // 数据同时留在 dataset 上：切语言要按新文案重画，而那次重画没有事件可用。
  container.dataset.taskId = taskId;
  container.dataset.changes = JSON.stringify(files);
  paintTurnChanges(container, taskId, files);
}

/** 切语言：卡片文案是生成时写死的，就地按新语言重画每一张（文件清单从 dataset 里取回来）。 */
function relabelTurnChanges(): void {
  for (const container of Array.from(conversation.querySelectorAll<HTMLElement>('.message-changes'))) {
    const raw = container.dataset.changes;
    if (!raw) continue;
    try { paintTurnChanges(container, container.dataset.taskId ?? '', changeFilesFrom(JSON.parse(raw))); } catch { /* 坏数据保持原样 */ }
  }
}

/**
 * 老会话兜底：恢复日志里还没有本轮改动快照（这个能力之前存下的会话）时，
 * 按任务记录的 changedFiles 现取一次统计补一张。数字是「此刻 vs HEAD」的累计值 ——
 * 与「改动」面板同口径，聊胜于无；新会话一律走 run_changed_files 的逐轮快照。
 */
function restoreLegacyChanges(taskId: string): void {
  const task = state?.tasks.find((item) => item.id === taskId);
  const paths = (task?.changedFiles ?? []).filter((path) => typeof path === 'string' && path !== '');
  if (!paths.length) return;
  void (async () => {
    const result = await window.mocodeWork.taskChanges({ taskId });
    // 期间切了任务 / 又跑完一轮：这份数据已经不属于屏上那条消息。
    if (viewingTaskId() !== taskId) return;
    const files = result.ok && result.files?.length
      ? result.files
      : paths.map((path) => ({ path, added: 0, removed: 0, untracked: false }));
    attachTurnChanges(lastAssistantTurn(), taskId, files);
  })();
}

/**
 * 打开右侧面板看某个文件的改动（长条点击）。
 *
 * 走「改动」面板那套逐文件 diff：先把它需要的视图前置条件摆好（面板可见、浏览器 / 终端
 * 让位、页签同步），再直接铺这一条 —— 不能让 refreshInspector 先画一遍列表再被覆盖，
 * 那会出现「点一下先闪一下列表」。
 */
function openChangeDiff(taskId: string, path: string): void {
  if (!path) return;
  activeInspectorTab = 'changes';
  inspector.classList.remove('hidden');
  inspectorContent.classList.remove('hidden');
  hideBrowserPanel();
  hideTerminalPanel();
  syncScmTabs();
  closeSourceControl();
  closeHistory();
  void showChangeDiff(taskId, path);
}

/* ── 需要人工介入：标题栏徽章 + 会话区横条 ──────────────────
 * 为什么两处都要：审批卡本身是浮在会话底部的浮层，用户往上翻历史 / 在看别的任务时就
 * 完全不知道 agent 已经停在那儿等人。侧栏只能提示「哪个任务」，徽章回答「有几个」，
 * 横条回答「当前这个在等什么」。三者都从 attention.ts + stream.pendingApproval 读，不另存状态。
 */

/** 标题栏「N 个待处理」+ 当前任务横条的唯一写入口。 */
function syncAttention(): void {
  const pending = pendingTasks(state?.tasks ?? []);
  // ── 标题栏徽章：跨任务的总数（窗口最外层，任何视图下都在）──
  attentionBadge.classList.toggle('hidden', pending.length === 0);
  if (pending.length) {
    const badgeText = t('attention.badge', { n: pending.length });
    if (attentionBadge.textContent !== badgeText) attentionBadge.textContent = badgeText;
    const badgeTitle = t('attention.badgeTitle', { n: pending.length });
    attentionBadge.title = badgeTitle;
    attentionBadge.setAttribute('aria-label', badgeTitle);
  }
  // ── 会话区横条：只看当前任务在等什么 ──
  const viewing = viewingTaskId();
  const stream = viewing ? streams.get(viewing) : undefined;
  const approval = stream?.pendingApproval ?? null;
  if (!viewing || !approval || stream?.running !== true) {
    attentionBar.classList.add('hidden');
    attentionBar.innerHTML = '';
    return;
  }
  const entering = attentionBar.classList.contains('hidden');
  // 审批 / 提问的标题就是「在等什么」—— 模型给的文案比任何通用措辞都准确。
  const title = String(approval.title ?? '').trim() || t('approval.default');
  attentionBar.innerHTML =
    `<span class="attention-bar-icon">${icon('warn')}</span>` +
    `<span class="attention-bar-body"><b class="attention-bar-title">${escapeHtml(t('attention.barTitle'))}</b>` +
    `<span class="attention-bar-detail">${escapeHtml(title)}</span></span>` +
    `<span class="attention-bar-hint">${escapeHtml(t('attention.barHint'))}</span>` +
    `<button class="attention-bar-jump" type="button">${escapeHtml(t('attention.jump'))}</button>`;
  attentionBar.classList.remove('hidden');
  // 与计划面板同一套入场动画语义：只在「刚出现」时播一次。
  attentionBar.classList.toggle('is-entering', entering);
  // 点横条（或「前往处理」）都把审批卡重新摆到用户眼前：它可能因切任务 / 滚动而不可见。
  // 用 onclick 赋值而不是 addEventListener：横条每同步一次都会重跑这里，
  // addEventListener 会累积一串同名监听（点一下弹多次、闭包里还握着旧的 taskId）。
  attentionBar.onclick = () => {
    const payload = streams.get(viewing)?.pendingApproval;
    if (!payload) return;
    // 横条 / 「前往处理」的语义就是「现在去回答」：用户可能刚把卡片收起在读正文，
    // 这里必须反向展开，否则点了看起来没反应（卡片只是被重画成收起态）。
    showApproval(viewing, payload, { expand: true });
    approvalPanel.scrollIntoView({ block: 'nearest' });
    approvalPanel.querySelector<HTMLTextAreaElement>('.approval-input')?.focus();
  };
}

/**
 * 跳到「最久等待」的那个任务（标题栏徽章、系统通知回执都走这里）。
 * 打开任务后若审批卡没被摆出来（比如缓存流里刚被清过），再补一次。
 */
async function jumpToPendingTask(taskId?: string): Promise<void> {
  const target = taskId ?? pendingTasks(state?.tasks ?? [])[0]?.id;
  if (!target) return;
  if (viewingTaskId() !== target) await openTask(target);
  const stream = streams.get(target);
  if (stream?.pendingApproval && stream.running) showApproval(target, stream.pendingApproval);
  syncAttention();
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
  let messageEl = currentTurn();
  if (!messageEl) {
    // 压缩提示行会把当前轮封口并置空 activeAssistant（见 sealTurn）：此时错误属于「后半轮」，
    // 必须另起一条 —— 否则「压完就失败」在会话流里只剩提示行，失败原因只有 3 秒 toast。
    const tail = conversation.lastElementChild;
    const messages = conversation.querySelectorAll<HTMLElement>('.message');
    const afterNotice = tail instanceof HTMLElement && tail.classList.contains('thread-notice');
    if (!afterNotice && !messages[messages.length - 1]?.classList.contains('is-sealed')) return;
    messageEl = startAssistantTurn();
  }
  const content = messageEl.querySelector('.message-content');
  if (!content || content.querySelector('.message-error')) return;
  const block = document.createElement('div');
  block.className = 'message-error';
  block.textContent = message;
  content.append(block);
  if (isAtBottom()) smartScrollToBottom(true);
}

/**
 * 系统提示行（「上下文已压缩」这类）。
 *
 * 与 showTurnError 的区别：它不是某一轮的失败，而是**会话里发生过的一件事**——所以不挂进
 * 助手消息，直接追加到会话流；也不属于任何 turn，finalizeTurn 收口时不会把它带走。
 * 文案按结构现算（notice 只存数据），切语言时和恢复日志重放都能得到当前语言的句子。
 */
function noticeText(notice: StreamNotice): string {
  if (notice.type === 'contextCompacted') {
    const before = typeof notice.beforeTokens === 'number' ? notice.beforeTokens : null;
    const after = typeof notice.afterTokens === 'number' ? notice.afterTokens : null;
    const window = typeof notice.windowTokens === 'number' && notice.windowTokens > 0 ? notice.windowTokens : null;
    const pct = (n: number): string => `${Math.round((n / (window ?? 1)) * 100)}%`;
    const detail = before !== null && after !== null
      ? window
        ? t('notice.contextCompacted', {
            before: tokenShort(before), after: tokenShort(after), beforePct: pct(before), afterPct: pct(after),
          })
        : t('notice.contextCompactedPlain', { before: tokenShort(before), after: tokenShort(after) })
      : t('notice.contextCompactedShort');
    return notice.manual ? t('notice.contextCompactedManual', { detail }) : detail;
  }
  return '';
}

/** 与终端 fmtCompactTokens 同一口径：<1k 整数、<10k 一位小数 k、≥100k 用 M。 */
function tokenShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
}

/**
 * 把当前轮「就地封口」:提示行要插在它下面,而后续输出必须另起一条消息。
 *
 * 不做完整的 finalizeTurn —— 那一轮还在跑,挂上复制 / 重新生成 / 分叉按钮会让它看起来已经结束。
 * 只做三件必须做的事:把待渲染的文字段渲染成 markdown、摘掉流式光标、丢掉一个字都没吐的空轮次。
 * 返回**已经封好口**的消息(仍留在会话流里),没什么可封口时返回 null。
 */
function sealTurn(): HTMLElement | null {
  const message = currentTurn();
  if (!message) return null;
  message.classList.remove('is-streaming');
  if (mdRenderTimer !== null) { clearTimeout(mdRenderTimer); mdRenderTimer = null; pendingMdBlocks.clear(); }
  for (const block of Array.from(message.querySelectorAll<HTMLElement>('.message-body'))) {
    const text = textBlockRaw.get(block) ?? block.textContent ?? '';
    if (!text.trim()) { block.remove(); continue; }
    renderMessageBody(block, text);
  }
  // 与 finalizeTurn 同一条判据:有点内容才留(工具行 / 错误行也算),否则收掉这个空气泡。
  const hasContent = !!message.querySelector('.message-body') || !!message.querySelector('.tool-entry') || !!message.querySelector('.message-error');
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  if (!hasContent) { message.remove(); return null; }
  message.dataset.sealed = '1';
  // 前半轮不是一次完整的回答:不挂复制 / 重新生成 / 分叉按钮(见 style.css 的 is-sealed)。
  message.classList.add('is-sealed');
  return message;
}

function addNotice(notice: StreamNotice): void {
  const text = noticeText(notice);
  if (!text) return;
  // 提示行是会话流的兄弟节点,而后续文字 / 工具仍会写进上面那条 assistant 消息内部 ——
  // 不封口的话它们被追加到提示行**上面**,提示行于是永远吊在整轮输出的最底部(用户报的就是这个)。
  // 封口后 resumableTurn 不再认领这条消息,后半轮另起一条,顺序变成「前半轮 → 提示行 → 后半轮」。
  sealTurn();
  const block = document.createElement('div');
  block.className = 'thread-notice';
  block.dataset.notice = JSON.stringify(notice);
  block.textContent = text;
  emptyState.classList.add('hidden');
  conversation.appendChild(block);
  if (isAtBottom()) smartScrollToBottom(true);
}

/** 切语言后就地重算会话流里的系统提示行（结构留在 data-notice，不重新落盘）。 */
function relabelNotices(): void {
  for (const block of Array.from(conversation.querySelectorAll<HTMLElement>('.thread-notice'))) {
    const raw = block.dataset.notice;
    if (!raw) continue;
    try { block.textContent = noticeText(JSON.parse(raw) as StreamNotice); } catch { /* 坏数据保持原样 */ }
  }
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

function parseContextUsage(value: unknown): ContextUsageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const numbers = ['tokens', 'window', 'remaining', 'percent', 'messages'] as const;
  if (numbers.some((key) => typeof usage[key] !== 'number' || !Number.isFinite(usage[key]))) return null;
  if (usage.source !== 'measured' && usage.source !== 'estimated') return null;
  return {
    tokens: usage.tokens as number,
    window: usage.window as number,
    remaining: usage.remaining as number,
    percent: usage.percent as number,
    messages: usage.messages as number,
    ...(typeof usage.cachedTokens === 'number' ? { cachedTokens: usage.cachedTokens } : {}),
    source: usage.source,
  };
}

function contextUsageDetails(usage: ContextUsageSnapshot): string {
  const number = (value: number): string => Math.max(0, Math.round(value)).toLocaleString();
  const source = t(usage.source === 'measured' ? 'composer.contextMeasured' : 'composer.contextEstimated');
  const note = t(usage.source === 'measured' ? 'composer.contextMeasuredNote' : 'composer.contextEstimatedNote');
  const row = (label: string, value: string): string => `<div class="context-usage-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  return `<div class="context-usage-heading"><span>${escapeHtml(t('composer.contextUsage'))}</span><b>${usage.percent}%</b></div>
    <div class="context-usage-meter" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, usage.percent))}%"></span></div>
    ${row(t('composer.contextUsed'), `${number(usage.tokens)} tokens`)}
    ${row(t('composer.contextWindow'), `${number(usage.window)} tokens`)}
    ${row(t('composer.contextRemaining'), `${number(usage.remaining)} tokens`)}
    ${row(t('composer.contextMessages'), number(usage.messages))}
    ${typeof usage.cachedTokens === 'number' ? row(t('composer.contextCached'), `${number(usage.cachedTokens)} tokens`) : ''}
    <div class="context-usage-source">${escapeHtml(source)}</div>
    <div class="context-usage-note">${escapeHtml(note)}</div>`;
}

/** 一轮 run 的累计消耗（live_usage 的 promptTokens 是**本轮累计**，不是上下文占用）。 */
interface TurnUsage { prompt: number; completion: number; cached: number; }
/** 主进程读 usage.jsonl 汇出来的会话累计（见 packages/work-app/src/usage.ts）。 */
interface SessionUsageTotals {
  input: number; output: number; cached: number; reasoning: number; cacheCreation: number;
  calls: number; source: 'session' | 'ledger' | 'none';
}

function parseTurnUsage(value: Record<string, unknown>): TurnUsage | null {
  const prompt = value.promptTokens;
  const completion = value.completionTokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  const cached = typeof value.cachedTokens === 'number' && Number.isFinite(value.cachedTokens) ? value.cachedTokens : 0;
  return { prompt: Math.max(0, prompt), completion: Math.max(0, completion), cached: Math.max(0, cached) };
}

/**
 * 会话累计的展示口径 = 文件快照 + 本轮增量。
 *
 * 只有在**本渲染层自己发起**这一轮时（sessionAddsTurn）才把本轮加在快照上 —— usage.jsonl
 * 每 step 追加一行，本轮进行中重读会把这轮已落盘的部分算两遍；而接管一条正在跑的会话
 * （窗口重载 / 切回运行中任务）时，快照里本来就含这轮的已落盘步骤，再加就虚高。
 */
function sessionDisplayTotals(stream: TaskStream | undefined): { input: number; output: number; cached: number; calls: number } | null {
  if (!stream) return null;
  const base = stream.sessionUsage;
  const turn = stream.sessionAddsTurn ? stream.turnUsage : null;
  if (!base && !turn) return null;
  return {
    input: (base?.input ?? 0) + (turn?.prompt ?? 0),
    output: (base?.output ?? 0) + (turn?.completion ?? 0),
    cached: (base?.cached ?? 0) + (turn?.cached ?? 0),
    calls: base?.calls ?? 0,
  };
}

/** 悬浮明细里的精确数字：k/M 缩写只适合一行摘要，核账要看原数。 */
function exactTokens(n: number): string { return Math.max(0, Math.round(n)).toLocaleString(); }

let lastTokenUsageSignature = '';

/** 重画输入框下面那行 token 消耗；没有会话或还没有任何消耗时整行隐藏。 */
function refreshTokenUsage(): void {
  const stream = streams.get(viewingTaskId() ?? '');
  const turn = stream?.turnUsage ?? null;
  const session = sessionDisplayTotals(stream);
  // live_usage 每秒可达上百条：先用「原始数字 + 语言」的廉价签名挡掉无变化的那些，
  // 缩写与 toLocaleString 只在真变了的时候才做。
  const signature = [
    getLang(),
    turn?.prompt ?? -1, turn?.completion ?? -1, turn?.cached ?? -1,
    session?.input ?? -1, session?.output ?? -1, session?.cached ?? -1, session?.calls ?? -1,
  ].join('|');
  if (signature === lastTokenUsageSignature) return;
  lastTokenUsageSignature = signature;
  const turnSpent = turn ? turn.prompt + turn.completion : 0;
  const sessionSpent = session ? session.input + session.output : 0;
  const parts: string[] = [];
  if (turnSpent > 0) {
    parts.push(
      `${t('composer.tokenTurn')} ↑${tokenShort(turn!.prompt)} ↓${tokenShort(turn!.completion)}` +
        (turn!.cached > 0 ? ` ↻${tokenShort(turn!.cached)}` : ''),
    );
  }
  if (sessionSpent > 0) parts.push(`${t('composer.tokenSession')} ${tokenShort(sessionSpent)}`);
  const text = parts.join(' · ');
  const title = [
    turnSpent > 0
      ? `${t('composer.tokenTurn')}：${t('usage.input')} ${exactTokens(turn!.prompt)} · ${t('usage.output')} ${exactTokens(turn!.completion)}` +
        (turn!.cached > 0 ? ` · ${t('usage.cached')} ${exactTokens(turn!.cached)}` : '') +
        ` · ${t('composer.tokenTotal')} ${exactTokens(turnSpent)}`
      : '',
    sessionSpent > 0
      ? `${t('composer.tokenSession')}：${t('usage.input')} ${exactTokens(session!.input)} · ${t('usage.output')} ${exactTokens(session!.output)}` +
        (session!.cached > 0 ? ` · ${t('usage.cached')} ${exactTokens(session!.cached)}` : '') +
        ` · ${t('composer.tokenTotal')} ${exactTokens(sessionSpent)}` +
        (session!.calls > 0 ? ` · ${session!.calls} ${t('usage.calls')}` : '')
      : '',
  ].filter(Boolean).join('\n');
  tokenUsageEl.textContent = text;
  tokenUsageEl.title = title;
  tokenUsageEl.classList.toggle('hidden', !text);
}

let sessionUsageQuerySequence = 0;
const latestSessionUsageQuery = new Map<string, number>();
/** 读该任务会话的 usage.jsonl 累计；主进程就地算，不启 host（见 work:session-usage）。 */
async function refreshSessionUsage(taskId: string): Promise<void> {
  const stream = streamFor(taskId);
  // 本轮由本渲染层发起且仍在跑：磁盘快照已含本轮已落盘的 step，再叠一次 turnUsage 就双计。
  // 这一轮结束时会由 settleTurnUsage 折进快照并重读（届时 sessionAddsTurn 已置 false）。
  if (stream.sessionAddsTurn && stream.running) return;
  const query = ++sessionUsageQuerySequence;
  latestSessionUsageQuery.set(taskId, query);
  try {
    const result = await window.mocodeWork.sessionUsage({ taskId });
    // 快速切任务时旧回执不能覆盖新任务的流。
    if (latestSessionUsageQuery.get(taskId) !== query) return;
    if (result.ok && result.usage) stream.sessionUsage = result.usage;
  } catch {
    // 记账读失败不该影响对话；留着上一次快照即可。
  }
  if (viewingTaskId() === taskId) refreshTokenUsage();
}

/**
 * 一轮结束（完成 / 失败 / 中止）时给 token 行收尾。
 *
 * 本轮的数字当场就定下来（payload.usage 是终值）；会话累计则「先把本轮折进旧快照、再按
 * usage.jsonl 重读」—— 直接置回旧快照会让数字先掉一截再跳回来，先折进去两次的数就一样了。
 * usage.jsonl 是每 step 追加一行的，本轮各 step 早已落盘，所以重读结果正好含本轮。
 */
function settleTurnUsage(stream: TaskStream, taskId: string, finalUsage: Record<string, unknown> | null): void {
  const turn = (finalUsage ? parseTurnUsage(finalUsage) : null) ?? stream.turnUsage;
  stream.turnUsage = turn;
  if (stream.sessionAddsTurn && turn) {
    const base = stream.sessionUsage;
    // 没有快照（新任务刚跑第一轮，sessionId 还没回到渲染层）时就地立一份：
    // 否则会话那半句会先消失、等重读回来再冒出来，数字看着像掉了。
    stream.sessionUsage = base
      ? { ...base, input: base.input + turn.prompt, output: base.output + turn.completion, cached: base.cached + turn.cached }
      : { input: turn.prompt, output: turn.completion, cached: turn.cached, reasoning: 0, cacheCreation: 0, calls: 0, source: 'session' };
  }
  // 快照自此已含本轮，别再叠一次。
  stream.sessionAddsTurn = false;
  if (viewingTaskId() === taskId) refreshTokenUsage();
  void refreshSessionUsage(taskId);
}

/** 上一次真正写进 DOM 的上下文快照签名（见 updateContextUsage 的去重理由）。 */
let lastContextUsageSignature = '';

/** 更新输入栏的当前上下文快照；null 表示尚无会话或数据尚未返回。 */
function updateContextUsage(usage: ContextUsageSnapshot | null): void {
  // live_usage 是流式进度事件，实测每秒可达上百条（同一份恢复日志里 25 万条）。
  // 数值一个字都没变时重建 popover 的 innerHTML 纯属浪费主线程 —— 而这恰好发生在
  // 「agent 正在跑」的时候，用户点输入框卡的那一下就在这些无意义的重排里。
  // 语言进签名：切语言时必须重算 label 与明细文案。
  const signature = usage
    ? `${getLang()}|${usage.percent}|${usage.tokens}|${usage.window}|${usage.remaining}|${usage.messages}|${usage.cachedTokens ?? ''}|${usage.source}`
    : `${getLang()}|none`;
  if (signature === lastContextUsageSignature) return;
  lastContextUsageSignature = signature;
  contextUsageEl.textContent = t('composer.contextUsageValue', { percent: usage ? `${usage.percent}%` : '--' });
  contextUsageEl.classList.toggle('usage-high', (usage?.percent ?? 0) >= 70);
  contextUsageEl.tabIndex = usage ? 0 : -1;
  contextUsagePopover.innerHTML = usage ? contextUsageDetails(usage) : '';
  if (!usage) contextUsagePopover.classList.add('hidden');
}

function showContextUsageDetails(): void {
  const usage = streams.get(viewingTaskId() ?? '')?.contextUsage;
  if (!usage) return;
  contextUsagePopover.innerHTML = contextUsageDetails(usage);
  contextUsagePopover.classList.remove('hidden');
  const anchor = contextUsageEl.getBoundingClientRect();
  const width = contextUsagePopover.offsetWidth;
  const height = contextUsagePopover.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + anchor.width / 2 - width / 2));
  const above = anchor.top - height - 10;
  contextUsagePopover.style.left = `${Math.round(left)}px`;
  contextUsagePopover.style.top = `${Math.round(above >= 12 ? above : anchor.bottom + 10)}px`;
}
function hideContextUsageDetails(): void { contextUsagePopover.classList.add('hidden'); }
contextUsageEl.addEventListener('mouseenter', showContextUsageDetails);
contextUsageEl.addEventListener('mouseleave', hideContextUsageDetails);
contextUsageEl.addEventListener('focus', showContextUsageDetails);
contextUsageEl.addEventListener('blur', hideContextUsageDetails);
window.addEventListener('resize', hideContextUsageDetails);

let contextUsageQuerySequence = 0;
const latestContextUsageQuery = new Map<string, number>();
/** 按任务自己的 sessionId 查询；请求和回执都绑定任务，快速切换不会串值。 */
async function refreshContextUsage(taskId: string): Promise<void> {
  const sessionId = state?.tasks.find((task) => task.id === taskId)?.sessionId;
  if (!sessionId) { if (viewingTaskId() === taskId) updateContextUsage(null); return; }
  const query = ++contextUsageQuerySequence;
  latestContextUsageQuery.set(taskId, query);
  const envelope = await requestPanelCommand({ type: 'context_usage', taskId, sessionId });
  if (latestContextUsageQuery.get(taskId) !== query || envelope.type === 'error') return;
  const stream = streamFor(taskId);
  stream.contextUsage = parseContextUsage(envelope.payload?.contextUsage);
  if (viewingTaskId() === taskId) updateContextUsage(stream.contextUsage);
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

/** 任务按钮只绑定一次：结构重排时保留节点，不能在每次状态通知时重复绑定或替换它们。 */
const wiredTaskOpenButtons = new WeakSet<HTMLButtonElement>();
const wiredTaskMenuButtons = new WeakSet<HTMLButtonElement>();
const wiredMoreButtons = new WeakSet<HTMLButtonElement>();
let taskListStructure = '';

/**
 * 任务行三态指示（只更新可见状态，不替换按钮、标题或 meta 节点，保护 pointerdown → click）：
 *   - running：转圈（agent 在动，不用管）
 *   - waiting：静止的琥珀色警示（agent 停在那儿等人，必须管）
 *   - 其余：显示「N 分钟前」
 * waiting 以前和 running 一样转圈 → 用户分不出「它在干活」和「它在等我」。
 */
function paintTaskItem(item: HTMLElement, task: Task, current: WorkState): void {
  const waiting = task.status === 'waiting';
  const busy = task.status === 'running';
  const className = `task-item ${task.status}${task.id === current.selectedTaskId ? ' selected' : ''}`;
  if (item.className !== className) item.className = className;
  if (task.lastError) item.title = taskErrorText(task);
  else if (waiting) item.title = t('task.needsYou');
  else item.removeAttribute('title');
  const open = item.querySelector<HTMLButtonElement>('.task-open');
  const title = item.querySelector<HTMLElement>('.task-title');
  const menu = item.querySelector<HTMLButtonElement>('.task-menu-btn');
  const label = taskTitle(task);
  if (open) open.title = waiting ? t('task.openNeedsYou', { name: label }) : t('task.open', { name: label });
  if (title) {
    if (title.textContent !== label) title.textContent = label;
    title.title = t('task.dblclickRename');
  }
  if (menu) { menu.setAttribute('aria-label', t('task.menu')); menu.title = t('sidebar.moreActions'); }
  const spinner = item.querySelector<HTMLElement>('.task-spinner');
  const waitMark = item.querySelector<HTMLElement>('.task-wait');
  const ago = item.querySelector<HTMLElement>('.task-meta small');
  spinner?.toggleAttribute('hidden', !busy);
  waitMark?.toggleAttribute('hidden', !waiting);
  ago?.toggleAttribute('hidden', busy || waiting);
  if (ago && !busy && !waiting) ago.textContent = timeAgo(task.updatedAt);
  paintTaskPlan(item, task);
}

/**
 * 任务行上的计划进度（n/m）。
 * 与时间/转圈同处 .task-meta：运行中显示转圈 + n/m，结束后显示时间 + n/m。
 * 后台任务也能看到进度 —— 这是会话区顶部计划面板看不到的那一半信息。
 *
 * ⚠ 计划跑完就**收起这颗 pill**，不显示「已完成」之类的字样：计划完成 ≠ 任务完成。
 * 一轮 run 结束、计划 6/6 之后用户往往接着聊下一件事，而计划是上一轮的遗留数据
 * （main.ts 的 updateTaskFromAgent 只在 plan_update 时写入，run 结束不清），
 * 挂着「已完成」会和左上角的转圈自相矛盾。跑完的计划没有增量信息，隐藏即可。
 */
function paintTaskPlan(item: HTMLElement, task: Task): void {
  const plan = task.plan;
  const pill = item.querySelector<HTMLElement>('.task-plan');
  if (!plan || plan.total <= 0 || plan.allDone) { pill?.remove(); return; }
  const label = t('plan.sidebar', { done: plan.done, total: plan.total });
  if (!pill) {
    const meta = item.querySelector('.task-meta');
    if (!meta) return;
    const created = document.createElement('span');
    created.className = 'task-plan';
    created.textContent = label;
    created.title = `${plan.title} · ${label}`;
    meta.append(created);
    return;
  }
  if (pill.textContent !== label) pill.textContent = label;
  pill.title = `${plan.title} · ${label}`;
}

/**
 * 各空间最近会话的缓存（主进程一次性批量给，见 work:space-recent-sessions）。
 *
 * 侧栏内联区要把「任务」和「终端会话」按时间混排，而混排要能在每次状态更新时同步重算 ——
 * 逐个空间 await 会把侧栏卡成一顿一顿的。所以只在启动与 sessionCount 变化时取一次。
 */
let spaceSessions: Map<string, ProjectSession[]> = new Map();
/** 上次取缓存时的「空间 + 会话数」指纹；变化了才重新取。 */
let spaceSessionsKey = '';
async function refreshSpaceSessions(): Promise<void> {
  try {
    const result = await window.mocodeWork.spaceRecentSessions();
    spaceSessions = new Map(result.map((item) => [item.projectId, item.sessions]));
  } catch (error) {
    console.error('[sidebar] recent sessions', error);
    spaceSessions = new Map();
  }
  renderTasks();
}

/**
 * 哪些空间的「更多 (N)」当前是展开的。放模块级而不是 DOM 上：侧栏重建会重铺模板，
 * 展开态不能因为一次状态刷新就弹回去。
 */
const openMoreProjects = new Set<string>();

/**
 * 展开「更多」时从磁盘取回的全量会话（每个空间只取一次）。
 *
 * 首屏只有每空间最近 20 条的批量快照（spaceSessions），展开区的会话可能不全；真要找旧
 * 会话时才去磁盘取一次全量（一个空间几百条）。取回后按空间缓存，侧栏重建直接复用，
 * 保证「展开一次之后，随便状态怎么刷新列表都还在」。
 */
const moreSessions = new Map<string, ProjectSession[]>();

/**
 * 取某空间的全量会话并重绘侧栏（已取过就直接返回）。
 *
 * 只在「展开更多」和「新会话落盘导致缓存失效」两处调用 —— 后者必须真的重取，
 * 否则用户盯着展开的列表时新会话永远不会出现。
 */
async function loadMoreSessions(projectId: string): Promise<void> {
  if (moreSessions.has(projectId)) return;
  try {
    moreSessions.set(projectId, await window.mocodeWork.projectSessions(projectId));
  } catch (error) {
    console.error('[sidebar] project sessions', error);
    moreSessions.set(projectId, []);
  }
  renderTasks();
}

/** 空间集合或会话数变了就重取一次缓存（首次启动也走这条路）。 */
function syncSpaceSessionCache(): void {
  const key = (state?.projects ?? []).map((project) => `${project.id}:${project.sessionCount ?? 0}`).join('|');
  if (key === spaceSessionsKey) return;
  spaceSessionsKey = key;
  // 新会话落盘后，展开「更多」时取回的那份全量已经过时：丢掉并就地重取正在展开的空间，
  // 免得用户盯着列表时新会话一直不出现。
  moreSessions.clear();
  for (const projectId of openMoreProjects) void loadMoreSessions(projectId);
  void refreshSpaceSessions();
}

/**
 * 侧栏排序：**只有运行中（running / waiting）的任务排在前面**，其余一律按
 * 「最近一次用户消息」倒序。
 *
 * 曾经的实现是纯 `updatedAt` 倒序，于是「点开一条历史会话」= 接管 = 以 now 建任务，
 * 只是看一眼就把一条几周前的旧会话顶到正在跑的任务上面。现在：
 *   · 置顶只由运行状态决定（时间再新也压不过它）；
 *   · 接管沿用会话原有时间（见 main.ts 的 adopt-session），浏览不再改排序。
 */
function byActiveThenUpdatedDesc(left: Task, right: Task): number {
  const leftActive = isActiveTaskStatus(left.status);
  const rightActive = isActiveTaskStatus(right.status);
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function renderTasks(): void {
  const current = state; if (!current) return;
  const byUpdatedDesc = byActiveThenUpdatedDesc;
  // 普通任务：projectId 为空，平铺在「任务」分组下；加入项目文件夹的任务归在「空间」分组对应文件夹下
  const normalTasks = current.tasks.filter((task) => !task.projectId).sort(byUpdatedDesc);
  const spaces = current.projects.map((project) => ({
    project,
    tasks: current.tasks.filter((task) => task.projectId === project.id).sort(byUpdatedDesc),
  }));
  // 空间内联区与「更多」展开区 = 任务 + 终端会话按时间混排（规则见 space-entries.ts）。
  // 会话池 = 批量快照（每空间最近 20 条）+ 展开「更多」时从磁盘取回的全量。
  const sessionPool = (projectId: string): ProjectSession[] => {
    const pool = new Map((spaceSessions.get(projectId) ?? []).map((session) => [session.id, session]));
    for (const session of moreSessions.get(projectId) ?? []) pool.set(session.id, session);
    return [...pool.values()];
  };
  const spaceViews = new Map(spaces.map(({ project, tasks }) => {
    const split = splitSpaceEntries(tasks, sessionPool(project.id));
    const overflowTasks = split.overflow.filter((entry) => entry.kind === 'task').length;
    // 会话总数以 project.sessionCount（磁盘真实条数）为准：批量快照只取最近 20 条，
    // 拿快照长度去减会在大空间里把「更多 (282)」显示成「更多 (6)」。
    const overflowSessions = moreSessions.has(project.id)
      ? split.overflow.filter((entry) => entry.kind === 'session').length
      : Math.max(0, (project.sessionCount ?? 0)
        - split.inline.filter((entry) => entry.kind === 'session').length
        - new Set(tasks.filter((task) => task.sessionId).map((task) => task.sessionId!)).size);
    return [project.id, { split, total: overflowTasks + overflowSessions }] as const;
  }));
  // 只有增删、排序、归属、展开区内容变化才需要重建分组。状态、选中、标题变化走原地绘制。
  const structure = JSON.stringify([
    getLang(),
    normalTasks.map((task) => task.id),
    spaces.map(({ project, tasks }) => {
      const view = spaceViews.get(project.id)!;
      return [
        project.id,
        tasks.map((task) => task.id),
        view.split.inline.map((entry) => `${entry.kind}:${entry.id}`),
        // 展开区的顺序与计数同源：会话池一变（新会话落盘 / 全量取回）就要重建。
        view.split.overflow.map((entry) => `${entry.kind}:${entry.id}`),
        view.total,
      ];
    }),
  ]);
  // 「谁在等我」只由 attention.ts 判定一次（侧栏 / 标题栏 / 主进程通知同口径）。
  const waitingByProject = pendingByProject(current.tasks);
  const paintProject = (heading: HTMLElement, project: Project): void => {
    heading.classList.toggle('selected', project.id === current.selectedProjectId);
    const name = heading.querySelector<HTMLElement>('.project-group-name');
    if (name) {
      if (name.textContent !== project.name) name.textContent = project.name;
      name.title = project.root;
    }
    // 空间里有几个任务在等人：空间可能是折叠的、任务行根本不可见，这个计数是唯一线索。
    const waitBadge = heading.querySelector<HTMLElement>('.project-group-wait');
    const waiting = waitingByProject.get(project.id) ?? 0;
    if (waitBadge) {
      waitBadge.toggleAttribute('hidden', waiting === 0);
      const waitLabel = String(waiting);
      if (waitBadge.textContent !== waitLabel) waitBadge.textContent = waitLabel;
      waitBadge.title = t('sidebar.spaceNeedsYou', { n: waiting });
      waitBadge.setAttribute('aria-label', t('sidebar.spaceNeedsYou', { n: waiting }));
    }
    const newTask = heading.querySelector<HTMLButtonElement>('[data-new-task-project]');
    if (newTask) {
      newTask.title = t('sidebar.newTaskInSpace');
      newTask.setAttribute('aria-label', t('sidebar.newTaskInProject', { name: project.name }));
    }
    const projectMenu = heading.querySelector<HTMLButtonElement>('[data-project-menu]');
    if (projectMenu) {
      projectMenu.title = t('sidebar.moreActions');
      projectMenu.setAttribute('aria-label', t('sidebar.moreActionsFor', { name: project.name }));
    }
    const moreLabel = heading.parentElement?.querySelector<HTMLElement>('.task-more-label');
    const view = spaceViews.get(project.id);
    if (moreLabel && view) {
      const label = t('sidebar.moreItems', { n: view.total });
      if (moreLabel.textContent !== label) moreLabel.textContent = label;
    }
  };
  const existingItems = new Map<string, HTMLElement>();
  taskList.querySelectorAll<HTMLElement>('.task-item[data-task-id]').forEach((item) => {
    if (item.dataset.taskId) existingItems.set(item.dataset.taskId, item);
  });
  if (structure === taskListStructure) {
    for (const task of current.tasks) {
      const item = existingItems.get(task.id);
      if (item) paintTaskItem(item, task, current);
    }
    taskList.querySelectorAll<HTMLElement>('[data-toggle-project]').forEach((heading) => {
      const project = current.projects.find((item) => item.id === heading.dataset.toggleProject);
      if (project) paintProject(heading, project);
    });
    return;
  }
  taskListStructure = structure;

  const taskItemHtml = (task: Task): string => {
    const id = escapeHtml(task.id);
    const waiting = task.status === 'waiting';
    const isRunning = task.status === 'running';
    // 转圈只给真正在跑的；waiting 用静止的琥珀色警示（不动的那个才是要你动手的）。
    const meta = `<span class="task-spinner"${isRunning ? '' : ' hidden'}>${icon('loader')}</span><span class="task-wait"${waiting ? '' : ' hidden'}>${icon('warn')}</span><small data-always="1"${isRunning || waiting ? ' hidden' : ''}>${timeAgo(task.updatedAt)}</small>`;
    // 失败原因只挂在 title 上：侧栏一行放不下长文案，而 lastError 里存的是稳定标记，
    // 必须过一层 taskErrorText 才能按当前语言显示。等待人工介入优先于失败原因（它更紧急）。
    const error = task.lastError ? ` title="${escapeHtml(taskErrorText(task))}"` : waiting ? ` title="${escapeHtml(t('task.needsYou'))}"` : '';
    const openTitle = waiting ? t('task.openNeedsYou', { name: escapeHtml(taskTitle(task)) }) : t('task.open', { name: escapeHtml(taskTitle(task)) });
    return `<div class="task-item ${task.status} ${task.id === current.selectedTaskId ? 'selected' : ''}" data-task-id="${id}"${error}><button class="task-open" data-task="${id}" title="${openTitle}"><span class="task-title" title="${t('task.dblclickRename')}">${escapeHtml(taskTitle(task))}</span><span class="task-meta">${meta}</span></button><button class="task-menu-btn" data-task-menu="${id}" aria-label="${t('task.menu')}" title="${t('sidebar.moreActions')}">${icon('more')}</button></div>`;
  };

  /**
   * 内联区里的终端会话行：只读，点一下即「接管」成本空间任务。
   *
   * 与任务行同高同级，但用分支图标代替状态点 —— 用户要能一眼分清「这是我在这里聊过的
   * work-app 任务」还是「这是终端留下的会话，点了会接管」。
   */
  const spaceSessionItemHtml = (projectId: string, session: ProjectSession): string => {
    const title = (session.firstUser || session.id).replace(/\s+/g, ' ').slice(0, 80);
    // 时间显示与排序键同源（lastActiveAt 优先）：否则列表按「最后活动」排序，却显示成
    // 「三个月前」——用户会读成排序坏了。
    const at = session.lastActiveAt || session.createdAt;
    return `<div class="task-item session-item" data-session-id="${escapeHtml(session.id)}"><button class="task-open" data-adopt="${escapeHtml(session.id)}" data-adopt-project="${projectId}" title="${escapeHtml(`${session.id} · ${session.model}`)}"><span class="task-kind">${icon('branch')}</span><span class="task-title">${escapeHtml(title)}</span><span class="task-meta"><small>${timeAgo(at)}</small></span></button></div>`;
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
    <span class="project-group-name" title="${escapeHtml(project.root)}">${escapeHtml(project.name)}</span>
    <span class="project-group-wait"${(waitingByProject.get(project.id) ?? 0) ? '' : ' hidden'}>${icon('warn')}${waitingByProject.get(project.id) ?? 0}</span>
    <span class="project-group-chevron">${icon(isCollapsed ? 'chevron-right' : 'chevron-down')}</span>
    <span class="project-group-actions"><button class="project-menu-btn icon-button-square" data-new-task-project="${projectId}" title="${t('sidebar.newTaskInSpace')}" aria-label="${t('sidebar.newTaskInProject', { name: escapeHtml(project.name) })}">${icon('plus')}</button><button class="project-menu-btn icon-button-square" data-project-menu="${projectId}" title="${t('sidebar.moreActions')}" aria-label="${t('sidebar.moreActionsFor', { name: escapeHtml(project.name) })}">${icon('more')}</button></span>
  </div>
  <div class="project-group-tasks">${(() => {
    const view = spaceViews.get(project.id)!;
    const split = view.split;
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const sessionById = new Map(sessionPool(project.id).map((session) => [session.id, session]));
    // 内联区 = 任务与会话按时间混排的前 6 条（见 space-entries.ts）。
    // 内联之后的条目全收进「更多 (N)」—— 不再分成「还有 N 个任务」与「历史会话」两块。
    const rowHtml = (entry: SpaceEntry): string => {
      if (entry.kind === 'task') {
        const task = taskById.get(entry.id);
        return task ? taskItemHtml(task) : '';
      }
      const session = sessionById.get(entry.id);
      return session ? spaceSessionItemHtml(project.id, session) : '';
    };
    const rows = split.inline.map(rowHtml).join('');
    const listHtml = rows || `<p class="empty-tasks">${t('sidebar.emptyTasks')}</p>`;
    // 展开态由模块级 openMoreProjects 决定，侧栏重建后列表仍保持展开。
    const isOpen = openMoreProjects.has(project.id);
    const moreHtml = view.total > 0
      ? `<button class="task-more ${isOpen ? 'open' : ''}" data-more-tasks="${projectId}" data-more-count="${view.total}"><span class="task-more-label">${t('sidebar.moreItems', { n: view.total })}</span><span class="task-more-chevron">${icon(isOpen ? 'chevron-up' : 'chevron-down')}</span></button><div class="task-more-list ${isOpen ? '' : 'hidden'}">${split.overflow.map(rowHtml).join('')}</div>`
      : '';
    return listHtml + moreHtml;
  })()}</div>
</div>`;
  }).join('')}</div>
</div>`;

  // 分组模板只在结构变化时生成；已有任务按钮原样搬回，状态刷新永远不替换点击目标。
  taskList.querySelectorAll<HTMLElement>('.task-item[data-task-id]').forEach((placeholder) => {
    const taskId = placeholder.dataset.taskId!;
    const task = current.tasks.find((item) => item.id === taskId);
    const item = existingItems.get(taskId) ?? placeholder;
    if (item !== placeholder) placeholder.replaceWith(item);
    if (task) paintTaskItem(item, task, current);
  });
  taskList.querySelectorAll<HTMLElement>('[data-toggle-project]').forEach((heading) => {
    const project = current.projects.find((item) => item.id === heading.dataset.toggleProject);
    if (project) paintProject(heading, project);
  });

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

  // 内联区的会话行：点一下即接管（与历史会话列表同一个动作，见 adoptSessionFrom）。
  taskList.querySelectorAll<HTMLButtonElement>('.session-item [data-adopt]').forEach((button) => {
    if (wiredInlineSessionButtons.has(button)) return;
    wiredInlineSessionButtons.add(button);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void adoptSessionFrom(button.dataset.adoptProject ?? '', button.dataset.adopt ?? '');
    });
  });

  taskList.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((button) => {
    if (wiredTaskOpenButtons.has(button)) return;
    wiredTaskOpenButtons.add(button);
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
    const menu = document.createElement('div');
    menu.id = 'task-context-menu';
    menu.className = 'project-context-menu';
    // ⚠ 「移动到别的空间」刻意不在这里：同一件事在底部工作空间 chip 的下拉里就能做，
    // 而放这儿时每多一个空间就多一行 —— 实测 8 个空间就能把「删除」顶出视口、点不到。
    // 菜单只留必然要用到的两条：重命名 / 删除。
    menu.innerHTML = `<button class="project-context-item" data-action="rename" data-tid="${taskId}"><span class="project-context-icon">${icon('edit')}</span>${t('menu.rename')}</button><div class="project-context-divider"></div><button class="project-context-item" data-action="delete" data-tid="${taskId}"${isRunning ? ' data-running="1"' : ''}><span class="project-context-icon">${icon('trash')}</span>${isRunning ? t('menu.stopAndDelete') : t('menu.delete')}</button>`;
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    // 水平：右对齐到锚点，两侧各留 4px。
    const left = Math.min(Math.max(4, anchor.right - menuRect.width), Math.max(4, window.innerWidth - menuRect.width - 4));
    // 垂直：优先挂在锚点下方；下方不够就翻到上方；两边都不够（菜单比视口还高）就贴顶，
    // 由 CSS 的 max-height + overflow 让它自己滚 —— 绝不能让最后一项跑到视口外点不到。
    let top = anchor.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 4) {
      const above = anchor.top - menuRect.height - 4;
      top = above >= 4 ? above : Math.max(4, window.innerHeight - menuRect.height - 4);
    }
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
  };

  taskList.querySelectorAll<HTMLButtonElement>('[data-task-menu]').forEach((button) => {
    if (wiredTaskMenuButtons.has(button)) return;
    wiredTaskMenuButtons.add(button);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openTaskMenu(button.dataset.taskMenu!, button.getBoundingClientRect());
    });
  });

  // 空间行「+」：在该空间下新建任务（归属显式绑定，不再依赖"跟随当前选中空间"）。
  taskList.querySelectorAll<HTMLButtonElement>('[data-new-task-project]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    void startNewTask(button.dataset.newTaskProject!);
  }));

  /**
   * 空间下的「更多 (N)」：内联 6 条之后的任务 + 终端历史会话，一份按时间混排的列表。
   *
   * 首屏那份列表来自每空间最近 20 条的批量快照，可能不全；第一次展开时去磁盘取一次
   * 全量（一个空间几百条，readdir + 少量 session.json 头），取回后按空间缓存，
   * 之后侧栏怎么重建都用这份缓存 —— 展开一次就一直在，直到 app 重启。
   */
  taskList.querySelectorAll<HTMLButtonElement>('[data-more-tasks]').forEach((button) => {
    if (wiredMoreButtons.has(button)) return;
    wiredMoreButtons.add(button);
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const projectId = button.dataset.moreTasks ?? '';
      const box = button.parentElement?.querySelector<HTMLElement>('.task-more-list');
      if (!box) return;
      const opening = box.classList.contains('hidden');
      box.classList.toggle('hidden', !opening);
      button.classList.toggle('open', opening);
      const chevron = button.querySelector<HTMLElement>('.task-more-chevron');
      if (chevron) chevron.innerHTML = icon(opening ? 'chevron-up' : 'chevron-down');
      if (!opening) {
        openMoreProjects.delete(projectId);
        return;
      }
      openMoreProjects.add(projectId);
      if (moreSessions.has(projectId)) return;
      // 取全量期间把列表压暗（`.loading`）：大空间 readdir + 读几十个 session.json 头要几十毫秒，
      // 不压暗会看着像点了没反应。取回后 renderTasks 会按同一份 openMoreProjects 重铺并保持展开。
      box.classList.add('loading');
      await loadMoreSessions(projectId);
      box.classList.remove('loading');
    });
  });

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
        const doomed = (state?.tasks ?? []).filter((task) => task.projectId === pid).map((task) => task.id);
        const hasRunning = (state?.tasks ?? []).some((task) => task.projectId === pid && (task.status === 'running' || task.status === 'waiting'));
        if (hasRunning) { showToast('warn', t('toast.cannotRemoveSpace')); return; }
        // 删之前记下正在看的是哪个任务：只有它真被删掉了才允许清空会话区。
        const viewingBefore = state?.selectedTaskId;
        const result = await window.mocodeWork.removeProject(pid);
        if (!result) return;
        // 这些任务的记录没了 → 渲染层的流缓冲也一起作废。否则已删任务的事件还会
        // 继续 streamFor() 建缓冲，isRunning() 也会读到一个已经不存在的任务。
        for (const taskId of doomed) dropTaskRuntime(taskId);
        updateState(result.state);
        // ⚠ 以前这里无条件 clearWorkspace()：删 A 空间会把**另一个空间里正在跑的那个会话**
        // 一起清空（清 DOM、activeAssistant 置空、发送键按回「发送」）。紧接着它下一条
        // text_delta 走到 appendText → ensureTextBlock → startAssistantTurn，界面上就凭空
        // 冒出一条新 assistant 消息、继续流那个 agent 的输出 —— 看起来像「跑着的会话泄出来了」。
        // 现在只有「正在看的那个任务确实属于被删空间」才清空，否则一像素都不动。
        if (viewingBefore && doomed.includes(viewingBefore)) clearWorkspace();
        showToast('info', t('toast.removedSpace', { removed: result.removed }));
      }
    }));
  }));
}

// 空间内联区里的会话行（.task-item.session-item）：点一下 = 接管成任务，与历史会话列表同一个动作。
const wiredInlineSessionButtons = new WeakSet<HTMLButtonElement>();

/** 接管一条终端会话：成功后就打开它建好的任务（历史列表与内联区共用）。 */
async function adoptSessionFrom(projectId: string, sessionId: string): Promise<void> {
  const result = await window.mocodeWork.adoptSession({ projectId, sessionId });
  if (!result?.ok) { showToast('warn', result?.message ?? t('toast.adoptFailed')); return; }
  if (result.state) updateState(result.state);
  if (result.task) {
    void openTask(result.task.id);
    showToast('success', t('toast.adopted'));
  }
}

function updateState(next: WorkState): void {
  // IPC 的广播与 invoke 回执可能携带同一份状态；重复回执不做任何 DOM 工作。
  if (state && JSON.stringify(next) === JSON.stringify(state)) return;
  const previousProject = activeProjectId();
  state = next; renderProjects(); renderTasks(); renderEmptyChips(); syncAttention();
  // 空间集合或会话数变了才重取内联区要用的会话快照（内部自己判断，不额外加 IPC）。
  syncSpaceSessionCache();
  // 切空间 = 切浏览器分区 + 换一份 PTY（shell 的 cwd 绑在空间根上）。
  if (activeProjectId() !== previousProject) {
    refreshBrowserPanelProject();
    refreshTerminalProject();
  }
  if (activeInspectorTab === 'source' && !inspector.classList.contains('hidden')) void refreshSourceControl(inspectorContent);
}
function clearWorkspace(): void { lastTokenUsageSignature = ''; tokenUsageEl.textContent = ''; tokenUsageEl.title = ''; tokenUsageEl.classList.add('hidden'); hideExtensionsView(); conversation.innerHTML = ''; userTurnIndex = 0; emptyState.classList.remove('hidden'); activeAssistant = null; activeTextBlock = null; activeToolGroup = null; setRunning(false); attachments = []; renderAttachments(); renderStatus(IDLE_STATUS); }

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

/**
 * 这次新开的助手消息是不是**同一次 run 的后半轮**。
 *
 * 判据:从会话流尾往前跳过提示行 / 状态行等非消息节点,落在一条**已被压缩提示行封口**的
 * assistant 消息上(`dataset.sealed`,由 sealTurn 设置)。
 * 上下文压缩提示行会把一轮切成「前半轮 → 提示行 → 后半轮」(见 addNotice 的封口),
 * 而封口后 resumableTurn 不再认领前半轮,后半轮只能另起一条消息 —— 若这条消息再画一次
 * 头像 + "MoCode",读起来就像用户又提了一次问、新一轮回答开始了(工具计数也跟着重新起算)。
 * 所以后半轮继承同一轮的身份:保留正文与工具行的连续性,只把重复的署名行隐掉(见 style.css 的
 * `.message.assistant.is-continuation`)。
 *
 * 必须认 sealed 而不是「上一条消息是 assistant」:run 结束后迟到的 no_reply / max_steps
 * 也会另起一条消息,那种情况是**新一轮的收尾**,署名行得照画。
 */
function isContinuationTurn(): boolean {
  const nodes = conversation.children;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i] as HTMLElement;
    // 会话流尾常常不是消息本身:压缩提示行、状态行(ensureStatusRow 保证自己永远压在最后)
    // 都排在消息之后,直接取最后一个子节点会永远判定为「新一轮」。
    if (!node.classList.contains('message')) continue;
    return node.classList.contains('assistant') && node.dataset.sealed === '1';
  }
  return false;
}

function startAssistantTurn(): HTMLElement {
  // 必须在 addMessage 之前判定:它自己会把新消息 append 进来。
  const continuation = isContinuationTurn();
  activeAssistant = addMessage('assistant');
  activeAssistant.classList.add('is-streaming');
  if (continuation) activeAssistant.classList.add('is-continuation');
  activeToolGroup = null;
  return activeAssistant;
}

/** 当前仍在文档里的助手轮次;没有则 null。(包成函数,避免调用点被 TS 收窄成 never。) */
function currentTurn(): HTMLElement | null {
  const turn: HTMLElement | null = activeAssistant;
  return turn && turn.isConnected ? turn : null;
}

/**
 * 可续写的助手轮次:activeAssistant 还在文档里就用它;否则在**本轮仍处于运行态**时,
 * 回落到会话里最后一条 assistant 消息,把它重新认领为当前轮。
 *
 * 为什么需要回落:activeAssistant 会被十来条路径置空(finish / addMessage('user') /
 * switchToTask / clearWorkspace / renderHistory / submitEdited / regenerate / finalizeTurn)。
 * 只要其中任何一条在本轮仍在产出时早到一步,后续的 text_delta / tool_started 就会走
 * `currentTurn() ?? startAssistantTurn()` **凭空开一条新气泡** —— 一次 run 在界面上显示成
 * 两条带 MoCode 头像的消息(实测:5 个 run_command 被切成「2 个 + 3 个」两组,中间多出一个
 * 头像和第一段正文的完成态按钮)。恢复日志里那一轮只有一条 run_started,即铁证。
 *
 * 只在运行中回落:正常的第二轮由 startRun / regenerate 显式 startAssistantTurn,那时
 * activeAssistant 一定非空;而 run_completed 之后才迟到的 delta 没有活跃 run,不该续到
 * 已经收口的轮次上 —— 那是「本轮已结束」的语义,由调用方决定怎么处理。
 */
function resumableTurn(): HTMLElement | null {
  const current = currentTurn();
  if (current) return current;
  if (!isRunning(viewingTaskId())) return null;
  // 会话区尾元素可能是状态行 / 系统提示行,所以从 .message 里找最后一条,而不是 lastElementChild。
  const messages = conversation.querySelectorAll<HTMLElement>('.message');
  const last = messages[messages.length - 1];
  // 最后一条是用户气泡时不续写:那是新一轮的边界,输出必须挂在它后面。
  if (!last || !last.classList.contains('assistant')) return null;
  // 被压缩提示行切断的轮次同样不续写(见 addNotice):续回去就把提示行又压到最下面了。
  if (last.dataset.sealed === '1') return null;
  activeAssistant = last;
  last.classList.add('is-streaming');
  // 收口时挂上的按钮属于中断点之前的半截正文:换成一个无子节点、无监听器的同款容器,
  // 让 finalizeTurn 用完整文本重挂(直接清 innerHTML 会保留旧监听器,再挂一次就变成两个
  // click 监听器,「重新生成」会被触发两遍)。
  const actions = last.querySelector('.message-actions');
  if (actions) actions.replaceWith(actions.cloneNode(false));
  // 文字段一定新开:旧段已经做完 markdown 渲染,再往里追加原始文本会与 md 结构冲突。
  activeTextBlock = null;
  // 工具集合能续就续:被打断的那段文字是空白(会在 finalizeTurn 里丢弃),视觉上就是
  // 一次连续的工具调用,不该因此拆成两组计数。
  const tail = last.querySelector('.message-content')?.lastElementChild;
  activeToolGroup = tail instanceof HTMLElement && tail.classList.contains('tool-group') ? tail : null;
  return last;
}

/** 当前可写入的文字段。若最后一个 block 已不是文字段(刚插入了工具行),新开一段。 */
function ensureTextBlock(): HTMLElement {
  const current = resumableTurn() ?? startAssistantTurn();
  const content = current.querySelector('.message-content') as HTMLElement | null;
  if (activeTextBlock?.isConnected && content?.lastElementChild === activeTextBlock) return activeTextBlock;
  const block = document.createElement('div');
  block.className = 'message-body text-block';
  (content ?? current).append(block);
  // 这一轮已有「本轮改动」卡片时把它挪回末尾：卡片是回答的收尾，新文字必须接在它上面
  // （上下文压缩切断后继续写的那半轮会走到这里 —— 不挪就会在卡片下方再长出一段正文）。
  const card = content?.querySelector('.message-changes');
  if (card) content!.append(card);
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

/**
 * 用户消息的原文与附件 —— 原地编辑必须能拿回它们。
 * 不能从 DOM 反推：图片消息本来就没有 .message-body（正文为空），
 * 而从 textContent 取文本会丢掉消息里的换行与首尾空白。
 */
const messageText = new WeakMap<HTMLElement, string>();
const messageAttachments = new WeakMap<HTMLElement, Attachment[]>();

function addMessage(kind: 'user' | 'assistant', text = '', images: Attachment[] = []): HTMLElement {
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
    // 图片独立于文字气泡：纯图片消息不留空白文本框，复制/回滚仍只针对文字。
    if (images.length) wrapper.append(imageGallery(images, 'message-image'));
    if (text) wrapper.append(body);
    wrapper.append(label);
    message.append(wrapper);
    // 用户消息的「复制 + 编辑/回滚」:userIndex 是它在会话里的序号,截断时靠它告诉主进程停在哪。
    message.dataset.userIndex = String(userTurnIndex);
    userTurnIndex += 1;
    // 原文与附件留档:原地编辑要从这里取,不能从 DOM 反推(纯图片消息没有 .message-body)。
    messageText.set(message, text);
    messageAttachments.set(message, images);
    wireMessageActions(message, text);
    activeTextBlock = null;
  } else {
    const label = 'MoCode';
    const avatarIcon = '<img class="app-avatar" src="../assets/icon.png" alt="MoCode">';
    // 头像与署名同一行，不再为头像保留贯穿整轮回答的左侧栏。
    // 操作按钮(复制 / 重新生成)是 .message 的第二个 grid 行:落在正文下沿、左对齐(见 style.css)。
    // 不能塞进 .message-content:那里最后一子元素必须是"正在写的文字段",
    // 否则 ensureTextBlock 的 lastElementChild 判断会把每个 chunk 都当成新段。
    message.innerHTML = `<div class="message-content"><div class="message-label"><div class="message-avatar">${avatarIcon}</div><span>${label}</span></div><div class="message-body"></div></div><div class="message-actions"></div>`;
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

/**
 * 「干净会话」：文件编辑不再单独成行、也不自动展开 diff，而是当成普通工具并进工具调用集合。
 *
 * 与 STANDALONE_TOOLS 是同一件事的两档：默认档认为「改动必须第一眼看到」，干净档认为
 * 「一次任务改十几个文件时，铺开的 diff 把整段对话埋了」。所以做成开关而不是改死其中一边。
 *
 * 纯渲染层偏好，存 localStorage 而不进 `~/.mocode/config` —— 后者每个键都会被 core 当环境变量
 * 读，而且 setSettings 会顺带 restartAllAgents()，为一个显示开关重启所有后台 agent 不合理。
 * 默认关闭 = 保持既有行为。
 */
const CLEAN_RUN_KEY = 'mocode-work-clean-run';
let cleanRunMode = ((): boolean => {
  try { return localStorage.getItem(CLEAN_RUN_KEY) === '1'; } catch { return false; }
})();
function setCleanRun(enabled: boolean): void {
  cleanRunMode = enabled;
  try { localStorage.setItem(CLEAN_RUN_KEY, enabled ? '1' : '0'); } catch { /* 无 localStorage 则仅本次生效 */ }
}

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
/** 入参里带文件路径的工具 —— 折叠行上的路径因此可以点开预览。 */
const FILE_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/**
 * 取工具入参里的**原始**文件路径（不截断）。
 * 与 toolTargetText 分开：展示用的那份会被 clip 成 120 字，拿去打开文件就找不到目标了。
 */
function toolFilePath(name: string, args: string): string {
  if (!FILE_PATH_TOOLS.has(name) || !args.trim()) return '';
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(args) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { return ''; }
  if (!parsed) return '';
  for (const key of TOOL_ARG_KEYS[name] ?? ['path']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 折叠行上的"对象"文本:路径 / 命令 / 关键词等,让工具行不只是一个工具名。 */
const TOOL_ARG_KEYS_DEFAULT = ['path', 'file', 'filePath', 'command', 'query', 'pattern', 'url', 'name', 'target'];
function toolTargetText(name: string, args: string): string {
  const raw = args.trim();
  if (!raw) return '';
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* 非 JSON 入参按纯文本处理 */ }
  if (parsed) {
    for (const key of TOOL_ARG_KEYS[name] ?? TOOL_ARG_KEYS_DEFAULT) {
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

/** 取 run_command 入参里的命令串（联动入口：回填到终端面板）。 */
function runCommandOf(args: string): string {
  if (!args) return '';
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const command = (parsed as Record<string, unknown>).command;
      if (typeof command === 'string') return command.trim();
    }
  } catch { /* 非 JSON 入参没有可回填的命令 */ }
  return '';
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
/** 批量渲染期间只登记脏集合行，收尾时每个只重算一次（见 batchRender）。 */
function refreshToolGroup(group: HTMLElement): void {
  if (batchRenderDepth > 0) { batchDirtyToolGroups.add(group); return; }
  paintToolGroup(group);
}

/** 重算集合行:名称(执行中/完成)、工具类型短语(读取文件 ×2 · 运行命令 ×3)、进度与总耗时。 */
function paintToolGroup(group: HTMLElement): void {
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

/** 文件改动的 diff 视图文案（每次渲染时按当前语言取，切语言即时生效）。 */
function fileChangeLabels(): FileChangeLabels {
  return {
    unchanged: (n) => t('tool.diffUnchanged', { n }),
    noChanges: t('tool.diffNoChanges'),
    tooLarge: t('tool.diffTooLarge'),
    truncated: (n) => t('tool.diffTruncated', { n }),
  };
}

/**
 * 工具结局的结构化字段（host 从 tool_completed 转发，见 src/host/stdio.ts）。
 *
 * 旧版 host 不发这些字段，那时只能回退到在 output 上嗅探 `错误:` 前缀 —— 保留该回退路径，
 * 但它只是兼容手段：前缀判断既漏（工具可以返回任意文案）又会误判（正文里讲到「错误:」）。
 */
interface ToolOutcomeEnvelope {
  status?: string;
  code?: string;
  changedFiles?: string[];
  editStartLine?: number;
  preWriteOld?: string | null;
  multiHunks?: ReadonlyArray<{ oldStr: string; newStr: string; startLine: number }>;
}

/** 这些前缀由 tool-runtime 的错误出口产出；仅在拿不到结构化 status 时作为兜底判据。 */
const TOOL_ERROR_PREFIXES = ['错误:', 'Error:', 'CHANGE_CONFLICT', 'EXECUTION_ERROR'];

function looksLikeToolError(output: string): boolean {
  return TOOL_ERROR_PREFIXES.some((prefix) => output.startsWith(prefix));
}

function toolOutcomeInfo(payload: Record<string, unknown>): ToolOutcomeEnvelope {
  const info: ToolOutcomeEnvelope = {};
  if (typeof payload.status === 'string') info.status = payload.status;
  if (typeof payload.code === 'string') info.code = payload.code;
  if (Array.isArray(payload.changedFiles)) info.changedFiles = payload.changedFiles.map(String);
  if (typeof payload.editStartLine === 'number') info.editStartLine = payload.editStartLine;
  if (typeof payload.preWriteOld === 'string') info.preWriteOld = payload.preWriteOld;
  if (Array.isArray(payload.multiHunks)) {
    info.multiHunks = (payload.multiHunks as unknown[])
      .map((raw) => {
        if (!raw || typeof raw !== 'object') return null;
        const hunk = raw as Record<string, unknown>;
        if (typeof hunk.oldStr !== 'string' || typeof hunk.newStr !== 'string') return null;
        return { oldStr: hunk.oldStr, newStr: hunk.newStr, startLine: Number(hunk.startLine) || 1 };
      })
      .filter((hunk): hunk is { oldStr: string; newStr: string; startLine: number } => hunk !== null);
  }
  return info;
}

/** 工具是否失败：结构化 status 优先，旧版 host 才退回字符串前缀。 */
function toolFailed(info: ToolOutcomeEnvelope, output: string): boolean {
  if (info.status) return info.status !== 'success';
  return looksLikeToolError(output);
}

/** tool-view.ts 的文案（每次渲染时现取，切语言即时生效）。 */
function toolViewLabels(): ToolViewLabels {
  return {
    failed: t('tool.statusFailed'),
    denied: t('tool.statusDenied'),
    aborted: t('tool.statusAborted'),
    noOutput: t('tool.statusNoOutput'),
    truncated: t('tool.truncated'),
    lines: (n) => t('tool.lines', { n }),
    matches: (n) => t('tool.summaryMatches', { n }),
    files: (n) => t('tool.summaryFiles', { n }),
    results: (n) => t('tool.summaryResults', { n }),
    changedFiles: (n) => t('tool.summaryChangedFiles', { n }),
    steps: (done, total) => t('tool.summarySteps', { done, total }),
    moreLines: (n) => t('tool.moreLines', { n }),
    askOptions: (n) => t('tool.askOptions', { n }),
    askAnswered: t('tool.askAnswered'),
    askCancelled: t('tool.askCancelled'),
    askAnswer: t('tool.askAnswer'),
    stepArgs: t('tool.subStepArgs'),
    stepResult: t('tool.subStepResult'),
    stepRunning: t('tool.subStepRunning'),
  };
}

/**
 * edit_file / write_file 的展开区：能还原去向就展示 diff 视图，否则回退原始参数 JSON。
 * 回退条件三条，缺一不可：①入参不是可解析的 JSON；②工具报错（改动没落盘，展示 diff 会骗人）；
 * ③解析不出改动片段（例如只给了未知字段）。
 *
 * 同时带上改动量：折叠行上要显示 `+3 -1`，用户不用展开就知道这次改了多少。
 *
 * ⚠ 只算「改动量」，HTML 交给 `build` 惰性构建：回放一次真实会话有 126 个 edit/write 块，
 * 全量渲染实测 28.4ms / 0.81MB，而 LCS（buildFileChange）+ 统计（summarizeFileChange）
 * 合计只有 2.3ms。折叠行要的是 `+3 -1`，展开区没人看 —— 与 tool-view 的 read_file 同一诉求。
 */
function fileChangeDetail(
  name: string,
  args: string,
  output: string,
  info: ToolOutcomeEnvelope,
): { build: () => string; added: number; removed: number } | null {
  if (name !== 'edit_file' && name !== 'write_file') return null;
  if (!args || toolFailed(info, output)) return null;
  const change = buildFileChange(name, args, {
    editStartLine: info.editStartLine,
    preWriteOld: info.preWriteOld ?? null,
    multiHunks: info.multiHunks,
  });
  if (!change) return null;
  const stats = summarizeFileChange(change) ?? { added: 0, removed: 0 };
  // 文案每次展开时现取（切语言即时生效，与原先每条都调 fileChangeLabels() 一致）。
  const build = (): string => renderFileChangeHtml(change, fileChangeLabels());
  return { build, added: stats.added, removed: stats.removed };
}

/* ── 工具块 detail 的两级惰性 ────────────────────────
 * 一次会话里九成以上的工具块是收起状态,而 detail HTML 一次就有 1.2–1.8MB
 * (实测 .mocode/sessions 里最大的几条):innerHTML 一插就是几万个节点参与样式与布局,
 * 这些开销用户永远看不到 —— 切会话的体感主要花在这里。
 *
 * 两级:
 *   ① 字符串级(buildToolView 返回闭包):read_file 的语法高亮最贵(实测 1.3ms/块,
 *      一份真实会话 514 个 read_file 合计 279ms),折叠行只要摘要,所以 HTML 字符串
 *      根本不在回放时拼 —— 实测 910 块的工具视图构建从 287ms 降到十几毫秒;
 *   ② DOM 级(本组 WeakMap):已经拼好的字符串也只存着,用户点开那一条才插进 DOM。
 * 展开一次后就缓存结果;同一块可能被原地更新(运行中 → 完成、流式重绘),
 * 每次 setToolDetail 会换掉 builder 并作废缓存。 */
const detailBuilders = new WeakMap<HTMLDetailsElement, () => string>();
const detailReady = new WeakMap<HTMLDetailsElement, string>();

/** 存下 detail 的构建器;当前已展开的块立刻建好并插进 DOM(否则就等 toggle)。 */
function setToolDetail(entry: HTMLDetailsElement, build: (() => string) | null): void {
  if (!build) {
    detailBuilders.delete(entry);
    detailReady.delete(entry);
    entry.querySelector(':scope > .tool-detail')?.remove();
    return;
  }
  detailBuilders.set(entry, build);
  detailReady.delete(entry);
  // force:同一 id 的块可能被原地更新(运行中 → 完成、流式输出重绘),
  // 已展开的块必须换成新内容,否则用户看到的是上一版的半截输出。
  if (entry.open) revealToolDetail(entry, true);
}

/** 展开时把 detail 插进 DOM;已存在则只在 force 时替换内容(重插会重置用户的滚动位置)。 */
function revealToolDetail(entry: HTMLDetailsElement, force = false): void {
  const build = detailBuilders.get(entry);
  if (!build) return;
  const existing = entry.querySelector<HTMLElement>(':scope > .tool-detail');
  if (existing && !force) return;
  let html = detailReady.get(entry);
  if (html === undefined) {
    html = build();
    detailReady.set(entry, html);
  }
  if (existing) {
    existing.innerHTML = html;
    mountIcons(existing);
    return;
  }
  entry.insertAdjacentHTML('beforeend', `<div class="tool-detail">${html}</div>`);
  // detail 里也可能有 data-icon 占位符,插完再挂一次图标。
  mountIcons(entry);
}

// 原生 <details> 的 toggle 事件不冒泡,只能在容器上捕获(与文件树 toggle 同一套做法)。
conversation.addEventListener(
  'toggle',
  (event) => {
    const entry = event.target;
    if (!(entry instanceof HTMLDetailsElement)) return;
    if (!entry.classList.contains('tool-entry') || !entry.open) return;
    revealToolDetail(entry);
  },
  true,
);

// 工具行上的「填入终端」：命令已经完整跑过一次，用户想手动复现/改一行再跑。
// 按钮在 <summary> 里，原生点击会连带展开/收起 —— 必须在这里吃掉。
conversation.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-terminal-fill]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  // 面板没开、或停在别的视图，都要切到终端 —— 按钮的语义就是「给我终端里这条命令」。
  if (inspector.classList.contains('hidden') || activeInspectorTab !== 'terminal') openInspector('terminal');
  fillTerminalCommand(button.dataset.terminalFill ?? '');
});

// 正文里的文件路径（`docs/x.md` 这类裸文本，由 file-links 包成 <a data-file-path>）：
// 点击后的去向见 openFilePath。href 恒为 `#`，不吃掉默认行为会让窗口滚到顶部。
conversation.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-file-path]');
  if (!link) return;
  event.preventDefault();
  // 工具行上的路径挂在 <summary> 里：不拦住冒泡，点它还会连带展开/收起那一行。
  event.stopPropagation();
  openFilePath(link.dataset.filePath ?? '', link.dataset.fileKind);
});

/**
 * 追加 / 更新一条工具行。
 * - 工具行一律 append 到当前助手轮次的末尾 —— 顺序 = 发生顺序;
 * - 默认折叠(details 关闭),只显示「动词 + 对象 + 状态/耗时」一行;
 * - 同一 id 的 tool_started → tool_completed 原地更新,不新增行。
 */
function addTool(payload: Record<string, unknown>, completed = false): void {
  // 工具完成可能直接展开长 diff；必须在内容增高前保存贴底状态，否则会把新增高度误判为用户上滑。
  // 批量回放期间不逐条读 scrollHeight（每次读都是强制布局），用批量入口那一次判定。
  const pinned = batchRenderDepth > 0 ? batchPinnedToBottom : isAtBottom();
  emptyState.classList.add('hidden');
  // 工具事件可能早于首个文字到达：先确保存在活跃的助手消息，工具行挂在其内容区内部。
  // 走 resumableTurn：本轮运行中被提前收口过的消息要续回去，不能另起一条气泡（见其注释）。
  const current = resumableTurn() ?? startAssistantTurn();
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
  const info = toolOutcomeInfo(payload);
  const startedAt = id ? toolStartTimes.get(id) : undefined;
  const elapsed = completed && startedAt !== undefined ? Date.now() - startedAt : null;
  const timing = elapsed !== null && elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s · ` : '';
  // 文件改动优先走 diff 视图：入参 JSON 原样展示（`{"path":…,"replacements":[{"new_string":"…"}]}`）
  // 里全是转义后的 \n，用户根本看不出改了哪几行 —— 这是这个块存在的全部意义。
  const diff = fileChangeDetail(name, args, output, info);
  // 其余工具走各自的人读视图（终端 / 文件列表 / 命中分组 / 计划清单 / 搜索结果 / 键值对）。
  // 返回 null 表示这类输出没有可靠解读，此时才回退「原始参数 + 原文」——宁可朴素，不能误导。
  const view = diff ? null : buildToolView(name, args, output, info, toolViewLabels());
  const failed = completed && toolFailed(info, output);
  const fallbackHtml = (): string => [
    args ? `<section><span>${t('tool.args')}</span><pre>${escapeHtml(args.slice(0, 2000))}</pre></section>` : '',
    output ? `<section><span>${t('tool.result')}</span><pre>${escapeHtml(output.slice(0, 6000))}${output.length > 6000 ? `\n${t('tool.truncated')}` : ''}</pre></section>` : '',
  ].join('');
  // detail 一律以「构建器」形式传下去:view.html 是闭包,折叠状态下永远不会被调用。
  const detailBuilder: (() => string) | null = diff
    ? diff.build
    : view
      ? view.html
      : args || output ? fallbackHtml : null;
  const hasDetail = detailBuilder !== null;
  // 折叠行右侧状态：先给「这次干了什么」的量化结论，再退到行数/完成。
  // 以 output 行数当状态是错的（读 3000 行文件会显示「3000 行」、grep 20 处命中显示「45 行」）。
  const changedCount = info.changedFiles?.length ?? 0;
  const status = !completed
    ? t('tool.running')
    : view?.summary
      ?? (changedCount > 0
        ? t('tool.summaryChangedFiles', { n: changedCount })
        : diff
          ? t('tool.done')
          : output
            ? t('tool.lines', { n: output.split('\n').length })
            : t('tool.done'));
  // 折叠行上的改动量：不展开也能看到这次改了多少（与终端 Update 头行的 Added/removed 同义）。
  const changeStat = diff
    ? `<span class="tool-changes">${diff.added > 0 ? `<span class="diff-add">+${diff.added}</span>` : ''}${diff.removed > 0 ? `<span class="diff-del">-${diff.removed}</span>` : ''}</span>`
    : '';

  entry.className = `tool-entry ${completed ? 'tool-done' : 'tool-running'}${hasDetail ? '' : ' tool-empty'}${failed ? ' tool-failed' : ''}`;
  entry.dataset.toolLabel = meta.label;
  // 联动入口：agent 跑过的命令可以一键回填到终端面板（不回车，等用户确认）。
  // 只给 run_command：其他工具没有「一条能在 shell 里重跑的命令」。
  const fillCommand = completed && name === 'run_command' ? runCommandOf(args) : '';
  // 文件类工具的路径本身也是入口：点了就在右侧面板预览，不必去正文里找那句「已写完：…」。
  // 用 <a data-file-path> 而不是 <span>，沿用正文里路径链接的同一条点击通道。
  const filePath = toolFilePath(name, args);
  // 产物（.exe/.zip 这类）点击是「去文件夹拿」，标题文案得跟着换，否则用户以为会进预览面板。
  const targetHtml = !target
    ? ''
    : filePath
      ? `<a class="tool-target tool-target-file" href="#" data-file-path="${escapeHtml(filePath)}" title="${escapeHtml(isArtifactPath(filePath) ? t('fileLink.reveal', { path: filePath }) : t('tool.openFile', { path: filePath }))}">${escapeHtml(target)}</a>`
      : `<span class="tool-target" title="${escapeHtml(target)}">${escapeHtml(target)}</span>`;
  entry.innerHTML = `<summary>
  <span class="tool-chevron" data-icon="chevron-right"></span>
  <span class="tool-kind" data-icon="${escapeHtml(meta.icon)}"></span>
  <span class="tool-name">${escapeHtml(meta.label)}</span>
  ${targetHtml}
  <span class="tool-meta">${changeStat}${completed ? '' : '<span class="tool-dot"></span>'}${timing}${escapeHtml(status)}</span>
  ${fillCommand ? `<button class="tool-fill" type="button" data-terminal-fill="${escapeHtml(fillCommand)}" title="${escapeHtml(t('terminal.fill'))}" aria-label="${escapeHtml(t('terminal.fill'))}">${icon('terminal')}</button>` : ''}
</summary>`;
  mountIcons(entry);
  // 折叠优先：完成即收起。运行中的行也默认收起（用户手动展开过则保留其状态）。
  // 例外两条：①文件编辑带 diff —— 终端里 diff 是直接铺在正文里的，收起等于让用户再点一次；
  // ②运行中的子 agent —— 它有进度行在长，收起就看不到「正在干什么」，与静止的卡片没区别。
  // 「干净会话」下①不再成立：diff 不自动铺开，用户想看再点（改动量 +N/-N 仍在折叠行上）。
  //
  // 失败的调用**也**默认收起：失败已经在折叠行上标出来了（tool-failed 的红色「失败」标签），
  // 再自动展开就会在一串调用里突然铺开一大块错误文本，把「一次工具调用 = 一行」的节奏打散；
  // 想看原因点一下即可，与其他工具完全一致。这里只需要保持一致的收起行为。
  if (completed) entry.open = Boolean(diff) && !cleanRunMode;
  else if (name === 'sub-agent' && view) entry.open = true;
  // detail 必须在 open 定下来之后再交出去：已展开的块要立刻插进 DOM，
  // 折叠的块只留构建器等 toggle（见上方 detailBuilders 注释）。
  setToolDetail(entry, detailBuilder);
  if (id) {
    if (completed) { activeTools.delete(id); toolStartTimes.delete(id); }
    else if (isNew) { activeTools.set(id, entry); toolStartTimes.set(id, Date.now()); }
  }
  if (isNew) {
    const content = (current.querySelector('.message-content') ?? current) as HTMLElement;
    if (!cleanRunMode && STANDALONE_TOOLS.has(name)) {
      // 文件编辑独立成行展示(不进集合):编辑内容用户必须能直接找到。
      // 「干净会话」下反过来——并进集合，让对话本身保持连续（diff 仍在，点击才展开）。
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
  if (pinned) smartScrollToBottom(true);
}
/* ── 工具流式输出（tool_output）──────────────────────────
   终端里边跑边出，GUI 若只在 tool_completed 时一次性画，用户就只能看最后一坨。
   但每来一个 chunk 就重建 innerHTML 会拖垮渲染（build/test 一次几百个 chunk），
   所以按 id 攒着、250ms 节流重绘一次；tool_completed 到达时会把最终 output 整体覆盖，
   节流队列里剩的 chunk 因而无需保证不丢。 */
const TOOL_OUTPUT_THROTTLE_MS = 250;
const toolOutputPending = new Map<string, ReturnType<typeof setTimeout>>();

function appendToolOutput(payload: Record<string, unknown>): void {
  const id = payload.id == null ? '' : String(payload.id);
  if (!id) return;
  // 已有一次待重绘就合并——chunk 高频到达时只保留一个定时器。
  if (toolOutputPending.has(id)) return;
  toolOutputPending.set(
    id,
    setTimeout(() => {
      toolOutputPending.delete(id);
      // 累计文本以事件缓冲为准（切任务回来仍能还原），DOM 只按最终文本重绘一次。
      const stream = streams.get(viewingTaskId() ?? '');
      const item = stream
        ? [...stream.items].reverse().find((entry) => entry.kind === 'tool' && entry.id === id)
        : undefined;
      if (!item || item.kind !== 'tool' || item.done) return;
      addTool({ id, name: item.name, output: item.output }, false);
    }, TOOL_OUTPUT_THROTTLE_MS),
  );
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
  // 每个 delta 都读一次 scrollHeight 会与「写 DOM」交替触发布局（layout thrash）——
  // 打字/点按钮就在这个循环里排队。跟随滚动并到一帧一次。
  scheduleFollowBottom();
}
function renderHistory(history: HistoryItem[]): void {
  hideExtensionsView();
  conversation.innerHTML = ''; activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  if (!history.length) { emptyState.classList.remove('hidden'); return; }
  // 一条 user 消息之后的所有 assistant / tool 片段归为同一轮,按原始顺序铺成 block 流。
  // 整段放进 batchRender：长会话几百条消息 + 上百个工具块，逐条各滚一次底、各重算一次集合行
  // 会触发上百次强制布局 —— 那是「点开会话要卡一下」的渲染侧主因。
  batchRender(() => {
    for (const item of history) {
      if (item.role === 'user') {
        finalizeTurn(activeAssistant);
        activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
        addMessage('user', item.text, item.attachments ?? []);
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
  });
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  // 历史回放也要还原计划面板：重启后打开旧任务时没有事件缓冲，plan 只能从会话历史里捞。
  const taskId = viewingTaskId();
  if (taskId) {
    const stream = streamFor(taskId);
    const plan = planForRestore(planFromHistory(history));
    if (plan) stream.plan = plan;
    syncPlanPanel(taskId);
  }
}

/**
 * 把一段文本用 markdown 渲染到 .message-body 内,挂上交互。
 * 助手消息流结束后调用,以及历史消息回放时调用。
 */
function renderMessageBody(body: HTMLElement, text: string): void {
  body.classList.add('md-rendered');
  body.innerHTML = renderMarkdown(closeOpenFence(text));
  enhanceCodeBlocks(body);
  // 正文里裸写的路径（「文档已写完：docs/xxx.md」）做成可点击入口。
  // 放在 md 渲染之后：代码块 / 行内代码 / 已有链接都在 DOM 里，file-links 才能跳过它们。
  linkifyFilePaths(body);
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
  // 同理:渲染前的贴底状态才算数(见 scheduleMdRender 注释)。批量回放期间复用入口的判定。
  const pinned = batchRenderDepth > 0 ? batchPinnedToBottom : isAtBottom();
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

let openTaskSequence = 0;
async function openTask(taskId: string): Promise<void> {
  const sequence = ++openTaskSequence;
  // 主进程读会话 / 恢复日志时可能抛异常（历史上就踩过 >125k 条日志展开传参的 RangeError）。
  // 那条 invoke 会变成 rejected Promise：不接住的话点击**完全没有反馈**，用户只会觉得「点不动、
  // 是不是卡了」，然后再点一次、再点一次。这里必须把它变成一句看得见的提示。
  let workspace: Awaited<ReturnType<typeof window.mocodeWork.selectTask>> = null;
  try {
    workspace = await window.mocodeWork.selectTask(taskId);
  } catch (cause) {
    if (sequence === openTaskSequence) {
      showToast('error', humanizeError(cause instanceof Error ? cause.message : String(cause)) ?? t('toast.openTaskFailed'), 6000);
    }
    return;
  }
  // 快速连点以最后一次为准：旧会话读取慢时，不能把已经打开的新会话覆盖回去。
  if (!workspace || sequence !== openTaskSequence) return;
  updateState(workspace.state);
  // 运行中/本周期跑过的任务用事件缓冲重放;旧任务(重启后)用 session 历史回放。
  switchToTask(taskId, workspace.history, workspace.recovery);
}

/**
 * 丢弃一个「任务记录已经不存在」的任务在渲染层的运行时残留。
 *
 * 删任务、删空间都走这里。不清的后果很具体：已删任务的事件到达时 streamFor() 会照旧建出
 * 缓冲，isRunning() 读到一个不存在的任务。
 *
 * ⚠ 只清与任务绑定的内存状态，**不碰 DOM**：当前正在看的是谁由调用方按 viewingTaskId 判断
 * —— 删空间时把别的空间正在跑的会话一并清空，就是「会话泄出来」那个 bug 的来源。
 */
function dropTaskRuntime(taskId: string): void {
  streams.delete(taskId);
  clearRunWatchdog(taskId);
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
  dropTaskRuntime(taskId);
  updateState(next);
  if (deletingSelectedTask && next.selectedTaskId !== taskId) clearWorkspace();
  showToast('info', t('toast.deletedTask'));
}

/**
 * 审批 / 提问面板。
 *
 * 协议里 approval_requested 有两种来源，处理方式必须分开：
 *   - permission（工具权限）：给几个选项让用户选，「允许一次 / 允许本次会话 / 拒绝」；
 *   - ask_human（模型主动提问）：模型想要一个**值**，可能根本没有选项 → 必须露出输入框。
 *
 * 旧实现三个硬伤，全部已修：
 *   ① 忽略 payload.type —— input 形态（无选项）被渲染成「确认」按钮，点下去
 *      回的是 selected，模型拿到的是「确认」这两个字而不是用户想给的值；
 *   ② 没有输入框 —— 用户无法在选项之外回答，模型给的预设选项不对时只能选个错的；
 *   ③ 忽略 defaultIndex —— 危险操作（rm -rf 之类）本来已把默认落在「拒绝」上
 *      （src/permissions/index.ts:279），面板却总把第一个按钮标成 approve 样式，
 *      顺手回车就是放行。
 */
/**
 * 人工介入卡被用户收起时记下 approvalId：事件重放 / 横条点击会重绘同一张卡，
 * 不能把用户「先收起来读正文」的意图重置回展开态。换了 approvalId 才算新卡片。
 */
let approvalCollapsedFor = '';

function showApproval(taskId: string, payload: Record<string, unknown>, intent?: { expand?: boolean }): void {
  const approvalId = String(payload.approvalId ?? '');
  const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  const isInput = String(payload.type ?? (options.length ? 'choice' : 'input')) === 'input';
  const allowCustom = payload.allowCustom !== false;
  const defaultIndex = Math.max(0, Math.min(Number(payload.defaultIndex) || 0, Math.max(0, options.length - 1)));
  const seed = String(payload.seed ?? '');
  approvalPanel.classList.remove('hidden');
  // 输入框在 input 形态下是主入口；choice 形态下只在 allowCustom 时作为「其他…」出现。
  const showInput = isInput || allowCustom;
  const buttons = options.length
    ? options
        .map(
          (option, index) =>
            `<button data-approval="${escapeHtml(option)}" class="${index === defaultIndex ? 'approve' : ''}">${escapeHtml(option)}</button>`,
        )
        .join('')
    : isInput
      ? ''
      : `<button data-approval="approve" class="approve">${icon('check')}${t('approval.confirm')}</button>`;
  const questionTitle = escapeHtml(String(payload.title ?? t('approval.default')));
  // 卡片分「卡片头」与「卡片体」：收起时只留头部一行，正文、详情、输入框、按钮全藏起来。
  // 目的是让人工介入不长期压住 agent 输出区底部 —— 用户先读正文做决定，读完再展开回答。
  approvalPanel.innerHTML =
    `<div class="approval-head">` +
      `<div class="approval-title">${icon('warn')}<span>${t('approval.title')}</span></div>` +
      `<span class="approval-summary" title="${questionTitle}">${questionTitle}</span>` +
      `<button type="button" class="approval-collapse" data-collapse aria-expanded="true">${icon('chevron-down')}<span>${escapeHtml(t('approval.collapse'))}</span></button>` +
    `</div>` +
    `<div class="approval-body">` +
      `<p>${questionTitle}</p>` +
      `<pre>${escapeHtml(String(payload.detail ?? ''))}</pre>` +
      (showInput
        ? `<textarea class="approval-input" rows="1" placeholder="${escapeHtml(t('approval.inputPlaceholder'))}">${escapeHtml(seed)}</textarea>`
        : '') +
      `<div class="approval-actions">${buttons}<button data-cancel>${icon('close')}${t('approval.reject')}</button></div>` +
    `</div>`;
  const resolve = (value: Record<string, unknown>): void => {
    window.mocodeWork.send({ type: 'approval', id: taskId, approvalId, ...value });
    approvalPanel.classList.add('hidden');
    approvalPanel.classList.remove('is-collapsed');
    approvalCollapsedFor = '';
    const stream = streams.get(taskId);
    if (stream) stream.pendingApproval = null;
    syncAttention();
  };
  const input = approvalPanel.querySelector<HTMLTextAreaElement>('.approval-input');
  // 单行起步、需要时才长高：多行答案（Shift+Enter）仍然能写，但平时不白占三行高度。
  const autoGrowInput = (): void => {
    // 收起态正文是 display:none，量到的 scrollHeight 恒为 0；此时不动高度，
    // 等展开时 setCollapsed(false) 再量一次（否则收起再展开会得到一个 0 高的框）。
    if (!input || approvalPanel.classList.contains('is-collapsed')) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  };
  const setCollapsed = (collapsed: boolean): void => {
    approvalPanel.classList.toggle('is-collapsed', collapsed);
    approvalCollapsedFor = collapsed ? approvalId : '';
    const toggle = approvalPanel.querySelector<HTMLButtonElement>('[data-collapse]');
    if (toggle) {
      const label = collapsed ? t('approval.expand') : t('approval.collapse');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.title = label;
      toggle.innerHTML = `${icon('chevron-down')}<span>${escapeHtml(label)}</span>`;
    }
    // 展开后才有可见尺寸：此时才量 scrollHeight 并还给输入框焦点。
    if (!collapsed) { autoGrowInput(); if (isInput) input?.focus(); }
  };
  // 同一张卡片被重复绘制（事件重放）时保留用户收起的意图；换了 approvalId 才复位。
  // intent.expand 给「前往处理」用：横条点击的语义就是「现在要去回答」，必须展开。
  setCollapsed(!intent?.expand && approvalCollapsedFor === approvalId && approvalCollapsedFor !== '');
  const submitInput = (): void => {
    const value = input?.value.trim() ?? '';
    // 空输入的「提交」等于没回答：退回让用户取消，不要给模型塞一个空串当答复。
    if (!value) return resolve({ action: 'cancelled' });
    resolve({ action: 'submitted', value });
  };
  if (input) {
    // input 形态下自动聚焦：用户点开面板就该能直接打字，不用再点一次输入框。
    if (isInput && !approvalPanel.classList.contains('is-collapsed')) queueMicrotask(() => input.focus());
    autoGrowInput();
    input.addEventListener('input', autoGrowInput);
    input.addEventListener('keydown', (event) => {
      // Enter 提交，Shift+Enter 换行（多行答案很常见）。
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitInput(); }
      if (event.key === 'Escape') { event.preventDefault(); resolve({ action: 'cancelled' }); }
    });
  }
  approvalPanel.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach((button) =>
    button.addEventListener('click', () => resolve({ action: 'selected', value: button.dataset.approval })),
  );
  // 整条头部都是点击目标。收起态下这一行就是卡片的**全部**内容，而「展开回答」只是最右边
  // 一个几十像素宽的胶囊 —— 用户得瞄准它才点得开，实测很难点中（尤其是收起态只剩一行时）。
  // 按钮节点保留：它是键盘可达的控件（tab 焦点环、Enter/Space 原生 click 会冒泡到头部），
  // 事件只挂在头部一处，避免「点按钮 = 冒泡到头部再切一次」把状态掀回去。
  approvalPanel.querySelector<HTMLElement>('.approval-head')?.addEventListener('click', () => {
    setCollapsed(!approvalPanel.classList.contains('is-collapsed'));
  });
  approvalPanel.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', () => resolve({ action: 'cancelled' }));
  if (isInput && !options.length) {
    // 没有选项按钮时，「提交」需要一个显式出口（只有 textarea 的 Enter 不够可发现）。
    const actions = approvalPanel.querySelector('.approval-actions');
    if (actions) {
      const submit = document.createElement('button');
      submit.className = 'approve';
      submit.textContent = t('approval.submit');
      submit.addEventListener('click', submitInput);
      actions.prepend(submit);
    }
  }
}
function setRunning(running: boolean): void { running = running && !promptInput.value.trim() && !attachments.length; sendButton.innerHTML = icon(running ? 'square' : 'paper-airplane'); sendButton.classList.toggle('stop', running); sendButton.title = running ? t('composer.stop') : t('composer.send'); sendButton.setAttribute('aria-label', running ? t('composer.stopAria') : t('composer.sendAria')); }
function resizePrompt(): void { promptInput.style.height = 'auto'; promptInput.style.height = `${Math.min(promptInput.scrollHeight, 128)}px`; setRunning(isRunning(viewingTaskId())); }

/**
 * 输入卡变高/变矮时，若用户本来就在底部，把会话重新贴到底。
 *
 * ⚠ 这里**不再**测量高度写 CSS 变量：会话区的底边由 flex 排版保证（.workspace flex column
 * → .thread `flex:1` → .composer-area `flex:0 0 auto`，见 style.css 的 .thread 注释）。
 * 历史教训：曾用 ResizeObserver 实测输入卡高度写 `--composer-h` 给 `.conversation`
 * 当 `inset` 底边，测量慢一拍（附件 chip 刚插入 / 窗口缩放 / 字体就绪前）会话区就伸到
 * 输入卡下面，且 scrollTop 已到 maxScroll —— 表现为「最后几行被输入框挡住，再也拉不上来」。
 *
 * 保留观察器的唯一理由：`.conversation` 上有 `overflow-anchor: none`，输入卡长高时会话
 * 可见区变矮而 scrollTop 不变，原本贴底的内容就会掉到视口下方，需要显式补一次贴底。
 */
function keepBottomOnComposerResize(): void {
  const area = $('.composer-area');
  if (!area || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => {
    if (!userScrolled) smartScrollToBottom(true);
  }).observe(area);
}
/* ── 图片预览：输入附件与已发送消息共用 ────────────────── */
let imageHoverEl: HTMLElement | null = null;
let imageHoverFrame = 0;
let imageViewerEl: HTMLElement | null = null;
let imageViewerReturnFocus: HTMLElement | null = null;

function hideImageHover(): void {
  cancelAnimationFrame(imageHoverFrame);
  imageHoverFrame = 0;
  if (!imageHoverEl) return;
  imageHoverEl.classList.add('hidden');
  imageHoverEl.querySelector('img')?.removeAttribute('src');
}

function ensureImageHover(): HTMLElement {
  if (imageHoverEl) return imageHoverEl;
  const preview = document.createElement('figure');
  preview.className = 'image-hover-preview hidden';
  preview.setAttribute('aria-hidden', 'true');
  preview.innerHTML = '<img alt=""><figcaption></figcaption>';
  document.body.append(preview);
  imageHoverEl = preview;
  return preview;
}

function showImageHover(attachment: ImageAttachment, anchor: HTMLElement): void {
  const preview = ensureImageHover();
  const image = preview.querySelector('img') as HTMLImageElement;
  (preview.querySelector('figcaption') as HTMLElement).textContent = attachment.name;
  preview.classList.remove('hidden');
  const position = (): void => {
    if (preview.classList.contains('hidden')) return;
    const anchorRect = anchor.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    const margin = 12;
    const gap = 10;
    const left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - previewRect.width - margin));
    const above = anchorRect.top - previewRect.height - gap;
    const below = anchorRect.bottom + gap;
    const top = above >= margin ? above : Math.max(margin, Math.min(below, window.innerHeight - previewRect.height - margin));
    preview.style.left = `${Math.round(left)}px`;
    preview.style.top = `${Math.round(top)}px`;
  };
  image.onload = position;
  image.alt = attachment.name;
  image.src = attachment.dataUrl;
  cancelAnimationFrame(imageHoverFrame);
  imageHoverFrame = requestAnimationFrame(position);
}

function closeImageViewer(): void {
  if (!imageViewerEl || imageViewerEl.classList.contains('hidden')) return;
  imageViewerEl.classList.add('hidden');
  imageViewerEl.querySelector('img')?.removeAttribute('src');
  imageViewerReturnFocus?.focus();
  imageViewerReturnFocus = null;
}

function openImageViewer(attachment: ImageAttachment, trigger: HTMLElement): void {
  if (!imageViewerEl) {
    const viewer = document.createElement('section');
    viewer.className = 'image-viewer hidden';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.innerHTML = `<div class="image-viewer-card"><button type="button" class="image-viewer-close" title="${t('common.close')}" aria-label="${t('common.close')}">${icon('close')}</button><figure><img alt=""><figcaption></figcaption></figure></div>`;
    viewer.querySelector('.image-viewer-close')?.addEventListener('click', closeImageViewer);
    viewer.addEventListener('click', (event) => { if (event.target === viewer) closeImageViewer(); });
    document.body.append(viewer);
    imageViewerEl = viewer;
  }
  imageViewerReturnFocus = trigger;
  const image = imageViewerEl.querySelector('img') as HTMLImageElement;
  image.alt = attachment.name;
  image.src = attachment.dataUrl;
  (imageViewerEl.querySelector('figcaption') as HTMLElement).textContent = attachment.name;
  imageViewerEl.setAttribute('aria-label', attachment.name);
  imageViewerEl.classList.remove('hidden');
  (imageViewerEl.querySelector('.image-viewer-close') as HTMLButtonElement).focus();
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !imageViewerEl || imageViewerEl.classList.contains('hidden')) return;
  event.preventDefault();
  event.stopPropagation();
  closeImageViewer();
});

function imagePreviewButton(attachment: ImageAttachment, showName = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = showName ? 'image-preview-trigger attachment-preview' : 'image-preview-trigger';
  button.title = t('composer.imagePreview', { name: attachment.name });
  button.setAttribute('aria-label', button.title);
  const image = document.createElement('img');
  image.className = 'image-thumb';
  image.src = attachment.dataUrl;
  image.alt = attachment.name;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.draggable = false;
  button.append(image);
  if (showName) {
    const name = document.createElement('span');
    name.className = 'attachment-image-name';
    name.textContent = attachment.name;
    button.append(name);
  }
  button.addEventListener('mouseenter', () => showImageHover(attachment, button));
  button.addEventListener('mouseleave', hideImageHover);
  button.addEventListener('focus', () => showImageHover(attachment, button));
  button.addEventListener('blur', hideImageHover);
  button.addEventListener('click', () => { hideImageHover(); openImageViewer(attachment, button); });
  return button;
}

/** 文档与图片使用同一附件模型；文档显示文件卡片，绝不送进 <img>。 */
function filePreview(attachment: Attachment): HTMLSpanElement {
  const card = document.createElement('span');
  card.className = 'file-attachment';
  card.title = attachment.truncated ? t('composer.fileTruncated', { name: attachment.name }) : attachment.name;
  const symbol = document.createElement('span');
  symbol.className = 'file-attachment-icon';
  symbol.innerHTML = icon('files');
  const name = document.createElement('span');
  name.className = 'file-attachment-name';
  name.textContent = attachment.name;
  card.append(symbol, name);
  if (attachment.truncated) {
    const mark = document.createElement('span');
    mark.className = 'file-attachment-truncated';
    mark.textContent = t('composer.truncated');
    card.append(mark);
  }
  return card;
}

function attachmentPreview(attachment: Attachment, showName = false): HTMLElement {
  return attachment.dataUrl ? imagePreviewButton({ ...attachment, dataUrl: attachment.dataUrl }, showName) : filePreview(attachment);
}

/** 用户消息附件网格；实时消息与历史回放共用。 */
function imageGallery(items: Attachment[], className = 'message-image'): HTMLElement {
  const gallery = document.createElement('div');
  gallery.className = `image-gallery ${className}`;
  for (const attachment of items) gallery.append(attachmentPreview(attachment));
  return gallery;
}

function renderAttachments(): void {
  hideImageHover();
  attachmentList.replaceChildren();
  attachments.forEach((attachment, index) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    chip.append(attachmentPreview(attachment, true));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.dataset.attachment = String(index);
    remove.title = t('composer.attachment');
    remove.setAttribute('aria-label', t('composer.attachmentRemove'));
    remove.innerHTML = icon('close');
    remove.addEventListener('click', () => { attachments.splice(index, 1); renderAttachments(); });
    chip.append(remove);
    attachmentList.append(chip);
  });
}

/* ── Smart scroll ──────────────────────────────────────── */
/** 距离底部 < 96px 视为"在底部",继续跟随;否则不打扰。 */
const AT_BOTTOM_THRESHOLD = 96;

function isAtBottom(): boolean {
  const distance = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  return distance < AT_BOTTOM_THRESHOLD;
}

/**
 * 批量渲染闸：切任务 / 重放历史 / 重启后打开旧会话时，会一次性 append 几百条消息与工具块。
 * 每个节点各自 `smartScrollToBottom()`（读 scrollHeight）+ `refreshToolGroup()`（querySelectorAll +
 * innerHTML）的话，一次切换要触发上百次强制布局 —— 这就是「点会话卡一下」的渲染侧主因。
 *
 * 批量期间只记脏，末尾统一收尾一次：滚动只算一次底线位置，工具集合行每个只重算一次。
 */
let batchRenderDepth = 0;
let batchPinnedToBottom = false;
let batchNeedsFloorScroll = false;
const batchDirtyToolGroups = new Set<HTMLElement>();

function batchRender<T>(run: () => T): T {
  if (batchRenderDepth === 0) batchPinnedToBottom = isAtBottom();
  batchRenderDepth += 1;
  try {
    return run();
  } finally {
    batchRenderDepth -= 1;
    if (batchRenderDepth === 0) {
      for (const group of batchDirtyToolGroups) paintToolGroup(group);
      batchDirtyToolGroups.clear();
      if (batchNeedsFloorScroll || batchPinnedToBottom) {
        conversation.scrollTop = conversation.scrollHeight;
      }
      batchNeedsFloorScroll = false;
    }
  }
}

function smartScrollToBottom(force = false): void {
  // 批量期间不碰布局：批量入口已经读过一次「是否贴底」，末尾统一滚。
  if (batchRenderDepth > 0) { batchNeedsFloorScroll ||= force; return; }
  if (force || isAtBottom()) conversation.scrollTop = conversation.scrollHeight;
}

/**
 * 「合并到一帧执行一次」的小工具。
 *
 * ⚠ 必须有定时器兜底：rAF 只在真的有帧要画时才推进 —— 窗口最小化 / 离屏时它会**静默挂起**
 * （实测踩过，见下方轨道注释）。只靠 rAF 的话「已排队」标志会永久卡住，
 * 之后每一次合并调用都被「已经排了一帧」挡掉 —— 表现为最小化再回来以后再也不自动贴底、
 * 高亮也不再跟着滚。超时兜底把这种情况收敛成「最多晚 50ms 跑一次」。
 */
const FRAME_FALLBACK_MS = 50;
function frameThrottle(run: () => void): () => void {
  let scheduled = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    if (!scheduled) return;
    scheduled = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    run();
  };
  return () => {
    if (scheduled) return;
    scheduled = true;
    frame = requestAnimationFrame(fire);
    timer = setTimeout(fire, FRAME_FALLBACK_MS);
  };
}

/**
 * 流式跟随的合并版：每来一个 token 都读一次 scrollHeight 会和「写 DOM → 触发布局」交替，
 * 形成 layout thrash（打字/点按钮就在这个循环里排队）。改成一帧最多跟一次。
 */
const requestFollowBottom = frameThrottle(() => {
  if (isAtBottom()) conversation.scrollTop = conversation.scrollHeight;
});
function scheduleFollowBottom(): void {
  if (batchRenderDepth > 0) return;
  requestFollowBottom();
}

// 用户主动滚动:离开底部超过阈值,直到再次回到底之前都不再自动跟。
// 高亮重算要遍历每条用户消息的 offsetTop —— 滚动事件每秒几十次，必须并到一帧一次。
const requestScrollSync = frameThrottle(() => {
  userScrolled = !isAtBottom();
  syncConvRailActive();
});
conversation.addEventListener('scroll', () => { requestScrollSync(); }, { passive: true });

/* ── 消息导航轨(minimap rail)─────────────────────────────
 * 会话列左侧一排小圆点:一个用户消息一个点,点击滚到那条提问。
 * 长会话里翻历史时靠它一眼看清"聊了几轮、当前在哪一轮"。
 *
 * 三条硬约束(改之前先读):
 *  1. **必须挂在 .thread 上,不能进 #conversation** —— 轨道要固定不随内容滚,
 *     放进滚动容器里就只能靠 position: sticky/fixed 和它较劲。
 *  2. **位置用 transform 而不是 top** —— 小圆点尺寸小、数量多,改 top 会逐帧触发
 *     布局;**transform 走合成层**,与滚动同帧不抖。
 *  3. **只标用户消息** —— 助手消息一轮可能有多个 block(文字/工具交错),
 *     按它打点会得到一排意义不明的点。用户消息才是"轮次"的天然锚点。
 */
const RAIL_DOT_MAX = 6;
/** 跳转后让目标消息停在视口顶部往下这么多,给它的这一轮回答留出阅读空间。 */
const RAIL_ANCHOR_OFFSET = 24;
/** 轨道自身上下内边距,与 .conv-rail 的 padding 保持一致(算可用高度用)。 */
const RAIL_PAD_Y = 12;
/** 点尺寸分档:优先大点,放不下就依次退到更小的一档。 */
const RAIL_DOT_STEPS = [6, 5, 4, 3, 2];
/** 每档点尺寸配的间隙 —— 点越小间隙越小,尽量把长会话也一一对应地排下。 */
const railGapFor = (dot: number): number => (dot >= 6 ? 6 : dot >= 4 ? 4 : 2);

/**
 * 上一次建点时**第一条用户消息**的节点引用 + 当时的条数。
 * 两者一起当"集合变了没有"的判据,缺一不可:
 *   · 只比首节点 → 末尾**追加**一条消息时首节点没动,会被误判成"没变"而漏掉新点
 *     (实测踩过:走真实发送路径 submit → addMessage('user'),点数停在 1 不动);
 *   · 只比条数 → `conversation.innerHTML = ''` 后重建时条数可能恰好相同,
 *     但节点全新,轨道会指向已脱离文档的旧节点。
 * 只做判据用,不参与渲染 —— 高亮那边一律现查 DOM(见 syncConvRailActive)。
 */
let railAnchorUser: HTMLElement | null = null;
let railAnchorCount = -1;
/**
 * 每个小点对应的**消息下标**。点数与消息数相等时就是 0..n-1;
 * 消息太多排不下时会抽稀(见 syncConvRail),那时点 i 对应的是被抽中的那条消息。
 */
let railTargets: number[] = [];

function syncConvRail(): void {
  const users = Array.from(conversation.querySelectorAll<HTMLElement>('.message.user'));
  if (!users.length) {
    convRail.classList.add('hidden');
    convRail.innerHTML = '';
    railAnchorUser = null;
    railAnchorCount = 0;
    railTargets = [];
    return;
  }
  convRail.classList.remove('hidden');
  // 点尺寸自适应:必须保证「m 个点 + 间隙」塞进轨道的**内容盒**。
  // ⚠ 可用高度取 convRail 自身的 clientHeight(它由 CSS 的 top/bottom 定死,与
  //   会话可见区等高),**不能**拿 conversation.clientHeight 再减 padding ——
  //   那会多算 112px(会话上下各 --space-2xl 的 padding),点多时算出的总高
  //   看着"放得下"、实际却把首尾的点画到输入卡和顶栏上(实测踩过)。
  // 取不到高度(隐藏中 / 首帧)时按最大档走,等 ResizeObserver 回调再纠。
  const available = Math.max(0, convRail.clientHeight - RAIL_PAD_Y * 2);
  const capacity = (dot: number, gap: number): number => Math.floor((available + gap) / (dot + gap));
  let dot = RAIL_DOT_MAX;
  let gap = railGapFor(RAIL_DOT_MAX);
  for (const size of RAIL_DOT_STEPS) {
    const candidateGap = railGapFor(size);
    dot = size; gap = candidateGap;
    // available === 0(还没测量)时容量不可信,先按最大档建,别抽稀。
    if (available > 0 && users.length <= capacity(size, candidateGap)) break;
  }
  // 连最小档都排不下(几百轮的长会话):抽稀成等距的 m 个点。
  // 保留首尾两条 —— 用户最需要的是"能跳到最开始"和"跳到最新",中间稀疏点无妨。
  const maxDots = available > 0 ? Math.max(1, capacity(dot, gap)) : users.length;
  const count = Math.min(users.length, maxDots);
  railTargets = users.length <= count
    ? users.map((_, index) => index)
    : Array.from({ length: count }, (_, i) => Math.round((i * (users.length - 1)) / (count - 1)));
  const tip = (index: number): string => escapeHtml(t('msg.railTip', { n: index + 1 }));
  // 不再写 title:悬停提示改由自绘气泡负责(见下方小点悬停气泡),留着 title 会在
  // 约 1 秒后再叠一个原生提示框。aria-label 保留 —— 无障碍名不能靠视觉气泡承载。
  convRail.innerHTML = railTargets
    .map((messageIndex, i) => `<button class="conv-rail-dot" type="button" data-rail="${messageIndex}" aria-label="${tip(messageIndex)}"${count < users.length ? ' data-sampled="1"' : ''}></button>`)
    .join('');
  convRail.style.setProperty('--rail-dot', `${dot}px`);
  convRail.style.setProperty('--rail-gap', `${gap}px`);
  railAnchorUser = users[0]!;
  railAnchorCount = users.length;
  syncConvRailActive();
}

/**
 * 高亮"当前读到哪一轮":离视口**中线**最近的那条用户消息。
 * 用中线而不是顶边 —— 用户翻历史时目光停在屏幕中央,"我在读哪一轮"就由中间那条决定。
 *
 * 每次都从 DOM 现查消息、**不缓存节点数组**:缓存过一次就会在
 * 「`conversation.innerHTML = ''` 后重建」「重新生成截断尾部」这些路径上留下
 * 指向已脱离文档的旧节点 —— 它们的 offsetTop/offsetHeight 恒为 0,
 * 于是每一条的距离都相等、高亮永远停在第一个点(实测踩过)。
 * 现查的代价只是一次 querySelectorAll,远比"高亮静默失真"划算。
 */
function syncConvRailActive(): void {
  const dots = convRail.querySelectorAll<HTMLElement>('.conv-rail-dot');
  if (!dots.length) return;
  // 布局未落定(隐藏中 / 尺寸过渡中)时 clientHeight 为 0,读到的 offsetTop 也不可信,
  // 算出来必然是"第一个点",干脆不算 —— 下一个真实触发点会纠正。
  if (!conversation.clientHeight) return;
  const users = conversation.querySelectorAll<HTMLElement>('.message.user');
  const mid = conversation.scrollTop + conversation.clientHeight / 2;
  // 找离中线最近的**消息**(不是点):抽稀后消息比点多,先定位消息再折回点。
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  users.forEach((message, index) => {
    // offsetTop 相对 .conversation(定位祖先),不受滚动影响 —— 正是要的"文档位置"。
    const center = message.offsetTop + message.offsetHeight / 2;
    const distance = Math.abs(center - mid);
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  });
  // 折回最近的小点(点 i 对应消息 railTargets[i])。
  let current = 0;
  let dotDistance = Number.POSITIVE_INFINITY;
  railTargets.forEach((messageIndex, i) => {
    const distance = Math.abs(messageIndex - best);
    if (distance < dotDistance) { dotDistance = distance; current = i; }
  });
  dots.forEach((dot, index) => dot.classList.toggle('is-current', index === Math.min(current, dots.length - 1)));
}

/** 点击小点:把那条用户消息滚到视口靠上位置 —— 留出它后面这一轮回答的阅读空间。 */
convRail.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.conv-rail-dot');
  if (!button) return;
  const index = Number(button.dataset.rail ?? '');
  const message = conversation.querySelectorAll<HTMLElement>('.message.user')[index];
  if (!message) return;
  // 手写滚动而不是 scrollIntoView:要控制"停在顶部往下一点"。
  conversation.scrollTo({ top: Math.max(0, message.offsetTop - RAIL_ANCHOR_OFFSET), behavior: 'smooth' });
});

/* ── 小点悬停气泡 ────────────────────────────────────────
 * 点只有 2–6px,原生 `title` 要等约 1 秒、不换行、长提问根本认不出是哪一条
 * (抽稀后的点更认不出)。鼠标进入即弹一条气泡显示那条用户消息的原文。
 *
 * 三条硬约束(改之前先读):
 *  1. **气泡挂 body + position: fixed** —— 轨道在 .thread 里,祖先的 overflow 与
 *     transform 都可能把它裁掉;fixed 也免去"相对哪个祖先定位"的推理。
 *  2. **pointer-events: none** —— 气泡绝不能吃到鼠标:一进气泡就触发 mouseleave,
 *     气泡消失 → 鼠标回到点 → 再出现,肉眼看到的是高频闪烁。
 *  3. **隐藏延后 80ms** —— 相邻两点只隔 --rail-gap(2–6px),鼠标横穿时会连续
 *     mouseleave/mouseover;立刻隐藏会让气泡在几毫米的间隙里闪一下。
 */
/** 气泡里最多显示多少字 —— 小点只是定位用,要看全文点下去就是了。 */
const RAIL_BUBBLE_CHARS = 240;
let railBubbleEl: HTMLElement | null = null;
let railBubbleTimer: ReturnType<typeof setTimeout> | null = null;

function hideRailBubble(): void {
  // 滚动/缩放会直接调用本函数,而那时可能还挂着一个待触发的延时隐藏 —— 不清掉它,
  // 定时器回调随后会把「刚显示的新气泡」一起按掉。
  if (railBubbleTimer) { clearTimeout(railBubbleTimer); railBubbleTimer = null; }
  railBubbleEl?.classList.add('hidden');
}

function scheduleHideRailBubble(): void {
  if (railBubbleTimer) clearTimeout(railBubbleTimer);
  railBubbleTimer = setTimeout(hideRailBubble, 80);
}

function showRailBubble(dot: HTMLElement): void {
  const index = Number(dot.dataset.rail ?? '');
  const message = conversation.querySelectorAll<HTMLElement>('.message.user')[index];
  if (!message) return;
  if (railBubbleTimer) { clearTimeout(railBubbleTimer); railBubbleTimer = null; }
  if (!railBubbleEl) {
    const bubble = document.createElement('div');
    bubble.className = 'conv-rail-bubble hidden';
    bubble.setAttribute('role', 'tooltip');
    bubble.innerHTML = '<span class="conv-rail-bubble-label"></span><span class="conv-rail-bubble-text"></span>';
    document.body.append(bubble);
    railBubbleEl = bubble;
  }
  // 原文优先取 messageText:纯图片消息没有 .message-body,从 DOM 反推只会得到空串。
  const raw = (messageText.get(message) ?? message.querySelector('.message-body')?.textContent ?? '').trim();
  // 按码点截断:用 slice 会把 emoji 的代理对劈成半个,气泡里显示成乱码方块。
  const chars = [...raw];
  const text = chars.length > RAIL_BUBBLE_CHARS ? `${chars.slice(0, RAIL_BUBBLE_CHARS).join('')}…` : raw;
  (railBubbleEl.querySelector('.conv-rail-bubble-label') as HTMLElement).textContent = t('msg.railTip', { n: index + 1 });
  (railBubbleEl.querySelector('.conv-rail-bubble-text') as HTMLElement).textContent = text || t('msg.railImageOnly');
  railBubbleEl.classList.remove('hidden');
  // 必须先显示再量尺寸:隐藏状态下 getBoundingClientRect 全为 0,算不出该往上还是往下。
  const anchor = dot.getBoundingClientRect();
  const box = railBubbleEl.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(anchor.right + 10, window.innerWidth - box.width - margin));
  const top = Math.max(margin, Math.min(anchor.top + anchor.height / 2 - box.height / 2, window.innerHeight - box.height - margin));
  railBubbleEl.style.left = `${Math.round(left)}px`;
  railBubbleEl.style.top = `${Math.round(top)}px`;
}

convRail.addEventListener('mouseover', (event) => {
  const dot = (event.target as HTMLElement).closest<HTMLElement>('.conv-rail-dot');
  if (dot) showRailBubble(dot);
});
convRail.addEventListener('mouseout', (event) => {
  if ((event.target as HTMLElement).closest('.conv-rail-dot')) scheduleHideRailBubble();
});
// 小点本来就是 <button>,Tab 到它时也给同样的信息。
convRail.addEventListener('focusin', (event) => {
  const dot = (event.target as HTMLElement).closest<HTMLElement>('.conv-rail-dot');
  if (dot) showRailBubble(dot);
});
convRail.addEventListener('focusout', () => scheduleHideRailBubble());
// 滚动 / 窗口尺寸变化会让气泡的锚点失效,直接收起而不是跟着飘。
conversation.addEventListener('scroll', () => { hideRailBubble(); }, { passive: true });
window.addEventListener('resize', () => hideRailBubble());

/**
 * 请求重建轨道。**用微任务而不是 rAF 合并**,两个原因:
 *  1. rAF 只在真的有帧要画时才跑 —— 窗口最小化 / 离屏 / 后台时不推进,
 *     轨道会停在旧状态(实测离屏窗口里 rAF 会静默挂起,点数始终不更新);
 *  2. 微任务同样能把「一个同步任务里的 n 次 append」合并成一次回调
 *     (MutationObserver 本身就是按微任务投递的),不会有 O(n²) 重建。
 * 未变化时只重算高亮:重建要 innerHTML 全量重写 + querySelectorAll,
 * 而流式期间状态行的挂载/卸载也会命中 observer,那些都不改变用户消息集合。
 * 跳过条件必须比对**首节点同一性** —— 切任务走 `conversation.innerHTML = ''` 后重建,
 * 条数可能与原来相同但节点全新,只看条数会留下指向已脱离文档的旧节点的轨道。
 */
let railSyncScheduled = false;
let railForceSync = false;
function scheduleConvRail(force = false): void {
  if (force) railForceSync = true;
  if (railSyncScheduled) return;
  railSyncScheduled = true;
  queueMicrotask(() => {
    railSyncScheduled = false;
    const forced = railForceSync;
    railForceSync = false;
    const users = conversation.querySelectorAll<HTMLElement>('.message.user');
    // 集合没变就只重算高亮(重建要点 innerHTML 全量重写)。
    // 「变了没有」必须同时比对**首节点同一性 + 条数**,缺一不可:
    //   · 只比首节点 → 末尾追加一条时首节点没动,新点会被漏掉(实测踩过);
    //   · 只比条数   → `innerHTML = ''` 后重建可能条数恰好相同但节点全新,轨道会指向旧节点。
    const unchanged = users.length === railAnchorCount && users.length > 0 && users[0] === railAnchorUser;
    if (!forced && unchanged) { syncConvRailActive(); return; }
    syncConvRail();
  });
}

/* 轨道是会话 DOM 的派生视图,用 observer 而不是在每个增删点手写调用 ——
 * 增(addMessage)、删(回滚重建 / 重新生成截断 / 切任务清空)都能自动跟上,
 * 少一处漏调用就少一个"点数对不上"的 bug。只看直接子节点(childList,不带 subtree):
 * 流式写入发生在 .message-body 内部,不该触发轨道重建。 */
new MutationObserver(() => scheduleConvRail()).observe(conversation, { childList: true });
// 视口尺寸变了要重算间距上限(窄窗 / 拖侧栏 / 开 inspector 都会改会话高度)。
new ResizeObserver(() => scheduleConvRail(true)).observe(conversation);
let userScrolled = false;
// 放在 userScrolled 声明之后：回调内部会读它（贴底跟随判断），
// 在声明之前注册会踩 TDZ（ESM 模块求值期直接抛 ReferenceError）。
keepBottomOnComposerResize();

/* ── Per-message actions (copy / regenerate / 编辑·回滚菜单) ──
 * 用户消息只留**一个**入口(铅笔):点开再选「编辑并重发」或「回滚到这条之前」。
 * 两个动作都要截断这段对话,区别只在截完是否立刻用改过的文本重跑一轮;
 * 并排成两个按钮会让「改一个字重问」和「丢掉这一轮」看起来同等危险,而前者是日常操作。 */
function wireMessageActions(message: HTMLElement, text: string): void {
  const actions = message.querySelector('.message-actions') as HTMLElement;
  if (!actions || actions.childElementCount) return;
  const isAssistant = message.classList.contains('assistant');
  // 失败轮次可能只有一行错误、没有正文:那就没有可复制的东西,只留「重新生成」。
  const copy = text.trim() ? `<button data-act="copy" title="${t('msg.copy')}" aria-label="${t('msg.copy')}">${icon('copy')}</button>` : '';
  if (isAssistant) {
    // 分支按钮:从这一轮之后开一条新会话。图标用「分叉」形态(git branch),与「重新生成」区分开,
    // 后者是原地重跑,前者是另开一条线、原会话保持不动。
    actions.innerHTML = `${copy}<button data-act="regen" title="${t('msg.regenerate')}" aria-label="${t('msg.regenerate')}">${icon('regen')}</button><button data-act="branch" title="${t('msg.branch')}" aria-label="${t('msg.branch')}">${icon('branch')}</button>`;
  } else {
    actions.innerHTML = `${copy}<button data-act="edit-menu" title="${t('msg.editMenu')}" aria-label="${t('msg.editMenu')}">${icon('edit')}</button>`;
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
    if (act === 'branch') { void branchFromMessage(message, button); return; }
    // 菜单本身就是"确认"这一步:选回滚已经是一次明确的二次动作,不再需要「回滚?」状态。
    if (act === 'edit-menu') { openMessageMenu(message, button); return; }
  });
}

/**
 * 从这条助手消息所在的轮次分叉出一条新会话。
 *
 * userIndex 取自**前方最近的那条用户消息**的 data-user-index —— 分叉点就是「这一问的回答」，
 * 而不是 assistant 的序号（一条轮次里有几条 assistant 取决于工具调用次数，不可靠）。
 * 原任务保持不变；成功后界面直接切到新任务，用户接着在那里往下聊。
 */
async function branchFromMessage(message: HTMLElement, button: HTMLButtonElement): Promise<void> {
  const viewing = viewingTaskId();
  if (!viewing) { showToast('warn', t('toast.noSession')); return; }
  if (isRunning(viewing)) { showToast('warn', t('toast.taskRunning')); return; }
  // 往前找同一轮的用户消息：会话 DOM 里 user 与 assistant 是平级的兄弟节点。
  let userIndex = -1;
  let node: Element | null = message.previousElementSibling;
  while (node) {
    const element = node as HTMLElement;
    if (element.classList.contains('message') && element.classList.contains('user')) {
      const parsed = Number(element.dataset.userIndex ?? '');
      if (Number.isInteger(parsed) && parsed >= 0) userIndex = parsed;
      break;
    }
    node = node.previousElementSibling;
  }
  if (userIndex < 0) { showToast('warn', t('toast.noUserMsg')); return; }
  button.disabled = true;
  try {
    const result = await window.mocodeWork.forkTask({ id: viewing, userIndex });
    if (!result.ok || !result.task) { showToast('error', result.message ?? t('toast.branchFail')); return; }
    if (result.state) updateState(result.state);
    // 主进程已经把新任务选中并预热 host；这里只需把会话区换成它的历史。
    await openTask(result.task.id);
    showToast('success', t('toast.branched'));
  } finally {
    button.disabled = false;
  }
}

/** 用户消息的操作菜单:编辑并重发 / 回滚到这条之前。 */
function openMessageMenu(message: HTMLElement, anchor: HTMLElement): void {
  document.getElementById('message-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'message-context-menu';
  menu.className = 'project-context-menu';
  menu.innerHTML = `<button class="project-context-item" data-action="edit"><span class="project-context-icon">${icon('edit')}</span>${t('msg.edit')}</button><button class="project-context-item" data-action="rollback"><span class="project-context-icon">${icon('rollback')}</span>${t('msg.rollback')}</button>`;
  document.body.append(menu);
  const menuRect = menu.getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(4, box.right - menuRect.width), window.innerWidth - menuRect.width - 4);
  let top = box.bottom + 4;
  // 贴底的消息(最新一条)往下没有空间了,翻到按钮上方。
  if (top + menuRect.height > window.innerHeight - 4) top = Math.max(4, box.top - menuRect.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
  const close = (): void => { menu.remove(); document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  requestAnimationFrame(() => { document.addEventListener('click', close); document.addEventListener('keydown', onKey); });
  menu.querySelectorAll<HTMLButtonElement>('.project-context-item').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    const action = item.dataset.action;
    close();
    if (action === 'edit') startMessageEdit(message);
    else if (action === 'rollback') void rollbackToMessage(message);
  }));
}

/** 回滚:截断这段对话(含这条用户消息),原文回填输入框,改完可再发一次。 */
async function rollbackToMessage(message: HTMLElement): Promise<void> {
  const viewing = viewingTaskId();
  const userIndex = Number(message.dataset.userIndex ?? '');
  if (!viewing || !Number.isInteger(userIndex)) { showToast('warn', t('toast.cannotRollback')); return; }
  // 回滚会连这条用户消息一起抹掉 —— 先把原文捞出来,成功后回填输入框。
  const rolledBackText = (messageText.get(message) ?? '').trim();
  const result = await window.mocodeWork.rollback({ id: viewing, userIndex });
  if (!result.ok) { showToast('error', result.message ?? t('toast.rollbackFail')); return; }
  // 本周期的事件缓冲已经不可信 —— 落盘的会话才是新真相,作废后按它重放。
  streams.delete(viewing);
  approvalPanel.classList.add('hidden');
  if (result.state) updateState(result.state);
  setRunning(false);
  switchToTask(viewing, result.history ?? [], result.recovery);
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
 * 原地编辑这条用户消息:气泡换成输入框,Enter 发送、Shift+Enter 换行、Esc 取消。
 * 发送时先截断到这条消息之前(与回滚同一个主进程接口),再用编辑后的文本重跑一轮 ——
 * 所以"改一个字重问"不用再去底部输入框里粘贴一遍。
 * 截断失败时输入框与文字原样留着,不吞用户的编辑。
 */
function startMessageEdit(message: HTMLElement): void {
  if (message.classList.contains('is-editing')) return;
  if (isRunning(viewingTaskId())) { showToast('warn', t('toast.taskRunning')); return; }
  const wrapper = message.querySelector<HTMLElement>('.message-content');
  if (!wrapper) return;
  const body = wrapper.querySelector<HTMLElement>('.message-body');
  const editor = document.createElement('div');
  editor.className = 'message-editor';
  editor.innerHTML = `<textarea class="message-editor-input" spellcheck="false"></textarea><div class="message-editor-actions"><button type="button" data-editor="cancel">${t('msg.editCancel')}</button><button type="button" class="primary" data-editor="send">${t('msg.editSend')}</button></div>`;
  const input = editor.querySelector('textarea')!;
  const send = editor.querySelector<HTMLButtonElement>('[data-editor="send"]')!;
  const cancel = editor.querySelector<HTMLButtonElement>('[data-editor="cancel"]')!;
  input.value = messageText.get(message) ?? '';
  const resizeEditor = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 320)}px`;
  };
  message.classList.add('is-editing');
  if (body) body.replaceWith(editor); else wrapper.insertBefore(editor, wrapper.querySelector('.message-label'));
  resizeEditor();
  input.focus();
  // 光标落到末尾:编辑既有消息时最常做的就是补一句 / 改最后几个字。
  input.setSelectionRange(input.value.length, input.value.length);

  const end = (): void => {
    message.classList.remove('is-editing');
    if (body) editor.replaceWith(body); else editor.remove();
  };
  const commit = async (): Promise<void> => {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    send.disabled = true; cancel.disabled = true;
    const ok = await submitEdited(message, value);
    if (!ok) { send.disabled = false; cancel.disabled = false; input.focus(); return; }
    // 成功时这条消息本身已被移除(由 startRun 重新渲染编辑后的版本),无需收尾。
  };
  send.addEventListener('click', () => { void commit(); });
  cancel.addEventListener('click', end);
  input.addEventListener('input', resizeEditor);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); end(); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void commit(); }
  });
}

/**
 * 截断到这条用户消息之前,再用编辑后的文本重发。
 * 返回 false 表示截断失败(此时 DOM、输入框都保持原样)。
 */
async function submitEdited(message: HTMLElement, text: string): Promise<boolean> {
  const viewing = viewingTaskId();
  const userIndex = Number(message.dataset.userIndex ?? '');
  if (!viewing || !Number.isInteger(userIndex)) { showToast('warn', t('toast.noUserMsg')); return false; }
  const task = state?.tasks.find((item) => item.id === viewing);
  if (!task) { showToast('warn', t('toast.noUserMsg')); return false; }
  const attachments = messageAttachments.get(message) ?? [];
  // 先让主进程裁剪会话与恢复日志;失败时原现场一字不动。
  const prepared = await window.mocodeWork.rollback({ id: viewing, userIndex });
  if (!prepared.ok) { showToast('error', prepared.message ?? t('toast.rollbackFail')); return false; }
  // 期间用户切走了任务:截断已生效,但不要再往当前视图里画。
  if (viewingTaskId() !== viewing) return true;
  if (prepared.state) updateState(prepared.state);
  const all = Array.from(conversation.querySelectorAll<HTMLElement>('.message'));
  const index = all.indexOf(message);
  // 这条消息与它之后的一整轮全部作废 —— 编辑后的版本由 startRun 重新渲染在末尾。
  if (index >= 0) for (let i = all.length - 1; i >= index; i -= 1) all[i]!.remove();
  // ⚠ 序号必须跟着 DOM 一起回退,否则下一条用户消息拿到偏移的 userIndex,
  // 之后任何截断都会切错位置(regenerate 早年漏了这一步,是同一个坑)。
  userTurnIndex = userIndex;
  // 被删掉的那一轮里可能还有「运行中」的工具行挂在 activeTools 上:
  // 不清就会留下指向已脱离文档的节点,后面同 id 的事件会往空气里更新。
  activeTools.clear(); toolStartTimes.clear();
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  const stream = streamFor(viewing);
  const targetUser = stream.items.map((item, i) => ({ item, i })).filter(({ item }) => item.kind === 'user')[userIndex];
  stream.items.length = targetUser ? targetUser.i : 0;
  stream.interrupted = false;
  stream.pendingApproval = null;
  approvalPanel.classList.add('hidden');
  // 截断会重启 host(main.ts 的 work:rollback),sessionId 不变,续同一个会话。
  window.mocodeWork.send({ type: 'user_message', id: task.id });
  startRun(task, text, attachments);
  showToast('info', t('toast.edited'));
  return true;
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
  const user = messages[userIndex]!;
  const regenerationUserIndex = Number(user.dataset.userIndex ?? '');
  if (!viewing || !Number.isInteger(regenerationUserIndex) || regenerationUserIndex < 0) {
    showToast('warn', t('toast.noUserMsg'));
    return;
  }
  const previousStream = streams.get(task.id);
  const userItems = previousStream?.items.filter((item) => item.kind === 'user') ?? [];
  const regenerationAttachments = userItems[regenerationUserIndex]?.kind === 'user' ? userItems[regenerationUserIndex].attachments ?? [] : [];
  // 先让主进程完成会话与恢复日志裁剪；失败时原 DOM/内存流一字不动，旧现场仍在。
  const prepared = await window.mocodeWork.rollback({ id: task.id, userIndex: regenerationUserIndex });
  if (!prepared.ok) { showToast('error', prepared.message ?? t('toast.rollbackFail')); return; }
  if (viewingTaskId() !== viewing) return;
  if (prepared.state) updateState(prepared.state);
  // 裁剪已成功才删除目标起的旧回答；目标 user 保留，普通 run 会把它写回会话与恢复日志。
  for (let i = messages.length - 1; i >= index; i -= 1) messages[i]!.remove();
  // 目标 user 留在 DOM 里，序号要回到「它之后」——否则下一次截断会按偏移的序号切错位置。
  userTurnIndex = regenerationUserIndex + 1;
  // 被删掉的回答里可能有仍在运行的随身工具行，一并作废，避免更新到已脱离文档的节点。
  activeTools.clear(); toolStartTimes.clear();
  const stream = streamFor(viewing);
  const targetUser = [...stream.items].map((item, i) => ({ item, i })).filter(({ item }) => item.kind === 'user')[regenerationUserIndex];
  if (targetUser) stream.items.length = targetUser.i + 1;
  for (const item of stream.items) {
    if (item.kind !== 'tool' || item.done) continue;
    item.done = true;
    item.payload = { ...item.payload, status: 'aborted' };
  }
  stream.interrupted = false;
  stream.pendingApproval = null;
  // 重新生成 = 同一会话又跑一轮：本轮归零，会话累计继续叠加。
  stream.turnUsage = null;
  stream.sessionAddsTurn = true;
  refreshTokenUsage();
  stream.running = true;
  stream.startedAt = Date.now();
  approvalPanel.classList.add('hidden');
  startAssistantTurn();
  applyStatus(stream, true, busyStatus('starting', 'status.starting'));
  setRunning(true);
  armRunWatchdog(task.id);
  window.mocodeWork.send({ type: 'user_message', id: task.id });
  window.mocodeWork.send({ type: 'run', id: task.id, prompt: userText, sessionId: task.sessionId, attachments: regenerationAttachments });
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
    [`${MOD}+K`, t('cheatsheet.search')],
    [`${MOD}+⇧+N`, t('nav.newTask')],
    [`${MOD}+/`, t('cheatsheet.switchModel')],
    [`${MOD}+⏎`, t('cheatsheet.send')],
    ['⇧+⏎', t('cheatsheet.newline')],
    [`${MOD}+.`, t('cheatsheet.stop')],
    [`${MOD}+F`, t('cheatsheet.searchConv')],
    [`${MOD}+B`, t('cheatsheet.toggleSidebar')],
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

/* ── 通用附件：选择与拖入统一由主进程解析，图片粘贴留在 renderer ───────────── */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;

function addAttachmentResults(results: AttachmentResult[]): void {
  for (const result of results) {
    if ('error' in result) {
      const keys: Record<AttachmentErrorCode, Parameters<typeof t>[0]> = {
        unsupported: 'toast.attachmentUnsupported', too_large: 'toast.attachmentTooLarge',
        invalid_utf8: 'toast.attachmentInvalidUtf8', empty_text: 'toast.attachmentEmpty', read_failed: 'toast.attachmentReadFail',
      };
      showToast('warn', t(keys[result.error], { label: result.name }), 5000);
      continue;
    }
    if (attachments.length >= MAX_ATTACHMENTS) { showToast('warn', t('toast.attachmentLimit', { n: MAX_ATTACHMENTS })); break; }
    attachments.push(result.attachment);
    if (result.attachment.truncated) showToast('info', t('toast.attachmentTruncated', { label: result.attachment.name }), 5000);
  }
  renderAttachments();
}

/** 把一张图片加入待发送附件。非图片或超限会提示并跳过，返回是否入队成功。 */
async function addImageFile(file: File, fallbackName = t('composer.imageFallback')): Promise<boolean> {
  const label = file.name || fallbackName;
  if (attachments.length >= MAX_ATTACHMENTS) { showToast('warn', t('toast.attachmentLimit', { n: MAX_ATTACHMENTS })); return false; }
  if (file.type && !/^image\/(?:png|jpeg|gif|webp)$/.test(file.type)) { showToast('warn', t('toast.imageNotImage', { label: label })); return false; }
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

/** 粘贴图片（Ctrl/Cmd+V）—— 剪贴板里的位图没有文件名,按时间戳生成一个。 */
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
    const paths = window.mocodeWork.droppedFilePaths(Array.from(event.dataTransfer.files));
    addAttachmentResults(await window.mocodeWork.readAttachments(paths));
    promptInput.focus();
  });
}
setupDragDrop();

/* ── Conversation search (Ctrl/Cmd+F) ─────────────────── */
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
/** 真正发起一轮 run：渲染用户气泡、起状态行、挂看门狗、发协议命令。 */
function startRun(task: Task, prompt: string, batch: Attachment[]): void {
  const stream = streamFor(task.id);
  // 新一轮与旧崩溃现场分开；历史未完成工具不会被显示成仍在执行。
  for (const item of stream.items) {
    if (item.kind !== 'tool' || item.done) continue;
    item.done = true;
    item.payload = { ...item.payload, status: 'aborted' };
  }
  stream.interrupted = false;
  // 新一轮：本轮消耗归零，会话累计开始叠加本轮（见 sessionDisplayTotals）。
  stream.turnUsage = null;
  stream.sessionAddsTurn = true;
  refreshTokenUsage();
  stream.items.push({ kind: 'user', text: prompt, attachments: batch });
  stream.running = true;
  stream.startedAt = Date.now();
  addMessage('user', prompt, batch);
  setRunning(true);
  // 助手消息就地建好:思考阶段就能看到头像与 "MoCode",状态行也稳定落在这条消息下面。
  startAssistantTurn();
  // 立刻上状态:此刻到首个 token 之间可能好几秒(工具组路由 + 首次 LLM 调用),
  // 状态行是这段时间里界面唯一的"收到了、在干活"证据。
  applyStatus(stream, true, busyStatus('starting', 'status.starting'));
  // 同时挂看门狗:好几秒可以，一直没有动静不行（见 armRunWatchdog）。
  armRunWatchdog(task.id);
  window.mocodeWork.send({ type: 'run', id: task.id, prompt, sessionId: task.sessionId, attachments: batch });
}

async function submit(): Promise<void> {
  const prompt = promptInput.value.trim();
  if (!prompt && !attachments.length) return;
  // 目标任务是当前查看的那个；没有就新建（第一次使用）。
  let task = selectedTask();
  if (!task) {
    const created = await window.mocodeWork.createTask('', undefined);
    updateState(created.state);
    task = created.task;
  }
  // 标题自动摘要：新建后还没命名的任务，用这一条指令就地命名（用户手动改过就不动）。
  if (!task.title.trim() && !task.sessionId) {
    const next = await window.mocodeWork.renameTask(task.id, prompt ? summarizePrompt(prompt) : attachments[0]?.name ?? t('composer.fileFallback'));
    if (next) updateState(next);
  }
  // 用户实际提交消息时立即置顶。
  window.mocodeWork.send({ type: 'user_message', id: task.id });
  // 刚建的任务 stream 里不会有 running；这里用 isRunning 而不是 selectedTask().status，
  // 因为后者是主进程异步刷新的，落后于「刚点发送」的瞬间。
  if (isRunning(task.id)) {
    const batch = attachments;
    const stream = streamFor(task.id);
    stream.items.push({ kind: 'user', text: prompt, attachments: batch });
    finalizeTurn(activeAssistant);
    activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
    addMessage('user', prompt, batch);
    startAssistantTurn();
    window.mocodeWork.send({ type: 'run', id: task.id, prompt, sessionId: task.sessionId, attachments: batch });
    promptInput.value = ''; resizePrompt();
    attachments = []; renderAttachments();
    return;
  }
  const batch = attachments;
  attachments = []; renderAttachments();
  promptInput.value = ''; resizePrompt();
  startRun(task, prompt, batch);
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
  // 面板回执优先：请求 id 是渲染层生成的 `panel-*`，不属于任何任务。
  // 必须抢在下面的任务错误分支之前拦下 —— 否则「用量查询失败」会把正在跑的任务判成 failed。
  if (handlePanelEvent(envelope)) return;
  if (typeof envelope.requestId === 'string' && envelope.requestId.startsWith('panel-')) return;
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
  // 无归属事件走全局通道：host_log 是日志，runtime_ready 是「host 起来了」的握手回执。
  // runtime_ready 此前被整条丢弃，代价是 MCP 启动警告（配置写错、server 起不来）
  // 永远到不了用户眼前，以及协议版本不一致时没有任何提示，只有「新按钮点了没反应」。
  if (!taskId) {
    if (envelope.event === 'host_log') handleHostLog(payload);
    else if (envelope.event === 'runtime_ready') handleRuntimeReady(payload);
    return;
  }
  // 收到任何一条归属本任务的事件 = 「它活着」，看门狗下岗。
  clearRunWatchdog(taskId);
  const stream = streamFor(taskId);
  const viewing = viewingTaskId() === taskId;
  switch (envelope.event) {
    case 'mode_changed': {
      // host 确认模式已切（并已重写 history[0] 的系统提示）。这里只镜像状态：
      // 模式的事实源在 host，界面不做乐观更新，避免「按钮翻过去了但 host 没认」。
      applyPlanToggle(String(payload.mode ?? 'auto') === 'plan');
      // ⚠ 不要在这里写状态行。mode_changed 只是一次模式回执，**没有启动任何 run**；
      // 以前这里调 busyStatus(...) 会带上 since 时间戳并开 1 秒心跳，于是点一下「计划」
      // 按钮就永远停在「思考中 · Ns」—— 而能收掉 busy 的只有 run_completed/failed/aborted，
      // 没跑 run 就永远收不掉。模式变化的反馈由按钮高亮 + 下面的 toast 承担。
      if (viewing) showToast('info', t(planMode ? 'status.planOn' : 'status.planOff'), 3200);
      break;
    }
    case 'run_started':
      // 「工具组路由」本身就是一次 LLM 调用 —— 首个 thinking 到来前的空窗必须有人交代。
      applyStatus(stream, viewing, busyStatus('starting', 'status.analyzing'));
      break;
    case 'message_received':
      if (viewing) showToast('info', t('toast.steering'), 2600);
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
        existing.payload = { ...existing.payload, ...payload };
        if (output) {
          // 子 agent 的进度行（tool_output 累积的 `▸ read_file …` 与 `[sub-tool]{…}` 机器行）
          // 不能被最终结论覆盖掉：那张卡片的价值一半在「它做完了什么」，另一半在「它做过什么」。
          // 机器行还承载每次内部调用的完整入参与输出 —— 丢了它们，展开区就什么都不剩。
          const progress = existing.output
            .split('\n')
            .filter(isSubAgentProgressLine)
            .join('\n');
          existing.output = progress && !hasSubAgentProgressLine(output) ? `${output}\n${progress}` : output;
        }
        if (args) existing.args = args;
      } else {
        stream.items.push({ kind: 'tool', id, name: String(payload.name ?? 'tool'), args, output, done: completed, payload });
      }
      if (viewing) {
        // 子 agent 卡片收尾要走「合并后的 output」：进度行（含 `[sub-tool]` 机器行）只存在于
        // stream.items 里，pass 原始 payload 会让 live DOM 只显示结论、内部步骤当场消失
        // ——切走再切回来又能看见，属于最难定位的那种「时有时无」。
        const mergedForDom =
          existing && existing.kind === 'tool' && existing.output !== output && hasSubAgentProgressLine(existing.output)
            ? { ...payload, output: existing.output }
            : payload;
        addTool(mergedForDom, completed);
      }
      // dev_server 就绪时把 readyUrl 记下来：浏览器面板地址栏旁边给一个一键入口。
      if (completed && String(payload.name ?? '') === 'dev_server') {
        const ready = /"readyUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/.exec(output);
        if (ready) rememberDevServerUrl(ready[1]);
      }
      // 计划面板吃 tool_started 的入参（那一刻计划就已经完整），不必等工具结束。
      ingestPlan(taskId, stream, viewing, payload, args);
      break;
    }
    case 'tool_output': {
      // 长命令（build / test / 大量 grep）的流式输出。终端边跑边出，GUI 若只等 tool_completed
      // 就只能看最后一坨 —— 走同一份 stream.items 缓冲，切任务回来也能还原。
      const id = payload.id == null ? '' : String(payload.id);
      const chunk = String(payload.chunk ?? '');
      if (!chunk) break;
      const item = id ? [...stream.items].reverse().find((entry) => entry.kind === 'tool' && entry.id === id) : undefined;
      if (item && item.kind === 'tool') item.output += chunk;
      else stream.items.push({ kind: 'tool', id, name: String(payload.name ?? 'tool'), args: '', output: chunk, done: false });
      if (viewing) appendToolOutput(payload);
      break;
    }
    case 'model_retry': {
      // 退避重试必须可见：否则是几十秒静止界面，与卡死无法区分。
      const seconds = Math.max(1, Math.round((Number(payload.waitMs) || 0) / 1000));
      applyStatus(
        stream,
        viewing,
        busyStatus('thinking', 'status.retrying', { s: seconds, n: Number(payload.attempt) || 1 }),
      );
      break;
    }
    case 'live_usage': {
      // 上下文百分比取同事件里的 prompt 快照；promptTokens/completionTokens 是**本轮累计**，
      // 两者语义不同，别拿一个去算另一个。
      const contextUsage = parseContextUsage(payload.contextUsage);
      if (contextUsage) {
        stream.contextUsage = contextUsage;
        if (viewing) updateContextUsage(contextUsage);
      }
      const turn = parseTurnUsage(payload);
      if (turn) {
        stream.turnUsage = turn;
        if (viewing) refreshTokenUsage();
      }
      break;
    }
    case 'image_relief': {
      const phase = String(payload.phase ?? '');
      if (phase === 'start') {
        const bytes = Number(payload.bytes) || 0;
        const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
        applyStatus(stream, viewing, busyStatus('thinking', 'status.imageRelief', { n: Number(payload.images) || 0, size }));
        break;
      }
      // done：replaced=0 表示这轮实际没改动，不该噪一声。
      const replaced = Number(payload.replaced) || 0;
      applyStatus(stream, viewing, busyStatus('thinking', 'status.thinking'));
      if (replaced > 0 && viewing) showToast('info', t('toast.imageRelief', { n: replaced }), 3500);
      break;
    }
    case 'no_reply':
      // 「模型没吐任何内容」是一个有意义的终态，不能让它表现为「跑完了但空白」。
      stream.items.push({ kind: 'error', message: t('status.noReply') });
      if (viewing) { if (!resumableTurn()) startAssistantTurn(); showTurnError(t('status.noReply')); }
      break;
    case 'max_steps': {
      // onMaxSteps 不带次数（AgentHooks 的签名就是 () => void），文案也不能假装知道数字。
      const message = t('status.maxSteps');
      stream.items.push({ kind: 'error', message });
      if (viewing) { if (!resumableTurn()) startAssistantTurn(); showTurnError(message); }
      break;
    }
    case 'approval_requested': {
      stream.pendingApproval = payload;
      applyStatus(stream, viewing, settledStatus('waiting', 'status.waitingLabel', 'warn'));
      if (viewing) showApproval(taskId, payload);
      else notifyBackground(taskId, t('status.approvalWait'));
      // 侧栏 / 标题栏 / 横条都靠这一步刷新：任务的 status 由主进程广播过来（waiting），
      // 但当前任务的横条吃的是 stream.pendingApproval，两者在同一个事件里到位。
      syncAttention();
      break;
    }
    // 系统通知被点击：主进程只发「去这个任务」的信号，怎么摆审批卡是渲染层的事。
    // 窗口已在主进程里 restore + focus 过，这里只负责切任务并把审批卡摆出来。
    case 'attention_open': {
      void jumpToPendingTask(taskId);
      break;
    }
    case 'run_aborted':
      // 中止也己经花掉 tokens，同样要收尾（并让会话累计重新读盘）。
      settleTurnUsage(stream, taskId, null);
      applyStatus(stream, viewing, settledStatus('stopped', 'status.cancelled', 'idle'));
      endTaskRun(taskId);
      if (viewing) finish();
      break;
    case 'run_changed_files': {
      // 这一轮改过的文件（含当时的 +N/-N）：进事件流，切走再回来 / 重启后按原样重放。
      const files = changeFilesFrom(payload.files);
      if (!files.length) break;
      stream.items.push({ kind: 'changes', files });
      if (!viewing) break;
      // pendingChangesTurn 是常规路径（run_completed 刚收口的那条）。它为空时回放兜底：
      // 切走又切回来时卡片已由 replay 画好，这里只补「还没有卡片」的那条；
      // 而这份统计迟到、用户已经发了下一轮时 stream.running 为真 —— 绝不往新消息上挂。
      let turn = pendingChangesTurn?.isConnected ? pendingChangesTurn : null;
      pendingChangesTurn = null;
      if (!turn && !stream.running) {
        const last = lastAssistantTurn();
        if (last && !last.querySelector('.message-changes')) turn = last;
      }
      attachTurnChanges(turn, taskId, files);
      break;
    }
    case 'run_completed': {
      stream.contextUsage = parseContextUsage(payload.contextUsage);
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
      settleTurnUsage(stream, taskId, usage);
      applyStatus(stream, viewing, settledStatus('done', 'status.completed', 'ok', elapsedDetail(stream.startedAt)));
      endTaskRun(taskId);
      // 本轮改动清单由紧随其后的 run_changed_files 带来（主进程先跑一次 git 统计）。
      // 这里只把「这一轮是哪条消息」记下来，收尾前取 —— finish() 会把空轮次整条移除。
      if (viewing) {
        const turn = currentTurn();
        updateContextUsage(stream.contextUsage);
        finish();
        pendingChangesTurn = turn && turn.isConnected ? turn : null;
      }
      else notifyBackground(taskId, t('status.completed'));
      break;
    }
    case 'context_compacting': {
      // 自动压缩要几十秒（一次完整的 LLM 摘要），不给状态行就是假死。
      applyStatus(stream, viewing, busyStatus('compacting', 'status.compacting'));
      break;
    }
    case 'context_compacting_done':
      // 压缩失败 / 被取消 / 没压成：只收状态行，绝不在会话流里留「已压缩」。
      applyStatus(stream, viewing, busyStatus('thinking', 'status.thinking'));
      break;
    case 'context_compacted': {
      // 自动压缩的**唯一可见痕迹**：终端那边有「● 压缩上下文 205k → 29k」那行，
      // GUI 以前什么都没有，用户只会发现上下文百分比莫名其妙掉了一截。
      // 这里在会话流里留一条常驻系统行（切任务 / 重启后由恢复日志重放），并刷新百分比。
      const notice: StreamNotice = {
        type: 'contextCompacted',
        ...(typeof payload.beforeTokens === 'number' ? { beforeTokens: payload.beforeTokens } : {}),
        ...(typeof payload.afterTokens === 'number' ? { afterTokens: payload.afterTokens } : {}),
        ...(typeof payload.contextWindow === 'number' ? { windowTokens: payload.contextWindow } : {}),
        ...(payload.manual === true ? { manual: true } : {}),
        ...(payload.summarized === true ? { summarized: true } : {}),
      };
      stream.items.push({ kind: 'notice', notice });
      const usage = parseContextUsage(payload.contextUsage);
      if (usage) stream.contextUsage = usage;
      applyStatus(stream, viewing, busyStatus('thinking', 'status.thinking'));
      if (viewing) {
        addNotice(notice);
        if (usage) updateContextUsage(usage);
      } else {
        notifyBackground(taskId, t('notice.contextCompactedShort'));
      }
      break;
    }
    case 'compact_done': {
      // 手动「压缩」按钮的回执：留痕由上面的 context_compacted 负责（同一次压缩两条事件，
      // 前者是会话流里的常驻系统行，这里只管百分比与状态），不再额外弹 toast。
      stream.contextUsage = parseContextUsage(payload.contextUsage);
      // 压缩不改变任务本身的终态,收尾回落到任务记录对应的状态。
      applyStatus(stream, viewing, statusFromTask(selectedTask()));
      if (viewing) updateContextUsage(stream.contextUsage);
      break;
    }
    case 'host_log':
      handleHostLog(payload);
      break;
    case 'run_failed': {
      const message = humanizeError(String(payload.message ?? t('err.runFailed'))) ?? t('err.runFailed');
      settleTurnUsage(stream, taskId, payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : null);
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
      settleTurnUsage(stream, taskId, null);
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
    // 点了停止但 host 那边没有在跑（已经结束了）。把界面从「正在停止」收回可用态，
    // 否则按钮停在停止图标上，用户以为还在跑。
    case 'run_idle':
      settleTurnUsage(stream, taskId, null);
      applyStatus(stream, viewing, statusFromTask(selectedTask()));
      endTaskRun(taskId);
      if (viewing) finish();
      break;
    // 受监管 Worker 的心跳（每 30s 一条）。work-app 不走 supervised 模式，正常收不到；
    // 真收到也只当「它还活着」，看门狗已经在上面的 clearRunWatchdog 里续过了。
    case 'heartbeat':
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
 * host 起来的握手回执（无 requestId，全局通道）。
 *
 * 这条事件以前被整条丢弃，代价是：MCP 启动警告（server 命令写错、端口不通、配置解析失败）
 * 永远到不了用户眼前，用户只知道「工具没反应」。
 *
 * 协议版本不匹配的检查**放在主进程**（packages/work-app/src/main.ts 的 receive）：
 * HOST_PROTOCOL_VERSION 的事实源在 @mocode/protocol，而渲染层是浏览器环境、
 * 不能 import 裸包名（没有打包器）。渲染层只负责把 main 推来的 host_log 弹出来。
 */
function handleRuntimeReady(payload: Record<string, unknown>): void {
  const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(String).filter(Boolean) : [];
  for (const warning of warnings) showToast('warn', t('toast.mcpWarning', { warning }), 8000);
  console.debug('[Agent Host] ready', payload);
}

/**
 * 切换查看的任务。三种来源,渲染优先级:
 * 1. 本周期内跑过(streams 里有缓冲) → 从事件缓冲全量重建,顺序与实时渲染一致;
 * 2. 否则用 select-task 返回的 session 历史(重启后打开旧任务)。
 */
function switchToTask(taskId: string, history?: HistoryItem[], recovery?: RecoverySnapshot | null): void {
  conversation.innerHTML = '';
  userTurnIndex = 0;
  activeAssistant = null; activeTextBlock = null; activeToolGroup = null;
  activeTools.clear(); toolStartTimes.clear();
  approvalPanel.classList.add('hidden');
  const cached = streams.get(taskId);
  // select-task 等待期间若实时事件已经到达，内存流更新，不能用旧快照覆盖它。
  let stream = cached && (cached.items.length > 0 || cached.running) ? cached : undefined;
  if (!stream && recovery) {
    stream = streamFor(taskId);
    stream.items = recovery.items;
    stream.running = recovery.running === true;
    stream.contextUsage = parseContextUsage(recovery.contextUsage);
    stream.pendingApproval = stream.running ? recovery.pendingApproval : null;
    stream.startedAt = recovery.startedAt;
    stream.interrupted = recovery.interrupted === true && !stream.running;
    if (stream.interrupted) stream.items.push({ kind: 'error', message: t('main.task.staleRun') });
  }
  stream ??= cached;
  if (stream && stream.items.length) {
    // 回放整段放进 batchRender：一次切换要重建几百条消息与工具块，逐条各滚一次底、
    // 各重算一次工具集合行会触发上百次强制布局（用户感受就是「点会话卡一下」）。
    batchRender(() => {
      for (const item of stream!.items) {
        if (item.kind === 'user') addMessage('user', item.text, item.attachments ?? []);
        else if (item.kind === 'text') appendText(item.text);
        else if (item.kind === 'tool') {
          // 中断时未完成的调用只标记为中止，保留参数、输出和 diff；绝不重新执行。
          const interruptedTool = stream!.interrupted === true && !item.done;
          addTool({ ...item.payload, id: item.id, name: item.name, arguments: item.args, output: item.output,
            ...(interruptedTool ? { status: 'aborted' } : {}) }, item.done || interruptedTool);
        } else if (item.kind === 'error') {
          if (!currentTurn()) startAssistantTurn();
          showTurnError(item.message);
        } else if (item.kind === 'notice') {
          // 系统提示行挂在会话流上、不挂助手消息：恢复现场时顺序与实时一致。
          addNotice(item.notice);
        } else if (item.kind === 'changes') {
          // 挂在刚刚回放完的那条助手消息尾部 —— 与实时渲染同一位置。
          attachTurnChanges(lastAssistantTurn(), taskId, item.files);
        }
      }
    });
    if (!stream.running) finish();
    else {
      setRunning(true);
      // 运行中的任务切回来：重放后游标为空，此时必须**续回**最后一条 assistant 消息，
      // 而不是新开一条 —— 否则切出去再切回来，屏幕尾部就多出一个 MoCode 头像
      // （同一次 run 被画成两段回答）。没有可续的（重放末尾是 user 气泡）才新建。
      if (!resumableTurn()) startAssistantTurn();
    }
    // 只有仍活着的 host 才能接受审批；崩溃恢复的卡片不可操作。
    if (stream.running && stream.pendingApproval) showApproval(taskId, stream.pendingApproval);
  } else if (history) {
    renderHistory(history);
  }
  hideContextUsageDetails();
  updateContextUsage(stream?.contextUsage ?? null);
  void refreshContextUsage(taskId);
  refreshTokenUsage();
  void refreshSessionUsage(taskId);
  // 计划面板按这个任务的缓冲还原（切任务时其它任务的计划不该留在屏上）。
  if (!stream?.plan) {
    const recovered = planForRestore(planFromItems(stream?.items) ?? planFromHistory(history));
    if (recovered) streamFor(taskId).plan = recovered;
  }
  syncPlanPanel(taskId);
  syncAttention();
  // 老会话（逐轮快照上线前存下的恢复日志）里没有任何 changes 项：按任务记录补一张，
  // 数字是「此刻 vs HEAD」的累计值，与右侧「改动」面板同口径。
  if (!stream?.items.some((item) => item.kind === 'changes')) restoreLegacyChanges(taskId);
  renderStatus(stream?.status ?? statusFromTask(selectedTask()), { replay: true });
  smartScrollToBottom(true);
  attachments = []; renderAttachments();
  // 系统提示行（.thread-notice）也算会话内容：只有压缩记录时不该显示空态。
  emptyState.classList.toggle('hidden', conversation.querySelector('.message') != null || conversation.querySelector('.thread-notice') != null);
  promptInput.focus();
}

function openInspector(tab: InspectorTab): void {
  activeInspectorTab = tab; inspector.classList.remove('hidden'); void refreshInspector();
}

/**
 * 「更改 / 历史」页签条的显隐与选中态。
 *
 * 只在这两个视图里出现：它们本是同一件事（源代码管理的现状与过去），
 * 所以在九宫格里只留一个入口，用页签切换，而不是两个平级菜单项。
 */
function syncScmTabs(): void {
  const onScm = activeInspectorTab === 'source' || activeInspectorTab === 'history';
  inspectorTabs.classList.toggle('hidden', !onScm);
  if (!onScm) return;
  const changes = $('#scm-tab-changes');
  const history = $('#scm-tab-history');
  const isHistory = activeInspectorTab === 'history';
  changes.classList.toggle('active', !isHistory);
  history.classList.toggle('active', isHistory);
  changes.setAttribute('aria-selected', String(!isHistory));
  history.setAttribute('aria-selected', String(isHistory));
}
for (const [selector, tab] of [['#scm-tab-changes', 'source'], ['#scm-tab-history', 'history']] as const) {
  $(selector).addEventListener('click', () => {
    if (activeInspectorTab === tab) return;
    activeInspectorTab = tab;
    void refreshInspector();
  });
}

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
  // 浏览器视图不复用这块 innerHTML：<webview> 被移除就等于换 guest 进程，登录态与
  // agent 正在操作的那一页会一起丢（见 browser-panel.ts 顶部约束）。
  if (activeInspectorTab === 'browser') {
    closeSourceControl();
    closeHistory();
    hideTerminalPanel();
    inspectorTabs.classList.add('hidden');
    inspectorContent.classList.add('hidden');
    inspectorContent.innerHTML = '';
    inspectorTitle.textContent = t('tools.browser');
    showBrowserPanel();
    return;
  }
  // 终端同理：xterm 实例与 PTY 都不能随视图切换重建 —— 重建等于换一个 shell，
  // 正在跑的东西（dev server / 测试）会一起没。
  if (activeInspectorTab === 'terminal') {
    closeSourceControl();
    closeHistory();
    hideBrowserPanel();
    inspectorTabs.classList.add('hidden');
    inspectorContent.classList.add('hidden');
    inspectorContent.innerHTML = '';
    inspectorTitle.textContent = t('tools.terminal');
    showTerminalPanel();
    return;
  }
  inspectorContent.classList.remove('hidden');
  hideBrowserPanel();
  hideTerminalPanel();
  // 「更改」与「历史」是源代码管理内部的两个页签：九宫格里只有一个入口，
  // 这里按当前页签显示/隐藏切换条，并同步选中态。
  syncScmTabs();
  // 离开源代码管理视图时立刻停掉它的轮询，别让后台计时器继续拉 git status。
  if (activeInspectorTab !== 'source') closeSourceControl();
  if (activeInspectorTab !== 'history') closeHistory();
  inspectorContent.innerHTML = `<p class="inspector-loading">${t('inspector.loading')}</p>`;
  if (activeInspectorTab === 'source') {
    inspectorTitle.textContent = t('scm.title');
    await refreshSourceControl(inspectorContent);
    return;
  }
  if (activeInspectorTab === 'history') {
    // 同一个面板，标题保持「源代码管理」，具体在看历史由页签选中态表达。
    inspectorTitle.textContent = t('scm.title');
    await refreshHistory(inspectorContent);
    return;
  }
  if (activeInspectorTab === 'changes') {
    inspectorTitle.textContent = t('tools.changes');
    await renderChangesPanel();
    return;
  }
  if (activeInspectorTab === 'checks') {
    inspectorTitle.textContent = t('tools.checks');
    await renderChecksPanel();
    return;
  }
  // 单文件预览：没有记录下路径（例如刚被清空）就退回文件树，而不是留一块空白。
  if (activeInspectorTab === 'file') {
    if (previewFilePath) { await previewFile(previewFilePath); return; }
    activeInspectorTab = 'files';
  }
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
  inspectorContent.querySelectorAll<HTMLButtonElement>('[data-action="file"]').forEach((button) => button.addEventListener('click', () => void previewFile(button.dataset.path!)));
}
/** 走富文本预览的文档扩展名：markdown 系一律按渲染后的排版看，而不是等宽原文。 */
const DOC_FILE_PATTERN = /\.(md|markdown|mdx)$/i;

/**
 * 打开右侧面板预览一个文件 —— 正文里的路径链接、工具行上的路径共用这一条通道。
 *
 * 刻意不做 `shell.openPath`：那会把文档甩给系统默认应用（记事本、Typora、浏览器各不同），
 * 用户在应用里读文档又得切一次窗口。预览留在本面板内，读完接着对话。
 */
function openFilePreview(file: string): Promise<void> {
  if (!file) return Promise.resolve();
  previewFilePath = file;
  activeInspectorTab = 'file';
  inspector.classList.remove('hidden');
  return refreshInspector();
}

/**
 * 在系统文件管理器里定位一个文件（选中它，不打开）。
 *
 * 产物（安装包 / 压缩包 / 二进制）在应用里读没有意义，用户要的是去目录把它拿出来 ——
 * 定位到选中状态比「打开所在文件夹」少点一次（不用在几十个文件里再找一遍）。
 */
async function revealFileInFolder(file: string): Promise<void> {
  const result = await window.mocodeWork.revealFile(file);
  if (!result.ok) showToast('warn', result.message ?? t('fileLink.reveal', { path: file }));
}

/**
 * 路径点击的统一去向：产物去文件管理器定位，文本 / 代码进右侧面板预览。
 *
 * 正文链接、工具行路径、预览面板内的链接共用这一条，避免三处各判一次导致行为不一致。
 * `kind` 来自 file-links 的数据属性；没有时按扩展名兜底（工具行不带这个属性）。
 */
function openFilePath(file: string, kind?: string): void {
  if (!file) return;
  if (kind === 'artifact' || (kind !== 'file' && isArtifactPath(file))) { void revealFileInFolder(file); return; }
  void openFilePreview(file);
}

/**
 * 右键目标上的路径：正文链接、工具行路径、「改动」面板行、文件树行都带路径属性。
 * 「改动」面板与文件树用 data-change-path / data-path，正文与工具行用 data-file-path。
 */
function pathOfContextTarget(target: HTMLElement | null): string {
  const link = target?.closest<HTMLElement>('[data-file-path]');
  if (link?.dataset.filePath) return link.dataset.filePath;
  const change = target?.closest<HTMLElement>('[data-change-path]');
  if (change?.dataset.changePath) return change.dataset.changePath;
  const generic = target?.closest<HTMLElement>('[data-path]');
  return generic?.dataset.path ?? '';
}

/**
 * 右键路径时的菜单：在文件夹中显示 / 复制路径。
 *
 * 为什么由渲染层弹 HTML 菜单而不是交给主进程的原生菜单：主进程看不见 DOM，拿不到
 * 「右键的是哪个文件」，只能靠同步 IPC 回问，为一个菜单引入 sendSync 不值得。
 * 复用侧栏 ... 菜单那套样式（.project-context-menu）。
 *
 * `preventDefault` 同时挡住主进程的原生「复制 / 全选」菜单 —— 实测渲染层拦了之后
 * 主进程的 context-menu 事件不触发，两者不会双弹（见 context-menu.ts 注释）。
 */
function showPathMenu(file: string, x: number, y: number): void {
  document.getElementById('path-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'path-context-menu';
  menu.className = 'project-context-menu';
  menu.innerHTML = `<button class="project-context-item" data-path-action="reveal"><span class="project-context-icon" data-icon="folder-open"></span>${t('menu.revealFile')}</button>`
    + `<button class="project-context-item" data-path-action="copy"><span class="project-context-icon" data-icon="copy"></span>${t('menu.copyPath')}</button>`;
  document.body.append(menu);
  mountIcons(menu);
  // 先量再定位：贴光标弹出，但右侧/下侧放不下时往回收，否则菜单会跑出视口。
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  const close = (): void => {
    menu.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', close, true);
  };
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
  // 延一帧再挂：本次 contextmenu 之后紧跟着的那次 click 会立刻把菜单关掉。
  requestAnimationFrame(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
  });
  menu.querySelectorAll<HTMLButtonElement>('[data-path-action]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    const action = item.dataset.pathAction;
    close();
    if (action === 'reveal') void revealFileInFolder(file);
    else void navigator.clipboard.writeText(file).then(() => showToast('info', t('msg.copied')), () => showToast('error', t('msg.copyFailed')));
  }));
}

// 右键任何带路径的目标 → 路径菜单（点击的补充通道：代码块 / diff / 文件树里的路径没被链接化）。
document.addEventListener('contextmenu', (event) => {
  const file = pathOfContextTarget(event.target as HTMLElement | null);
  if (!file) return;
  event.preventDefault();
  showPathMenu(file, event.clientX, event.clientY);
});

async function previewFile(file: string): Promise<void> {
  const [content, diff] = await Promise.all([window.mocodeWork.readFile(file), window.mocodeWork.fileDiff(file)]); inspectorTitle.textContent = file;
  const raw = content.error ?? content.content ?? '';
  // 文档走 markdown 渲染（与正文共用 .message-body.md-rendered 那套排版，见 style.css），
  // 其余仍是等宽原文：代码 / 日志的换行与缩进必须原样保留。
  const asDoc = !content.error && DOC_FILE_PATTERN.test(file);
  const body = asDoc ? `<div class="message-body md-rendered file-doc">${renderMarkdown(raw)}</div>` : `<pre class="file-preview">${escapeHtml(raw)}</pre>`;
  // 第三个按钮：在文件管理器里定位。预览是「读」，定位是「我要拿去用」—— 读完想拷/双击运行时不必手点目录。
  inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-files">${t('inspector.backToFiles')}</button><button id="show-diff">${t('inspector.gitDiff')}</button><button id="reveal-file" data-icon="folder-open" title="${escapeHtml(t('fileLink.reveal', { path: file }))}">${t('inspector.reveal')}</button></div>${body}`;
  mountIcons(inspectorContent);
  $('#reveal-file').addEventListener('click', () => void revealFileInFolder(file));
  if (asDoc) {
    enhanceCodeBlocks(inspectorContent);
    // 文档里引用的其它文件（例如方案里提到的 `src/...`）也能继续点开，形成一条链路。
    const doc = inspectorContent.querySelector<HTMLElement>('.file-doc');
    if (doc) {
      linkifyFilePaths(doc);
      // 面板内的路径链接不走会话流的代理（那块 DOM 在 .thread 里，不在 inspector 里）。
      doc.addEventListener('click', (event) => {
        const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-file-path]');
        if (!link) return;
        event.preventDefault();
        // 文档里也可能写到产物（「安装包已生成：release/x-setup.exe」），走同一条分流。
        openFilePath(link.dataset.filePath ?? '', link.dataset.fileKind);
      });
    }
  }
  $('#back-to-files').addEventListener('click', () => { previewFilePath = null; activeInspectorTab = 'files'; void refreshInspector(); });
  $('#show-diff').addEventListener('click', () => {
    // 与源代码管理面板同一套并排渲染：左原始 / 右改动后 + 双行号。解析不了才退回原文。
    const raw = diff.error ?? diff.content ?? '';
    const rendered = diff.error ? null : renderUnifiedDiff(raw, {
      moreLines: (n) => t('tool.moreLines', { n }),
      oldSide: t('diff.oldSide'),
      newSide: t('diff.newSide'),
    });
    inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-files">${t('inspector.backToFiles')}</button></div>${rendered ?? `<pre class="file-preview diff-preview">${escapeHtml(raw)}</pre>`}`;
    $('#back-to-files').addEventListener('click', () => void previewFile(file));
  });
}

/* ── 「改动」面板 ──────────────────────────────────────────────
 * 数据源是任务自己的 `changedFiles`（host 在 run_completed 时落盘），不是 git status ——
 * 用户可能还有别的未提交改动，那些不属于「这次 agent 干了什么」。
 *
 * **只读，不提供文件回退**。回退是破坏性操作，正确的实现要能区分「agent 这轮改的」与
 * 「用户之后自己又动的」，还要有变更集级别的原子性 —— 那是另一件事，得单独评估。
 * 这一版先把「改了什么、改成什么样」摆出来，用户据此自己去终端 / 源代码管理里操作。
 */
async function renderChangesPanel(): Promise<void> {
  const taskId = viewingTaskId();
  if (!taskId) { inspectorContent.innerHTML = `<p class="inspector-empty">${t('changes.noTask')}</p>`; return; }
  inspectorContent.innerHTML = `<p class="inspector-loading">${t('inspector.loading')}</p>`;
  const result = await window.mocodeWork.taskChanges({ taskId });
  // 请求期间用户可能切了任务或换了视图：旧结果绝不能画到新上下文里。
  if (activeInspectorTab !== 'changes' || viewingTaskId() !== taskId) return;
  if (!result.ok) {
    // 普通任务（无空间）跑在 scratch 目录里，那里不是 git 仓库 —— 没有 HEAD 可比，
    // 这不是错误，只是这个面板在那种任务上没有可展示的基准。
    const message = result.message === 'NOT_REPOSITORY' ? t('changes.noRepo') : (result.message ?? t('changes.failed'));
    inspectorContent.innerHTML = `<p class="inspector-empty">${escapeHtml(message)}</p>`;
    return;
  }
  const files = result.files ?? [];
  if (!files.length) { inspectorContent.innerHTML = `<p class="inspector-empty">${t('changes.empty')}</p>`; return; }
  const rows = files.map((file) => {
    const added = file.added > 0 ? `<span class="diff-add">+${file.added}</span>` : '';
    const removed = file.removed > 0 ? `<span class="diff-del">-${file.removed}</span>` : '';
    const badge = file.untracked ? `<span class="changes-badge">${t('changes.untracked')}</span>` : '';
    return `<button class="inspector-row changes-row" data-change-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}"><span class="changes-path">${escapeHtml(file.path)}</span><span class="changes-stat">${badge}${added}${removed}</span></button>`;
  }).join('');
  inspectorContent.innerHTML = `<p class="tree-note">${escapeHtml(t('changes.count', { n: String(files.length) }))}</p>`
    + `<div class="changes-list">${rows}</div>`
    + (result.truncated ? `<p class="inspector-empty">${t('changes.truncated')}</p>` : '')
    + `<p class="inspector-hint">${t('changes.hint')}</p>`;
  inspectorContent.querySelectorAll<HTMLButtonElement>('[data-change-path]').forEach((button) =>
    button.addEventListener('click', () => void showChangeDiff(taskId, button.dataset.changePath ?? '')),
  );
}

async function showChangeDiff(taskId: string, path: string): Promise<void> {
  if (!path) return;
  inspectorTitle.textContent = path;
  inspectorContent.innerHTML = `<p class="inspector-loading">${t('inspector.loading')}</p>`;
  const result = await window.mocodeWork.taskChangeDiff({ taskId, path });
  if (activeInspectorTab !== 'changes' || viewingTaskId() !== taskId) return;
  const body = result.ok ? (result.content ?? '') : (result.message ?? t('changes.failed'));
  // 统一 diff 走并排渲染：左原始 / 右改动后 + 双行号，改动一眼可扫。解析不了（二进制、
  // mode-only、错误文案）才退回原文 <pre>。
  const rendered = result.ok
    ? renderUnifiedDiff(body, {
      moreLines: (n) => t('tool.moreLines', { n }),
      oldSide: t('diff.oldSide'),
      newSide: t('diff.newSide'),
    })
    : null;
  inspectorContent.innerHTML = `<div class="file-actions"><button id="back-to-changes">${t('changes.back')}</button></div>`
    + (rendered ?? (body.trim() ? `<pre class="file-preview diff-preview">${escapeHtml(body)}</pre>` : `<p class="inspector-empty">${t('changes.noDiff')}</p>`))
    + (result.truncated ? `<p class="inspector-empty">${t('changes.diffTruncated')}</p>` : '');
  $('#back-to-changes').addEventListener('click', () => {
    inspectorTitle.textContent = t('tools.changes');
    void renderChangesPanel();
  });
}

/* ── 「检查」面板 ──────────────────────────────────────────────
 * 列出从 package.json 发现的校验脚本，点击把命令**填进终端**（不直接执行）。
 * 为什么不在面板里自己跑：那需要一条全新的执行通道（超时、输出上限、并发、取消），
 * 而终端本来就已经跑着用户自己的 shell —— 命令填进去，能看输出、能 Ctrl+C、能改一行再跑。
 */
async function renderChecksPanel(): Promise<void> {
  const taskId = viewingTaskId();
  if (!taskId) { inspectorContent.innerHTML = `<p class="inspector-empty">${t('checks.noTask')}</p>`; return; }
  inspectorContent.innerHTML = `<p class="inspector-loading">${t('inspector.loading')}</p>`;
  const result = await window.mocodeWork.checks({ taskId });
  if (activeInspectorTab !== 'checks' || viewingTaskId() !== taskId) return;
  if (!result.ok) {
    inspectorContent.innerHTML = `<p class="inspector-empty">${escapeHtml(result.message ?? t('checks.failed'))}</p>`;
    return;
  }
  const groups = (result.groups ?? []).filter((group) => group.scripts.length > 0);
  if (!groups.length) { inspectorContent.innerHTML = `<p class="inspector-empty">${t('checks.empty')}</p>`; return; }
  const sections = groups.map((group) => {
    // 根包用 package.json 的 name；没写 name 的 monorepo 根退回一个中性文案。
    const title = group.label || t('checks.root');
    const rows = group.scripts.map((script) => {
      const command = checkCommand(group.packageManager, script.name, group.dir);
      return `<button class="inspector-row checks-row" data-check-command="${escapeHtml(command)}" title="${escapeHtml(command)}"><span class="checks-name">${escapeHtml(script.name)}</span><span class="checks-cmd">${escapeHtml(command)}</span></button>`;
    }).join('');
    return `<section class="checks-group"><h3>${escapeHtml(title)}${group.dir ? `<span>${escapeHtml(group.dir)}</span>` : ''}</h3>${rows}</section>`;
  }).join('');
  inspectorContent.innerHTML = `${sections}<p class="inspector-hint">${t('checks.hint')}</p>`;
  inspectorContent.querySelectorAll<HTMLButtonElement>('[data-check-command]').forEach((button) =>
    button.addEventListener('click', () => {
      // 语义就是「给我终端里这条命令」：面板没开或停在别的视图都先切过去。
      if (inspector.classList.contains('hidden') || activeInspectorTab !== 'terminal') openInspector('terminal');
      fillTerminalCommand(button.dataset.checkCommand ?? '');
    }),
  );
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
/* ── 扩展整页视图（Skills / MCP）：覆盖 agent 输出区，不是弹窗 ──
 * 侧栏「新建任务」下方两个入口切换进来；返回按钮 / 选择任务 / 新建任务时退出。
 * 渲染函数 renderSkillsView / renderMcpView 与弹窗解耦，接收容器参数。 */
const extensionsView = $('#extensions-view');
const extensionsViewBody = $('#extensions-view-body');
/** 扩展整页视图承载两类内容：扩展（skills/mcp）与数据面板（会话/回滚/用量/记忆）。 */
type ExtensionsViewTab = 'skills' | 'mcp' | PanelKind;
let extensionsActiveTab: ExtensionsViewTab = 'skills';
const PANEL_TABS: readonly PanelKind[] = ['sessions', 'usage', 'memory'];
const PANEL_TITLE_KEYS: Record<PanelKind, LocaleKey> = {
  sessions: 'nav.sessions',
  usage: 'nav.usage',
  memory: 'nav.memory',
};

/** 重绘扩展视图当前页的内容（tab 切换由侧栏入口负责，这里只刷新标题 + 列表）。 */
async function renderExtensionsView(): Promise<void> {
  if (!extensionsViewBody) return;
  const title = document.querySelector('#extensions-view-title');
  const tab = extensionsActiveTab;
  if (title) title.textContent = t(PANEL_TABS.includes(tab as PanelKind) ? PANEL_TITLE_KEYS[tab as PanelKind] : tab === 'skills' ? 'nav.skills' : 'nav.mcp');
  if (PANEL_TABS.includes(tab as PanelKind)) await renderPanel(tab as PanelKind, extensionsViewBody);
  else if (tab === 'skills') await renderSkillsView(extensionsViewBody);
  else await renderMcpView(extensionsViewBody);
}

/** 打开扩展视图并定位到指定 tab（重复点击同 tab = 刷新列表）。 */
function showExtensionsView(tab: ExtensionsViewTab): void {
  extensionsActiveTab = tab;
  extensionsView?.classList.remove('hidden');
  void renderExtensionsView();
}

/** 关闭扩展视图，回到会话画面。 */
function hideExtensionsView(): void {
  extensionsView?.classList.add('hidden');
}

$('#nav-skills').addEventListener('click', () => showExtensionsView('skills'));
$('#nav-mcp').addEventListener('click', () => showExtensionsView('mcp'));
// 面板模块只依赖这几个注入函数（避免与 renderer 互相 import 成环）。
initPanels({
  t,
  icon,
  escapeHtml,
  toast: (level, text, durationMs) => showToast(level, text, durationMs),
  currentTaskId: () => viewingTaskId(),
  // session 口径的用量必须显式带会话 id：面板命令可能落到刚懒启动的 host 上，
  // 那时它进程内的 sessionId 还是空串。
  currentSessionId: () => selectedTask()?.sessionId,
  // 会话恢复 / 回滚之后历史变了：按磁盘重新回放这个任务，界面不能停在旧对话上。
  reloadTask: (taskId) => void openTask(taskId),
  send: (command) => window.mocodeWork.panel(command),
});
// 数据面板复用同一个整页视图。会话 / 记忆仍必须有任务：它们的命令都打到「当前选中任务」的
// host 上，没有任务就是空列表，提示一句比空白页好懂。
// 用量例外：跨项目口径读的是全局账本 ~/.mocode/usage-daily.jsonl，与任何工作区无关
// （主进程直接算完回执，见 main.ts 的 work:panel），所以任何时候都能打开。
for (const kind of PANEL_TABS) {
  $(`#nav-${kind}`).addEventListener('click', () => {
    if (kind !== 'usage' && !viewingTaskId()) { showToast('warn', t('panel.noTask')); return; }
    showExtensionsView(kind);
  });
}
$('#extensions-view-back').addEventListener('click', hideExtensionsView);

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
$('#add-attachment').addEventListener('click', async () => {
  addAttachmentResults(await window.mocodeWork.pickAttachment());
});
$('#compact-button').addEventListener('click', () => {
  const viewing = viewingTaskId();
  if (!viewing) return;
  window.mocodeWork.send({ type: 'compact', id: viewing });
});
/**
 * 计划模式开关（对齐终端的 /plan、/auto 与 Shift+Tab）。
 *
 * 为什么必须有：work-app 之前完全没有 plan 模式——host 硬编码 initialMode:'auto'，
 * 于是「只读探查 + 先给方案」这条路在桌面端不存在，模型一上手就改文件。
 *
 * 模式是 host 侧进程级状态，但**必须带 id 否则 host 报错**（要求 requestId 才能回 mode_changed）。
 * 切任务不改模式（与终端一致：模式属于当前会话上下文，不属于界面）。
 */
$('#plan-toggle')?.addEventListener('click', () => {
  const viewing = viewingTaskId();
  if (!viewing) { showToast('info', t('status.planNeedsTask'), 2400); return; }
  window.mocodeWork.send({ type: 'set_mode', id: viewing, mode: planMode ? 'auto' : 'plan' });
});
/** 计划模式开关的视觉与 aria（单一入口，避免两处各改一半）。 */
function applyPlanToggle(next: boolean): void {
  planMode = next;
  const button = $('#plan-toggle');
  if (!button) return;
  button.classList.toggle('active', next);
  button.setAttribute('aria-pressed', next ? 'true' : 'false');
  button.title = t('composer.planToggleTitle');
}
/** 右上角工具箱：菜单只负责选工具，文件与源代码管理仍复用同一个右侧 inspector。 */
const toolsMenu = $('#tools-menu');
const toolsButton = $('#show-tools');
function hideToolsMenu(): void {
  toolsMenu.classList.add('hidden');
  toolsButton.setAttribute('aria-expanded', 'false');
}
function positionToolsMenu(): void {
  if (toolsMenu.classList.contains('hidden')) return;
  const anchor = toolsButton.getBoundingClientRect();
  toolsMenu.style.right = `${Math.max(8, window.innerWidth - anchor.right)}px`;
  toolsMenu.style.top = `${Math.round(anchor.bottom + 6)}px`;
}
toolsButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!toolsMenu.classList.contains('hidden')) { hideToolsMenu(); return; }
  hideModelPicker();
  toolsMenu.classList.remove('hidden');
  toolsButton.setAttribute('aria-expanded', 'true');
  positionToolsMenu();
});
toolsMenu.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', hideToolsMenu);
for (const [selector, tab] of [['#show-files', 'files'], ['#show-source-control', 'source'], ['#show-browser', 'browser'], ['#show-terminal', 'terminal'], ['#show-changes', 'changes'], ['#show-checks', 'checks']] as const) {
  $(selector).addEventListener('click', () => {
    hideToolsMenu();
    if (inspector.classList.contains('hidden')) { openInspector(tab); return; }
    if (activeInspectorTab !== tab) { activeInspectorTab = tab; void refreshInspector(); return; }
    inspector.classList.add('hidden');
    closeSourceControl();
    closeHistory();
    hideBrowserPanel();
    hideTerminalPanel();
  });
}
// 面板的 key 是动态字符串（状态行、占位文案），这里收敛到 LocaleKey 再交给 t()。
const activeProjectId = (): string | undefined => {
  const task = selectedTask();
  return task?.projectId
    ? state?.projects.find((project) => project.id === task.projectId)?.id
    : selectedProject()?.id;
};
initBrowserPanel($('#browser-panel'), {
  t: (key, vars) => t(key as LocaleKey, vars),
  icon,
  escapeHtml,
  currentProjectId: activeProjectId,
  show: (payload) => window.mocodeWork.browserShow(payload),
  hide: () => window.mocodeWork.browserHide(),
  navigate: (url) => window.mocodeWork.browserNavigate(url),
  command: (command) => window.mocodeWork.browserCommand(command),
  onState: (callback) => window.mocodeWork.onBrowserState(callback),
});
// PTY 在主进程，这里只收发字符串；cwd 跟当前空间走，和 agent 的 run_command 同起点。
initTerminalPanel($('#terminal-panel'), {
  t: (key, vars) => t(key as LocaleKey, vars),
  icon,
  escapeHtml,
  currentProjectId: activeProjectId,
  open: (payload) => window.mocodeWork.terminalOpen(payload),
  write: (data) => window.mocodeWork.terminalWrite({ ...(activeProjectId() ? { projectId: activeProjectId()! } : {}), data }),
  resize: (cols, rows) => window.mocodeWork.terminalResize({ ...(activeProjectId() ? { projectId: activeProjectId()! } : {}), cols, rows }),
  close: () => window.mocodeWork.terminalClose(activeProjectId() ? { projectId: activeProjectId()! } : {}),
  clipboardRead: () => window.mocodeWork.clipboardRead(),
  clipboardWrite: (text) => window.mocodeWork.clipboardWrite(text),
  onData: (callback) => window.mocodeWork.onTerminalData(callback),
  onExit: (callback) => window.mocodeWork.onTerminalExit(callback),
  insertPrompt: (text) => insertIntoPrompt(text),
  toast: (level, text) => showToast(level, text, 2200),
});
initSourceControl({
  t,
  icon,
  escapeHtml,
  toast: (level, text, durationMs) => showToast(level, text, durationMs),
  currentTaskId: () => viewingTaskId(),
  // 任务面板归属任务自己的空间；仅无任务时跟随全局选中的空间。
  currentProjectId: () => {
    const task = selectedTask();
    return task?.projectId
      ? state?.projects.find((project) => project.id === task.projectId)?.id
      : selectedProject()?.id;
  },
  repos: (target) => window.mocodeWork.gitRepos(target),
  diff: (target, path, staged) => window.mocodeWork.gitDiff(target, path, staged),
  stage: (target, paths) => window.mocodeWork.gitStage(target, paths),
  unstage: (target, paths) => window.mocodeWork.gitUnstage(target, paths),
  commit: (target, message) => window.mocodeWork.gitCommit(target, message),
  generate: (command, options) => requestPanelCommand(command, options),
});
// 历史视图：与源代码管理共用仓库解析，但不轮询（历史不会自己变）。
initHistory({
  t,
  icon,
  escapeHtml,
  relativeTime: timeAgo,
  currentTaskId: () => viewingTaskId(),
  currentProjectId: () => {
    const task = selectedTask();
    return task?.projectId
      ? state?.projects.find((project) => project.id === task.projectId)?.id
      : selectedProject()?.id;
  },
  repos: (target) => window.mocodeWork.gitRepos(target),
  log: (target, options) => window.mocodeWork.gitLog(target, options),
  commitFiles: (target, sha) => window.mocodeWork.gitCommitFiles(target, sha),
  commitFile: (target, sha, path) => window.mocodeWork.gitCommitFile(target, sha, path),
});
$('#close-inspector').addEventListener('click', () => { inspector.classList.add('hidden'); closeSourceControl(); closeHistory(); hideBrowserPanel(); hideTerminalPanel(); });
$('#search-button').addEventListener('click', () => { searchPanel.classList.remove('hidden'); searchInput.value = ''; refreshSearch(); searchInput.focus(); });
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast('info', t('toast.themeSwitched', { theme: next === 'dark' ? t('appearance.themeDark') : t('appearance.themeLight') }), 1600);
});

/** 应用并持久化主题。saved 可为 light/dark/system; dataset 始终写入实际生效的 light/dark。 */
/**
 * Windows 原生窗口按钮（右上角 — □ ✕）的**符号色**跟着主题走。
 *
 * 底色不在这里管：主进程把 overlay 底色设成透明（见 main.ts 的 TRANSPARENT_OVERLAY），
 * 那块区域露出的是网页自身的 `.titlebar` 背景。曾经这里把 `.titlebar` 的实测底色也传过去，
 * 结果是「两套颜色互相追」：一旦某条链路失效（比如 canvas 读色在旧构建里恒为 null），
 * 按钮区就停在主进程的硬编码值上，深色主题下标题栏右端明显两块色。
 * 现在颜色只有一个来源（CSS），这里只负责符号深浅。
 *
 * 符号色必须规范化成 #rrggbb：computed style 给的是 oklch(...)，原生侧解析不可靠。
 * 不能靠 canvas.fillStyle 读回字符串（它会把 oklch 原样存回），要画 1px 再读像素，
 * 让 Chromium 自己做色域转换。
 */
function toSrgbHex(color: string): string | null {
  if (!color || !CSS.supports('color', color)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (!a) return null;
  return `#${[r!, g!, b!].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function syncTitleBarOverlay(): void {
  const bar = document.querySelector('.titlebar');
  if (!bar) return;
  const brandText = bar.querySelector('.titlebar-brand-text');
  const symbol = toSrgbHex((brandText ? getComputedStyle(brandText).color : '') || getComputedStyle(bar).color);
  if (symbol) window.mocodeWork.setTitleBarOverlay({ symbol });
}

function applyTheme(saved: 'light' | 'dark' | 'system'): void {
  const effective = saved === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : saved;
  document.documentElement.dataset.theme = effective;
  try { localStorage.setItem('mocode-work-theme', saved); } catch { /* 无 localStorage 则仅本次生效 */ }
  window.mocodeWork.setTheme(saved);
  syncTitleBarOverlay();
  // xterm 只在创建时吃 theme；换主题必须显式重设，否则终端永远停在旧配色。
  refreshTerminalTheme();
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
  // accent 色相会轻微改变 surface-app，titlebar overlay 也要跟着对一次色。
  syncTitleBarOverlay();
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
type SettingsSectionId = 'model' | 'behavior' | 'voice' | 'appearance' | 'about';
/** 分类元数据存 i18n key（不存译文）—— 模块级常量在启动时求值一次，存译文会锁死语言。 */
const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; labelKey: LocaleKey; icon: string; descKey: LocaleKey }> = [
  { id: 'model', labelKey: 'settings.model', icon: 'spark-bot', descKey: 'settings.modelDesc' },
  { id: 'behavior', labelKey: 'settings.behavior', icon: 'wrench', descKey: 'settings.behaviorDesc' },
  { id: 'voice', labelKey: 'settings.voice', icon: 'mic', descKey: 'settings.voiceDesc' },
  { id: 'appearance', labelKey: 'settings.appearance', icon: 'sun', descKey: 'settings.appearanceDesc' },
  { id: 'about', labelKey: 'settings.about', icon: 'info', descKey: 'settings.aboutDesc' },
];
let settingsActiveSection: SettingsSectionId = 'model';
/**
 * 行为开关清单。分组是为了让「上下文 / 记忆 / 工具面」三类一眼分开 ——
 * 十几个开关平铺成一列，用户根本记不住哪个属于哪块。
 */
const SETTING_GROUPS: Array<{ titleKey: LocaleKey; hintKey: LocaleKey; items: Array<{ key: string; labelKey: LocaleKey; hintKey: LocaleKey }> }> = [
  {
    titleKey: 'settings.groupContext',
    hintKey: 'settings.groupContextHint',
    items: [
      { key: 'autoCompact', labelKey: 'setting.autoCompact', hintKey: 'setting.autoCompactHint' },
      { key: 'autoReflect', labelKey: 'setting.autoReflect', hintKey: 'setting.autoReflectHint' },
    ],
  },
  {
    titleKey: 'settings.groupMemory',
    hintKey: 'settings.groupMemoryHint',
    items: [
      { key: 'memory', labelKey: 'setting.memory', hintKey: 'setting.memoryHint' },
      { key: 'turnRecall', labelKey: 'setting.turnRecall', hintKey: 'setting.turnRecallHint' },
      { key: 'proactive', labelKey: 'setting.proactive', hintKey: 'setting.proactiveHint' },
      { key: 'episodic', labelKey: 'setting.episodic', hintKey: 'setting.episodicHint' },
      { key: 'consolidate', labelKey: 'setting.consolidate', hintKey: 'setting.consolidateHint' },
    ],
  },
  {
    titleKey: 'settings.groupTools',
    hintKey: 'settings.groupToolsHint',
    items: [
      { key: 'router', labelKey: 'setting.router', hintKey: 'setting.routerHint' },
      { key: 'subAgent', labelKey: 'setting.subAgent', hintKey: 'setting.subAgentHint' },
      { key: 'frontendTools', labelKey: 'setting.frontendTools', hintKey: 'setting.frontendToolsHint' },
      { key: 'computerUse', labelKey: 'setting.computerUse', hintKey: 'setting.computerUseHint' },
      { key: 'mcp', labelKey: 'setting.mcp', hintKey: 'setting.mcpHint' },
    ],
  },
];
const SETTING_ITEMS = SETTING_GROUPS.flatMap((group) => group.items);
/** 思考强度五档，与 core 的 ReasoningEffort 同集合（/effort 对应的用户面）。 */
const EFFORT_ITEMS: Array<{ value: EffortValue; labelKey: LocaleKey; hintKey: LocaleKey }> = [
  { value: 'off', labelKey: 'effort.off', hintKey: 'effort.offHint' },
  { value: 'low', labelKey: 'effort.low', hintKey: 'effort.lowHint' },
  { value: 'medium', labelKey: 'effort.medium', hintKey: 'effort.mediumHint' },
  { value: 'high', labelKey: 'effort.high', hintKey: 'effort.highHint' },
  { value: 'auto', labelKey: 'effort.auto', hintKey: 'effort.autoHint' },
];
let settingsState: Record<string, boolean | string> = {};

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
      <button class="settings-add" id="model-browse-catalog">
        <span class="settings-add-icon">${icon('globe')}</span>
        <span class="settings-row-body"><span class="settings-row-title">${t('settings.browseCatalog')}</span><span class="settings-row-sub">${t('settings.browseCatalogSub')}</span></span>
      </button>
      </div>`;
    settingsSection.querySelector<HTMLButtonElement>('#model-add')?.addEventListener('click', () => openModelForm());
    settingsSection.querySelector<HTMLButtonElement>('#model-browse-catalog')?.addEventListener('click', () => void openCatalogModal());
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
      <button class="settings-add" id="model-browse-catalog">
        <span class="settings-add-icon">${icon('globe')}</span>
        <span class="settings-row-body"><span class="settings-row-title">${t('settings.browseCatalog')}</span><span class="settings-row-sub">${t('settings.browseCatalogSub')}</span></span>
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
  settingsSection.querySelector<HTMLButtonElement>('#model-browse-catalog')?.addEventListener('click', () => void openCatalogModal());
}

/* ── 模型目录浏览（models.dev） ───────────────────────────────
 * 与 mocode 终端 /model browse 等价：快照与终端共用 ~/.mocode/catalog.json，
 * 任何一边刷新两边都能读到。选中条目回模型表单预填（协议判定同 core，
 * 只暴露可直发的 openai-compatible / anthropic 条目）。 */

const CATALOG_MAX_ROWS = 120;
let catalogEntries: CatalogEntryView[] = [];
let catalogLoaded = false;
let catalogLoading = false;
let catalogEl: HTMLElement | null = null;

const catalogField = <T extends HTMLElement>(id: string): T => catalogEl!.querySelector(`#${id}`) as T;

function ensureCatalogModal(): HTMLElement {
  if (catalogEl) return catalogEl;
  const el = $('#catalog-modal') as HTMLElement;
  catalogEl = el;
  const searchInput = catalogField<HTMLInputElement>('catalog-search');
  // 输入即时过滤（客户端过滤，主进程一次性回全量可直发条目）。
  searchInput.addEventListener('input', () => renderCatalogList());
  catalogField<HTMLButtonElement>('catalog-refresh').addEventListener('click', () => void loadCatalogEntries(true));
  el.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeCatalogModal));
  el.addEventListener('click', (event) => { if (event.target === el) closeCatalogModal(); });
  return el;
}

function catalogStatusText(message: string, show: boolean = true): void {
  const el = catalogField<HTMLElement>('catalog-status');
  el.textContent = message;
  el.classList.toggle('hidden', !show);
}

function openCatalogModal(): void {
  const el = ensureCatalogModal();
  el.classList.remove('hidden');
  catalogField<HTMLInputElement>('catalog-search').value = '';
  if (!catalogLoaded) void loadCatalogEntries(false);
  else renderCatalogList();
  catalogField<HTMLInputElement>('catalog-search').focus();
}

function closeCatalogModal(): void {
  catalogEl?.classList.add('hidden');
}

async function loadCatalogEntries(refresh: boolean): Promise<void> {
  if (catalogLoading) return;
  catalogLoading = true;
  const refreshButton = catalogField<HTMLButtonElement>('catalog-refresh');
  refreshButton.disabled = true;
  refreshButton.classList.add('spinning');
  catalogStatusText(t('catalog.loading'));
  try {
    const result = await window.mocodeWork.catalogLoad({ refresh });
    if (!result.ok || !result.entries) {
      catalogStatusText(result.message ?? t('catalog.loadFailed'));
      return;
    }
    catalogEntries = result.entries;
    catalogLoaded = true;
    catalogStatusText('');
    const meta = catalogField<HTMLElement>('catalog-meta');
    meta.textContent = t('catalog.count', {
      providers: result.providerCount ?? 0,
      models: result.total ?? result.entries.length,
      date: (result.fetchedAt ?? '').slice(0, 10),
    });
  } catch (error) {
    catalogStatusText(t('catalog.loadFailed', { msg: (error as Error).message }));
  } finally {
    catalogLoading = false;
    refreshButton.disabled = false;
    refreshButton.classList.remove('spinning');
    renderCatalogList();
  }
}

function renderCatalogList(): void {
  if (!catalogEl) return;
  const listEl = catalogField<HTMLElement>('catalog-list');
  // 首次还没加载成功前列表保持空白：状态条负责展示「加载中 / 失败」，别自相矛盾。
  if (!catalogLoaded) {
    listEl.innerHTML = '';
    return;
  }
  const query = catalogField<HTMLInputElement>('catalog-search').value;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = tokens.length
    ? catalogEntries.filter((e) => {
        const hay = [e.providerName, e.providerId, e.modelId, e.name ?? ''].join(' ').toLowerCase();
        return tokens.every((tok) => hay.includes(tok));
      })
    : catalogEntries;
  if (!filtered.length) {
    listEl.innerHTML = `<p class="catalog-none">${escapeHtml(tokens.length ? t('catalog.noMatch', { query }) : t('catalog.empty'))}</p>`;
    return;
  }
  const rows = filtered.slice(0, CATALOG_MAX_ROWS).map((entry, index) => {
    const title = entry.name || entry.modelId;
    const caps = [
      entry.reasoning ? `<span class="catalog-cap">${t('catalog.capReasoning')}</span>` : '',
      entry.toolCall ? `<span class="catalog-cap">${t('catalog.capTools')}</span>` : '',
      entry.attachment ? `<span class="catalog-cap">${t('catalog.capVision')}</span>` : '',
    ].filter(Boolean).join('');
    return `
      <button class="catalog-row" data-provider="${escapeHtml(entry.providerId)}" data-model="${escapeHtml(entry.modelId)}" role="option" data-index="${index}">
        <span class="catalog-row-main">
          <span class="catalog-row-name">${escapeHtml(title)}</span>
          <span class="catalog-row-provider">${escapeHtml(entry.providerName)}</span>
        </span>
        <span class="catalog-row-meta">
          <span class="catalog-row-id">${escapeHtml(entry.modelId)}</span>
          <span class="catalog-row-ctx">${Math.round(entry.contextWindow / 1000)}k</span>
          ${caps}
        </span>
      </button>`;
  }).join('');
  listEl.innerHTML = rows + (filtered.length > CATALOG_MAX_ROWS ? `<p class="catalog-none">${escapeHtml(t('catalog.truncated', { shown: CATALOG_MAX_ROWS, total: filtered.length }))}</p>` : '');
  listEl.querySelectorAll<HTMLButtonElement>('.catalog-row').forEach((row) => {
    row.addEventListener('click', () => void pickCatalogEntry(row.dataset.provider ?? '', row.dataset.model ?? ''));
  });
}

async function pickCatalogEntry(providerId: string, modelId: string): Promise<void> {
  if (!providerId || !modelId) return;
  const result = await window.mocodeWork.catalogPrefill({ providerId, modelId });
  if (!result.ok || !result.prefill) {
    showToast('error', result.message ?? t('catalog.loadFailed'));
    return;
  }
  closeCatalogModal();
  openModelForm(undefined, { ...result.prefill, suggestedName: result.suggestedName, apiKeySeed: result.apiKeySeed ?? '' });
}

/* ── Skill 市场 / 扩展管理（设置页「Skills」分类） ──────────────
 * skill 安装目录 ~/.mocode/skills/ 与 mocode 终端共用，格式兼容 Claude Code /
 * Agent Skills 开放标准（目录 + SKILL.md frontmatter）。导入通道：本地文件夹、
 * zip 包、git 仓库（市场）；市场 = 浅克隆到本地缓存 → 扫描含 SKILL.md 的目录。 */

let skillListItems: SkillItem[] = [];

/** 市场源：内置精选 + 自定义 git URL。label 为品牌名（仓库路径），不随语言变。 */
const SKILL_MARKET_SOURCES: Array<{ id: string; url: string; labelKey?: LocaleKey; label?: string }> = [
  { id: 'anthropics-skills', url: 'https://github.com/anthropics/skills', label: 'anthropics/skills' },
  { id: 'obra-superpowers', url: 'https://github.com/obra/superpowers', label: 'obra/superpowers' },
  { id: 'custom', url: '', labelKey: 'skillMarket.customSource' },
];

const MCP_TEMPLATES: Array<{ label: string; name: string; draft: McpDraft }> = [
  { label: 'fetch · 网页抓取', name: 'fetch', draft: { transport: 'stdio', command: 'uvx', argsText: 'mcp-server-fetch' } },
  { label: 'memory · 长期记忆', name: 'memory', draft: { transport: 'stdio', command: 'npx', argsText: '-y\n@modelcontextprotocol/server-memory' } },
  { label: 'filesystem · 文件系统', name: 'filesystem', draft: { transport: 'stdio', command: 'npx', argsText: '-y\n@modelcontextprotocol/server-filesystem\n.' } },
  { label: 'sequential-thinking · 思维链', name: 'sequential-thinking', draft: { transport: 'stdio', command: 'npx', argsText: '-y\n@modelcontextprotocol/server-sequential-thinking' } },
  { label: 'context7 · 文档检索', name: 'context7', draft: { transport: 'stdio', command: 'npx', argsText: '-y\n@upstash/context7-mcp' } },
  { label: 'playwright · 浏览器自动化', name: 'playwright', draft: { transport: 'stdio', command: 'npx', argsText: '-y\n@playwright/mcp@latest' } },
  { label: 'everything · 测试服务器', name: 'everything', draft: { transport: 'stdio', command: 'npx', argsText: '-y\n@modelcontextprotocol/server-everything' } },
];

function skillOriginLabel(origin: SkillOrigin): string {
  return origin === 'user' ? t('extensions.originUser') : origin === 'claude' ? t('extensions.originClaude') : t('extensions.originProject');
}

function skillRow(item: SkillItem): string {
  const meta = [
    skillOriginLabel(item.origin),
    item.version ? `v${escapeHtml(item.version)}` : null,
    item.modelInvocable ? null : t('extensions.manualOnly'),
  ].filter(Boolean).join(' · ');
  const deletable = item.origin !== 'claude';
  return `
    <div class="settings-row-wrap">
      <div class="settings-row" role="listitem">
        <span class="settings-row-body">
          <span class="settings-row-title">${escapeHtml(item.name)}</span>
          <span class="settings-row-sub" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</span>
          <span class="settings-row-sub">${meta}</span>
        </span>
      </div>
      <button class="settings-row-act icon-button muted" data-skill-open="${escapeHtml(item.dir)}" title="${t('extensions.openDir')}" aria-label="${t('extensions.openDir')}">${icon('folder-open')}</button>
      ${deletable ? `<button class="settings-row-act icon-button muted" data-skill-delete="${escapeHtml(item.dir)}" data-skill-name="${escapeHtml(item.name)}" title="${t('extensions.delete')}" aria-label="${t('extensions.delete')}">${icon('trash')}</button>` : `<span class="settings-row-act settings-row-readonly" title="${t('extensions.readonlyDir')}">${icon('info')}</span>`}
    </div>`;
}

/** 「Skills」分类：已安装列表 + 四条导入通道。 */
/** 「Skill 市场」整页视图（渲染进 #extensions-view-body，不再是设置弹窗分类）。 */
async function renderSkillsView(container: HTMLElement): Promise<void> {
  const projectRoot = selectedProject()?.root;
  try { skillListItems = await window.mocodeWork.skillsList(projectRoot); }
  catch { skillListItems = []; }
  const groups: Array<{ origin: SkillOrigin; items: SkillItem[] }> = (['user', 'claude', 'project'] as const)
    .map((origin) => ({ origin, items: skillListItems.filter((s) => s.origin === origin) }))
    .filter((group) => group.items.length);
  container.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('extensions.importTitle')}</b><span>${t('extensions.importHint')}</span></div>
      <div class="skill-import-grid">
        <button class="settings-add" id="skill-import-folder">
          <span class="settings-add-icon">${icon('folder-open')}</span>
          <span class="settings-row-body"><span class="settings-row-title">${t('extensions.importFolder')}</span><span class="settings-row-sub">${t('extensions.importFolderSub')}</span></span>
        </button>
        <button class="settings-add" id="skill-import-zip">
          <span class="settings-add-icon">${icon('files')}</span>
          <span class="settings-row-body"><span class="settings-row-title">${t('extensions.importZip')}</span><span class="settings-row-sub">${t('extensions.importZipSub')}</span></span>
        </button>
        <button class="settings-add" id="skill-browse-market">
          <span class="settings-add-icon">${icon('globe')}</span>
          <span class="settings-row-body"><span class="settings-row-title">${t('skillMarket.title')}</span><span class="settings-row-sub">${t('skillMarket.subtitle')}</span></span>
        </button>
      </div>
      <div class="skill-git-row">
        <input id="skill-git-url" class="field-input" type="text" autocomplete="off" spellcheck="false" placeholder="${t('extensions.gitUrlPlaceholder')}" />
        <button class="btn-primary" id="skill-git-import">${t('extensions.gitImport')}</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('extensions.installedTitle')}</b><span>${t('extensions.installedHint', { n: skillListItems.length })}</span></div>
      ${groups.length
        ? groups.map((group) => `
            <div class="settings-provider">
              <div class="settings-provider-head"><b>${escapeHtml(skillOriginLabel(group.origin))}</b><span class="settings-provider-count">${t('settings.providerCount', { n: group.items.length })}</span></div>
              <div class="settings-list">${group.items.map(skillRow).join('')}</div>
            </div>`).join('')
        : `<div class="settings-empty">${icon('sparkles')}<div><b>${t('extensions.emptyTitle')}</b><p>${t('extensions.emptyHint')}</p></div></div>`}
    </div>
  `;
  const applyImport = async (result: ImportResult | Promise<ImportResult>): Promise<void> => {
    const settled = await result;
    if (!settled.ok && settled.message !== 'cancelled' && settled.message) showToast('error', settled.message);
    if (settled.ok) showToast('success', settled.message ?? t('extensions.importDone'));
    await renderSkillsView(container);
  };
  container.querySelector<HTMLButtonElement>('#skill-import-folder')?.addEventListener('click', () => void applyImport(window.mocodeWork.skillImportFolder()));
  container.querySelector<HTMLButtonElement>('#skill-import-zip')?.addEventListener('click', () => void applyImport(window.mocodeWork.skillImportZip()));
  container.querySelector<HTMLButtonElement>('#skill-browse-market')?.addEventListener('click', () => openSkillMarketModal());
  container.querySelector<HTMLButtonElement>('#skill-git-import')?.addEventListener('click', () => {
    const input = container.querySelector<HTMLInputElement>('#skill-git-url');
    const url = input?.value.trim() ?? '';
    if (!url) { showToast('warn', t('extensions.gitUrlRequired')); return; }
    showToast('info', t('extensions.gitImporting'));
    void applyImport(window.mocodeWork.skillImportGit(url));
  });
  container.querySelectorAll<HTMLButtonElement>('[data-skill-open]').forEach((button) => {
    button.addEventListener('click', () => void window.mocodeWork.skillOpen(button.dataset.skillOpen!));
  });
  container.querySelectorAll<HTMLButtonElement>('[data-skill-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.armed !== '1') {
        button.dataset.armed = '1';
        button.classList.add('danger-armed');
        showToast('warn', t('extensions.deleteConfirm', { name: button.dataset.skillName ?? '' }));
        setTimeout(() => { button.dataset.armed = '0'; button.classList.remove('danger-armed'); }, 3200);
        return;
      }
      const result = await window.mocodeWork.skillDelete(button.dataset.skillDelete!, projectRoot);
      if (!result.ok && result.message) showToast('error', result.message);
      else showToast('success', t('extensions.deleted', { name: button.dataset.skillName ?? '' }));
      await renderSkillsView(container);
    });
  });
}

/* ── Skill 市场弹窗 ──────────────────────────────────────────── */

let skillMarketEl: HTMLElement | null = null;
let skillMarketUrl = SKILL_MARKET_SOURCES[0]?.url ?? '';
let skillMarketLoading = false;

const skillMarketField = <T extends HTMLElement>(id: string): T => skillMarketEl!.querySelector(`#${id}`) as T;

function ensureSkillMarketModal(): HTMLElement {
  if (skillMarketEl) return skillMarketEl;
  const el = $('#skill-market-modal') as HTMLElement;
  skillMarketEl = el;
  const sourceSelect = skillMarketField<HTMLSelectElement>('skill-market-source');
  const rebuildSources = (): void => {
    sourceSelect.innerHTML = '';
    for (const source of SKILL_MARKET_SOURCES) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.labelKey ? t(source.labelKey) : source.label!;
      sourceSelect.append(option);
    }
  };
  rebuildSources();
  sourceSelect.addEventListener('change', () => {
    const source = SKILL_MARKET_SOURCES.find((s) => s.id === sourceSelect.value);
    skillMarketUrl = source?.url ?? '';
    skillMarketField<HTMLInputElement>('skill-market-url').classList.toggle('field-hidden', !!source?.url);
    if (source?.url) void loadSkillMarketList(false);
  });
  skillMarketField<HTMLInputElement>('skill-market-url').addEventListener('change', () => {
    skillMarketUrl = skillMarketField<HTMLInputElement>('skill-market-url').value.trim();
  });
  skillMarketField<HTMLButtonElement>('skill-market-refresh').addEventListener('click', () => void loadSkillMarketList(true));
  el.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeSkillMarketModal));
  el.addEventListener('click', (event) => { if (event.target === el) closeSkillMarketModal(); });
  return el;
}

function openSkillMarketModal(): void {
  const el = ensureSkillMarketModal();
  el.classList.remove('hidden');
  if (!skillMarketLoading) void loadSkillMarketList(false);
}

function closeSkillMarketModal(): void {
  skillMarketEl?.classList.add('hidden');
}

function skillMarketStatus(message: string, show = true): void {
  const el = skillMarketField<HTMLElement>('skill-market-status');
  el.textContent = message;
  el.classList.toggle('hidden', !show);
}

async function loadSkillMarketList(refresh: boolean): Promise<void> {
  if (!skillMarketEl) return;
  const sourceSelect = skillMarketField<HTMLSelectElement>('skill-market-source');
  const source = SKILL_MARKET_SOURCES.find((s) => s.id === sourceSelect.value);
  const url = source?.url || skillMarketField<HTMLInputElement>('skill-market-url').value.trim();
  if (!url) { skillMarketStatus(t('extensions.gitUrlRequired')); return; }
  skillMarketLoading = true;
  const refreshButton = skillMarketField<HTMLButtonElement>('skill-market-refresh');
  refreshButton.disabled = true;
  refreshButton.classList.add('spinning');
  skillMarketStatus(t('skillMarket.loading'));
  try {
    const result = await window.mocodeWork.skillsMarketLoad(url, refresh);
    if (!result.ok) { skillMarketStatus(result.message ?? t('skillMarket.loadFailed')); return; }
    skillMarketStatus('');
    skillMarketField<HTMLElement>('skill-market-meta').textContent = t('skillMarket.count', { n: result.skills.length });
    renderSkillMarketList(url, result.skills);
  } catch (error) {
    skillMarketStatus(t('skillMarket.loadFailed', { msg: (error as Error).message }));
  } finally {
    skillMarketLoading = false;
    refreshButton.disabled = false;
    refreshButton.classList.remove('spinning');
  }
}

function renderSkillMarketList(url: string, skills: MarketSkills['skills']): void {
  const listEl = skillMarketField<HTMLElement>('skill-market-list');
  if (!skills.length) { listEl.innerHTML = `<p class="catalog-none">${t('skillMarket.empty')}</p>`; return; }
  listEl.innerHTML = skills.map((skill) => `
    <div class="settings-row-wrap">
      <div class="settings-row" role="listitem">
        <span class="settings-row-body">
          <span class="settings-row-title">${escapeHtml(skill.name)}${skill.version ? ` <span class="catalog-row-id">v${escapeHtml(skill.version)}</span>` : ''}</span>
          <span class="settings-row-sub" title="${escapeHtml(skill.description)}">${escapeHtml(skill.description)}</span>
        </span>
      </div>
      <button class="btn-primary skill-market-install" data-url="${escapeHtml(url)}" data-reldir="${escapeHtml(skill.relDir)}" data-name="${escapeHtml(skill.name)}">${t('skillMarket.install')}</button>
    </div>`).join('');
  listEl.querySelectorAll<HTMLButtonElement>('.skill-market-install').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await window.mocodeWork.skillInstallMarket(button.dataset.url!, button.dataset.reldir!);
        if (!result.ok && result.message) { showToast('error', result.message); return; }
        showToast('success', t('extensions.installedOne', { name: button.dataset.name ?? '' }));
        button.textContent = t('skillMarket.installed');
        // 市场弹窗关掉后背后就是 Skill 页：安装成功即刷新列表，免去手动刷新。
        if (extensionsView && !extensionsView.classList.contains('hidden') && extensionsActiveTab === 'skills' && extensionsViewBody) void renderSkillsView(extensionsViewBody);
      } finally { button.disabled = false; }
    });
  });
}

/* ── MCP 接入（设置页「MCP」分类） ─────────────────────────────
 * 配置落 ~/.mocode/mcp.json（标准 { "mcpServers": ... } 格式），main 进程启动时
 * 把它注入 host 的 MCP_CONFIG_PATH（用户已有自己的 MCP 配置时不覆盖）。 */

let mcpListItems: McpServerView[] = [];

function mcpRow(server: McpServerView): string {
  const detail = server.transport === 'stdio'
    ? `${server.command ?? ''}${server.args?.length ? ' ' + server.args.join(' ') : ''}`.trim()
    : server.url ?? '';
  const meta = [
    server.transport,
    detail ? `<code class="mcp-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</code>` : null,
    Object.keys(server.env ?? {}).length ? t('mcp.envCount', { n: Object.keys(server.env ?? {}).length }) : null,
    server.disabled ? t('mcp.disabled') : null,
  ].filter(Boolean).join(' · ');
  return `
    <div class="settings-row-wrap">
      <div class="settings-row ${server.disabled ? 'mcp-disabled' : ''}" role="listitem">
        <span class="settings-row-body">
          <span class="settings-row-title">${escapeHtml(server.name)}</span>
          <span class="settings-row-sub">${meta}</span>
        </span>
      </div>
      <button class="settings-row-act icon-button muted" data-mcp-toggle="${escapeHtml(server.name)}" data-disabled="${server.disabled ? '0' : '1'}" title="${server.disabled ? t('mcp.enable') : t('mcp.disable')}" aria-label="${server.disabled ? t('mcp.enable') : t('mcp.disable')}">${icon(server.disabled ? 'circle-plus' : 'close')}</button>
      <button class="settings-row-act icon-button muted" data-mcp-edit="${escapeHtml(server.name)}" title="${t('menu.edit')}" aria-label="${t('menu.edit')}">${icon('edit')}</button>
      <button class="settings-row-act icon-button muted" data-mcp-delete="${escapeHtml(server.name)}" title="${t('extensions.delete')}" aria-label="${t('extensions.delete')}">${icon('trash')}</button>
    </div>`;
}

/** 「MCP 接入」整页视图（渲染进 #extensions-view-body，不再是设置弹窗分类）。 */
async function renderMcpView(container: HTMLElement): Promise<void> {
  try { mcpListItems = await window.mocodeWork.mcpList(); }
  catch { mcpListItems = []; }
  const configPath = await window.mocodeWork.mcpConfigPath();
  container.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('mcp.listTitle')}</b><span>${t('mcp.listHint', { n: mcpListItems.length })}</span></div>
      <div class="skill-import-grid">
        <button class="settings-add" id="mcp-add">
          <span class="settings-add-icon">${icon('plus')}</span>
          <span class="settings-row-body"><span class="settings-row-title">${t('mcp.add')}</span><span class="settings-row-sub">${t('mcp.addSub')}</span></span>
        </button>
        <button class="settings-add" id="mcp-import">
          <span class="settings-add-icon">${icon('copy')}</span>
          <span class="settings-row-body"><span class="settings-row-title">${t('mcp.importJson')}</span><span class="settings-row-sub">${t('mcp.importJsonSub')}</span></span>
        </button>
      </div>
      ${mcpListItems.length
        ? `<div class="settings-list">${mcpListItems.map(mcpRow).join('')}</div>`
        : `<div class="settings-empty">${icon('globe')}<div><b>${t('mcp.emptyTitle')}</b><p>${t('mcp.emptyHint')}</p></div></div>`}
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('mcp.aboutTitle')}</b><span>${t('mcp.aboutHint')}</span></div>
      <div class="settings-kv">
        <div class="settings-kv-row"><span>${t('mcp.kvConfigFile')}</span><b title="${escapeHtml(configPath)}">${escapeHtml(configPath)}</b></div>
        <div class="settings-kv-row"><span>${t('mcp.kvEffective')}</span><b>${t('mcp.kvEffectiveValue')}</b></div>      </div>
      <p class="settings-row-sub">${t('mcp.aboutNote')}</p>
    </div>
  `;
  container.querySelector<HTMLButtonElement>('#mcp-add')?.addEventListener('click', () => openMcpForm());
  container.querySelector<HTMLButtonElement>('#mcp-import')?.addEventListener('click', () => openMcpImportModal());
  container.querySelectorAll<HTMLButtonElement>('[data-mcp-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await window.mocodeWork.mcpToggle(button.dataset.mcpToggle!, button.dataset.disabled === '1');
      showToast(result.ok ? 'success' : 'error', result.message);
      await renderMcpView(container);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-mcp-edit]').forEach((button) => {
    button.addEventListener('click', () => openMcpForm(button.dataset.mcpEdit));
  });
  container.querySelectorAll<HTMLButtonElement>('[data-mcp-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.armed !== '1') {
        button.dataset.armed = '1';
        button.classList.add('danger-armed');
        showToast('warn', t('mcp.deleteConfirm', { name: button.dataset.mcpDelete ?? '' }));
        setTimeout(() => { button.dataset.armed = '0'; button.classList.remove('danger-armed'); }, 3200);
        return;
      }
      const result = await window.mocodeWork.mcpDelete(button.dataset.mcpDelete!);
      showToast(result.ok ? 'success' : 'error', result.message);
      await renderMcpView(container);
    });
  });
}

/* ── MCP server 编辑器（添加 / 编辑 / 模板） ────────────────── */

let mcpFormEl: HTMLElement | null = null;
let mcpFormEditing: string | undefined;

const mcpFormField = <T extends HTMLElement>(id: string): T => mcpFormEl!.querySelector(`#${id}`) as T;

function rebuildMcpTemplates(): void {
  const select = mcpFormField<HTMLSelectElement>('mcp-form-template');
  if (!select) return;
  select.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = t('mcpForm.custom');
  select.append(custom);
  for (const [index, template] of MCP_TEMPLATES.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${template.label} · ${template.name}`;
    select.append(option);
  }
}

function syncMcpFormVisibility(): void {
  const isStdio = mcpFormField<HTMLSelectElement>('mcp-form-transport').value === 'stdio';
  mcpFormField<HTMLElement>('mcp-form-command-field').classList.toggle('field-hidden', !isStdio);
  mcpFormField<HTMLElement>('mcp-form-args-field').classList.toggle('field-hidden', !isStdio);
  mcpFormField<HTMLElement>('mcp-form-env-field').classList.toggle('field-hidden', !isStdio);
  mcpFormField<HTMLElement>('mcp-form-url-field').classList.toggle('field-hidden', isStdio);
  mcpFormField<HTMLElement>('mcp-form-headers-field').classList.toggle('field-hidden', isStdio);
}

function showMcpFormError(message: string): void {
  const el = mcpFormField<HTMLElement>('mcp-form-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearMcpFormError(): void {
  const el = mcpFormField<HTMLElement>('mcp-form-error');
  el.textContent = '';
  el.classList.add('hidden');
}

function ensureMcpForm(): HTMLElement {
  if (mcpFormEl) return mcpFormEl;
  const el = $('#mcp-form-modal') as HTMLElement;
  mcpFormEl = el;
  rebuildMcpTemplates();
  mcpFormField<HTMLSelectElement>('mcp-form-template').addEventListener('change', () => {
    const select = mcpFormField<HTMLSelectElement>('mcp-form-template');
    if (select.value === '') return;
    const template = MCP_TEMPLATES[Number(select.value)];
    if (!template) return;
    mcpFormField<HTMLInputElement>('mcp-form-name').value = template.name;
    mcpFormField<HTMLSelectElement>('mcp-form-transport').value = template.draft.transport;
    mcpFormField<HTMLInputElement>('mcp-form-command').value = template.draft.command ?? '';
    mcpFormField<HTMLTextAreaElement>('mcp-form-args').value = template.draft.argsText ?? '';
    mcpFormField<HTMLTextAreaElement>('mcp-form-env').value = template.draft.envText ?? '';
    syncMcpFormVisibility();
  });
  mcpFormField<HTMLSelectElement>('mcp-form-transport').addEventListener('change', syncMcpFormVisibility);
  el.querySelector('.model-form-body')?.addEventListener('input', () => clearMcpFormError());
  $('#mcp-form-save')?.addEventListener('click', () => void submitMcpForm());
  $('#mcp-form-delete')?.addEventListener('click', () => void deleteEditingMcp());
  el.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeMcpForm));
  el.addEventListener('click', (event) => { if (event.target === el) closeMcpForm(); });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'TEXTAREA') { event.preventDefault(); void submitMcpForm(); }
  });
  return el;
}

function openMcpForm(name?: string): void {
  const el = ensureMcpForm();
  mcpFormEditing = name;
  const isEdit = !!name;
  const title = el.querySelector('#mcp-form-title') as HTMLElement;
  const deleteButton = el.querySelector('#mcp-form-delete') as HTMLButtonElement;
  deleteButton.dataset.armed = '0';
  deleteButton.textContent = t('mcpForm.delete');
  deleteButton.hidden = !isEdit;
  title.textContent = isEdit ? t('mcpForm.edit') : t('mcpForm.add');
  mcpFormField<HTMLSelectElement>('mcp-form-template').value = '';
  mcpFormField<HTMLSelectElement>('mcp-form-template').disabled = isEdit;
  mcpFormField<HTMLInputElement>('mcp-form-name').value = '';
  mcpFormField<HTMLSelectElement>('mcp-form-transport').value = 'stdio';
  mcpFormField<HTMLInputElement>('mcp-form-command').value = '';
  mcpFormField<HTMLTextAreaElement>('mcp-form-args').value = '';
  mcpFormField<HTMLTextAreaElement>('mcp-form-env').value = '';
  mcpFormField<HTMLInputElement>('mcp-form-url').value = '';
  mcpFormField<HTMLTextAreaElement>('mcp-form-headers').value = '';
  clearMcpFormError();
  el.classList.remove('hidden');
  if (!isEdit) { mcpFormField<HTMLInputElement>('mcp-form-name').focus(); return; }
  const server = mcpListItems.find((item) => item.name === name);
  if (!server) { showMcpFormError(t('mcpForm.notFound', { name: name ?? '' })); return; }
  mcpFormField<HTMLInputElement>('mcp-form-name').value = server.name;
  mcpFormField<HTMLSelectElement>('mcp-form-transport').value = server.transport;
  mcpFormField<HTMLInputElement>('mcp-form-command').value = server.command ?? '';
  mcpFormField<HTMLTextAreaElement>('mcp-form-args').value = (server.args ?? []).join('\n');
  mcpFormField<HTMLTextAreaElement>('mcp-form-env').value = Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
  mcpFormField<HTMLInputElement>('mcp-form-url').value = server.url ?? '';
  mcpFormField<HTMLTextAreaElement>('mcp-form-headers').value = Object.entries(server.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  syncMcpFormVisibility();
}

function closeMcpForm(): void {
  mcpFormEl?.classList.add('hidden');
  mcpFormEditing = undefined;
}

function collectMcpDraft(): McpDraft | null {
  const transport = mcpFormField<HTMLSelectElement>('mcp-form-transport').value as McpTransport;
  const draft: McpDraft = { transport };
  if (transport === 'stdio') {
    draft.command = mcpFormField<HTMLInputElement>('mcp-form-command').value.trim();
    if (!draft.command) {
      showMcpFormError(t('mcpForm.errorCommand'));
      return null;
    }
    draft.argsText = mcpFormField<HTMLTextAreaElement>('mcp-form-args').value;
    draft.envText = mcpFormField<HTMLTextAreaElement>('mcp-form-env').value;
  } else {
    draft.url = mcpFormField<HTMLInputElement>('mcp-form-url').value.trim();
    if (!draft.url) {
      showMcpFormError(t('mcpForm.errorUrl'));
      return null;
    }
    draft.headersText = mcpFormField<HTMLTextAreaElement>('mcp-form-headers').value;
  }
  return draft;
}

async function submitMcpForm(): Promise<void> {
  clearMcpFormError();
  const name = mcpFormField<HTMLInputElement>('mcp-form-name').value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) { showMcpFormError(t('mcpForm.errorName')); return; }
  const draft = collectMcpDraft();
  if (!draft) return;
  const result = await window.mocodeWork.mcpSave({ name, originalName: mcpFormEditing, draft });
  if (!result.ok) { showMcpFormError(result.message); return; }
  showToast('success', result.message);
  closeMcpForm();
  if (extensionsViewBody) await renderMcpView(extensionsViewBody);
}

async function deleteEditingMcp(): Promise<void> {
  const name = mcpFormEditing;
  if (!name) return;
  const button = mcpFormField<HTMLButtonElement>('mcp-form-delete');
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = t('mcpForm.confirmDelete');
    setTimeout(() => { button.dataset.armed = '0'; button.textContent = t('mcpForm.delete'); }, 3200);
    return;
  }
  const result = await window.mocodeWork.mcpDelete(name);
  if (!result.ok) { showMcpFormError(result.message); return; }
  showToast('success', result.message);
  closeMcpForm();
  if (extensionsViewBody) await renderMcpView(extensionsViewBody);
}

/* ── MCP JSON 导入弹窗 ──────────────────────────────────────── */

let mcpImportEl: HTMLElement | null = null;

function ensureMcpImportModal(): HTMLElement {
  if (mcpImportEl) return mcpImportEl;
  const el = $('#mcp-import-modal') as HTMLElement;
  mcpImportEl = el;
  $('#mcp-import-save')?.addEventListener('click', () => void submitMcpImport());
  el.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeMcpImportModal));
  el.addEventListener('click', (event) => { if (event.target === el) closeMcpImportModal(); });
  return el;
}

function openMcpImportModal(): void {
  const el = ensureMcpImportModal();
  (el.querySelector('#mcp-import-text') as HTMLTextAreaElement).value = '';
  (el.querySelector('#mcp-import-error') as HTMLElement).classList.add('hidden');
  el.classList.remove('hidden');
  (el.querySelector('#mcp-import-text') as HTMLTextAreaElement).focus();
}

function closeMcpImportModal(): void {
  mcpImportEl?.classList.add('hidden');
}

async function submitMcpImport(): Promise<void> {
  const text = (mcpImportEl!.querySelector('#mcp-import-text') as HTMLTextAreaElement).value;
  const errorEl = mcpImportEl!.querySelector('#mcp-import-error') as HTMLElement;
  const result = await window.mocodeWork.mcpImportJson(text);
  if (!result.ok) {
    errorEl.textContent = result.message;
    errorEl.classList.remove('hidden');
    return;
  }
  showToast('success', result.message);
  closeMcpImportModal();
  if (extensionsViewBody) await renderMcpView(extensionsViewBody);
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
/** 目录/原预设的元数据；模型或端点被改后不再沿用，避免能力张冠李戴。 */
let modelFormSource: Partial<WorkPresetDraft> = {};
let modelFormEffort: EffortValue = 'auto';
/** 每次打开/关闭都作废旧 IPC；迟到的 A 回读不能覆盖 B 或新建表单。 */
let modelFormGeneration = 0;

const modelFormField = <T extends HTMLElement>(id: string): T => modelFormEl!.querySelector(`#${id}`) as T;

function effortLabel(value: EffortValue): string {
  return t(`effort.${value}` as LocaleKey);
}

/** 自动始终可选；其它档位严格按该模型 + 端点的能力开放。 */
function effortOptionsHtml(capability: ReasoningCapability, selected: EffortValue): string {
  return EFFORT_ITEMS.map((item) => {
    const enabled = item.value === 'auto' || capability.supportedEfforts.includes(item.value);
    return `<button type="button" class="effort-option" data-effort="${item.value}" aria-pressed="${selected === item.value}" ${enabled ? '' : 'disabled'}>${escapeHtml(t(item.labelKey))}</button>`;
  }).join('');
}

function reasoningHelpText(capability: ReasoningCapability, selected: EffortValue): string {
  const key: LocaleKey = capability.requiresLargerOutput
    ? 'modelForm.reasoningNeedsOutput'
    : capability.mode === 'unknown'
      ? 'modelForm.reasoningUnknown'
      : capability.mode === 'unsupported'
        ? 'modelForm.reasoningUnsupported'
        : selected === 'auto'
          ? 'modelForm.reasoningAuto'
          : capability.mode === 'toggle'
            ? 'modelForm.reasoningToggle'
            : 'modelForm.reasoningLevels';
  const mapping = selected !== 'auto' && capability.effortMap[selected]
    ? ` ${t('modelForm.reasoningMapped', { from: effortLabel(selected), to: capability.effortMap[selected]! })}`
    : '';
  return `${t(key)}${mapping}`;
}

function modelFormMetadata(
  model: string,
  baseURL: string,
  provider: WorkPresetFile['provider'],
): Partial<Pick<WorkPresetDraft, 'catalogProvider' | 'catalogModel' | 'capabilities' | 'pricing'>> {
  const source = modelFormSource;
  if (source.model?.trim() !== model || source.baseURL?.trim() !== baseURL || (source.provider ?? 'openai') !== provider) return {};
  return {
    ...(source.catalogProvider ? { catalogProvider: source.catalogProvider } : {}),
    ...(source.catalogModel ? { catalogModel: source.catalogModel } : {}),
    ...(source.capabilities ? { capabilities: source.capabilities } : {}),
    ...(source.pricing ? { pricing: source.pricing } : {}),
  };
}

function syncFormReasoning(): void {
  if (!modelFormEl) return;
  const provider = modelFormField<HTMLSelectElement>('model-form-provider').value as WorkPresetFile['provider'];
  const baseURL = modelFormField<HTMLInputElement>('model-form-baseurl').value.trim();
  const model = modelFormField<HTMLInputElement>('model-form-model').value.trim();
  const rawMaxTokens = modelFormField<HTMLInputElement>('model-form-max-tokens').value.trim();
  const capability = reasoningCapabilityForPreset({
    provider,
    baseURL,
    model,
    apiKey: '',
    contextWindow: 0,
    maxTokens: rawMaxTokens ? Number(rawMaxTokens) : undefined,
    ...modelFormMetadata(model, baseURL, provider),
  });
  if (modelFormEffort !== 'auto' && !capability.supportedEfforts.includes(modelFormEffort)) modelFormEffort = 'auto';
  modelFormField<HTMLElement>('model-form-effort').innerHTML = effortOptionsHtml(capability, modelFormEffort);
  modelFormField<HTMLElement>('model-form-reasoning-hint').textContent = reasoningHelpText(capability, modelFormEffort);
}

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
    modelFormSource = {};
    modelFormEffort = 'auto';
    modelFormField<HTMLSelectElement>('model-form-provider').value = template.provider;
    modelFormField<HTMLInputElement>('model-form-baseurl').value = template.baseURL;
    modelFormField<HTMLInputElement>('model-form-model').value = template.model;
    modelFormField<HTMLInputElement>('model-form-window').value = String(template.contextWindow);
    modelFormField<HTMLInputElement>('model-form-max-tokens').value = '';
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
  for (const id of ['model-form-baseurl', 'model-form-model', 'model-form-max-tokens']) {
    modelFormField<HTMLInputElement>(id).addEventListener('input', syncFormReasoning);
  }
  modelFormField<HTMLElement>('model-form-effort').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-effort]');
    if (!button || button.disabled) return;
    modelFormEffort = (button.dataset.effort ?? 'auto') as EffortValue;
    syncFormReasoning();
  });
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
  syncFormReasoning();
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
  modelFormSource = {};
  modelFormEffort = 'auto';
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
  modelFormField<HTMLInputElement>('model-form-max-tokens').value = '';
  setFormToggle('model-form-cache', false);
  syncFormVisibility();
  clearFormError();
  modelFormField<HTMLButtonElement>('model-form-save').disabled = false;
}

/** 打开编辑器。传 name = 编辑既有预设（回读完整字段含 apiKey）；
 *  不传 name 但传 prefill = 从模型目录选中后预填（仍是新增态）；都不传 = 空白新增。 */
function openModelForm(name?: string, prefill?: CatalogPrefill & { suggestedName?: string; apiKeySeed?: string }): void {
  const el = ensureModelForm();
  const generation = ++modelFormGeneration;
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
  // 回读完成前不能用半空草稿覆盖原预设；回包后仅同代次请求可以解锁。
  saveButton.disabled = isEdit;
  el.classList.remove('hidden');

  if (!isEdit) {
    if (prefill) {
      // 目录预填同时携带 reasoning_options / output limit，表单据此开放真实可用档位。
      modelFormSource = { ...prefill };
      modelFormField<HTMLSelectElement>('model-form-provider').value = prefill.provider;
      modelFormField<HTMLInputElement>('model-form-baseurl').value = prefill.baseURL;
      modelFormField<HTMLInputElement>('model-form-model').value = prefill.model;
      modelFormField<HTMLInputElement>('model-form-window').value = String(prefill.contextWindow);
      modelFormField<HTMLInputElement>('model-form-max-tokens').value = prefill.maxTokens ? String(prefill.maxTokens) : '';
      setFormToggle('model-form-cache', prefill.anthropicPromptCache);
      if (prefill.apiKeySeed) modelFormField<HTMLInputElement>('model-form-apikey').value = prefill.apiKeySeed;
      const nameInput = modelFormField<HTMLInputElement>('model-form-name');
      nameInput.value = prefill.suggestedName ?? '';
      nameInput.dataset.auto = '1';
      syncFormVisibility();
      modelFormField<HTMLInputElement>('model-form-apikey').focus();
      return;
    }
    modelFormField<HTMLInputElement>('model-form-name').focus();
    return;
  }
  void (async () => {
    const detail = await window.mocodeWork.getModel(name!);
    if (generation !== modelFormGeneration || modelFormEditing !== name) return;
    if (!detail.ok || !detail.preset) {
      deleteButton.hidden = true;
      saveButton.disabled = true;
      showFormError(detail.message ?? t('modelForm.errorRead', { name: name }));
      return;
    }
    saveButton.disabled = false;
    const preset = detail.preset;
    modelFormSource = { ...preset };
    modelFormEffort = preset.reasoningEffort ?? 'auto';
    modelFormField<HTMLInputElement>('model-form-name').value = preset.name;
    modelFormField<HTMLSelectElement>('model-form-provider').value = preset.provider;
    modelFormField<HTMLInputElement>('model-form-baseurl').value = preset.baseURL;
    modelFormField<HTMLInputElement>('model-form-model').value = preset.model;
    modelFormField<HTMLInputElement>('model-form-apikey').value = preset.apiKey;
    modelFormField<HTMLInputElement>('model-form-window').value = String(preset.contextWindow);
    modelFormField<HTMLInputElement>('model-form-max-tokens').value = preset.maxTokens ? String(preset.maxTokens) : '';
    setFormToggle('model-form-cache', preset.anthropicPromptCache);
    syncFormVisibility();
    modelFormField<HTMLInputElement>('model-form-name').focus();
  })();
}

function closeModelForm(): void {
  modelFormGeneration += 1;
  modelFormEl?.classList.add('hidden');
  modelFormEditing = undefined;
  modelFormSource = {};
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
  const provider = modelFormField<HTMLSelectElement>('model-form-provider').value as WorkPresetFile['provider'];
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
  const maxTokensValue = modelFormField<HTMLInputElement>('model-form-max-tokens').value.trim();
  const maxTokens = maxTokensValue ? Number(maxTokensValue) : undefined;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) return flag('model-form-max-tokens', t('modelForm.errorMaxTokens'));
  const capability = reasoningCapabilityForPreset({
    provider, baseURL, apiKey, model, contextWindow, maxTokens,
    ...modelFormMetadata(model, baseURL, provider),
  });
  if (modelFormEffort !== 'auto' && !capability.supportedEfforts.includes(modelFormEffort)) {
    showFormError(t('modelForm.errorEffortUnsupported'));
    return null;
  }
  return {
    provider,
    baseURL,
    apiKey,
    model,
    contextWindow: Math.floor(contextWindow),
    maxTokens,
    reasoningEffort: modelFormEffort,
    anthropicPromptCache: provider === 'anthropic' && modelFormField<HTMLElement>('model-form-cache').getAttribute('aria-checked') === 'true',
    ...modelFormMetadata(model, baseURL, provider),
  };
}

async function submitModelForm(): Promise<void> {
  clearFormError();
  const draft = collectModelDraft();
  if (!draft) return;
  const name = modelFormField<HTMLInputElement>('model-form-name').value.trim();
  const originalName = modelFormEditing;
  const activate = !originalName && modelFormActivate;
  const saveButton = modelFormField<HTMLButtonElement>('model-form-save');
  // Enter 不会触发 disabled 按钮的原生 click 拦截，在这里统一挡住加载中和重复提交。
  if (saveButton.disabled) return;
  const generation = modelFormGeneration;
  saveButton.disabled = true;
  try {
    const result = await window.mocodeWork.saveModel({ name, originalName, draft, activate });
    // 用户已关掉或换成另一份表单时，保存照常完成，但不再替新表单报错或关窗。
    if (generation !== modelFormGeneration) return;
    if (!result.ok) { showFormError(result.message); return; }
    showToast('success', result.message);
    closeModelForm();
    await refreshModelList();
    try { setModeButton(await window.mocodeWork.getConfig()); } catch { /* 忽略 */ }
    await renderSettingsModelSection();
  } catch (error) {
    if (generation === modelFormGeneration) showFormError(t('modelForm.saveFailed', { msg: (error as Error).message }));
  } finally {
    if (generation === modelFormGeneration) saveButton.disabled = false;
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

/**
 * 「行为」分类：mocode 终端的斜杠命令用户面（/effort、/router、/memory_switch、
 * /memory 子开关、/subagent、/fe、/cu、MCP 总开关）。
 *
 * 每一行长成这样：标题 + 一句说明 + 右侧开关（或五档单选）。改动一律写 ~/.mocode/config
 * 并重启后台 agent —— host 启动期就把 env 固化成 config 快照，只改内存等于「重启就丢」。
 */
function renderSettingsBehaviorSection(): void {
  if (!settingsSection) return;
  const toggleRow = (item: { key: string; labelKey: LocaleKey; hintKey: LocaleKey }): string => `
    <button class="settings-row settings-toggle" data-setting="${item.key}" role="switch" aria-checked="${settingsState[item.key] === true ? 'true' : 'false'}">
      <span class="settings-row-body"><span class="settings-row-title">${escapeHtml(t(item.labelKey))}</span><span class="settings-row-sub">${escapeHtml(t(item.hintKey))}</span></span>
      <span class="settings-switch" aria-hidden="true"></span>
    </button>`;

  settingsSection.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('settings.effort')}</b><span>${t('settings.effortHint')}</span></div>
      <div class="settings-list">
        ${EFFORT_ITEMS.map((item) => `
          <button class="settings-row settings-toggle" data-effort="${item.value}" role="radio" aria-checked="${settingsState.effort === item.value ? 'true' : 'false'}">
            <span class="settings-row-body"><span class="settings-row-title">${escapeHtml(t(item.labelKey))}</span><span class="settings-row-sub">${escapeHtml(t(item.hintKey))}</span></span>
            <span class="settings-radio" aria-hidden="true"></span>
          </button>
        `).join('')}
      </div>
    </div>
    ${SETTING_GROUPS.map((group) => `
      <div class="settings-block">
        <div class="settings-block-head"><b>${t(group.titleKey)}</b><span>${t(group.hintKey)}</span></div>
        <div class="settings-list">${group.items.map(toggleRow).join('')}</div>
      </div>
    `).join('')}
  `;

  const hasRunning = (): boolean => (state?.tasks ?? []).some((task) => task.status === 'running' || task.status === 'waiting');

  settingsSection.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach((button) => {
    button.addEventListener('click', async () => {
      const key = button.dataset.setting;
      if (!key) return;
      const next = settingsState[key] !== true;
      try { settingsState = await window.mocodeWork.setSettings({ [key]: next }); }
      catch (error) { console.error('[settings]', error); showToast('error', t('toast.settingsSaveFailed')); return; }
      renderSettingsBehaviorSection();
      const item = SETTING_ITEMS.find((entry) => entry.key === key);
      const label = item ? t(item.labelKey) : key;
      const stateText = next ? t('settings.enableVerb') : t('settings.disableVerb');
      showToast('success', `${t('settings.toggled', { label: label, state: stateText })}${hasRunning() ? t('settings.restartNote') : ''}`);
    });
  });

  settingsSection.querySelectorAll<HTMLButtonElement>('[data-effort]').forEach((button) => {
    button.addEventListener('click', async () => {
      const effort = button.dataset.effort ?? '';
      if (!effort || settingsState.effort === effort) return;
      try { settingsState = await window.mocodeWork.setSettings({ effort }); }
      catch (error) { console.error('[settings]', error); showToast('error', t('toast.settingsSaveFailed')); return; }
      renderSettingsBehaviorSection();
      const label = EFFORT_ITEMS.find((entry) => entry.value === effort);
      showToast('success', `${t('settings.effortApplied', { value: label ? t(label.labelKey) : effort })}${hasRunning() ? t('settings.restartNote') : ''}`);
    });
  });
}

/* ── 语音输入：本地 ASR（模型 226MB，用户开启后才下载）──────────── */
/** 与主进程 voice/asr.ts 的 MODEL_TOTAL_BYTES 保持一致，只用于展示文案。 */
const VOICE_MODEL_BYTES = 226 * 1024 * 1024 + 316 * 1024;
/** 录音上限。SenseVoice 是非流式整段识别，太长会明显变慢，也给用户一个"忘了停"的兜底。 */
const VOICE_MAX_MS = 60_000;
/** 最近一条下载进度（只在设置页展示，主进程也会在重开设置页时给快照）。 */
let voiceProgress: VoiceProgress | null = null;
/** 录音态：null = 空闲。 */
let voiceRecorder: {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  startedAt: number;
  timer: number;
} | null = null;
let voiceBusy = false;
const micButton = document.querySelector<HTMLButtonElement>('[data-voice-mic]');

/**
 * 语音开关存 localStorage，不进 ~/.mocode/config。
 * 原因：`~/.mocode/config` 的每个键都会被 core 当环境变量读取，voice 是纯 work-app 的
 * UI 偏好；而且 setSettings 会顺带 restartAllAgents()，为一个本地开关重启所有 agent 不合理。
 */
const VOICE_ENABLED_KEY = 'mocode-work-voice-enabled';
function readVoiceEnabled(): boolean {
  try { return localStorage.getItem(VOICE_ENABLED_KEY) === '1'; } catch { return false; }
}
function setVoiceEnabled(enabled: boolean): void {
  settingsState.voice = enabled;
  try { localStorage.setItem(VOICE_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* 忽略 */ }
  if (!enabled && voiceRecorder) void stopVoiceRecording();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** 麦克风按钮只在「开关打开」时出现；状态由 settingsState.voice 决定。 */
function applyVoiceButtonVisibility(): void {
  if (!micButton) return;
  micButton.classList.toggle('hidden', settingsState.voice !== true);
}

/**
 * 把一段外部文本（终端选中的输出）插到输入框光标处：与语音听写同一套插入语义，
 * 区别只是「终端输出多为多行命令/报错」——原样插入，不补空格。
 */
function insertIntoPrompt(text: string): void {
  const value = text.trimEnd();
  if (!value) return;
  const start = promptInput.selectionStart ?? promptInput.value.length;
  const end = promptInput.selectionEnd ?? start;
  const before = promptInput.value.slice(0, start);
  const after = promptInput.value.slice(end);
  // 前后空一行：终端输出多半是代码块，粘在句子里会被当成同一句读。
  const leading = before && !before.endsWith('\n') ? '\n\n' : '';
  const inserted = `${leading}${value}${after ? '\n\n' : ''}`;
  promptInput.value = `${before}${inserted}${after}`;
  const caret = start + inserted.length;
  promptInput.setSelectionRange(caret, caret);
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
  promptInput.focus();
}

/** 把识别结果插到光标处，保留用户已经打了一半的内容。 */
function insertDictation(text: string): void {
  const start = promptInput.selectionStart ?? promptInput.value.length;
  const end = promptInput.selectionEnd ?? start;
  const before = promptInput.value.slice(0, start);
  const after = promptInput.value.slice(end);
  // 中文与英文之间不硬塞空格，但两侧都是英文单词时补一个，避免单词粘在一起。
  const needsSpace = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(text);
  const inserted = `${needsSpace ? ' ' : ''}${text}`;
  promptInput.value = `${before}${inserted}${after}`;
  const caret = start + inserted.length;
  promptInput.setSelectionRange(caret, caret);
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
  promptInput.focus();
}

function setVoiceButtonState(state: 'idle' | 'recording' | 'transcribing'): void {
  if (!micButton) return;
  micButton.classList.toggle('recording', state === 'recording');
  micButton.classList.toggle('transcribing', state === 'transcribing');
  micButton.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
  micButton.title = state === 'recording' ? t('voice.recording') : state === 'transcribing' ? t('voice.transcribing') : t('voice.micTitle');
}

async function stopVoiceRecording(): Promise<void> {
  const recorder = voiceRecorder;
  if (!recorder) return;
  voiceRecorder = null;
  clearTimeout(recorder.timer);
  try { recorder.processor.disconnect(); } catch { /* 已断开 */ }
  try { recorder.source.disconnect(); } catch { /* 已断开 */ }
  recorder.stream.getTracks().forEach((track) => track.stop());
  try { await recorder.ctx.close(); } catch { /* 已关闭 */ }

  const total = recorder.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of recorder.chunks) { samples.set(chunk, offset); offset += chunk.length; }
  if (total === 0) { setVoiceButtonState('idle'); showToast('error', t('voice.errNoAudio')); return; }

  setVoiceButtonState('transcribing');
  voiceBusy = true;
  try {
    const result = await window.mocodeWork.voiceTranscribe({ samples, sampleRate: recorder.ctx.sampleRate || 16000 });
    if (!result.ok) showToast('error', result.message ?? t('voice.errTranscribe'));
    else if (!result.text) showToast('info', t('voice.empty'));
    else insertDictation(result.text);
  } catch (error) {
    console.error('[voice] transcribe', error);
    showToast('error', t('voice.errTranscribe'));
  } finally {
    voiceBusy = false;
    setVoiceButtonState('idle');
  }
}

async function startVoiceRecording(): Promise<void> {
  if (voiceBusy || voiceRecorder) return;
  // 先确认模型就绪：没模型时连麦克风都别开，否则用户说完才看到报错。
  // 注意这里**不自动下载**——226MB 必须由用户在设置页里主动点「下载模型」。
  try {
    const status = await window.mocodeWork.voiceStatus();
    if (!status.ready) {
      showToast('error', t('voice.needModel'));
      openSettings('voice');
      return;
    }
  } catch (error) { console.error('[voice] status', error); return; }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    console.error('[voice] getUserMedia', error);
    showToast('error', t('voice.micDenied'));
    return;
  }

  // 16kHz 直接就是模型要的采样率；部分设备会忽略这个约束，所以真正的采样率从 ctx 读，
  // 交给主进程兜底重采样。
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => {
    // 必须复制：WebAudio 复用同一个 inputBuffer，直接存引用会拿到同一段数据。
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  // ScriptProcessor 需要接到 destination 才会被驱动；接一个静音增益避免真的出声。
  const sink = ctx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(ctx.destination);

  const timer = window.setTimeout(() => {
    void stopVoiceRecording().then(() => showToast('info', t('voice.tooLong', { seconds: String(VOICE_MAX_MS / 1000) })));
  }, VOICE_MAX_MS);

  voiceRecorder = { ctx, stream, source, processor, chunks, startedAt: Date.now(), timer };
  setVoiceButtonState('recording');
}

micButton?.addEventListener('click', () => {
  if (settingsState.voice !== true) { showToast('info', t('voice.off'), 1800); return; }
  if (voiceRecorder) void stopVoiceRecording();
  else void startVoiceRecording();
});

/**
 * 下载前的规格确认。226MB 下载 + 约 350MB 常驻内存（实测 RSS 50MB→348MB）
 * 不是随手就下的东西，所以先摊开要求，用户点「开始下载」才真的开始。
 * 规格文案里的数字都来自实测，改模型时必须同步更新。
 */
function confirmVoiceDownload(): Promise<boolean> {
  const modal = $('#voice-download-modal');
  if (!modal) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (confirmed: boolean) => {
      modal.classList.add('hidden');
      modal.querySelectorAll('[data-voice-download-close]').forEach((el) => el.removeEventListener('click', onClose));
      modal.removeEventListener('click', onBackdrop);
      // keydown 用捕获阶段挂在 modal 上：全局 Esc 监听（closeSettings）在 document 的冒泡
      // 阶段，捕获先跑，stopPropagation 才能真正把它挡住——否则一次 Esc 会连设置页一起关掉。
      modal.removeEventListener('keydown', onKey, true);
      confirmButton?.removeEventListener('click', onConfirm);
      resolve(confirmed);
    };
    const confirmButton = modal.querySelector<HTMLButtonElement>('#voice-download-confirm');
    const onConfirm = () => finish(true);
    const onClose = () => finish(false);
    // 点遮罩就算取消：这个弹窗是「确认才继续」，任何含糊操作都按不下载处理。
    const onBackdrop = (event: MouseEvent) => { if (event.target === modal) finish(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      finish(false);
    };
    confirmButton?.addEventListener('click', onConfirm);
    modal.querySelectorAll('[data-voice-download-close]').forEach((el) => el.addEventListener('click', onClose));
    modal.addEventListener('click', onBackdrop);
    modal.addEventListener('keydown', onKey, true);
    // 规格里的体积用当前模型大小现填，避免文案与 asr.ts 的 MODEL_TOTAL_BYTES 漂移。
    modal.querySelectorAll<HTMLElement>('[data-i18n="voice.specDiskValue"], [data-i18n="voice.specNetworkValue"]').forEach((el) => {
      el.textContent = t(el.dataset.i18n as LocaleKey, { size: formatBytes(VOICE_MODEL_BYTES) });
    });
    modal.classList.remove('hidden');
    confirmButton?.focus();
  });
}

/** 「语音」分类：总开关 + 本地模型下载/删除。 */
async function renderSettingsVoiceSection(): Promise<void> {
  if (!settingsSection) return;
  let status: VoiceStatus = { ready: false, bytes: 0, dir: '', downloading: false };
  try { status = await window.mocodeWork.voiceStatus(); }
  catch (error) { console.error('[voice] status', error); }
  // 模型没下载就不允许开启：顺手把落盘的开关同步关掉，否则麦克风按钮会留在输入框边上，
  // 用户点开只得到一句「模型未就绪」。删除模型后重进设置页也走这条路径收敛。
  if (!status.ready && settingsState.voice === true) {
    setVoiceEnabled(false);
    applyVoiceButtonVisibility();
  }
  const enabled = settingsState.voice === true && status.ready;
  // 下载进度只在「确实在下载」时才有意义；进度本身由 work:voice-progress 推过来，
  // 这里先按主进程快照铺底，之后由订阅回调局部更新（不整页重绘，否则输入焦点会跳）。
  const percent = voiceProgress ? voiceProgress.percent : 0;
  const statusText = status.ready
    ? t('voice.modelReady')
    : status.bytes > 0
      ? t('voice.modelPartial', { size: formatBytes(status.bytes) })
      : t('voice.modelMissing');
  const busy = status.downloading === true;

  settingsSection.innerHTML = `
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('voice.subtitle')}</b></div>
      <div class="settings-list">
        <button class="settings-row settings-toggle" data-setting="voice" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-disabled="${status.ready ? 'false' : 'true'}">
          <span class="settings-row-body"><span class="settings-row-title">${escapeHtml(t('voice.enable'))}</span><span class="settings-row-sub">${escapeHtml(status.ready ? t('voice.enableHint') : t('voice.enableLocked'))}</span></span>
          <span class="settings-switch" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-block-head"><b>${t('voice.model')}</b><span>${escapeHtml(t('voice.modelName'))}</span></div>
      <div class="settings-list">
        <div class="settings-row settings-readonly">
          <span class="settings-row-icon">${icon('layers-compress')}</span>
          <span class="settings-row-body">
            <span class="settings-row-title">${escapeHtml(t('voice.modelHint', { size: formatBytes(VOICE_MODEL_BYTES) }))}</span>
            <span class="settings-row-sub">${escapeHtml(statusText)}${status.ready ? ` · ${escapeHtml(status.dir)}` : ''}</span>
            ${busy
              ? `<span class="settings-progress"><span class="settings-progress-bar" style="width:${percent}%"></span></span>
                 <span class="settings-row-sub" data-voice-progress-label>${escapeHtml(voiceProgress ? t('voice.downloading', { file: voiceProgress.file, percent: String(voiceProgress.percent) }) : t('voice.download'))}</span>`
              : ''}
          </span>
          <span class="settings-row-actions">
            ${busy
              ? `<button class="settings-action" data-voice="cancel">${escapeHtml(t('voice.cancelDownload'))}</button>`
              : status.ready
                ? `<button class="settings-action danger" data-voice="remove">${escapeHtml(t('voice.remove'))}</button>`
                : `<button class="settings-action primary" data-voice="download">${escapeHtml(t('voice.download'))}</button>`}
          </span>
        </div>
      </div>
    </div>
  `;

  settingsSection.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach((button) => {
    button.addEventListener('click', async () => {
      // 模型未下载时开关是锁的：不弹「下载」对话框，只提示并留在当前页，
      // 因为用户此刻是来「开开关」不是来「下模型」，直接弹下载会把焦点抢走。
      if (!status.ready) { showToast('info', t('voice.enableLocked'), 2200); return; }
      // 语音开关是 work-app 自己的 UI 偏好，不能走 setSettings —— 那条路会写进
      // ~/.mocode/config，而那个文件里所有键都是 core 读的环境变量（写进去等于
      // 给 mocode 终端塞一个它不认识的键），且 setSettings 会顺带 restartAllAgents()。
      setVoiceEnabled(settingsState.voice !== true);
      applyVoiceButtonVisibility();
      await renderSettingsVoiceSection();
      showToast('success', settingsState.voice === true ? t('voice.enable') : t('voice.off'), 2000);
    });
  });

  settingsSection.querySelectorAll<HTMLButtonElement>('[data-voice]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.voice;
      if (action === 'download') {
        // 226MB 下载 + 约 350MB 常驻内存，先摊开规格建议让用户判断，确认后才真的开始下。
        if (!(await confirmVoiceDownload())) return;
        button.disabled = true;
        try {
          const result = await window.mocodeWork.voiceDownload();
          if (result.cancelled) { /* 取消不提示，静默重画 */ }
          else if (!result.ok) showToast('error', result.message ?? t('voice.errTranscribe'));
          else showToast('success', t('voice.downloaded'));
        } catch (error) {
          console.error('[voice] download', error);
          showToast('error', t('voice.errTranscribe'));
        }
        await renderSettingsVoiceSection();
        return;
      }
      if (action === 'cancel') {
        await window.mocodeWork.voiceCancelDownload();
        await renderSettingsVoiceSection();
        return;
      }
      if (action === 'remove') {
        const ok = window.confirm(t('voice.removeConfirm', { size: formatBytes(VOICE_MODEL_BYTES) }));
        if (!ok) return;
        try { await window.mocodeWork.voiceRemoveModel(); showToast('success', t('voice.removed')); }
        catch (error) { console.error('[voice] remove', error); }
        await renderSettingsVoiceSection();
      }
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
      <div class="settings-block-head"><b>${getLang() === 'zh-CN' ? '桌面伙伴' : 'Desktop companion'}</b></div>
      <button class="settings-row settings-toggle" data-desktop-pet role="switch" aria-checked="${settingsState.desktopPet === true}">
        <span class="settings-row-body"><span class="settings-row-title">${getLang() === 'zh-CN' ? '3D 桌宠' : '3D desktop companion'}</span><span class="settings-row-sub">${getLang() === 'zh-CN' ? '点身体抱抱，点头摸摸，拖动转圈并移动。随任务进度切换动作，双击查看任务。' : 'Tap its body for a hug, pet its head, or drag to spin and move. Reacts to task progress; double-click to open task.'}</span></span>
        <span class="settings-switch" aria-hidden="true"></span>
      </button>
      <div class="settings-list" role="radiogroup" aria-label="${getLang() === 'zh-CN' ? '选择宠物' : 'Choose companion'}">
        ${PET_CHARACTERS.map(character => {
          const selected = (settingsState.petCharacter || 'byte') === character.id;
          return `<button type="button" class="settings-row${selected ? ' active' : ''}" data-pet-character="${character.id}" role="radio" aria-checked="${selected}">
            <span class="settings-row-radio">${selected ? icon('check') : ''}</span>
            <img src="../assets/pet-portraits/${character.id}.png" alt="" width="48" height="41">
            <span class="settings-row-body"><span class="settings-row-title">${getLang() === 'zh-CN' ? character.name : character.englishName}</span><span class="settings-row-sub">${getLang() === 'zh-CN' ? character.description : character.englishDescription}</span></span>
          </button>`;
        }).join('')}
      </div>
    </div>
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
      <div class="settings-block-head"><b>${t('appearance.session')}</b><span>${t('appearance.sessionHint')}</span></div>
      <div class="settings-list">
        <button class="settings-row settings-toggle" data-clean-run role="switch" aria-checked="${cleanRunMode ? 'true' : 'false'}">
          <span class="settings-row-body"><span class="settings-row-title">${t('appearance.cleanRun')}</span><span class="settings-row-sub">${t('appearance.cleanRunHint')}</span></span>
          <span class="settings-switch" aria-hidden="true"></span>
        </button>
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
  settingsSection.querySelector<HTMLButtonElement>('[data-desktop-pet]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try { settingsState = await window.mocodeWork.setSettings({ desktopPet: settingsState.desktopPet !== true }); renderSettingsAppearanceSection(); }
    catch (error) { button.disabled = false; showToast('error', String(error)); }
  });
  settingsSection.querySelectorAll<HTMLButtonElement>('[data-pet-character]').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { settingsState = await window.mocodeWork.setSettings({petCharacter: button.dataset.petCharacter!}); renderSettingsAppearanceSection(); }
      catch (error) { button.disabled = false; showToast('error', String(error)); }
    });
  });
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
  settingsSection.querySelectorAll<HTMLButtonElement>('[data-clean-run]').forEach((button) => {
    button.addEventListener('click', () => {
      setCleanRun(!cleanRunMode);
      renderSettingsAppearanceSection();
      // 只影响「之后重绘的块」：已经在屏上的历史块保持原样（重排会让视图跳走）。
      // 想让旧块也按新档重画，切一下任务即可 —— 那是显式动作，用户自己按节奏来。
      showToast('success', cleanRunMode ? t('appearance.cleanRunOn') : t('appearance.cleanRunOff'), 2400);
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
  else if (settingsActiveSection === 'voice') await renderSettingsVoiceSection();
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
    // voice 不在主进程的 settings 快照里（它存在 localStorage），整份覆盖后必须补回来，
    // 否则每次重开设置页开关都会显示成关闭状态。
    settingsState.voice = readVoiceEnabled();
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
/* ── Inspector resize (拖拽调面板宽度) ───────────────────
 * 与侧栏同一套交互：拖左沿改宽、双击复位、宽度持久化。
 *
 * 宽度必须写成 CSS 变量而不是 inline width：`.workspace-actions`（右上角工具箱）
 * 的 right 也算 `var(--inspector-width)` —— 只改面板自身宽度的话，面板拖窄后
 * 按钮会浮在面板上。变量挂在 .app-body 上，两者都在它的子树里。
 *
 * 窄屏（@media ≤ 60rem / 40rem）里 .inspector 有自己的固定宽度，媒体查询会赢，
 * 用户拖出来的值在窄屏不生效，这是刻意的：窄屏本来就该铺满。
 */
const INSPECTOR_WIDTH_KEY = 'mocode-work-inspector-width';
const INSPECTOR_MIN = 260;
const INSPECTOR_MAX = 720;
const INSPECTOR_DEFAULT = 340;
/** 会话区至少留这么宽，面板不能把正文挤没。 */
const CONVERSATION_MIN = 320;
const inspectorResize = $('#inspector-resize') as HTMLElement | null;
function clampInspectorWidth(width: number): number {
  const workspace = inspector?.parentElement;
  const available = workspace ? workspace.clientWidth - CONVERSATION_MIN : INSPECTOR_MAX;
  const max = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, available));
  return Math.round(Math.max(INSPECTOR_MIN, Math.min(max, width)));
}
function applyInspectorWidth(width: number): void {
  if (!appBody) return;
  appBody.style.setProperty('--inspector-width', `${clampInspectorWidth(width)}px`);
}
function getSavedInspectorWidth(): number {
  try {
    const raw = localStorage.getItem(INSPECTOR_WIDTH_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return clampInspectorWidth(n);
    }
  } catch { /* 忽略 */ }
  return INSPECTOR_DEFAULT;
}
function saveInspectorWidth(width: number): void {
  try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width)); } catch { /* 忽略 */ }
}
applyInspectorWidth(getSavedInspectorWidth());
if (inspectorResize) {
  let resizing = false;
  let startX = 0;
  let startWidth = INSPECTOR_DEFAULT;
  inspectorResize.addEventListener('pointerdown', (event) => {
    resizing = true;
    startX = event.clientX;
    startWidth = inspector?.offsetWidth ?? INSPECTOR_DEFAULT;
    try { inspectorResize.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    document.body.classList.add('inspector-resizing');
    event.preventDefault();
  });
  inspectorResize.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    // 往左拖 = 变宽，所以 delta 取反。
    applyInspectorWidth(startWidth - (event.clientX - startX));
  });
  const endResize = (event: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    try { inspectorResize.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
    document.body.classList.remove('inspector-resizing');
    if (inspector) saveInspectorWidth(inspector.offsetWidth);
  };
  inspectorResize.addEventListener('pointerup', endResize);
  inspectorResize.addEventListener('pointercancel', endResize);
  inspectorResize.addEventListener('dblclick', () => {
    applyInspectorWidth(INSPECTOR_DEFAULT);
    saveInspectorWidth(INSPECTOR_DEFAULT);
  });
}
// 窗口变窄后旧宽度可能把正文挤没：只收紧，不放大用户的偏好。
window.addEventListener('resize', () => { applyInspectorWidth(getSavedInspectorWidth()); });
/* ── Model picker ─────────────────────────────────────── */
let modelPickerEl: HTMLElement | null = null;
let modelList: ModelItem[] = [];
let modelHoverEl: HTMLElement | null = null;
let modelHoverName: string | null = null;
let modelHoverPreset: ModelPresetDetail | null = null;
let modelHoverAnchor: HTMLElement | null = null;
let modelHoverEffort: EffortValue = 'auto';
let modelHoverGeneration = 0;
let modelHoverSaving = false;
/** change 与 click 同一次操作可能各触发一次保存：合并到同一条写入链，禁止旧回包覆盖新选择。 */
let modelHoverSaveQueue: Promise<void> = Promise.resolve();
let modelHoverOpenTimer: ReturnType<typeof setTimeout> | undefined;
let modelHoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
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
  const active = modelList.find((item) => item.isActive && item.label === config.model);
  const effortBadge = active && active.reasoningEffort !== 'auto'
    ? `<span class="model-picker-effort">${escapeHtml(effortLabel(active.reasoningEffort))}</span>`
    : '';
  button.innerHTML = `<span class="mode-label">${escapeHtml(label)}</span>${effortBadge}${cacheBadge}<svg class="icon icon-inline" data-icon="chevron-down"></svg>`;
  mountIcons(button);
  const detail = [
    config.model ? `${t('modelDetail.alias')}: ${config.model}` : null,
    config.label && config.label !== config.model ? `${t('settings.model')}: ${config.label}` : null,
    `${t('modelDetail.protocol')}: ${config.provider}`,
    config.provider === 'anthropic' ? t('toast.promptCache', { details: config.promptCache ? 'on' : 'off' }) : null,
    config.baseUrl ? `API: ${config.baseUrl}` : null,
    config.contextWindow ? `${t('modelDetail.context')}: ${(config.contextWindow / 1000).toFixed(0)}k tokens` : null,
    active ? `${t('modelForm.reasoning')}: ${effortLabel(active.reasoningEffort)}` : null,
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
  if (lastModelConfig) setModeButton(lastModelConfig);
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
    `<span class="model-picker-effort ${model.reasoningEffort === 'auto' ? 'hidden' : ''}">${model.reasoningEffort === 'auto' ? '' : escapeHtml(effortLabel(model.reasoningEffort))}</span>`,
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
  hideModelHover();
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
    button.addEventListener('pointerenter', () => {
      const name = button.dataset.model;
      if (name) scheduleModelHoverOpen(name, button);
    });
    button.addEventListener('pointerleave', scheduleModelHoverClose);
    button.addEventListener('focusin', () => {
      const name = button.dataset.model;
      if (name) scheduleModelHoverOpen(name, button);
    });
    button.addEventListener('focusout', scheduleModelHoverClose);
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

/* ── 模型行的悬停控制页 ───────────────────────────────────
 * 350ms 打开、200ms 关闭。控制页与模型行并列展开，而不是在狭窄下拉里展开，
 * 这样鼠标可以跨过去输入；打开/保存期间重新 hover 或切模型会作废旧 IPC 回包。
 */
const MODEL_HOVER_OPEN_MS = 350;
const MODEL_HOVER_CLOSE_MS = 200;

function ensureModelHover(): HTMLElement {
  if (modelHoverEl) return modelHoverEl;
  const el = $('#model-hover-panel') as HTMLElement;
  modelHoverEl = el;
  el.addEventListener('pointerenter', () => {
    if (modelHoverCloseTimer !== undefined) { clearTimeout(modelHoverCloseTimer); modelHoverCloseTimer = undefined; }
  });
  el.addEventListener('pointerleave', scheduleModelHoverClose);
  el.addEventListener('focusin', () => {
    if (modelHoverCloseTimer !== undefined) { clearTimeout(modelHoverCloseTimer); modelHoverCloseTimer = undefined; }
  });
  el.addEventListener('focusout', () => {
    if (!el.contains(document.activeElement)) scheduleModelHoverClose();
  });
  el.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.matches('[data-hover-max-tokens]') || !modelHoverPreset) return;
    const raw = input.value.trim();
    const capability = reasoningCapabilityForPreset({ ...modelHoverPreset, maxTokens: raw ? Number(raw) : undefined });
    if (modelHoverEffort !== 'auto' && !capability.supportedEfforts.includes(modelHoverEffort)) {
      modelHoverEffort = 'auto';
      el.querySelectorAll<HTMLButtonElement>('[data-effort]').forEach((option) => {
        option.setAttribute('aria-pressed', String(option.dataset.effort === 'auto'));
      });
    }
    syncModelHoverControls();
  });
  el.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.matches('[data-hover-window], [data-hover-max-tokens]')) void saveModelHover();
  });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.target as HTMLElement).matches('input')) {
      event.preventDefault();
      void saveModelHover();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideModelHover();
      $('#mode-button')?.focus();
    }
  });
  el.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-effort]');
    if (!button || button.disabled || !modelHoverPreset) return;
    modelHoverEffort = (button.dataset.effort ?? 'auto') as EffortValue;
    el.querySelectorAll<HTMLButtonElement>('[data-effort]').forEach((option) => {
      option.setAttribute('aria-pressed', String(option.dataset.effort === modelHoverEffort));
    });
    const hint = el.querySelector<HTMLElement>('[data-hover-reasoning-hint]');
    if (hint) hint.textContent = reasoningHelpText(reasoningCapabilityForPreset(modelHoverPreset), modelHoverEffort);
    void saveModelHover();
  });
  return el;
}

function clearModelHoverTimers(): void {
  if (modelHoverOpenTimer !== undefined) { clearTimeout(modelHoverOpenTimer); modelHoverOpenTimer = undefined; }
  if (modelHoverCloseTimer !== undefined) { clearTimeout(modelHoverCloseTimer); modelHoverCloseTimer = undefined; }
}

function scheduleModelHoverOpen(name: string, anchor: HTMLElement): void {
  if (modelHoverCloseTimer !== undefined) { clearTimeout(modelHoverCloseTimer); modelHoverCloseTimer = undefined; }
  if (modelHoverName === name && modelHoverEl && !modelHoverEl.classList.contains('hidden')) return;
  if (modelHoverOpenTimer !== undefined) clearTimeout(modelHoverOpenTimer);
  modelHoverOpenTimer = setTimeout(() => {
    modelHoverOpenTimer = undefined;
    void openModelHover(name, anchor);
  }, MODEL_HOVER_OPEN_MS);
}

function scheduleModelHoverClose(): void {
  if (modelHoverOpenTimer !== undefined) { clearTimeout(modelHoverOpenTimer); modelHoverOpenTimer = undefined; }
  if (modelHoverCloseTimer !== undefined) clearTimeout(modelHoverCloseTimer);
  modelHoverCloseTimer = setTimeout(() => {
    modelHoverCloseTimer = undefined;
    // Tab 从模型行进入控制页时，pointerleave/focusout 已排了关闭；不能在焦点落稳前把输入框删掉。
    if (modelHoverEl?.contains(document.activeElement)) return;
    hideModelHover();
  }, MODEL_HOVER_CLOSE_MS);
}

function hideModelHover(): void {
  clearModelHoverTimers();
  modelHoverGeneration += 1;
  modelHoverName = null;
  modelHoverPreset = null;
  modelHoverAnchor = null;
  modelHoverSaving = false;
  modelHoverEl?.classList.add('hidden');
}

function syncModelHoverControls(): void {
  const rawMaxTokens = modelHoverEl?.querySelector<HTMLInputElement>('[data-hover-max-tokens]')?.value.trim();
  const capability = modelHoverPreset ? reasoningCapabilityForPreset({
    ...modelHoverPreset,
    maxTokens: rawMaxTokens ? Number(rawMaxTokens) : undefined,
  }) : null;
  modelHoverEl?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
    const effort = control.dataset.effort as EffortValue | undefined;
    // 保存期间仍接受新的输入/档位；saveModelHover 会把最新草稿排到写入链末尾。
    // 加载阶段面板里还没有控件，因此不需要再用 modelHoverSaving 禁用整页。
    control.disabled = !!effort && effort !== 'auto' && !capability?.supportedEfforts.includes(effort);
  });
  const hint = modelHoverEl?.querySelector<HTMLElement>('[data-hover-reasoning-hint]');
  if (hint && capability) hint.textContent = reasoningHelpText(capability, modelHoverEffort);
}

function modelHoverStatus(message = '', error = false): void {
  const status = modelHoverEl?.querySelector<HTMLElement>('[data-hover-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', error);
}

function positionModelHover(): void {
  const el = modelHoverEl;
  const anchor = modelHoverAnchor;
  const picker = modelPickerEl;
  if (!el || !anchor || !picker) return;
  // 下拉滚动时按钮的 rect 会更新；控制页跟随原模型行，而不是悬在旧位置。
  if (!anchor.isConnected || !picker.contains(anchor)) return;
  const rect = anchor.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const panelRect = el.getBoundingClientRect();
  // 默认在右侧展开，像常见模型选择器；右侧放不下才换到左侧。
  const rightX = pickerRect.right + 8;
  const x = rightX + panelRect.width <= window.innerWidth - 8
    ? rightX
    : Math.max(8, pickerRect.left - panelRect.width - 8);
  const y = Math.max(8, Math.min(window.innerHeight - panelRect.height - 8, rect.top - 4));
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${y}px`;
}

async function openModelHover(name: string, anchor: HTMLElement): Promise<void> {
  if (modelPickerEl?.classList.contains('hidden')) return;
  const generation = ++modelHoverGeneration;
  const el = ensureModelHover();
  modelHoverName = name;
  modelHoverAnchor = anchor;
  modelHoverPreset = null;
  modelHoverSaving = true;
  const item = modelList.find((model) => model.name === name);
  el.innerHTML = `
    <div class="model-hover-head"><span class="model-hover-title">${escapeHtml(item?.label ?? name)}</span><span class="model-hover-provider">${escapeHtml(item?.providerHost ?? '')}</span></div>
    <div class="model-hover-status" data-hover-status>${t('modelForm.hoverSaving')}</div>`;
  el.classList.remove('hidden');
  positionModelHover();
  try {
    // 同一模型保存途中重新打开时，必须先等写入完成再回读；否则新面板会拿到旧预设，
    // 下一次只改档位也会把旧的上下文/输出上限一并写回，覆盖刚保存的值。
    await modelHoverSaveQueue;
    if (generation !== modelHoverGeneration || modelHoverName !== name) return;
    const detail = await window.mocodeWork.getModel(name);
    if (generation !== modelHoverGeneration || modelHoverName !== name) return;
    if (!detail.ok || !detail.preset) throw new Error(detail.message ?? t('modelForm.errorRead', { name }));
    modelHoverPreset = detail.preset;
    modelHoverEffort = detail.preset.reasoningEffort ?? 'auto';
    const capability = detail.reasoning ?? reasoningCapabilityForPreset(detail.preset);
    el.innerHTML = `
      <div class="model-hover-head"><span class="model-hover-title">${escapeHtml(detail.preset.model)}</span><span class="model-hover-provider">${escapeHtml(item?.providerHost ?? detail.preset.provider)}</span></div>
      <div class="model-hover-grid">
        <label class="model-hover-field"><span>${t('modelForm.contextWindow')} · tokens</span><input class="model-hover-input" data-hover-window type="number" min="1" step="1000" value="${detail.preset.contextWindow}" /></label>
        <label class="model-hover-field"><span>${t('modelForm.maxTokens')} · tokens</span><input class="model-hover-input" data-hover-max-tokens type="number" min="1" step="1000" value="${detail.preset.maxTokens ?? ''}" /></label>
      </div>
      <div class="model-hover-section"><div class="model-hover-section-head"><span>${t('modelForm.reasoning')}</span><span>${escapeHtml(detail.preset.name)}</span></div>
        <div class="effort-segmented" role="group" aria-label="${t('modelForm.reasoning')}">${effortOptionsHtml(capability, modelHoverEffort)}</div>
        <p class="model-hover-hint" data-hover-reasoning-hint>${escapeHtml(reasoningHelpText(capability, modelHoverEffort))}</p>
      </div>
      <p class="model-hover-hint">${t('modelForm.hoverHint')}</p>
      <div class="model-hover-status" data-hover-status aria-live="polite"></div>`;
    modelHoverSaving = false;
    syncModelHoverControls();
    positionModelHover();
  } catch (error) {
    if (generation !== modelHoverGeneration) return;
    modelHoverSaving = false;
    modelHoverStatus((error as Error).message, true);
  }
}

interface ModelHoverSaveRequest {
  name: string;
  draft: WorkPresetDraft;
  /** 用于判定回包能否更新当前控制页，不用于决定写哪个模型。 */
  generation: number;
}

function saveModelHover(): Promise<void> {
  const name = modelHoverName;
  const preset = modelHoverPreset;
  const el = modelHoverEl;
  if (!name || !preset || !el) return Promise.resolve();
  const contextWindow = Number(el.querySelector<HTMLInputElement>('[data-hover-window]')?.value);
  const rawMaxTokens = el.querySelector<HTMLInputElement>('[data-hover-max-tokens]')?.value.trim() ?? '';
  const maxTokens = rawMaxTokens ? Number(rawMaxTokens) : undefined;
  const effort = modelHoverEffort;
  const capability = reasoningCapabilityForPreset({ ...preset, maxTokens });
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    modelHoverStatus(t('modelForm.errorWindow'), true);
    return Promise.resolve();
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    modelHoverStatus(t('modelForm.errorMaxTokens'), true);
    return Promise.resolve();
  }
  if (effort !== 'auto' && !capability.supportedEfforts.includes(effort)) {
    modelHoverStatus(t('modelForm.errorEffortUnsupported'), true);
    return Promise.resolve();
  }
  // 入队时就冻结名称与草稿。之后 hover 到 B / 关闭面板都不能让 A 的待写操作变成写 B。
  // 是否刷新运行配置由主进程按保存执行时的 .active 决定，不能相信打开面板时的激活状态。
  const request: ModelHoverSaveRequest = {
    name,
    draft: { ...preset, contextWindow, maxTokens, reasoningEffort: effort },
    generation: ++modelHoverGeneration,
  };
  const run = modelHoverSaveQueue.then(() => saveModelHoverNow(request));
  modelHoverSaveQueue = run.catch(() => { /* 单个请求失败不阻断后续保存 */ });
  return run;
}

async function saveModelHoverNow(request: ModelHoverSaveRequest): Promise<void> {
  const { name, draft } = request;
  const visible = modelHoverName === name && modelHoverGeneration === request.generation;
  if (visible) {
    modelHoverSaving = true;
    modelHoverStatus(t('modelForm.hoverSaving'));
    syncModelHoverControls();
  }
  try {
    const result = await window.mocodeWork.saveModel({ name, draft, activate: false });
    if (!result.ok) throw new Error(result.message);
    if (visible && modelHoverName === name && modelHoverGeneration === request.generation) {
      modelHoverPreset = { ...modelHoverPreset!, ...draft };
      modelHoverSaving = false;
      syncModelHoverControls();
      modelHoverStatus(t('modelForm.hoverSaved'));
    }
    await refreshModelList();
    const current = modelList.find((model) => model.name === name);
    if (current) {
      const effort = draft.reasoningEffort ?? 'auto';
      const contextBadge = modelPickerEl?.querySelector<HTMLElement>(`[data-model="${CSS.escape(name)}"] .model-picker-ctx`);
      if (contextBadge) contextBadge.textContent = `${(draft.contextWindow / 1000).toFixed(0)}k ${t('modelDetail.context')}`;
      const badge = modelPickerEl?.querySelector<HTMLElement>(`[data-model="${CSS.escape(name)}"] .model-picker-effort`);
      if (badge) {
        badge.textContent = effort === 'auto' ? '' : effortLabel(effort);
        badge.classList.toggle('hidden', effort === 'auto');
      }
      try { setModeButton(await window.mocodeWork.getConfig()); } catch { /* 配置查询失败不撤回已保存的预设 */ }
    }
  } catch (error) {
    if (visible && modelHoverName === name && modelHoverGeneration === request.generation) {
      modelHoverSaving = false;
      syncModelHoverControls();
      modelHoverStatus((error as Error).message, true);
    } else {
      showToast('error', (error as Error).message);
    }
  }
}

function presetIsActive(name: string): boolean {
  return modelList.some((model) => model.name === name && model.isActive);
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
  hideModelHover();
  const el = ensureModelPicker();
  el.classList.remove('hidden');
  positionModelPicker();
  $('#mode-button')?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => el.classList.add('model-picker-in'));
}
function hideModelPicker(): void {
  hideModelHover();
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
  if (modelHoverEl?.contains(target)) return;
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

// 语音：恢复开关状态（localStorage，不进 ~/.mocode/config）+ 订阅下载进度。
// 注意这里**不做任何下载**：模型只在用户于设置页显式点「下载模型」时才拉，
// 开启开关本身不会产生网络请求。
setVoiceEnabled(readVoiceEnabled());
applyVoiceButtonVisibility();
window.mocodeWork.onVoiceProgress((progress) => {
  voiceProgress = progress;
  // 只在设置页停在「语音」分类时局部刷新进度，避免整页重绘抢走焦点。
  if (!settingsModal?.classList.contains('hidden') && settingsActiveSection === 'voice') {
    const bar = settingsSection?.querySelector<HTMLElement>('.settings-progress-bar');
    if (bar) bar.style.width = `${progress.percent}%`;
    const label = settingsSection?.querySelector<HTMLElement>('[data-voice-progress-label]');
    if (label) label.textContent = t('voice.downloading', { file: progress.file, percent: String(progress.percent) });
  }
});
/**
 * 发送 / 停止是**两个不同动作**，共用一枚按钮但语义分开：
 *   - 任务正在跑 → 按钮显示方框，点击 = 取消这一轮（有输入时点击或 Enter 追加到当前任务，见 submit）；
 *   - 空闲 → 点击 = 发送。
 * 以前两条路径都落到 submit()，导致「想接着说一句」直接掐掉正在跑的活。
 */
sendButton.addEventListener('click', () => {
  const viewing = viewingTaskId();
  if (isRunning(viewing) && !promptInput.value.trim() && !attachments.length) { window.mocodeWork.send({ type: 'cancel', id: viewing }); return; }
  void submit();
});
promptInput.addEventListener('input', resizePrompt);
promptInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } });
window.addEventListener('resize', () => {
  hideModelHover();
  if (modelPickerEl && !modelPickerEl.classList.contains('hidden')) positionModelPicker();
  positionToolsMenu();
});
window.addEventListener('keydown', (event) => {
  const cmd = event.ctrlKey || event.metaKey;
  // ? 打开 cheatsheet(Shift + / 在大多数键盘上是 ?)
  // 注意判空:cheatsheetEl 首次按下时还是 null,写成 `cheatsheetEl?.classList.contains('hidden')`
  // 会得到 undefined 从而走 else 的 hideCheatsheet() —— 「第一次按 ? 没反应」。
  if (event.key === '?' && !(event.target instanceof HTMLElement && (event.target.matches('input, textarea') || event.target.isContentEditable))) { event.preventDefault(); if (!cheatsheetEl || cheatsheetEl.classList.contains('hidden')) showCheatsheet(); else hideCheatsheet(); return; }
  if (event.key === 'Escape') {
    // ⚠ 判空必须写成 `X && !X.classList.contains(...)`,不能用 `X?.classList.contains(...)`:
    //   三个浮层都是懒建的,首次按 Esc 时变量还是 null,可选链求值得 undefined(falsy)
    //   → 全部跳过 → 落到最后一行,连当时开着的 search-panel 也关不掉(实测踩过)。
    if (cheatsheetEl && !cheatsheetEl.classList.contains('hidden')) { hideCheatsheet(); return; }
    if (searchOverlay && !searchOverlay.classList.contains('hidden')) { closeConvSearch(); return; }
    if (modelPickerEl && !modelPickerEl.classList.contains('hidden')) { hideModelPicker(); return; }
    const toolsMenu = $('#tools-menu');
    if (toolsMenu && !toolsMenu.classList.contains('hidden')) { toolsMenu.classList.add('hidden'); $('#show-tools').setAttribute('aria-expanded', 'false'); return; }
    if (!searchPanel.classList.contains('hidden')) { searchPanel.classList.add('hidden'); return; }
    if (!approvalPanel.classList.contains('hidden')) { approvalPanel.classList.add('hidden'); return; }
    // 快捷键面板里 Esc 那行写的是「关闭弹窗 / 取消输入焦点」——后半句此前没有实现
    // (全仓没有任何 blur() 调用)。没有浮层可关时,把焦点还给正文。
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.matches('input, textarea') || active.isContentEditable)) active.blur();
    return;
  }
  if (cmd && event.key.toLowerCase() === 'k') { event.preventDefault(); searchPanel.classList.remove('hidden'); searchInput.value = ''; searchInput.focus(); refreshSearch(); return; }
  if (cmd && event.key.toLowerCase() === '/') {
    event.preventDefault();
    // 原来这里只弹一句「助手模式: MoCode Agent(暂未开放多模型切换)」—— 那是多模型切换
    // 还没做时的占位。现在模型选择器已经是真功能,这条快捷键就该真去开它,
    // 否则快捷键面板里那行是空壳(用户报过「这些快捷键都是空壳」)。
    const picker = ensureModelPicker();
    if (!picker.classList.contains('hidden')) { hideModelPicker(); return; }
    hideWorkspacePicker();
    void refreshModelList().then(() => { renderModelPicker(); showModelPicker(); });
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
// 标题栏徽章 → 跳到「最久等待」的那个任务并把审批卡摆出来。
// 主进程的系统通知被点击时也走同一条路径（见 handleAgentEvent 的 attention_open）。
attentionBadge.addEventListener('click', () => { void jumpToPendingTask(); });
void window.mocodeWork.getState().then((next) => {
  updateState(next);
  // 进程重启后不仅恢复侧栏选中态，也立即恢复该任务的可见输出与工具调用。
  if (next.selectedTaskId) void openTask(next.selectedTaskId);
});

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
  const currentId = task ? task.projectId : (state?.selectedProjectId ?? '');
  const fixed = chipTaskFixed();
  // 有任务时选中它的归属；没有任务时选中浏览上下文，点击即切换 SCM 所属空间。
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
      if (!chipTask()) {
        updateState(await window.mocodeWork.selectProject(id));
        showToast('success', t('toast.switchedProject', { name: project?.name ?? id }));
        return;
      }
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

// 启动即把**保存的主题**推给主进程，再对一次 titlebar overlay 的符号色。
// 窗口的明暗状态（原生最小化/最大化/关闭按钮的 hover 高亮、窗口底色）由主进程的
// nativeTheme.themeSource 决定，它默认停在 'system'；而应用主题存在 localStorage，原先
// 只有用户手动切主题时才经 work:set-theme 同步过去。于是系统浅色 + 应用深色时，按钮的
// hover 高亮按浅色算（近黑半透明），压在深色标题栏上完全看不见，切一次主题才对齐。
syncTitleBarOverlay();
window.mocodeWork.setTheme(currentSavedTheme());
