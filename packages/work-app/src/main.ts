import { isPetCharacter, normalizePetCharacter, type PetCharacterId } from './pet-characters.js';
import { DesktopPet } from './desktop-pet.js';
import { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, nativeTheme, screen, session as electronSession, shell, type MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  EFFORT_VALUES,
  normalizeWorkPresetDraft,
  readWorkPreset,
  reasoningCapabilityForPreset,
  writeWorkPreset,
  type EffortValue,
  type ReasoningCapability,
  type WorkPresetDraft,
  type WorkPresetFile,
} from './model-config.js';
import { ATTACHMENT_EXTENSIONS, configureAttachmentModulePath, historyAttachments, readAttachment } from './attachments.js';
// 计划解析与渲染层共用同一份（renderer 走 ../plan.js），否则侧栏的 n/m 与面板会对不上。
import { parsePlan } from './plan.js';
// 右键菜单的「弹哪些项」是纯决策，抽成纯函数便于单测（Menu 在无头环境造不出来）。
import { contextMenuPlan } from './context-menu.js';
import { truncateSessionAfterUser, truncateSessionAtUser, type RawSessionRecord } from './truncate-session.js';
import { clampToWorkArea } from './window-fit.js';
import { compactRecoveryLogs, deleteRecoveryLog, readRecoveryAsync, recoveryLog, type RecoveryAttachment, type RecoveryEnvelope, type RecoveryLog } from './recovery-log.js';
import { compactedHistorySummary, type HistoryItem } from './transcript-view.js';
import { tMain } from './i18n/main.js';
// 浏览器面板的分区名由主进程与渲染层共用，见 browser-panel.ts。
import { panelPartitionFor } from './browser-panel.js';
import { BrowserHost, denySessionPermissions, validatePanelUrl } from './browser-host.js';
import { TerminalHost } from './terminal-host.js';
import {
  cancelVoiceDownload,
  downloadVoiceModel,
  isDownloading,
  removeVoiceModel,
  transcribe,
  voiceModelStatus,
  warmUpRecognizer,
  type VoiceDownloadProgress,
} from './voice/asr.js';
import { SESSION_DIR_RE, countProjectSessions, isNoiseWorkspace, listProjectSessions, readSessionHistory, readWorkspaceRegistry, sessionLastActiveAt } from './workspace-sync.js';
// 侧栏排序键的对账规则（纯函数）：修复历史上被写成 now 的 updatedAt。
import { planSortKeyRepair } from './task-order.js';
// 「点了 + 但一句话都没发」的空草稿判定（纯函数）：选中项离开它就丢弃，见 discardEmptyDrafts。
import { discardableDraftIds } from './task-draft.js';
import {
  deleteMcpServer,
  deleteSkill,
  importMcpJson,
  importSkillsFromFolder,
  importSkillsFromZip,
  installFromMarket,
  listInstalledSkills,
  listMcpServers,
  loadSkillMarket,
  mcpConfigPath,
  openSkillFolder,
  saveMcpServer,
  toggleMcpServer,
} from './extensions.js';
import {
  buildCatalogPick,
  catalogSnapshotPath,
  flattenSupportedEntries,
  filterEntries,
  hasCatalogSnapshot,
  readCatalogSnapshot,
  refreshCatalog,
} from './catalog.js';
import {
  AgentHostClient,
  resolveMocodeHostLaunchSpec,
  type HostCommand,
  type HostEnvelope,
} from '@mocode/runtime/host';
import { isUserConfigEnvKey } from '@mocode/protocol';
import { commitStaged, gitCommitFile, gitCommitFiles, gitDiff, gitFileDiff, gitFileStats, gitLog, gitRepos, gitStatus, stageFiles, stagedDiff, unstageFiles, validateRepoRoot } from './git.js';
import { buildCheckGroups, parsePackage, workspaceDirs } from './checks.js';
import { readGlobalUsage, summarizeGlobalUsage, summarizeSessionUsage } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 开发环境从 workspace/root node_modules 解析；安装版只读随包发布的独立资源目录。
if (app.isPackaged) configureAttachmentModulePath(path.join(process.resourcesPath, 'mocode-ai'));
/**
 * 不进文件树的目录：依赖、构建产物、缓存。
 * `target` 是 Cargo/Maven/Gradle 的产物目录（mocode 仓库里它一家就占 7200 个 .o/.rlib，
 * 不排除的话会把真实源码挤出列表——用户报「文件缺少」的真正大头）；`dist-tests` 同 `dist`，
 * 是 tsc 测试编译的输出。
 */
const IGNORED_DIRECTORIES = new Set(['.git', '.mocode', 'node_modules', 'dist', 'dist-tests', 'target', 'coverage', '.next', '.cache']);

/**
 * 复用 mocode 已配好的模型 / 沙箱 / 记忆 / 主题等配置。
 * 与 src/config/index.ts 的 loadEnvFiles() 行为一致:
 *   候选(后者覆盖前者,优先级升序):<projectRoot>/.env(兼容旧用法,最低)
 *     → ~/.mocode/config(全局,/model 与 mocode config 写此)
 *     → <projectRoot>/.mocode/config(项目级覆盖,最高)。
 * shell 里 export 的同名键不被回填(/model 写文件的优先级语义与 REPL 一致)。
 *
 * 过滤规则来自 @mocode/protocol 的 USER_CONFIG_ENV_KEYS —— 与 core 读取的 106 个键逐一对齐。
 * 此前这里是本文件内一份 30 键白名单,导致 MEMORY_ENABLED 之外的记忆子开关、
 * MOCODE_COMPUTER_USE_ENABLED / MOCODE_FRONTEND_TOOLS_ENABLED / MOCODE_REQUEST_MAX_KB /
 * MOCODE_ROUTER_* / HTTP(S)_PROXY 等写进配置文件后在 GUI 里完全不生效。
 * 白名单仍保留（不做「全部回填」）：一个 work-app 进程服务多个项目空间，
 * 不能把项目 A 的任意 .env 键漏给项目 B 的 host，也不能让它们被 run_command 子进程继承。
 */
function loadMocodeConfig(projectRoot?: string): { loaded: string[]; missing: string[] } {
  const candidates: string[] = [];
  if (projectRoot) candidates.push(path.join(projectRoot, '.env'));
  candidates.push(path.join(os.homedir(), '.mocode', 'config'));
  if (projectRoot) candidates.push(path.join(projectRoot, '.mocode', 'config'));
  const fromFiles: Record<string, string> = {};
  for (const p of candidates) {
    try { Object.assign(fromFiles, dotenv.parse(readFileSync(p, 'utf8'))); } catch { /* 文件不存在:跳过 */ }
  }
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(fromFiles)) {
    if (!isUserConfigEnvKey(k)) continue;
    if (process.env[k] === undefined) { process.env[k] = v; loaded.push(k); }
  }
  const missing: string[] = [];
  if (!process.env.LLM_BASE_URL) missing.push('LLM_BASE_URL');
  if (!process.env.LLM_API_KEY) missing.push('LLM_API_KEY');
  return { loaded, missing };
}

type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface Project {
  id: string; name: string; root: string; branch: string;
  /**
   * true = 由全局工作空间注册表（~/.mocode/workspaces.jsonl）自动并入的空间，
   * 不是用户手动「添加项目」加进来的。手动加的空间为 undefined/false。
   */
  auto?: boolean;
  /** 该工作空间 `.mocode/sessions` 下的会话目录数（登记表统计口径，best-effort）。 */
  sessionCount?: number;
}
interface TaskRecord {
  // projectId 为空字符串 = 普通任务（不加入任何空间 / 项目文件夹），agent 在 scratch 目录运行
  id: string; projectId: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string;
  sessionId?: string; changedFiles: string[]; lastError?: string;
  /**
   * 最新一份执行计划的进度（由 plan_update 事件写入，见 updateTaskFromAgent）。
   * 只存侧栏一行需要的数字：完整步骤清单在会话区顶部的计划面板里，不进状态文件
   * （否则每步更新都要重写并广播整个 state）。
   */
  plan?: TaskPlanProgress;
}
/** 侧栏任务行显示的计划进度。 */
interface TaskPlanProgress {
  title: string;
  done: number;
  total: number;
  allDone: boolean;
}
interface StoredState {
  version: 1; projects: Project[]; selectedProjectId: string; tasks: TaskRecord[]; selectedTaskId?: string;
  /**
   * 用户显式移除过的「自动并入」空间（project id）。没有它的话，
   * `remove-project` 删掉的空间下次启动会被注册表同步又加回来。
   */
  hiddenProjects?: string[];
}
interface CommandResult { ok: boolean; stdout: string; stderr: string; }

/**
 * 应用内浏览器面板与 agent 共用同一个真浏览器：面板是主进程持有的 WebContentsView，
 * agent 通过 CDP（connectOverCDP）接管同一个视图（见 browser-host.ts 顶部说明）。
 * 端口交给 Chromium 自己挑（`--remote-debugging-port=0`），实际端口它写进 userData 下的
 * DevToolsActivePort —— 固定端口会和用户已有的 Chrome 调试实例/其它工具撞车。
 */
let browserCdpUrl: string | null = null;
// 必须在 app ready 之前追加：ready 后再设这个 switch 不生效。
app.commandLine.appendSwitch('remote-debugging-port', '0');

/** 等 Chromium 把真实调试端口写入 DevToolsActivePort（首行是端口，第二行是 ws 路径）。 */
async function resolveBrowserCdpUrl(timeoutMs = 5_000): Promise<string | null> {
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
    } catch { /* 还没写出来：继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

/** 面板网页的权限一律拒绝：agent 可能打开任意站点，不能顺带拿到定位/通知/摄像头。 */
function denyPanelPermissions(projectId: string | undefined): void {
  denySessionPermissions(electronSession.fromPartition(panelPartitionFor(projectId)));
}

/**
 * 浏览器面板的原生视图宿主。窗口重建时随之重建（视图挂在 window.contentView 上），
 * 所以只保留一个引用 + 一个惰性 getter。
 */
let browserHost: BrowserHost | null = null;
function browserHostFor(): BrowserHost {
  if (browserHost) return browserHost;
  browserHost = new BrowserHost(
    () => windowRef,
    (viewState) => pushRenderer('work:browser-state', viewState),
  );
  return browserHost;
}

/**
 * 终端面板的 PTY 宿主。会话按空间缓存（同一空间来回切面板不重开 shell），
 * cwd 恒为该空间的根目录 —— 与 agent 的 run_command 起点一致。
 *
 * 只在主进程：node-pty 是原生模块，渲染进程开着 contextIsolation + sandbox，
 * 不该也不能 require 它。
 */
let terminalHost: TerminalHost | null = null;
function terminalHostFor(): TerminalHost {
  if (terminalHost) return terminalHost;
  terminalHost = new TerminalHost((projectId) => {
    // 空 projectId = 纯任务，落到 scratch（与 agent 的独立任务同一处）。
    if (!projectId) return scratchProject().root;
    return state.projects.find((item) => item.id === projectId)?.root ?? null;
  });
  terminalHost.on('data', (payload: { projectId: string; chunk: string }) => pushRenderer('work:terminal-data', payload));
  terminalHost.on('exit', (payload: { projectId: string; exitCode: number }) => pushRenderer('work:terminal-exit', payload));
  return terminalHost;
}

/**
 * 落盘用的「语言无关」错误标记。state 会写进 work-projects.json，
 * 一旦把本地化文案写进去，用户切语言后旧语言的错误就会永久留在文件里 ——
 * 所以这里只存稳定标识符，渲染层再按当前语言翻译（见 renderer 的 taskErrorText）。
 */
const STALE_RUN_MARKER = '__stale_run__';
const RUN_FAILED_MARKER = '__run_failed__';

let windowRef: BrowserWindow | null = null;
let appMenu: Menu | null = null;
let state: StoredState;
/**
 * 多任务并行：每个任务一个独立的 agent host 子进程（各自 cwd / 各自会话），
 * 互不干扰。renderer 随时切换查看的任务，后台任务的事件照常流入对应实例。
 */
const agents = new Map<string, LocalAgent>();
/** 面板取消与空间移除共用这张路由表；请求结束后由 host 回执清除。 */
interface PendingCommitMessage {
  projectId: string;
  agent: LocalAgent | null;
  sent?: Promise<boolean>;
}
const pendingCommitMessages = new Map<string, PendingCommitMessage>();
/**
 * 正在等待 host 回执的「复制会话」请求（work:fork-task）。
 *
 * 与面板请求的区别：面板把回执一路推给渲染层由它自己配对，这里**必须就地拦下** ——
 * fork 只是分叉流程的中间步，不是用户可见的事件，推到渲染层会冒出一句「会话已分叉」的
 * 无关事件，而且渲染层也没有对应的 pending 表。
 */
interface PendingFork {
  agent: LocalAgent | null;
  resolve: (result: ForkResult) => void;
  timer: ReturnType<typeof setTimeout>;
}
type ForkResult = { ok: boolean; sessionId?: string; message?: string };
const pendingForks = new Map<string, PendingFork>();
const FORK_TIMEOUT_MS = 30_000;

/** host 退出 / 被 stop 时，在等它回执的 fork 永远不会来 —— 就地失败，别让调用方等到超时。 */
function failPendingForks(agent: LocalAgent, message: string): void {
  for (const [id, pending] of pendingForks) {
    if (pending.agent !== agent) continue;
    pendingForks.delete(id);
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, message });
  }
}
const recoveryLogs = new Map<string, RecoveryLog>();
const recoveryRoot = (): string => app.getPath('userData');
// 每个流式 token 都可能写日志；复用对象，避免每次都重读整份 JSONL 来恢复 seq。
const taskRecovery = (taskId: string): RecoveryLog => {
  let log = recoveryLogs.get(taskId);
  if (!log) { log = recoveryLog(recoveryRoot(), taskId); recoveryLogs.set(taskId, log); }
  return log;
};
const removeRecovery = (taskId: string): void => {
  // 保留墓碑：已停止 host 的迟到事件不能重新建出刚删除的任务日志。
  const discard = (): void => {};
  recoveryLogs.set(taskId, { user: discard, event: discard, truncate: discard, regenerate: discard });
  deleteRecoveryLog(recoveryRoot(), taskId);
};
const RECOVERED_EVENTS = new Set([
  'run_started', 'text_delta', 'tool_started', 'tool_output', 'tool_completed',
  'live_usage', 'no_reply', 'max_steps', 'approval_requested', 'run_aborted',
  'run_completed', 'run_failed', 'host_exit',
  // 本轮改动快照（run_completed 之后由主进程算好追加）：是对话内容的一部分，
  // 每条助手消息尾部的清单都靠它重放。
  'run_changed_files',
  // 压缩留下的系统行是**对话内容**：切走再回来、重启后打开会话都必须还在。
  // 只持久化完成事件；context_compacting 是纯瞬时状态，恢复时没有意义。
  'context_compacted',
]);

/** 持久化与 renderer 相同的事件语义；面板回执不属于任务对话，绝不混进恢复日志。 */
function recordRecoveryEvent(taskId: string, envelope: RecoveryEnvelope): void {
  if (envelope.type === 'error' || (envelope.type === 'event' && RECOVERED_EVENTS.has(envelope.event ?? ''))) {
    taskRecovery(taskId).event({ ...envelope, requestId: taskId });
  }
}

/** 每个任务「改动快照」的代号：只有最新一轮的那次 git 统计允许落盘与下发。 */
const changedFilesSeq = new Map<string, number>();

/**
 * 本轮改动清单：run_completed 之后立刻取一次快照，作为独立的 run_changed_files 事件下发 + 落盘。
 *
 * 为什么必须**现在**取，不能等渲染层需要时再算：清单要挂在**这一条**助手消息尾部，
 * 切走再回来看、重启后打开会话都得复现。而 gitFileStats 的基准是 HEAD —— 事后算出来的是
 * 「此刻 vs HEAD」的累计差异，历史轮次甚至可能因后续提交归零。所以这里抓住那一轮的瞬间值。
 *
 * 取不到统计（不是 git 仓库 / git 失败）时仍然发清单，只是不带 +N/-N：
 * 「这一轮动了哪些文件」本身仍然成立，行数缺失不该让整块消失。
 */
function announceChangedFiles(taskId: string, payload: Record<string, unknown>, changeSnapshotId: string): void {
  const files = Array.isArray(payload.changedFiles)
    ? payload.changedFiles.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
  if (!files.length) return;
  const task = taskById(taskId);
  const project = task ? workspaceForTask(task) : undefined;
  if (!project) return;
  const seq = (changedFilesSeq.get(taskId) ?? 0) + 1;
  changedFilesSeq.set(taskId, seq);
  void gitFileStats(project.root, files).then((result) => {
    // 期间又开了新一轮（或任务被删）：这份快照已经不属于屏上那条消息了。
    if (changedFilesSeq.get(taskId) !== seq || !taskById(taskId)) return;
    const stats = result.ok && result.stats.length
      ? result.stats
      : files.map((file) => ({ path: file, added: 0, removed: 0, untracked: false }));
    const envelope: RecoveryEnvelope = { type: 'event', event: 'run_changed_files', requestId: taskId, payload: { changeSnapshotId, files: stats } };
    recordRecoveryEvent(taskId, envelope);
    pushRenderer('work:agent-event', envelope);
  });
}

function statePath(): string { return path.join(app.getPath('userData'), 'work-projects.json'); }
function modelsDir(): string { return path.join(os.homedir(), '.mocode', 'models'); }
function userConfigPath(): string { return path.join(os.homedir(), '.mocode', 'config'); }
function pushRenderer(channel: string, payload: unknown): void {
  // 退出竞态:window-all-closed 之后 agent 子进程还可能 flush 最后一段 stdout,
  // 此时 webContents 已 destroyed。`?.` 挡不住,必须显式判 isDestroyed。
  const w = windowRef;
  if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
    w.webContents.send(channel, payload);
  }
}
function broadcastState(): void { pushRenderer('work:state', state); desktopPet.update(state.tasks); }

/** 读取 ~/.mocode/config 的所有键(不写 process.env,仅作查询)。 */
function readUserConfig(): Record<string, string> {
  try { return dotenv.parse(readFileSync(userConfigPath(), 'utf8')); } catch { return {}; }
}

/** 写入 ~/.mocode/config —— 保留文件中其它键,只覆盖传入的。 */
function writeUserConfig(patch: Record<string, string | null>): void {
  const existing = readUserConfig();
  const merged: Record<string, string> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  // 保持稳定顺序:patch 中声明的键排在最前
  const ordered: string[] = [];
  for (const k of Object.keys(patch)) if (merged[k] !== undefined) ordered.push(k);
  for (const k of Object.keys(existing)) if (!ordered.includes(k) && merged[k] !== undefined) ordered.push(k);
  const text = `${ordered.map((k) => `${k}=${merged[k] ?? ''}`).join('\n')}\n`;
  writeFileSync(userConfigPath(), text, 'utf8');
}

interface ModelDescriptor {
  name: string;          // 文件名(去掉 .json),用户标识 / 写入 config 的 LLM_MODEL
  label: string;         // 实际 API 的 model 名
  provider: 'openai' | 'anthropic' | 'google';
  promptCache: boolean;
  baseURL: string;       // 仅显示用(只返回 host,不泄漏完整 endpoint)
  providerHost: string;  // 归一化后的提供商标识(剥掉 api./www. 等前缀),renderer 按它分组
  contextWindow: number; // tokens
  maxTokens?: number;
  reasoningEffort: EffortValue;
  reasoning: ReasoningCapability;
  isActive: boolean;
}

/**
 * 读 ~/.mocode/models/.active —— mocode 用来记录"当前激活预设"的指针文件。
 * 注意它存的是**预设文件名**，与 config 里的 LLM_MODEL（真实 API model 名）不是一回事：
 * 预设 deepseek-v4-1-flash 的 model 字段是 deepseek-v4.1-flash，两者拼写不同。
 * 判定"哪个预设是激活项"必须看这个指针，不能拿 LLM_MODEL 去比文件名。
 */
function readActivePreset(): string {
  try { return readFileSync(path.join(modelsDir(), '.active'), 'utf8').trim(); } catch { return ''; }
}

/**
 * 读取 .active 预设的 baseURL（masked）。唯一用途：给「当前配置」摘要兜底 ——
 * 老配置里 ~/.mocode/config 的 LLM_BASE_URL 可能为空，此时只能靠激活预设自己的 baseURL 填这一行。
 */
function activePresetBaseURL(): string {
  const name = readActivePreset();
  if (!name) return '';
  try {
    const raw = JSON.parse(readFileSync(path.join(modelsDir(), `${name}.json`), 'utf8')) as Record<string, unknown>;
    return typeof raw.baseURL === 'string' ? maskUrl(raw.baseURL) : '';
  } catch { return ''; }
}

/** 扫描 ~/.mocode/models/*.json,返回所有模型描述 + 当前激活标记。 */
function listModels(): ModelDescriptor[] {
  const activeName = readActivePreset();
  const activeModel = process.env.LLM_MODEL || readUserConfig().LLM_MODEL || '';
  const dir = modelsDir();
  let entries: string[] = [];
  try { entries = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: ModelDescriptor[] = [];
  for (const file of entries) {
    const preset = readWorkPreset(path.join(dir, file));
    if (!preset) continue;
    // 激活身份只看 .active 指针(它是 mocode 唯一的真相源);指针缺失时才退回比对真实 model 名。
    // 绝不能拿 baseURL 反推激活项 —— 同一家提供商的多个预设主机名相同,会把整组都标成"当前"。
    out.push(describePreset(preset, activeName ? preset.name === activeName : preset.model === activeModel));
  }
  // 激活项置顶,其余按名称字典序
  out.sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name) : a.isActive ? -1 : 1));
  return out;
}

/**
 * 让运行环境遵循 mocode 的「激活预设」语义:`.active` 指针指向哪个预设,就用哪个预设的
 * LLM 四键(config 里的裸键只在没有激活预设时才作数)。
 *
 * 为什么必须做:loadMocodeConfig 会把 ~/.mocode/config 的裸 LLM 键灌进 process.env,
 * 而 mocode core 的优先级规则是「shell 显式设的 env > .active 预设 > config 裸键」——
 * 一旦我们把 config 裸键提前塞进 process.env,host 进程就会把它当成"shell 设的"，
 * 从而**跳过 .active 预设覆盖**。此时若 config 里的 LLM_MODEL 是个过时/写错的值
 * (例如历史版本误写成预设文件名 deepseek-v4-1-flash,而非真实 model deepseek-v4.1-flash),
 * host 就会拿这个错值去请求,得到 `404 The model ... does not exist`。
 */
function applyActivePreset(): void {
  const name = readActivePreset();
  if (!name) return;
  const preset = readWorkPreset(path.join(modelsDir(), `${name}.json`));
  if (preset) applyPresetEnv(preset);
}

/**
 * 把指定模型切为当前激活:读目标 .json,把所有相关键写入 ~/.mocode/config 与 process.env。
 * host 子进程持有自己的一份 config 快照,所以要换代;但**正在跑的任务绝不能被打断**:
 * 那一轮继续用旧模型跑完,新模型只在它下一次 run 发出前重启 host 时才生效
 * (见 restartAllAgents / LocalAgent.deferRestart)。
 *
 * **关键**:LLM_MODEL 必须写预设里的真实 API model 名(如 deepseek-v4.1-flash),
 * 绝不能写预设文件名(deepseek-v4-1-flash)。两者拼写常常不同(点号 vs 连字符),
 * 写错会让 host 拿一个后端不存在的模型名去请求,得到
 * `404 The model ... does not exist`。真正"当前激活预设"的身份由 .active 指针文件承载。
 */
function switchModel(name: string): { ok: boolean; message: string; model?: ModelDescriptor } {
  if (!PRESET_NAME_RE.test(name)) return { ok: false, message: tMain('main.preset.nameInvalid') };
  const preset = readWorkPreset(path.join(modelsDir(), `${name}.json`));
  if (!preset) return { ok: false, message: tMain('main.switchModel.cannotRead', { name }) };
  const patch = presetConfigPatch(preset);
  try { writeUserConfig(patch); }
  catch (error) { return { ok: false, message: tMain('main.switchModel.writeFail', { msg: (error as Error).message }) }; }
  // 同步 .active 指针,否则下次启动 config/index.ts 会用指针指向的旧预设覆盖刚写的键。
  try { writeFileSync(path.join(modelsDir(), '.active'), `${name}\n`, 'utf8'); }
  catch { /* 指针写失败不阻断切换 */ }
  applyPresetEnv(preset);
  // 切模型 = 换 host 的 config 快照。在跑的任务原地继续用旧模型跑完（不能被取消/重启打断），
  // 新模型推迟到它下一次 run 前才换代生效。
  const deferred = anyTaskBusy();
  restartAllAgents();
  return {
    ok: true,
    message: tMain('main.switchModel.saved', { name, provider: preset.provider, cache: preset.anthropicPromptCache ? ' · cache on' : '' })
      + (deferred ? tMain('main.switchModel.deferred') : ''),
    model: describePreset(preset, true),
  };
}

/* ── 预设文件读写（新增 / 编辑 / 重命名 / 删除） ──────────────────────
 * 与 src/config/presets.ts 保持同语义：per-file JSON、name 只允许 [a-zA-Z0-9_-]{1,32}、
 * `.active` 指针指向的预设若被改名/删除要同步跟随，否则下次启动回退 config 裸键丢窗口。 */

/** 预设名规则与 core 的 config/presets.ts 一致（路径穿越防护的第一道）。 */
const PRESET_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** 磁盘上的完整预设（含 apiKey 明文）。只允许在主进程内流转，绝不整条发往 renderer。 */
type PresetFile = WorkPresetFile;

/** 用户可编辑的字段。name 单独处理（改名走 savePresetFromRenderer）。 */
type PresetDraft = WorkPresetDraft;

function presetPathFor(name: string): string {
  return path.join(modelsDir(), `${name}.json`);
}

function describePreset(preset: WorkPresetFile, isActive: boolean): ModelDescriptor {
  return {
    name: preset.name,
    label: preset.model,
    provider: preset.provider,
    promptCache: preset.anthropicPromptCache,
    baseURL: maskUrl(preset.baseURL),
    providerHost: providerHostOf(preset.baseURL),
    contextWindow: preset.contextWindow,
    ...(preset.maxTokens ? { maxTokens: preset.maxTokens } : {}),
    reasoningEffort: preset.reasoningEffort ?? 'auto',
    reasoning: reasoningCapabilityForPreset(preset),
    isActive,
  };
}

function presetConfigPatch(draft: PresetDraft): Record<string, string | null> {
  return {
    LLM_PROVIDER: draft.provider ?? 'openai',
    LLM_BASE_URL: draft.baseURL,
    LLM_API_KEY: draft.apiKey,
    LLM_MODEL: draft.model,
    ANTHROPIC_PROMPT_CACHE: draft.anthropicPromptCache ? 'true' : 'false',
    CONTEXT_WINDOW_TOKENS: String(draft.contextWindow),
    REASONING_EFFORT: draft.reasoningEffort ?? 'auto',
    MAX_TOKENS: draft.maxTokens ? String(draft.maxTokens) : null,
  };
}

function applyPresetEnv(draft: PresetDraft): void {
  const patch = presetConfigPatch(draft);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
}

/** 原子写预设（写 tmp 再 rename），与 core 的 savePreset 同策略。 */
function writePresetFile(name: string, draft: PresetDraft): void {
  writeWorkPreset(presetPathFor(name), { name, ...draft, provider: draft.provider ?? 'openai', anthropicPromptCache: draft.anthropicPromptCache ?? false });
}

/** 读一个预设文件为草稿；文件缺失/损坏返回 null。 */
function readPresetFile(name: string): PresetFile | null {
  return readWorkPreset(presetPathFor(name));
}

/** 把一个预设激活（写 config + .active + process.env），供新建/编辑后自动生效使用。 */
function activatePreset(name: string, draft: PresetDraft): void {
  try { writeUserConfig(presetConfigPatch(draft)); } catch { /* 写 config 失败不阻断 .active */ }
  try { writeFileSync(path.join(modelsDir(), '.active'), `${name}\n`, 'utf8'); } catch { /* 指针写失败不阻断 */ }
  applyPresetEnv(draft);
}

/**
 * 保存（新建或覆盖）一个预设。
 * activate=true 时顺带切为当前 —— 新建模型后用户期待的下一步就是用它，
 * 否则还要再点一次「切换」。编辑非激活预设时不打扰当前运行环境。
 */
function savePresetFromRenderer(input: {
  name?: unknown;
  originalName?: unknown;
  draft?: unknown;
  activate?: unknown;
}): { ok: boolean; message: string; name?: string } {
  const name = String(input.name ?? '').trim();
  if (!PRESET_NAME_RE.test(name)) return { ok: false, message: tMain('main.preset.nameInvalid') };
  const normalized = normalizeWorkPresetDraft((input.draft ?? {}) as Partial<PresetDraft>);
  if (!normalized.ok) return { ok: false, message: tMain(normalized.message as Parameters<typeof tMain>[0]) };
  const draft = normalized.value;

  const originalName = String(input.originalName ?? '').trim();
  const renaming = !!originalName && originalName !== name;
  if (renaming) {
    if (!PRESET_NAME_RE.test(originalName)) return { ok: false, message: tMain('main.preset.nameInvalid') };
    if (existsSync(presetPathFor(name))) return { ok: false, message: tMain('main.preset.alreadyExists', { name }) };
    if (!existsSync(presetPathFor(originalName))) return { ok: false, message: tMain('main.preset.notExist', { name: originalName }) };
  }
  try {
    writePresetFile(name, draft);
    if (renaming) {
      // 先写新文件再删旧文件：中途失败也不会丢配置。
      try { unlinkSync(presetPathFor(originalName)); } catch { /* 旧文件已被手动删掉 */ }
      if (readActivePreset() === originalName) {
        try { writeFileSync(path.join(modelsDir(), '.active'), `${name}\n`, 'utf8'); } catch { /* 忽略 */ }
      }
    }
  } catch (error) {
    return { ok: false, message: tMain('main.preset.writeFail', { msg: (error as Error).message }) };
  }

  const wasActive = readActivePreset() === name || readActivePreset() === originalName;
  if (input.activate === true || wasActive) {
    activatePreset(name, draft);
    restartAllAgents();
  }
  return { ok: true, message: renaming ? tMain('main.preset.renamed', { name }) : tMain('main.preset.saved', { name }), name };
}

/** 删除一个预设；删的若是激活预设，顺带清掉指针（否则下次启动指向空文件）。 */
function removePreset(name: string): { ok: boolean; message: string } {
  if (!PRESET_NAME_RE.test(name)) return { ok: false, message: tMain('main.preset.nameInvalid') };
  if (!existsSync(presetPathFor(name))) return { ok: false, message: tMain('main.preset.notExist', { name }) };
  const wasActive = readActivePreset() === name;
  try { unlinkSync(presetPathFor(name)); }
  catch (error) { return { ok: false, message: tMain('main.preset.deleteFail', { msg: (error as Error).message }) }; }
  if (wasActive) {
    try { unlinkSync(path.join(modelsDir(), '.active')); } catch { /* 指针已不在 */ }
  }
  return { ok: true, message: tMain('main.preset.deleted', { name, active: wasActive ? tMain('main.preset.deletedActive') : '' }) };
}

/**
 * 配置类变更（模型 / 行为开关 / MCP）后统一走这里。
 *
 * 关键：**正在跑的任务（含等审批）不能被打断**。以前这里一律 cancel + 杀 host，
 * 于是「agent 跑着的时候切模型」会当场把这一轮打断（用户看到的就是报错）。
 * 现在只给这类实例记一个「下一轮生效」标记：这一轮用旧配置跑完，
 * 等下一次 run/compact 发出前才换代 host（LocalAgent.applyPendingRestart）。
 * 空闲实例照旧立刻重启，下次 send 按新配置冷启动。
 */
function restartAllAgents(): void {
  for (const [id, agent] of agents) {
    const task = taskById(id);
    // runActive 是 host 那一侧的真实忙碌态；task.status 另有涵义（等审批时是 waiting，
    // 而 run 刚发出时主进程已先把状态置成 running，所以两者取或才不漏。
    const busy = agent.isBusy || (!!task && (task.status === 'running' || task.status === 'waiting'));
    if (busy) {
      agent.deferRestart();
      continue;
    }
    agent.restart();
  }
}

/**
 * 是否有任务正在跑或等审批 —— 切模型时据此决定要不要提示「下一轮生效」。
 * 与 restartAllAgents 同口径：agent 自己的 runActive 也算（host 那边真的有一轮在跑）。
 */
function anyTaskBusy(): boolean {
  if (state.tasks.some((task) => task.status === 'running' || task.status === 'waiting')) return true;
  for (const agent of agents.values()) if (agent.isBusy) return true;
  return false;
}

/* ── 行为开关（设置浮层用，语义对齐 mocode 终端的斜杠命令） ──
 * 读取顺序：process.env（host 启动时的快照来源）→ ~/.mocode/config → mocode 默认值。
 *
 * 为什么开关写在主进程而不是走 host 的 `settings` 命令：主进程拥有 host 生命周期，
 * 改完必须 restartAllAgents() 才对新起的 host 生效（host 启动期就把 env 固化进 config 快照）。
 * host 侧那份 settings 命令是给无主进程的客户端（headless/CLI）用的，判定函数同源，
 * 但**只影响自己那个进程**，不适合 GUI。
 *
 * 默认值口径与 core 一一对齐：
 *   - AUTO_COMPACT / AUTO_REFLECT / MOCODE_ROUTER_ENABLED / MOCODE_MCP_ENABLED /
 *     MOCODE_MEMORY_* 子通道：默认开，只有 0/false/off/no 才关（!== 'false' 不够，
 *     因为 '0' 也是关，这里用 notOff 统一）。
 *   - MEMORY_ENABLED / MOCODE_SUBAGENT_ENABLED / MOCODE_FRONTEND_TOOLS_ENABLED /
 *     MOCODE_COMPUTER_USE_ENABLED：显式 'true' 才开（core 在 env 缺省时按 profile 决定，
 *     主进程看不到 profile，所以在未配置时显示"关"——写 'true' 即可打开，不会误关已开的项）。
 */
const notOff = (value: string | undefined): boolean =>
  value === undefined || !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
const exactlyTrue = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true';

const SETTING_TOGGLES = {
  autoCompact: { env: 'AUTO_COMPACT', on: notOff },
  memory: { env: 'MEMORY_ENABLED', on: exactlyTrue },
  subAgent: { env: 'MOCODE_SUBAGENT_ENABLED', on: exactlyTrue },
  autoReflect: { env: 'AUTO_REFLECT', on: notOff },
  // MCP 总开关（core 的 readMcpServers 认 MOCODE_MCP_ENABLED=false）。
  mcp: { env: 'MOCODE_MCP_ENABLED', on: notOff },
  // 工具路由总开关（/router）：默认开，关闭后每轮暴露全部工具簇。
  router: { env: 'MOCODE_ROUTER_ENABLED', on: notOff },
  // 记忆四条 push/后台通道（R3/R6/R11/R17）：默认开，各自可单独关。
  turnRecall: { env: 'MOCODE_MEMORY_TURN_RECALL', on: notOff },
  proactive: { env: 'MOCODE_MEMORY_PROACTIVE', on: notOff },
  episodic: { env: 'MOCODE_MEMORY_EPISODIC', on: notOff },
  consolidate: { env: 'MOCODE_MEMORY_CONSOLIDATE', on: notOff },
  // 默认不挂的工具簇（/fe、/cu）：显式 true 才进默认工具面。
  frontendTools: { env: 'MOCODE_FRONTEND_TOOLS_ENABLED', on: exactlyTrue },
  computerUse: { env: 'MOCODE_COMPUTER_USE_ENABLED', on: exactlyTrue },
} as const;
type SettingKey = keyof typeof SETTING_TOGGLES;

/** 思考强度五档由 model-config 与 core 的 ReasoningEffort 同集合。 */

/** 来回读一份配置（env 优先，其次 ~/.mocode/config），开关与 effort 共用。 */
const desktopPet = new DesktopPet();

function settingsValue(env: string): string | undefined {
  return process.env[env] ?? readUserConfig()[env];
}

function readSettings(): Record<SettingKey, boolean> & { effort: EffortValue; desktopPet: boolean; petCharacter: PetCharacterId } {
  const out = {} as Record<SettingKey, boolean> & { effort: EffortValue };
  for (const [key, def] of Object.entries(SETTING_TOGGLES)) {
    out[key as SettingKey] = def.on(settingsValue(def.env));
  }
  const raw = (settingsValue('REASONING_EFFORT') ?? '').trim().toLowerCase();
  out.effort = (EFFORT_VALUES as readonly string[]).includes(raw) ? (raw as EffortValue) : 'auto';
  return Object.assign(out, { desktopPet: settingsValue('MOCODE_DESKTOP_PET') === 'true', petCharacter: normalizePetCharacter(settingsValue('MOCODE_PET_CHARACTER')) });
}


function runCommand(root: string, executable: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => execFile(executable, args, { cwd: root, windowsHide: true, maxBuffer: 1_024 * 1_024 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
  }));
}

async function branchAt(root: string): Promise<string> {
  const result = await runCommand(root, 'git', ['branch', '--show-current']);
  // 空串 = 非 git 仓库 / 无分支，渲染层再按当前语言显示「本地」。
  // 这里绝不能存本地化文案 —— state 会落盘，切语言后旧文案会永久留在侧栏。
  return result.ok ? (result.stdout || 'detached') : '';
}

async function projectFor(root: string): Promise<Project> {
  const normalized = path.resolve(root);
  return { id: normalized.toLowerCase(), name: path.basename(normalized) || normalized, root: normalized, branch: await branchAt(normalized) };
}

/**
 * 把全局注册表里的工作空间并入侧栏「空间」。
 *
 * 只并入**还存在于磁盘且确实有历史会话**的目录：注册表里 49 条里大半是临时目录
 * （Electron/scratch、wt-xxxx 这类），全塞进侧栏只会把真正的项目挤下去。
 * 用户手动「移除」过的空间记在 `hiddenProjects` 里，不会被同步加回来。
 */
const REGISTRY_SYNC_DEBOUNCE_MS = 15_000;
let lastRegistrySyncAt = 0;

async function syncWorkspaceRegistry(force = false): Promise<boolean> {
  if (!force && Date.now() - lastRegistrySyncAt < REGISTRY_SYNC_DEBOUNCE_MS) return false;
  lastRegistrySyncAt = Date.now();
  const hidden = new Set((state.hiddenProjects ?? []).map((id) => id.toLowerCase()));
  let changed = false;
  for (const entry of readWorkspaceRegistry()) {
    const id = path.resolve(entry.root).toLowerCase();
    if (hidden.has(id) || !existsSync(entry.root)) continue;
    // 临时工作区（%TEMP%\mocode-ws-*、.mocode/worktrees/wt-*、lanes/*/copy）不占侧栏，
    // 否则十来个叫 copy / wt-xxxx 的空间会把真正的项目挤下去。
    if (isNoiseWorkspace(entry.root)) continue;
    const count = countProjectSessions(entry.root);
    const existing = state.projects.find((item) => item.id === id);
    if (existing) {
      if (existing.sessionCount !== count) { existing.sessionCount = count; changed = true; }
      continue;
    }
    if (count === 0) continue; // 没有历史会话的目录先不占位
    const project = await projectFor(entry.root);
    project.auto = true;
    project.sessionCount = count;
    state.projects.push(project);
    changed = true;
  }
  // 手动添加、且不在注册表里的空间也要算一次：它们同样可能是用户之前用终端跑过的工作区
  // （注册表里没有，但 `<root>/.mocode/sessions` 有会话）。不算的话这些空间永远展开不出历史。
  for (const project of state.projects) {
    const id = project.id.toLowerCase();
    if (hidden.has(id)) continue;
    const count = countProjectSessions(project.root);
    if (project.sessionCount !== count) { project.sessionCount = count; changed = true; }
  }
  if (changed) { saveState(); broadcastState(); }
  return changed;
}

function normalizeState(value: unknown): StoredState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<StoredState>;
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) return null;
  const projects = raw.projects.filter((item): item is Project => !!item && typeof item.id === 'string' && typeof item.root === 'string')
    .map((item) => ({
      ...item,
      name: item.name || path.basename(item.root),
      branch: typeof item.branch === 'string' ? item.branch : '',
      ...(item.auto === true ? { auto: true } : {}),
      ...(typeof item.sessionCount === 'number' ? { sessionCount: item.sessionCount } : {}),
    }));
  if (!projects.length) return null;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter((item): item is TaskRecord => !!item && typeof item.id === 'string' && typeof item.projectId === 'string')
    .map((item) => {
      const status = item.status || 'completed';
      // 上次会话结束时仍在 running/waiting 的任务，终态事件（run_completed/run_failed）不会落盘 ——
      // 进程退出即失联。重启后一律收敛为 failed，否则侧栏永远转圈。
      // draft 壳子（queued 且从未发过 run，pendingTask 依赖它）保留 queued。
      const stale = status === 'running' || status === 'waiting';
      return {
        ...item,
        changedFiles: Array.isArray(item.changedFiles) ? item.changedFiles : [],
        status: (stale ? 'failed' : status) as TaskStatus,
        lastError: stale && !item.lastError ? STALE_RUN_MARKER : item.lastError,
      };
    }) : [];
  return { version: 1, projects, tasks, selectedProjectId: projects.some((item) => item.id === raw.selectedProjectId) ? raw.selectedProjectId! : projects[0].id, selectedTaskId: typeof raw.selectedTaskId === 'string' ? raw.selectedTaskId : undefined };
}

/**
 * 首次启动的默认项目根目录。
 *  - 开发态：仓库根(work-app/dist → ../../..)，方便直接拿 mocode 自己的源码开工。
 *  - 打包态：安装目录只读(Windows 在 Program Files/AppData\Programs 下)，往那儿写
 *    `.mocode/sessions` 会直接 EPERM。改用 userData 下的 workspace 目录，可写且稳定。
 */
function defaultProjectRoot(): string {
  if (!app.isPackaged) return path.join(__dirname, '..', '..', '..');
  const root = path.join(app.getPath('userData'), 'workspace');
  mkdirSync(root, { recursive: true });
  return root;
}

async function loadState(): Promise<StoredState> {
  try { const loaded = normalizeState(JSON.parse(readFileSync(statePath(), 'utf8'))); if (loaded) return loaded; } catch { /* First launch. */ }
  const project = await projectFor(path.resolve(process.env.MOCODE_WORK_PROJECT ?? defaultProjectRoot()));
  return { version: 1, projects: [project], selectedProjectId: project.id, tasks: [] };
}

function saveState(): void {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 启动时对账侧栏排序键（`updatedAt`）。
 *
 * 旧版接管历史会话一律把 `updatedAt` 写成 `now`，真机上还成批把老任务写成了同一个
 * 亚秒窗口，结果是「点开看一眼」就把几周前的会话顶到正在跑的任务上面、再也找不到自己
 * 在找的那条。规则本身在 task-order.ts（纯函数，可单测），这里只负责取磁盘证据并落盘：
 * 会话的最后活动时间以 `session.json` 的 mtime 为准，只在「明显对不上」且任务已终态时回退。
 *
 * 返回修正条数（0 表示无需落盘）。
 */
function repairTaskSortKeys(): number {
  const repairs = planSortKeyRepair(state.tasks, (task) => {
    if (!task.sessionId) return null;
    const record = taskById(task.id);
    if (!record) return null;
    const project = workspaceForTask(record);
    if (!project) return null;
    try { return sessionLastActiveAt(project.root, task.sessionId); } catch { return null; }
  });
  if (!repairs.length) return 0;
  for (const repair of repairs) {
    const task = taskById(repair.taskId);
    if (task) task.updatedAt = repair.to;
  }
  saveState();
  return repairs.length;
}
function selectedProject(): Project { return state.projects.find((item) => item.id === state.selectedProjectId) ?? state.projects[0]; }
function taskById(id?: string): TaskRecord | undefined { return state.tasks.find((item) => item.id === id); }

/**
 * 丢弃「点了 + 但一句话都没发」的空草稿任务（判定见 task-draft.ts）。
 *
 * 触发时机：**选中项要离开一条空草稿时**。点「+」会立刻落一条任务记录并预热一个 host
 * 子进程；用户若只是打开看一眼又切去别的会话，这条记录会永远挂在空间下面显示成
 * 「新任务」，还白占着一个闲置的 host —— 这正是一句没聊却在侧栏留下空任务的原因。
 *
 * `keepId` 是马上要被选中的那条（它自己也可能仍是空草稿，比如连点两次 +）：留着，
 * 否则界面会在用户敲第一个字之前闪一下空状态。它会在用户真正切走时被下一次调用收走。
 *
 * 只 saveState 不 broadcast：调用方紧接着就会改 selectedTaskId 并广播完整状态。
 */
function discardEmptyDrafts(keepId?: string): boolean {
  const ids = discardableDraftIds(state.tasks, keepId);
  if (!ids.length) return false;
  for (const id of ids) {
    const agent = agents.get(id);
    if (agent) { agent.stop(); agents.delete(id); }
    removeRecovery(id);
  }
  const doomed = new Set(ids);
  state.tasks = state.tasks.filter((task) => !doomed.has(task.id));
  if (state.selectedTaskId && doomed.has(state.selectedTaskId)) state.selectedTaskId = undefined;
  saveState();
  return true;
}

/**
 * 普通任务（无项目文件夹）的 pseudo-project：agent host 需要一个 cwd 跑子进程、
 * 会话历史也按 <root>/.mocode/sessions 存放，所以给它一个稳定的 scratch 目录。
 * 放在 userData 下，不污染用户的项目目录。
 */
let scratch: Project | null = null;
function scratchProject(): Project {
  if (scratch) return scratch;
  const root = path.join(app.getPath('userData'), 'scratch');
  mkdirSync(root, { recursive: true });
  scratch = { id: '__scratch__', name: tMain('main.task.standalone'), root, branch: '' };
  return scratch;
}
/** 任务实际运行的 project：普通任务落到 scratch，其余按 projectId 找。 */
function workspaceForTask(task: TaskRecord): Project | undefined {
  return task.projectId ? state.projects.find((item) => item.id === task.projectId) : scratchProject();
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => part?.type === 'text' && part.attachment !== true && typeof part.text === 'string' ? part.text : '').join('');
  return value == null ? '' : JSON.stringify(value);
}

/**
 * 会话历史 → 渲染用的有序片段流。
 * 顺序即时间顺序:user 一条,assistant 正文一条,随后每个 tool 结果一条(带上工具名与入参,
 * 这样渲染端能把工具行折叠成「编辑文件 · src/foo.ts」这种一行摘要)。
 * assistant 消息里的 tool_calls 只登记 id → (name, arguments) 映射,真正的工具行在
 * 读到对应 role=tool 结果时才产出 —— 保证与真实执行顺序一致。
 */
function sessionHistory(project: Project, sessionId?: string): HistoryItem[] {
  if (!sessionId) return [];
  // readSessionHistory 除了活会话 / 旧版单文件，还会回退读 archive/<id>.json.gz——
  // 接管一条已被 retention 归档的终端会话时，不补这条分支聊天区会是一片空白。
  const messages = readSessionHistory(project.root, sessionId);
  return messages ? flattenHistory(messages) : [];
}

function flattenHistory(messages: Array<Record<string, unknown>>): HistoryItem[] {
  const items: HistoryItem[] = [];
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const [index, message] of messages.entries()) {
    const summary = compactedHistorySummary(message, index);
    if (summary) {
      items.push(summary);
      continue;
    }
    const role = message.role;
    if (role === 'user' || role === 'assistant') {
      const text = contentText(message.content);
      const attachments = role === 'user' ? historyAttachments(message.content) : [];
      // 纯图片用户消息也必须保留：否则会丢轮次，后续助手回答并入上一轮。
      if (text || attachments.length) items.push({ role, text, ...(attachments.length ? { attachments } : {}) });
      if (role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
      for (const call of message.tool_calls) {
        const entry = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const id = typeof entry.id === 'string' ? entry.id : '';
        if (!id) continue;
        const rawArgs = entry.function?.arguments;
        calls.set(id, {
          name: String(entry.function?.name ?? 'tool'),
          arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {}),
        });
      }
      continue;
    }
    if (role !== 'tool') continue;
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
    const call = calls.get(id);
    items.push({
      role: 'tool',
      text: contentText(message.content),
      name: call?.name ?? 'tool',
      arguments: call?.arguments ?? '',
    });
  }
  return items;
}

/**
 * 会话落盘文件的位置 —— 与 core 的 SessionStore 同格式(见 src/session/store.ts):
 * `<root>/.mocode/sessions/<id>/session.json` 为主,`<id>.json` 只是读兜底(写一律落到新版位置)。
 */
function sessionFileFor(project: Project, sessionId: string): string | null {
  const dir = path.join(project.root, '.mocode', 'sessions');
  const modern = path.join(dir, sessionId, 'session.json');
  if (existsSync(modern)) return modern;
  const legacy = path.join(dir, `${sessionId}.json`);
  return existsSync(legacy) ? legacy : null;
}

/**
 * 回滚一段对话:会话历史截断到「第 userIndex 条用户消息之前」,这条用户消息本身与之后这一轮
 * 的正文 / 工具记录一起作废。截断规则在 truncate-session.ts(纯函数,可独立验证)。
 * **只动对话** —— 磁盘上被 agent 改过的文件一律保留,回滚不该悄悄改代码。
 */
function rollbackSession(task: TaskRecord, userIndex: number): { ok:boolean; message?: string } {
  const project = workspaceForTask(task);
  if (!project) return { ok: false, message: tMain('main.rollback.noWorkspace') };
  if (!task.sessionId) return { ok: false, message: tMain('main.rollback.noSession') };
  const file = sessionFileFor(project, task.sessionId);
  if (!file) return { ok: false, message: tMain('main.rollback.noFile') };
  let record: RawSessionRecord;
  try { record = JSON.parse(readFileSync(file, 'utf8')) as RawSessionRecord; } catch { return { ok: false, message: tMain('main.rollback.corrupt') }; }
  const result = truncateSessionAtUser(record, userIndex, { noHistory: tMain('main.rollback.noHistory'), compacted: tMain('main.rollback.compacted') });
  if (!result.ok) return result;
  // 原子写(tmp + rename):与 core 侧写 session 同策略,中途崩掉不会留下半个文件。
  const tmp = `${file}.rollback-tmp`;
  writeFileSync(tmp, JSON.stringify(record), 'utf8');
  renameSync(tmp, file);
  return { ok: true };
}

/**
 * 目录树的文件清单。
 * 上限从 180 提到 5000：180 会让稍微大一点的项目**后半截整个消失**（用户报「文件缺少」），
 * 而目录树默认折叠，五千个节点展开前并没有渲染压力。
 * 排序只在最外层做一次（原来每层递归都 sort 一遍，白跑）。
 * 返回 `truncated` 让渲染层能明说"还有更多"，而不是静默截断。
 */
const FILE_LIST_LIMIT = 5000;
const FILE_PREVIEW_SIZE_LIMIT = 4_000_000;

function listFiles(root: string): { files: string[]; truncated: boolean } {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    if (entries.length >= FILE_LIST_LIMIT) return;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entries.length >= FILE_LIST_LIMIT) return;
        // git 备份目录（`.git-corrupted-backup` 之类）内部是 objects/hooks 的二进制碎块，属于噪音。
        // 只匹配 `.git` 本身与 `.git-<后缀>`：**不能**用 startsWith('.git')，那会把 `.github`
        // （CI 工作流，是真实项目内容）一起误杀。
        if (entry.isDirectory() && (IGNORED_DIRECTORIES.has(entry.name) || entry.name === '.git' || entry.name.startsWith('.git-'))) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).replaceAll('\\', '/');
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && statSync(absolute).size <= FILE_PREVIEW_SIZE_LIMIT) entries.push(relative);
      }
    } catch { /* Unreadable directories are omitted. */ }
  };
  walk(root);
  return { files: entries.sort((left, right) => left.localeCompare(right)), truncated: entries.length >= FILE_LIST_LIMIT };
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
  const listing = listFiles(project.root);
  return { project, branch, status: status.ok ? status.stdout.split('\n').filter(Boolean) : [], diffStat: diffStat.ok ? diffStat.stdout : '', lastCommit: commit.ok ? commit.stdout : '', files: listing.files, filesTruncated: listing.truncated };
}

/** 把仍在运行的任务就地收敛为 failed —— host 退出/启动失败时不会再有 run_completed 落盘，不收敛侧栏就永远转圈。 */
function failTask(taskId: string, message: string): void {
  const task = taskById(taskId);
  if (!task || (task.status !== 'running' && task.status !== 'waiting')) return;
  task.status = 'failed';
  task.lastError = message;
  saveState();
  broadcastState();
}

/**
 * 最近一次 plan_update 的入参，按任务缓存。
 * 必要性：tool_completed 的 payload 里没有 arguments（host 的 onToolResult 只带 output），
 * 侧栏要等「工具真的成功」才落账，就必须把 tool_started 的入参留到那一刻。
 * 只对 plan_update 这一个工具做，不值得给所有工具建通用暂存。
 */
const pendingPlanArgs = new Map<string, unknown>();

/* ── 需要人工介入的系统级提醒 ────────────────────────────────
 * 只在「用户根本没在看这个应用」时打扰：窗口失焦 / 最小化。窗口在前台时侧栏的琥珀色
 * 等待行、标题栏「N 个待处理」、会话区横条已经把话说清楚，再来一条系统通知纯属重复。
 * 同一任务的等待期只提醒一次（一个 agent 可能连续发好几个审批，不该连环弹窗）；
 * 它一旦重新跑起来（status / run_* ）就把记录清掉，下次卡住再提醒。
 */
const notifiedWaitingTasks = new Set<string>();
let attentionFlashTimer: ReturnType<typeof setTimeout> | null = null;

/** 任务栏闪烁。Windows 上 flashFrame(true) 会一直闪到窗口获得焦点，兜底 8s 自己收掉。 */
function flashTaskbar(): void {
  const win = windowRef;
  if (!win || win.isDestroyed()) return;
  try { win.flashFrame(true); } catch { /* 某些平台不支持，静默 */ }
  if (attentionFlashTimer) clearTimeout(attentionFlashTimer);
  attentionFlashTimer = setTimeout(() => {
    attentionFlashTimer = null;
    try { win.flashFrame(false); } catch { /* 同上 */ }
  }, 8000);
}

function notifyNeedsAttention(task: TaskRecord, detail: string): void {
  const win = windowRef;
  const looking = !!win && !win.isDestroyed() && win.isFocused() && !win.isMinimized();
  if (looking || notifiedWaitingTasks.has(task.id)) return;
  notifiedWaitingTasks.add(task.id);
  flashTaskbar();
  if (!Notification.isSupported()) return;
  const title = task.title.trim() || tMain('empty.draft');
  const notification = new Notification({
    title: tMain('attention.notifyTitle'),
    body: tMain('attention.notifyBody', { steps: detail ? `${title} · ${detail}` : title }),
  });
  // 点通知 = 把窗口拎到前台 + 让渲染层跳到这个任务并摆出审批卡。
  // 渲染层是唯一知道「审批面板怎么摆」的地方，所以这里只发一个跳转信号。
  notification.on('click', () => {
    const target = windowRef;
    if (target && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
    pushRenderer('work:agent-event', { type: 'event', event: 'attention_open', requestId: task.id, payload: {} });
  });
  notification.show();
}

function updateTaskFromAgent(envelope: HostEnvelope): void {
  const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : undefined;
  const task = taskById(requestId);
  if (!task) return;
  const event = envelope.event;
  // text_delta / tool_output 等事件不改变侧栏。先留快照，只有任务记录真的变化才落盘、广播；
  // 否则每个正文 token 都会让 renderer 重画一次侧栏，鼠标按下与抬起之间按钮可能被替换而丢 click。
  const before = JSON.stringify(task);
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
  if (event === 'run_started') { task.status = 'running'; if (typeof payload.sessionId === 'string') task.sessionId = payload.sessionId; }
  if (event === 'approval_requested') {
    task.status = 'waiting';
    // 审批 / 提问的标题就是「它在等什么」，直接放进通知体，用户不点开也大致知道要答什么。
    notifyNeedsAttention(task, String(payload.title ?? '').trim());
  }
  // 一旦它重新动起来，就把「提醒过」的记录清掉：下次再卡住要重新提醒一次。
  if (event === 'status' || event === 'run_started' || event === 'run_aborted' || event === 'run_completed' || event === 'run_failed') {
    notifiedWaitingTasks.delete(task.id);
  }
  if (event === 'status') task.status = 'running';
  if (event === 'run_aborted') task.status = 'cancelled';
  if (event === 'run_failed') { task.status = 'failed'; task.lastError = String(payload.message ?? RUN_FAILED_MARKER); }
  if (event === 'run_completed') {
    task.changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles.filter((item): item is string => typeof item === 'string') : [];
    task.status = payload.terminationReason === 'aborted' ? 'cancelled' : payload.terminationReason === 'completed' ? 'completed' : 'failed';
  }
  // 侧栏任务行的计划进度：只在 plan_update 出现时更新。
  // 用 tool_started 暂存入参、tool_completed 才落账 —— tool_completed 的 payload 里
  // 只有 output 没有 arguments（见 src/host/stdio.ts 的 onToolResult），直接在那里解析
  // 会永远拿到 undefined；而被打断 / 校验失败的调用不该把侧栏写成一份没提交成功的计划
  // （会话区面板是实时预览，两者口径不同是有意的）。
  if (payload.name === 'plan_update') {
    if (event === 'tool_started') {
      pendingPlanArgs.set(task.id, payload.arguments);
    } else if (event === 'tool_completed') {
      const args = pendingPlanArgs.get(task.id);
      pendingPlanArgs.delete(task.id);
      const plan = parsePlan(args);
      if (plan) task.plan = { title: plan.title, done: plan.done, total: plan.total, allDone: plan.allDone };
    }
  } else if (event === 'run_completed' || event === 'run_failed' || event === 'run_aborted') {
    pendingPlanArgs.delete(task.id);
  }
  // updatedAt 是侧栏的「最近用户消息」排序键：Agent 事件只更新运行状态，不能抢排序。
  if (JSON.stringify(task) === before) return;
  saveState();
  broadcastState();
}

/**
 * host 冷启动上限。实测本机「空跑」启动 ≈8s（MCP 关闭），开 MCP / 慢盘 / 首启会更久 ——
 * 原来的 15s 太贴脸：一旦超时就把 host 杀掉并把任务判失败（"Agent 进程已停止，任务中断"）。
 */
const HOST_STARTUP_TIMEOUT_MS = 30_000;

/** host 启动失败的英文原因 → 用户照着就能做的本地化提示。 */
function describeHostStartFailure(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/did not become ready within/i.test(raw)) {
    return tMain('main.host.startTimeout', { s: Math.round(HOST_STARTUP_TIMEOUT_MS / 1000) });
  }
  if (/exited before readiness/i.test(raw)) {
    return tMain('main.host.exitedEarly');
  }
  return tMain('main.host.startFail', { raw });
}

class LocalAgent {
  private readonly client = new AgentHostClient({ startupTimeoutMs: HOST_STARTUP_TIMEOUT_MS });
  /** 本实例服务的任务 id（ensureAgent 创建时绑定）。host 退出/报错时用它把任务收敛到终态。 */
  private readonly taskId: string;
  private currentProject: Project | null = null;
  private starting: Promise<void> | null = null;
  /** 正在执行的 stop() promise。restart 后立刻 send 必须等它,否则会发给正在退出的旧 host。 */
  private restarting: Promise<void> | null = null;
  /** stop() 后实例即报废:在飞的 send() 会被 client 换代顶掉,那是主动报废不是故障,静默即可。 */
  private stopped = false;
  private crashStreak = 0;
  /** 最近一次启动失败的原因。start() 自己已经报过一次，send() 靠它避免同一条错误弹两遍。 */
  private lastStartError: string | null = null;
  /** 累计报过的错误条数：send() 用它判断「刚才那次 start() 到底报没报过」。 */
  private errorSeq = 0;
  /** 配置类变更（切模型 / 开关 / MCP）在任务运行中被推迟到下一轮重启（见 deferRestart）。 */
  private pendingRestart = false;
  /** 本实例是否有一轮在跑（run 已发出、还没收到终态事件）。推迟的重启必须等它结束。 */
  private runActive = false;
  private static MAX_CRASH_STREAK = 3;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.client.onEvent((envelope) => this.receive(envelope));
    this.client.onDiagnostic((message) =>
      this.receive({ type: 'event', event: 'host_log', payload: { message } }),
    );
    this.client.onExit(({ code, expected }) => {
      // 进程都没了就不存在「还在跑的一轮」：不清这一位，被推迟的配置重启会永远等不到下一次
      // run 前那次换代（applyPendingRestart 依赖它）。
      this.runActive = false;
      // host 一旦退出，未回执的面板请求已随进程终止，不能留在路由表里。
      for (const [id, pending] of pendingCommitMessages) {
        if (pending.agent === this) pendingCommitMessages.delete(id);
      }
      failPendingForks(this, tMain('main.fork.hostGone'));
      // 预期内的退出全是**我们自己**发起的（stop / 切模型重启 / 被新一次 start 打断）：
      // 这时任务要么马上会被重新拉起（重启后紧接着的那条 send），要么调用方已经自己收敛了状态
      // （删任务 / 回滚 / 退出应用，见各自的 handler）。以前一律 failTask + 发 host_exit，会把
      // 「重启后正常接着跑」的那一轮误报成「运行失败 / Agent 进程已停止」—— 用户看到的就是莫名的失败。
      if (expected) {
        if (!this.taskId.startsWith('workspace:')) {
          pushRenderer('work:agent-event', { type: 'event', event: 'host_stopped', requestId: this.taskId, payload: { code } });
        }
        return;
      }
      this.receive({ type: 'event', event: 'host_exit', payload: { code } });
      // 辅助 host 不属于任何任务，崩溃只让面板请求失败，不能弹出假任务失败。
      if (this.taskId.startsWith('workspace:')) return;
      // 真崩了：本任务的 run 不会再有 run_completed，就地收敛 + 自动重启一次。
      failTask(this.taskId, tMain('main.host.crashed', { code: code ?? 'null' }));
      const project = this.currentProject;
      if (project && this.crashStreak < LocalAgent.MAX_CRASH_STREAK) {
        this.crashStreak += 1;
        void this.start(project);
      }
    });
  }

  /** 当前 host 进程所在的工作目录 id（普通任务是 __scratch__），用于避免不必要的重启。 */
  get projectId(): string | null {
    return this.currentProject?.id ?? null;
  }

  /** 启动 host。返回是否真的起来了 —— 调用方据此决定要不要报错，绝不允许「没起来还往下走」。 */
  async start(project: Project): Promise<boolean> {
    if (this.stopped) return false;
    this.currentProject = project;
    const { loaded, missing } = loadMocodeConfig(project.root);
    // host_log 的 message 是**给人看**的（已按当前语言本地化），渲染层要据此决定弹不弹 toast。
    // 拿中文关键词去匹配会在切成英文后失效，所以额外带一个稳定 code 让渲染层判定。
    if (loaded.length) {
      this.receive({
        type: 'event',
        event: 'host_log',
        payload: { code: 'config_loaded', message: `[mocode-work] ${tMain('toast.configLoaded', { loaded: loaded.join(', ') })}` },
      });
    }
    if (missing.length) {
      this.receive({
        type: 'event',
        event: 'host_log',
        payload: { code: 'config_missing', message: `[mocode-work] ${tMain('toast.configMissing', { missing: missing.join(', ') })}` },
      });
    }

    let spec;
    try {
      spec = resolveMocodeHostLaunchSpec();
    } catch (cause) {
      this.crashStreak = LocalAgent.MAX_CRASH_STREAK;
      this.fail(tMain('main.host.noEntry', { raw: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    }
    this.receive({
      type: 'event',
      event: 'host_log',
      payload: {
        code: spec.usesElectronNode ? 'host_electron_node' : 'host_system_node',
        message: spec.usesElectronNode
          ? `[mocode-work] ${tMain('main.host.electronNode')}`
          : `[mocode-work] ${tMain('main.host.systemNode', { command: spec.command })}`,
      },
    });
    const starting = this.client.start(spec, {
      cwd: project.root,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        // 让 host 的 browser 工具接管面板那个页面，而不是另开一个浏览器进程。
        ...(browserCdpUrl ? { MOCODE_BROWSER_CDP_URL: browserCdpUrl } : {}),
      },
    });
    this.starting = starting;
    let failure: string | null = null;
    try {
      await starting;
    } catch (cause) {
      failure = describeHostStartFailure(cause);
    } finally {
      if (this.starting === starting) this.starting = null;
    }
    // stop 可能与 readiness 同时发生；主动报废不能报错，也不能被后续 send 重启。
    if (this.stopped) return false;
    if (failure) {
      this.fail(failure);
      return false;
    }
    if (!this.client.isRunning) {
      // 并发第二次 start()（例如「预热还没起完，用户就发了指令」）会顶掉我们这次的生成号，
      // 让我们的 startChild 直接 return、一个进程都没起 —— 那不是失败，是别人接手了。
      // 不等它出结果，就会把「被接手」误报成「启动失败」，用户平白看到一个红色错误。
      const reported = this.errorSeq;
      if (this.starting) await this.starting.catch(() => undefined);
      if (this.client.isRunning) {
        this.lastStartError = null;
        return true;
      }
      // 后一次 start 自己已经报过这次失败，就不再重复弹一条。
      if (this.errorSeq === reported) this.fail(tMain('main.host.stoppedEarly'));
      return false;
    }
    this.lastStartError = null;
    return true;
  }

  /**
   * 「这一轮没法跑」的唯一出口：记下原因 + 带 requestId 报到渲染层。
   * 所有失败路径都必须走这里 —— 静默 return 会让界面永远停在「正在启动 agent」。
   */
  private fail(message: string): void {
    this.lastStartError = message;
    this.receive({ type: 'error', error: message });
  }

  async send(value: HostCommand): Promise<boolean> {
    // stop() 之后实例已报废:任何未送达的指令本来就不再需要送达(调用方正在拆这个任务),
    // 直接静默返回 —— 否则 client 换代会让在飞的 send 抛「was replaced」,炸出一条假故障 toast。
    if (this.stopped) return false;
    // 配置变更后的第一次开跑:先换代 host，让新模型/新开关对这一轮就生效。
    // 推迟到此刻而不是切模型当下，正是为了不打断上一个还在跑的轮次。
    // runActive 仍为真 = 本条 run 只是接进当前轮的消息队列，不能在这里换代（会杀掉那一轮）。
    if ((value.type === 'run' || value.type === 'compact') && !this.runActive) this.applyPendingRestart();
    // 先等正在进行的 restart 收尾:client.stop() 只发了 kill,子进程尚未退出时
    // isRunning 仍为 true,若直接发会落到正在死掉的旧进程上(切换模型后最易踩)。
    if (this.restarting) await this.restarting;
    if (this.stopped) return false;
    if (!this.client.isRunning) {
      const project = this.currentProject;
      if (!project) {
        this.fail(tMain('main.host.couldNotStart'));
        return false;
      }
      if (this.crashStreak >= LocalAgent.MAX_CRASH_STREAK) {
        this.fail(tMain('main.host.continuousCrash'));
        return false;
      }
      // 已经有一次 start 在飞（创建任务时的预热还没起完）→ **等它**，别再发一次：
      // 再发会让 AgentHostClient 顶掉生成号，把正在启动的那个 host 杀掉
      // —— 用户看到的就是莫名其妙的「Agent 进程已停止」，还白搭一次冷启动。
      if (this.starting) await this.starting.catch(() => undefined);
      if (this.stopped) return false;
      if (!this.client.isRunning) {
        const reportedErrors = this.errorSeq;
        await this.start(project);
        if (!this.client.isRunning) {
          // start() 报过的具体原因就不再重复弹；没报过（并发早退等）也必须兜底一条。
          if (this.errorSeq === reportedErrors) {
            this.fail(this.lastStartError ?? tMain('main.host.couldNotStart'));
          }
          return false;
        }
      }
    }
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.stopped) return false;
    if (!this.client.isRunning) {
      this.fail(tMain('main.host.couldNotStart'));
      return false;
    }
    try {
      await this.client.send(value);
      this.crashStreak = 0;
      if (value.type === 'run') this.runActive = true;
      return true;
    } catch (cause) {
      // 与入口的 stopped 检查同理:stop() 与在飞的 send 竞态胜出时,client 换代抛
      // 「was replaced before the command could be sent」—— 这是主动报废,不该报给用户。
      if (this.stopped) return false;
      this.fail(tMain('main.host.sendFail', { raw: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    }
  }

  /**
   * 让 host 复制一份会话（终端的 /fork 同一条能力：整个会话目录复制 + 内部引用改写），等回执拿新 id。
   * fork 不改 host 的当前会话，所以调用方可以继续用这个 host 跑别的活。
   */
  async forkSessionOnHost(sessionId: string): Promise<ForkResult> {
    const requestId = `fork-${randomUUID()}`;
    const result = new Promise<ForkResult>((resolve) => {
      const timer = setTimeout(() => {
        pendingForks.delete(requestId);
        resolve({ ok: false, message: tMain('main.fork.timeout') });
      }, FORK_TIMEOUT_MS);
      pendingForks.set(requestId, { agent: this, resolve, timer });
    });
    const command: HostCommand = { id: requestId, type: 'sessions', action: 'fork', sessionId };
    const sent = await this.send(command).catch(() => false);
    if (!sent) {
      const pending = pendingForks.get(requestId);
      if (pending) {
        pendingForks.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, message: tMain('main.fork.failed') });
      }
    }
    return result;
  }

  /** host 现在是否活着（正在跑）。用于判断「停止」有没有必要发出去。 */
  get isRunning(): boolean {
    return this.client.isRunning;
  }

  stop(): void {
    this.stopped = true;
    this.currentProject = null;
    this.starting = null;
    for (const [id, pending] of pendingCommitMessages) {
      if (pending.agent === this) pendingCommitMessages.delete(id);
    }
    failPendingForks(this, tMain('main.fork.hostGone'));
    void this.client.stop();
  }

  /** 实例是否已被 stop() 报废(ensureAgent 据此丢弃旧实例,绝不复用)。 */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * 停掉当前 host 但**保留 currentProject** —— 下次 send 会走 send() 里的
   * `!this.client.isRunning` 分支自动重启并读最新配置。
   * /model 切换后必须调它:host 子进程启动时就固化了 config 快照,
   * 不重启的话新选的模型不会生效(仍按旧模型发请求)。
   * 若 host 本来就没在跑,是空操作。
   */
  restart(): void {
    this.starting = null;
    this.crashStreak = 0;
    this.pendingRestart = false;
    this.runActive = false;
    const stopping = this.client.stop();
    this.restarting = stopping.catch(() => undefined);
    void this.restarting.finally(() => {
      if (this.restarting === stopping) this.restarting = null;
    });
  }

  /**
   * 把「按新配置重启」推迟到下一次 run 之前。
   * 正在跑的轮次必须用旧配置跑完 —— 就地重启会杀掉 host、打断这一轮。
   */
  deferRestart(): void {
    if (this.stopped) return;
    this.pendingRestart = true;
  }

  /** 消费推迟的重启：下一次 run 发出前换代，新 host 才会读到新 env/config。 */
  private applyPendingRestart(): void {
    if (!this.pendingRestart) return;
    this.restart();
  }

  /** 本实例是否有一轮在跑（切模型等配置变更要据此推迟重启）。 */
  get isBusy(): boolean {
    return this.runActive;
  }

  private receive(envelope: HostEnvelope): void {
    if (envelope.requestId && (envelope.type === 'error' || envelope.event === 'commit_message_report')) {
      pendingCommitMessages.delete(envelope.requestId);
    }
    // 「复制会话」的回执必须就地拦下 —— 它只是分叉流程的中间步，不是给用户看的事件。
    if (envelope.requestId && pendingForks.has(envelope.requestId)) {
      if (envelope.event === 'session_forked' || envelope.type === 'error') {
        const pending = pendingForks.get(envelope.requestId)!;
        pendingForks.delete(envelope.requestId);
        clearTimeout(pending.timer);
        const payload = (envelope.payload ?? {}) as { sessionId?: unknown };
        pending.resolve(envelope.type === 'error'
          ? { ok: false, message: envelope.error || tMain('main.fork.failed') }
          : { ok: true, sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined });
        return;
      }
    }
    // 一轮的终态事件到达 = 这一轮跑完了，下次 run 前可以安全换代（见 applyPendingRestart）。
    // run_idle = host 那边本来就没有在跑的轮次（例如停止指令落到空转 host）。
    if (envelope.type === 'event'
      && (envelope.event === 'run_completed' || envelope.event === 'run_failed'
        || envelope.event === 'run_aborted' || envelope.event === 'run_idle')) {
      this.runActive = false;
    }
    if (envelope.type === 'error' && (envelope.requestId === undefined || envelope.requestId === this.taskId)) {
      // 这一轮压根没发出去 / host 报错：同样不再算「在跑」，否则切模型的推迟重启会永远等下去。
      this.runActive = false;
    }
    if (this.taskId.startsWith('workspace:')) {
      // 辅助 host 只给面板回执，不存在可失败的任务或恢复日志。
      if (envelope.type === 'error' && envelope.requestId?.startsWith('panel-')) this.errorSeq += 1;
      pushRenderer('work:agent-event', envelope);
      return;
    }
    if (envelope.type === 'event') updateTaskFromAgent(envelope);
    const attributed = envelope.requestId === this.taskId || envelope.requestId === undefined
      && (envelope.type === 'error' || envelope.event === 'host_exit');
    if (attributed && envelope.type === 'event' && envelope.event === 'run_completed') {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      if (Array.isArray(payload.changedFiles) && payload.changedFiles.length) {
        const changeSnapshotId = randomUUID();
        envelope = { ...envelope, payload: { ...payload, changeSnapshotId } };
        announceChangedFiles(this.taskId, payload, changeSnapshotId);
      }
    }
    if (attributed) recordRecoveryEvent(this.taskId, envelope);
    // 新一轮开始后不采用新的磁盘统计，上一轮的文件清单已随完成事件保存。
    if (attributed && envelope.type === 'event' && envelope.event === 'run_started') {
      changedFilesSeq.set(this.taskId, (changedFilesSeq.get(this.taskId) ?? 0) + 1);
    }
    if (envelope.type === 'error') {
      this.errorSeq += 1;
      // 面板命令（requestId = panel-*）的失败不属于任何一次 run：交给面板自己显示，
      // 不能顺手把正在跑的任务判成 failed —— 用户只是点了一下用量统计。
      if (envelope.requestId !== undefined && envelope.requestId !== this.taskId) {
        pushRenderer('work:agent-event', envelope);
        return;
      }
      // host 起不来 / send 失败（尚未就绪、连续崩溃、管道断开等）也必须收敛任务，
      // 否则任务停在 running 等一个永远不会来的 run_completed。
      failTask(this.taskId, envelope.error || tMain('main.host.commFailed'));
      // 一律补上 requestId(= 任务 id)：渲染层据此把失败归到正确的那条会话，
      // 而不是靠「当前正在看哪个任务」猜（切过任务就张冠李戴）。
      const attributed = { ...envelope, requestId: envelope.requestId ?? this.taskId };
      pushRenderer('work:agent-event', attributed);
      return;
    }
    pushRenderer('work:agent-event', envelope);
  }
}

/**
 * Windows 原生窗口按钮区（最小化/最大化/关闭）的底色：**透明**。
 *
 * 为什么不让主进程上色：那块区域是 Electron 的 titleBarOverlay，画在网页内容之上，
 * 只能吃一个十六进制值；而标题栏真实颜色来自 CSS `.titlebar` 的 `--surface-app`，
 * 那是带 accent 色相的 oklch token —— 深浅两套 × 6 套主题色 = 12 个值，还会随主题色切换变。
 * 写死 hex 永远追不上：浅色下 #f7f8f7 恰好接近 token 看不出问题，深色下 #202225 与
 * 标题栏 #080c09 差一整档，右端明显两块色（用户反馈即此）。
 * 传透明后该区域渗出网页自身的像素，按钮底色与 `.titlebar` 天然同色，无需任何同步。
 * 实测（Electron 43 / Windows）：透明时按钮区取样 = 标题栏取样；symbolColor 仍可独立设置。
 */
const TRANSPARENT_OVERLAY = '#00000000';

/**
 * 把窗口收进它当前所在显示器的工作区（算法见 window-fit.ts）。
 *
 * 为什么必须做：Windows 跨显示器拖动时**保留窗口原尺寸**。把高 1067px 的窗口拖到
 * 工作区只有 960px 的屏上，窗口就比自己所在的屏还高；而输入卡按设计贴在窗口底边
 * （.workspace 是 flex column，.composer-area 是最后一项），整块输入框于是被推出屏幕外——
 * 用户看到的就是「看不到输入框」，而且窗沿已顶到屏幕顶，拖也救不回来。渲染层无从修：
 * 它只是忠实按窗口尺寸排版（实测 innerHeight=1060 vs availHeight=960）。
 *
 * 没溢出就什么都不做：用户的尺寸/位置偏好必须保住，而且我们的 setBounds 会再触发
 * resize，无限改窗口会和用户拖拽打架。
 */
function fitWindowToDisplay(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
  const bounds = win.getBounds();
  // getDisplayMatching 按重叠面积最大的屏算：窗口跨两屏时跟着它主要所在的那块走。
  const fitted = clampToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea);
  if (fitted) win.setBounds(fitted);
}

/**
 * 主窗口的右键菜单。
 *
 * 为什么必须有：Electron 默认**不弹任何菜单**（浏览器原生菜单不属于 web 内容），
 * 于是用户拖选一段回答后右键是彻底没反应 —— 只能去找每条消息右上角那个「复制内容」按钮，
 * 而它复制的是整段、不是选区。
 *
 * 「弹哪些项」的决策在 context-menu.ts（纯函数、有单测），这里只做 Electron 侧的翻译。
 * 无可用项时按 contextMenuPlan 返回空数组 → 不弹，否则满屏右键都弹一个「全选」会让人以为点错了。
 *
 * 注意与渲染层的分工：xterm 终端面板自己 `preventDefault` 了 contextmenu（它有选区复制/
 * 无选区粘贴的专用语义），实测渲染层 preventDefault 后主进程这个事件**不会触发**，
 * 所以两者不会同时弹菜单。
 */
function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const selection = params.selectionText;
    const plan = contextMenuPlan({
      isEditable: params.isEditable,
      selectionText: selection,
      editFlags: {
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
    });
    if (!plan.length) return;
    const contents = win.webContents;
    const items: MenuItemConstructorOptions[] = plan.map((entry) => {
      if (entry.id === 'separator') return { type: 'separator' };
      if (entry.id === 'cut') return { label: tMain('menu.cut'), enabled: !entry.disabled, click: () => contents.cut() };
      if (entry.id === 'paste') return { label: tMain('menu.paste'), enabled: !entry.disabled, click: () => contents.paste() };
      if (entry.id === 'selectAll') return { label: tMain('menu.selectAll'), enabled: !entry.disabled, click: () => contents.selectAll() };
      // 只读文字的复制走主进程 clipboard：webContents.copy() 依赖焦点元素，
      // 而用户此刻的焦点可能还在输入框上，显式写剪贴板才不会复制错东西。
      return {
        label: tMain('menu.copy'),
        enabled: !entry.disabled,
        click: () => (params.isEditable ? contents.copy() : clipboard.writeText(selection)),
      };
    });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow(): void {
  // 应用图标(白底圆角正方形 + 像素兔)。dev 模式下用于窗口/Dock;Windows 任务栏 / 打包后的 .exe
  // 图标是 electron-builder 资源,需要打包时配 win.icon 才能换,这里管不到。
  const appIconPath = path.join(__dirname, 'assets', 'icon.png');
  // 窗口底色仍需跟随系统明暗：createWindow 到首帧渲染之间的空白期用的是它。
  const systemDark = nativeTheme.shouldUseDarkColors;
  windowRef = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 620, title: 'MoCode Work', backgroundColor: systemDark ? '#1b1c1f' : '#ffffff', autoHideMenuBar: true,
    ...(existsSync(appIconPath) ? { icon: appIconPath } : {}),
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      // 37 = titlebar 38px 减去 1px 底边线：overlay 若盖满 38，按钮区那段就缺少
      // .titlebar 的 border-bottom，肉眼可见一条断口。
      titleBarOverlay: { color: TRANSPARENT_OVERLAY, symbolColor: systemDark ? '#f5f5f5' : '#202124', height: 37 },
    } : {}),
    webPreferences: { preload: path.join(__dirname, 'renderer', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  windowRef.setMenuBarVisibility(false);
  // file:// 窗口必须显式放行 media（语音输入）和 clipboard-sanitized-write（复制按钮）。
  // 后者只允许用户主动写入系统剪贴板，不开放 clipboard-read；其它权限仍一律拒绝。
  const session = windowRef.webContents.session;
  const allowedPermissions = new Set(['media', 'clipboard-sanitized-write']);
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));
  // 面板里的站点是任意网页：一律拒绝它的权限请求（定位/通知/摄像头等），
  // 免得 agent 打开一个页面就顺带获得系统级能力。各个分区在 BrowserHost 建视图时还会装一次。
  denyPanelPermissions(state.selectedProjectId);
  installContextMenu(windowRef);
  void windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 窗口关掉立刻清掉引用,免得 agent 后续 stdout 还往里塞 → "Object has been destroyed"。
  windowRef.on('closed', () => { if (windowRef) windowRef = null; });

  // 跨显示器自适应（见 fitWindowToDisplay 注释）。
  // move / resize 在拖动与缩放过程中会连发几十次，必须防抖：只在手势结束、尺寸稳定后
  // 收一次，否则窗口会在用户手指下不断被改尺寸。
  // 必须用 move/resize 而不是 moved/resized：后者只在 WM_EXITSIZEMOVE（用户松手）时触发，
  // 程序化改窗口（Snap、其它工具、本函数的 setBounds）一次都不会走到，实测漏事件。
  const win = windowRef;
  win.on('closed', () => desktopPet.setEnabled(false));
  desktopPet.setCharacter(readSettings().petCharacter);
  desktopPet.setEnabled(readSettings().desktopPet);
  desktopPet.update(state.tasks);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { if (!win.isDestroyed()) fitWindowToDisplay(win); }, 180);
  };
  win.on('move', settle);
  win.on('resize', settle);
  // 系统侧变化（改缩放 / 拔插显示器 / 任务栏位置变了）也会让窗口溢出 —— 那时没有窗口事件。
  const onDisplaysChanged = (): void => { if (!win.isDestroyed()) fitWindowToDisplay(win); };
  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  win.on('closed', () => {
    if (settleTimer) clearTimeout(settleTimer);
    screen.removeListener('display-metrics-changed', onDisplaysChanged);
    screen.removeListener('display-added', onDisplaysChanged);
    screen.removeListener('display-removed', onDisplaysChanged);
  });
}

/** 让窗口原生背景和 Windows 控制按钮的符号色跟随应用主题。
 *
 *  overlay 的**底色恒为透明**（见 TRANSPARENT_OVERLAY）：底色由 CSS `.titlebar` 决定，
 *  主进程只负责按钮符号（— □ ✕）的深浅，否则深色主题下会得到一组看不见的深色符号。 */
function applyThemeBackground(theme: 'light' | 'dark' | 'system'): void {
  nativeTheme.themeSource = theme;
  const isDark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark';
  const bg = isDark ? '#1b1c1f' : '#ffffff';
  windowRef?.setBackgroundColor(bg);
  if (process.platform === 'win32' && windowRef && !windowRef.isDestroyed()) {
    windowRef.setTitleBarOverlay({
      color: TRANSPARENT_OVERLAY,
      symbolColor: isDark ? '#f5f5f5' : '#202124',
      // 37 = titlebar 38px - 1px CSS 底边线：overlay 若盖满 38，按钮区那段就没有
      // .titlebar 的 border-bottom，肉眼可见一条断口。
      height: 37,
    });
  }
}

/**
 * 打开任务时要回给渲染层的那份「现场」：任务记录 + 会话历史 + 恢复日志快照。
 *
 * 必须 async：readRecovery 要读整份 JSONL（真机实测 32MB = 240ms），同步读会把 Electron
 * 主线程钉死，期间点击 / 输入 / 切会话全部排队 —— 用户看到的就是「agent 在跑的时候点哪都卡」。
 * renderer 那边本来就在 await invoke，改成异步对它没有任何 API 变化。
 */
async function currentTaskWorkspace(task: TaskRecord): Promise<Record<string, unknown>> {
  const project = workspaceForTask(task);
  const running = task.status === 'running' || task.status === 'waiting';
  // 日志本身无法区分“正在执行”与“进程已消失”；只有主进程知道任务是否仍活着。
  const recovery = await readRecoveryAsync(recoveryRoot(), task.id, running);
  if (recovery) {
    recovery.running = running;
    recovery.interrupted = !running && (recovery.interrupted === true || task.lastError === STALE_RUN_MARKER);
  }
  return { task, history: project ? sessionHistory(project, task.sessionId) : [], recovery };
}

/**
 * 任务级 agent 实例：懒创建,创建即预热 host（异步,不阻塞 IPC 返回）。
 * 每个任务独享一个 host 子进程 —— 并行任务互不抢 cwd / 会话。
 *
 * **任何要用到 agent 的地方都必须走这里**（尤其是 agent-send）：
 * agents 表是进程内内存，应用重启后只剩任务记录、没有 agent 实例；
 * 早先只靠 create-task 建实例，于是「重启后打开旧任务 → 直接发指令」会查不到实例，
 * 指令被静默丢掉 —— 界面就一直停在「正在启动 agent」。
 */
function ensureAgent(task: TaskRecord): LocalAgent {
  const workspace = workspaceForTask(task);
  const existing = agents.get(task.id);
  // 被 stop() 报废的实例(回滚 / 删任务 / 退出)直接丢弃 —— stopped 是单向闸门,
  // 它的 send() 会静默吞掉一切指令,复用它等于让这个任务永远哑掉。
  if (existing?.isStopped) agents.delete(task.id);
  const current = agents.get(task.id);
  if (current) {
    // start 失败等场景下实例还在表里但没有 cwd:就地重新绑定,
    // 否则下一次 send 会以「还没起来」失败。
    if (!current.projectId && workspace) void current.start(workspace);
    return current;
  }
  const agent = new LocalAgent(task.id);
  agents.set(task.id, agent);
  if (workspace) void agent.start(workspace);
  return agent;
}

/**
 * 没有任务时，源代码管理仍可使用当前空间。辅助 host 以工作空间为键，
 * 只处理独立面板请求，没有用户任务记录，也不会创建或写入任何会话。
 */
function ensureProjectAgent(project: Project): LocalAgent {
  const key = `workspace:${project.id}`;
  const existing = agents.get(key);
  if (existing && !existing.isStopped) return existing;
  return ensureAgent({ id: key, projectId: project.id, title: '', status: 'queued', createdAt: '', updatedAt: '', changedFiles: [] });
}

/** 取消仅命中已经登记的面板请求，绝不能把目标 id 当成任务 id 转发。 */
function cancelPendingCommitMessage(targetId: string): void {
  const pending = pendingCommitMessages.get(targetId);
  if (!pending) return;
  pendingCommitMessages.delete(targetId);
  const agent = pending.agent;
  if (!agent || agent.isStopped) return;
  const command = { id: `${targetId}-cancel-host`, type: 'cancel_commit_message', targetId } as HostCommand;
  if (pending.sent) {
    // 等原命令送达后再取消，避免两次懒启动互相顶掉 host 世代。
    void pending.sent.then((sent) => sent && !agent.isStopped ? agent.send(command) : false).catch(() => false);
  } else if (agent.isRunning) {
    void agent.send(command);
  }
}

/** Git 工作空间只从已登记的任务 / 项目解析，renderer 不能传任意目录。 */
function gitWorkspace(payload: unknown): Project | null {
  const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (input.taskId !== undefined && typeof input.taskId !== 'string') return null;
  if (input.projectId !== undefined && typeof input.projectId !== 'string') return null;
  if (typeof input.taskId === 'string' && input.taskId) {
    const task = taskById(input.taskId);
    const project = task ? workspaceForTask(task) : undefined;
    // 任务换绑空间后，旧面板请求也不能落到新空间。
    return project && (input.projectId === undefined || project.id === input.projectId) ? project : null;
  }
  // 无任务请求固定到点击时的空间，不跟随 IPC 到达时的全局选择漂移。
  if (typeof input.projectId === 'string') return state.projects.find((item) => item.id === input.projectId) ?? null;
  return selectedProject() ?? null;
}

/**
 * 解析一次 SCM 请求的目标仓库：`repoRoot` 缺省是工作空间自身，显式给出时必须是
 * 工作空间/主仓库之内的真实仓库（见 validateRepoRoot），渲染层不能借此操作任意目录。
 */
async function repoFor(project: Project, payload: unknown): Promise<string | null> {
  const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (input.repoRoot !== undefined && typeof input.repoRoot !== 'string') return null;
  const requested = typeof input.repoRoot === 'string' && input.repoRoot ? input.repoRoot : project.root;
  return validateRepoRoot(project.root, requested);
}

/**
 * 「改动」「检查」两个面板的目标：**必须**是一个任务，而不是单纯的工作空间。
 *
 * 与 gitWorkspace 的区别就在这里：那两个面板回答的是「这个任务的 agent 干了什么」和
 * 「这个任务的工作区该跑哪些校验」，没有任务就没有主语。没有任务时返回 null，
 * 由调用方给出可读的空态，而不是退回到全局选中的空间去猜。
 */
function taskWorkspaceTarget(payload: unknown): { task: TaskRecord; project: Project } | null {
  const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const taskId = typeof input.taskId === 'string' && input.taskId ? input.taskId : state.selectedTaskId;
  const task = taskById(taskId);
  if (!task) return null;
  const project = workspaceForTask(task);
  return project ? { task, project } : null;
}

/** 判定包管理器用的锁文件（顺序无关：packageManagerFor 自己决定优先级）。 */
const CHECK_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json'] as const;

/** 把一条「无法执行」的失败送回渲染层（带任务 id，渲染层能归到正确的会话上）。 */
function reportTaskError(taskId: string, message: string): void {
  pushRenderer('work:agent-event', { type: 'error', requestId: taskId, error: message });
}

/**
 * 归一化到可直接展示的 `host`。写预设时 baseURL 可能不带协议（如 `api.deepseek.com/v1`），
 * 所以先补 https:// 再解析；仍然解析失败就退化成截掉路径的原始串，绝不返回空。
 */
function maskUrl(raw: string): string {
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.host || '';
  } catch {
    return raw.split('/')[0] ?? '';
  }
}

/**
 * 提供商键：把 host 里的 `www.` / `api.` 这类常见前缀剥掉，让
 * `api.deepseek.com`、`www.deepseek.com`、`platform.deepseek.com` 归到同一个提供商。
 * 用作 renderer 分组的 key（同 key 必同组，不会出现同一家被拆成两栏）。
 */
function providerHostOf(raw: string): string {
  const host = maskUrl(raw).toLowerCase();
  if (!host) return '';
  // 去掉端口再当分组键：同一台机器上不同端口的自建网关仍算同一家提供商。
  const parts = (host.split(':')[0] ?? '').split('.');
  while (parts.length > 2 && /^(www|api|platform|open|gateway)$/.test(parts[0]!)) parts.shift();
  return parts.join('.');
}

function installIpc(): void {
  ipcMain.handle('work:get-state', () => state);
  ipcMain.handle('work:pick-project', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = await projectFor(result.filePaths[0]);
    const existing = state.projects.find((item) => item.id === project.id);
    if (existing) Object.assign(existing, project); else state.projects.push(project);
    state.selectedProjectId = project.id;
    // 打开新空间只切换浏览器上下文，不动任何任务的归属 ——
    // 归属变更走 work:set-task-project（chip / 任务菜单显式触发）。
    // 顺带收走没人要的空草稿：切走之后它连「当前正在编辑」都不是了。
    discardEmptyDrafts();
    state.selectedTaskId = undefined;
    saveState(); broadcastState(); return state;
  });
  ipcMain.handle('work:select-project', async (_event, projectId: string) => {
    if (!state.projects.some((item) => item.id === projectId)) return state;
    state.selectedProjectId = projectId;
    // 同上：切空间不清空当前查看的任务（任务保留在各自分组里，切回去还在）。
    saveState(); broadcastState(); return state;
  });
  // projectId 显式传 '' = 纯任务（不进任何空间，落到 scratch 目录）；传项目 id = 归入对应空间；
  // 不传 = 跟随当前选中的空间（兼容旧调用，renderer 已改为显式传参）。
  ipcMain.handle('work:create-task', async (_event, title: string, projectId?: string) => {
    const now = new Date().toISOString();
    let targetProjectId: string;
    if (typeof projectId === 'string') {
      targetProjectId = projectId && state.projects.some((item) => item.id === projectId) ? projectId : '';
    } else {
      targetProjectId = selectedProject().id;
    }
    const task: TaskRecord = { id: randomUUID(), projectId: targetProjectId, title: title.slice(0, 160), status: 'queued', createdAt: now, updatedAt: now, changedFiles: [] };
    // 新建即意味着「上一个空草稿没人要了」：连点两个空间的 + 不该在两个空间下各留一条空任务。
    discardEmptyDrafts(task.id);
    state.tasks.unshift(task); state.selectedTaskId = task.id;
    if (targetProjectId) state.selectedProjectId = targetProjectId;
    saveState(); broadcastState();
    ensureAgent(task);
    return { state, task };
  });
  /**
   * 关联 / 解除任务的工作空间 —— 「任务」与「空间」两个分组之间的唯一通路。
   * projectId 传 '' = 纯任务（落到 userData/scratch）；传项目 id = 归入该空间。
   *
   * 只允许**从未跑过**的任务改归属：agent host 的 cwd 在启动时固化，会话历史也按
   * <root>/.mocode/sessions 落盘，跑过之后再换目录会让历史与新目录错位（旧会话找不回）。
   * 返回 { ok:false } 时 renderer 会拿 message 提示用户。
   */
  ipcMain.handle('work:set-task-project', async (_event, taskId: string, projectId: string) => {
    const task = taskById(taskId);
    if (!task || typeof projectId !== 'string') return { ok: false, message: tMain('main.task.projectNotExist') };
    if (task.sessionId || task.status === 'running' || task.status === 'waiting') {
      return { ok: false, message: tMain('main.task.cannotChangeSpace') };
    }
    const target = projectId && state.projects.some((item) => item.id === projectId) ? projectId : '';
    const agent = agents.get(task.id);
    // cwd 变了 → 旧 host（按旧目录启动）作废，下次 send 按新目录重启。
    if (agent) { agent.stop(); agents.delete(task.id); }
    task.projectId = target;
    if (target) state.selectedProjectId = target;
    saveState(); broadcastState();
    ensureAgent(task);
    return { ok: true, state, task };
  });
  ipcMain.handle('work:select-task', async (_event, taskId: string) => {
    const task = taskById(taskId); if (!task) return null;
    // 选中项离开一条空草稿 → 丢弃它（判定与理由见 discardEmptyDrafts / task-draft.ts）。
    discardEmptyDrafts(task.id);
    state.selectedTaskId = task.id;
    // 普通任务不改变当前选中的项目（空间高亮保持不变）
    if (task.projectId) {
      const project = workspaceForTask(task);
      if (project) state.selectedProjectId = project.id;
    }
    saveState(); broadcastState();
    // 打开任务（含应用重启后恢复出来的旧任务）就预热 host：不然用户敲下第一条指令时才开始
    // 冷启动（实测 ~8s，开 MCP 更久），且没有实例时指令会被丢掉。
    ensureAgent(task);
    return { state, ...await currentTaskWorkspace(task) };
  });
  // 回滚对话:截断会话到指定用户消息之前。
  // 落盘之后必须重启该任务的 host —— 它内存里还留着被回滚掉的历史,继续用同一个进程会
  // 在下一轮结束时把旧历史全量写回磁盘,回滚当场失效(这就是为什么这里不要走 online 通道)。
  ipcMain.handle('work:rollback', async (_event, taskId: string, userIndex: number) => {
    if (typeof taskId !== 'string' || !taskId || typeof userIndex !== 'number') return { ok: false, message: tMain('main.rollback.invalidParam') };
    const task = taskById(taskId);
    if (!task) return { ok: false, message: tMain('main.task.projectNotExist') };
    const rolled = rollbackSession(task, userIndex);
    if (!rolled.ok) return rolled;
    // ⚠️ 这里**不能**先给 host 发 cancel 再 stop:cancel 若抢先送达,host 会「优雅收尾」,
    // 在 turn 结束时把内存里的**旧历史全量写回**会话文件 —— 刚截断的回滚当场被覆盖。
    // stop() 直接杀进程,内存态作废,截断才能保住。(在飞的 send 被 stop 顶掉也不会报错,见 LocalAgent.stopped)
    const agent = agents.get(taskId);
    if (agent) { agent.stop(); agents.delete(taskId); }
    if (task.status === 'running' || task.status === 'waiting') task.status = 'cancelled';
    task.lastError = undefined;
    taskRecovery(taskId).truncate(userIndex);
    saveState(); broadcastState();
    return { ok: true, state, ...await currentTaskWorkspace(task) };
  });
  /**
   * 分叉会话：从这条 assistant 消息所在的那一轮之后开一个新分支。
   *
   * 做法（与终端 /fork 同一条能力，只是多一步截断）：
   *   1. 让**原任务的 host** 复制会话目录（内存里最新的尾巴由 host 自己先落盘）；
   *   2. 把副本截断到「第 userIndex 轮结束」——之后的对话不带过去；
   *   3. 建一个新任务绑定副本的 sessionId，选中它并回放历史，界面直接跳过去。
   *
   * 为什么必须让原 host 来复制：会话是「活文件 + host 内存历史」两份，主进程直接 cp 只能拿到
   * 上一次 checkpoint 的内容，最近一轮会丢。fork 不改 host 的当前会话，原任务继续可用。
   */
  ipcMain.handle('work:fork-task', async (_event, taskId: string, userIndex: number) => {
    if (typeof taskId !== 'string' || !taskId || typeof userIndex !== 'number' || userIndex < 0) {
      return { ok: false, message: tMain('main.fork.invalidParam') };
    }
    const task = taskById(taskId);
    if (!task) return { ok: false, message: tMain('main.task.projectNotExist') };
    if (!task.sessionId) return { ok: false, message: tMain('main.fork.noSession') };
    if (task.status === 'running' || task.status === 'waiting') return { ok: false, message: tMain('main.fork.notIdle') };
    const project = workspaceForTask(task);
    if (!project) return { ok: false, message: tMain('main.rollback.noWorkspace') };
    // 必须在停掉 host 之前复制：host 要先把内存里的最新对话落盘（与终端 /fork 同因）。
    const agent = agents.get(task.id) ?? ensureAgent(task);
    const forked = await agent.forkSessionOnHost(task.sessionId);
    if (!forked.ok || !forked.sessionId) return { ok: false, message: forked.message ?? tMain('main.fork.failed') };
    const newSessionId = forked.sessionId;
    // 截断副本。失败就把刚烤出来的副本删掉——半成品会话（带着不该有的后续轮次）比没有更危险。
    const copyFile = sessionFileFor(project, newSessionId);
    if (!copyFile) return { ok: false, message: tMain('main.fork.copyMissing') };
    let truncated = false;
    try {
      const record = JSON.parse(readFileSync(copyFile, 'utf8')) as RawSessionRecord;
      const result = truncateSessionAfterUser(record, userIndex, {
        noHistory: tMain('main.rollback.noHistory'),
        compacted: tMain('main.rollback.compacted'),
      });
      if (result.ok) {
        const tmp = `${copyFile}.fork-tmp`;
        writeFileSync(tmp, JSON.stringify(record), 'utf8');
        renameSync(tmp, copyFile);
        truncated = true;
      } else {
        rmSync(path.dirname(copyFile), { recursive: true, force: true });
        return { ok: false, message: result.message ?? tMain('main.fork.failed') };
      }
    } catch {
      try { rmSync(path.dirname(copyFile), { recursive: true, force: true }); } catch { /* 清理失败不遮住真正的原因 */ }
      return { ok: false, message: tMain('main.fork.truncateFailed') };
    }
    if (!truncated) return { ok: false, message: tMain('main.fork.failed') };
    const now = new Date().toISOString();
    const branch: TaskRecord = {
      id: randomUUID(), projectId: task.projectId,
      title: tMain('main.fork.title', { title: task.title }).slice(0, 160),
      status: 'completed', createdAt: now, updatedAt: now, changedFiles: [], sessionId: newSessionId,
    };
    discardEmptyDrafts(branch.id);
    state.tasks.unshift(branch);
    state.selectedTaskId = branch.id;
    if (branch.projectId) state.selectedProjectId = branch.projectId;
    saveState(); broadcastState();
    // 新任务也预热 host：用户点了分支就是要立刻接着聊，不该再等一次冷启动。
    ensureAgent(branch);
    return { ok: true, state, ...await currentTaskWorkspace(branch) };
  });
  ipcMain.handle('work:delete-task', (_event, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) return null;
    // 任务 id 全局唯一，且「任务」「空间」两个分组都会展示任务 —— 不能再按 selectedProjectId 拦，
    // 否则在「任务」分组里删空间任务（或反之）会被静默拒绝。
    const task = taskById(taskId);
    if (!task) return null;
    // 任务整个删除,host 直接杀(发 cancel 毫无收益:进程反正要死,还可能与 stop 竞态炸假故障)。
    const agent = agents.get(taskId);
    if (agent) { agent.stop(); agents.delete(taskId); }
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    removeRecovery(taskId);
    if (state.selectedTaskId === taskId) state.selectedTaskId = undefined;
    saveState(); broadcastState(); return state;
  });
  ipcMain.handle('work:clear-tasks', (_event, projectId?: string) => {
    const targetProjectId = projectId ?? state.selectedProjectId;
    const selectedTaskId = state.selectedTaskId;
    const removed = state.tasks.filter((task) => task.projectId === targetProjectId && task.status !== 'running' && task.status !== 'waiting');
    for (const task of removed) {
      const agent = agents.get(task.id);
      if (agent) { agent.stop(); agents.delete(task.id); }
      removeRecovery(task.id);
    }
    const removedIds = new Set(removed.map((task) => task.id));
    state.tasks = state.tasks.filter((task) => !removedIds.has(task.id));
    if (selectedTaskId && !state.tasks.some((task) => task.id === selectedTaskId)) state.selectedTaskId = undefined;
    saveState(); broadcastState(); return state;
  });
  // 重命名任务：保留其余字段，仅覆盖 title。用于侧栏双击重命名与「新建任务」弹窗的重命名模式。
  ipcMain.handle('work:rename-task', (_event, taskId: string, title: string) => {
    if (typeof taskId !== 'string' || !taskId || typeof title !== 'string') return null;
    const task = taskById(taskId);
    if (!task) return null;
    task.title = title.trim().slice(0, 160) || task.title;
    saveState(); broadcastState();
    return state;
  });
  // 重命名项目：仅覆盖展示名（不影响 root/branch）。
  ipcMain.handle('work:rename-project', (_event, projectId: string, name: string) => {
    if (typeof projectId !== 'string' || !projectId || typeof name !== 'string') return null;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return null;
    project.name = name.trim().slice(0, 80) || project.name;
    saveState(); broadcastState();
    return state;
  });
  // 在系统文件管理器里打开项目文件夹。
  ipcMain.handle('work:open-folder', (_event, projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return false;
    shell.openPath(project.root).catch(() => {});
    return true;
  });
  /**
   * 在文件管理器里**定位**一个文件（不是打开它）。
   *
   * 存在的理由：agent 跑完构建会在回复里给出产物路径（`packages/work-app/release/MoCode Work-1.1.0-setup.exe`），
   * 用户真正想做的是去那个目录把文件拿出来 —— 让他在预览面板里看一个 148MB 的二进制毫无意义，
   * 而手动从项目根逐级点进 release/ 又很繁琐。`showItemInFolder` 直接选中该文件。
   *
   * 路径可以是相对（按当前任务的工作区解析，产物与改动都记在任务里）或绝对
   * （用户从别处粘来的路径）。只做存在性检查 —— 定位不会读文件内容，越界读取的风险不适用于这里。
   */
  ipcMain.handle('work:reveal-file', (_event, input: string) => {
    if (typeof input !== 'string' || !input.trim()) return { ok: false, message: tMain('main.reveal.missing', { path: String(input ?? '') }) };
    const root = taskWorkspaceTarget(undefined)?.project.root ?? state.projects[0]?.root ?? '';
    const absolute = path.isAbsolute(input) ? input : root ? path.resolve(root, input) : '';
    if (!absolute || !existsSync(absolute)) return { ok: false, message: tMain('main.reveal.missing', { path: input }) };
    shell.showItemInFolder(absolute);
    return { ok: true, path: absolute };
  });
  // 从空间列表中移除一个项目（不删除磁盘文件，仅从 UI 列表移除）。
  ipcMain.handle('work:remove-project', (_event, projectId: string) => {
    if (typeof projectId !== 'string' || !projectId) return null;
    const idx = state.projects.findIndex((item) => item.id === projectId);
    if (idx === -1) return null;
    const removed = state.projects.splice(idx, 1)[0];
    // 如果移除的是当前选中项目，切到第一个剩余项目。
    // ⚠ **不能顺手清 selectedTaskId**：正在查看的任务可能属于别的空间，或者是 projectId
    // 为空的普通任务 —— 它根本没被删。把它一起取消选中，渲染层就会以为「当前没有任务」
    // 并清空会话区，而那个任务其实还在跑、事件还在来，症状就是「跑着的会话突然冒出来」。
    // 只有这个被查看的任务本身属于被删空间时才清。
    if (state.selectedProjectId === projectId) {
      state.selectedProjectId = state.projects[0]?.id ?? '';
      const viewing = state.selectedTaskId ? state.tasks.find((task) => task.id === state.selectedTaskId) : undefined;
      if (!viewing || viewing.projectId === projectId) state.selectedTaskId = undefined;
    }
    // 先撤销未发出的请求，再停辅助 host；异步 diff 返回后也不能把它重新拉起来。
    for (const [id, pending] of pendingCommitMessages) {
      if (pending.projectId === projectId) cancelPendingCommitMessage(id);
    }
    const projectAgent = agents.get(`workspace:${projectId}`);
    if (projectAgent) { projectAgent.stop(); agents.delete(`workspace:${projectId}`); }
    // 清理该项目的任务与其 agent 实例(直接杀,理由同 delete-task)
    for (const task of state.tasks.filter((task) => task.projectId === projectId)) {
      const agent = agents.get(task.id);
      if (agent) { agent.stop(); agents.delete(task.id); }
      removeRecovery(task.id);
    }
    state.tasks = state.tasks.filter((task) => task.projectId !== projectId);
    // 自动并入的空间被移除后必须记住：不然下次启动 registy 同步又把它加回来，
    // 用户会看到「移除 → 重启 → 又出现了」，像是移除没生效。
    if (removed.auto) {
      state.hiddenProjects = [...(state.hiddenProjects ?? []).filter((id) => id !== projectId), projectId];
    }
    saveState(); broadcastState();
    return { state, removed: removed.name };
  });
  /**
   * 某个工作空间里终端留下的历史会话（供侧栏「历史会话」分组与接管）。
   *
   * 上限 400 而不是 40：mocode 主仓库实测有 284 条会话，40 条会让「历史会话 (284)」
   * 展开后只看到零头，看着像丢数据。
   */
  ipcMain.handle('work:project-sessions', (_event, projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return [];
    return listProjectSessions(project.root, 400);
  });
  /**
   * 侧栏内联区要用的「每个空间最近几条会话」——一次 IPC 批量取回。
   *
   * 为什么要批量而不是让渲染层逐空间调 work:project-sessions：内联区在每次状态更新时
   * 都要重算（任务变了排序就变），逐空间 await 会把侧栏滚动卡成一顿一顿的。这里只在
   * 启动与 sessionCount 变化时取一次，渲染层缓存起来同步用。
   * 每个空间只读 20 条：内联最多展示 6 行，留足余量应付「已接管的会话要跳过」。
   */
  ipcMain.handle('work:space-recent-sessions', () =>
    state.projects.map((project) => ({
      projectId: project.id,
      sessions: listProjectSessions(project.root, 20),
    })),
  );
  /**
   * 接管一条终端历史会话：在对应空间里建一个绑定该 sessionId 的任务。
   *
   * 绑定 sessionId 后，第一次发指令时 host 的 `prepareSession(command.sessionId)` 会
   * 直接把那条会话读回内存继续对话 —— 不是复制、不是导入，就是同一个会话。
   * 已经接管过的（同 projectId + sessionId）不重复建，直接返回既有任务。
   */
  ipcMain.handle('work:adopt-session', async (_event, payload: { projectId?: unknown; sessionId?: unknown; title?: unknown }) => {
    const projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    const project = state.projects.find((item) => item.id === projectId);
    if (!project || !SESSION_DIR_RE.test(sessionId)) return { ok: false, message: tMain('main.task.projectNotExist') };
    const existing = state.tasks.find((task) => task.projectId === projectId && task.sessionId === sessionId);
    if (existing) {
      // 接管一条已有会话 = 离开当前那个空草稿，把它收走。
      discardEmptyDrafts(existing.id);
      state.selectedTaskId = existing.id;
      saveState(); broadcastState();
      return { ok: true, state, task: existing, ...await currentTaskWorkspace(existing) };
    }
    const meta = listProjectSessions(project.root, 400).find((item) => item.id === sessionId);
    const now = new Date().toISOString();
    const title = typeof payload?.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 160)
      : (meta?.firstUser?.replace(/\s+/g, ' ').trim().slice(0, 60) || sessionId);
    const task: TaskRecord = {
      id: randomUUID(), projectId, title, status: 'completed',
      // 排序键沿用该会话自己的最后活动时间，**不是 now**：接管只是「打开看一眼」，
      // 用 now 会把一条几个月前的旧会话顶到正在跑的任务上面（用户报的就是这个）。
      createdAt: meta?.createdAt || now,
      updatedAt: meta?.lastActiveAt || meta?.createdAt || now,
      changedFiles: [], sessionId,
    };
    discardEmptyDrafts(task.id);
    state.tasks.unshift(task);
    state.selectedTaskId = task.id;
    state.selectedProjectId = projectId;
    saveState(); broadcastState();
    // 接管不预热 host：用户可能只是想看历史，敲下第一句话时 ensureAgent 会按该会话恢复。
    return { ok: true, state, task, ...await currentTaskWorkspace(task) };
  });
  ipcMain.handle('work:project-overview', async () => {
    // 纯任务（无工作空间）没有 git 仓库可概览：返回一份空壳，避免 renderer 拿 scratch 目录
    // 当成项目展示（那里只有聊天记录，没有代码）。
    const task = taskById(state.selectedTaskId);
    if (task && !task.projectId) return { project: null, branch: '', status: [], diffStat: '', lastCommit: '', files: [], noWorkspace: true };
    return projectOverview(selectedProject());
  });
  ipcMain.handle('work:read-file', (_event, relativePath: string) => {
    const target = resolvedProjectFile(selectedProject(), relativePath); if (!target) return { error: tMain('main.read.outside') };
    try { return { path: relativePath, content: readFileSync(target, 'utf8').slice(0, 200_000) }; } catch { return { error: tMain('main.read.unreadable') }; }
  });
  ipcMain.handle('work:file-diff', async (_event, relativePath: string) => {
    const target = resolvedProjectFile(selectedProject(), relativePath); if (!target) return { error: tMain('main.read.outside') };
    const result = await runCommand(selectedProject().root, 'git', ['diff', '--', relativePath]); return { path: relativePath, content: result.ok ? result.stdout || tMain('main.read.noDiff') : result.stderr };
  });
  /**
   * 「改动」面板：本任务记录下来的 changedFiles + 每个文件相对 HEAD 的增删行数。
   *
   * 数据源是任务自己的 changedFiles（run_completed 时由 host 落盘），不是 git status ——
   * 用户可能自己还有别的未提交改动，那些不属于「这次 agent 干了什么」。
   */
  ipcMain.handle('work:task-changes', async (_event, payload: Record<string, unknown>) => {
    const target = taskWorkspaceTarget(payload);
    if (!target) return { ok: false, files: [], message: tMain('main.task.projectNotExist') };
    const files = target.task.changedFiles.filter((item): item is string => typeof item === 'string' && item !== '');
    if (!files.length) return { ok: true, files: [], truncated: false };
    const result = await gitFileStats(target.project.root, files);
    return { ok: result.ok, files: result.stats, truncated: files.length > 200, message: result.message };
  });
  /**
   * 输入框下面那行 token 消耗里的「本会话」口径。
   *
   * 直接读 <工作区>/.mocode/sessions/<id>/usage.jsonl 就地汇总，**不启也不经过 host**：
   * 这个数字每轮结束都要刷新，为一条只读统计唤醒一个 agent host 太重；行格式与 host 的
   * 用量面板同源，两边算出来的数一致（会话目录已归档时回退全局账本）。
   */
  ipcMain.handle('work:session-usage', (_event, payload: Record<string, unknown>) => {
    const target = taskWorkspaceTarget(payload);
    if (!target || !target.task.sessionId) return { ok: true, usage: null };
    return { ok: true, usage: summarizeSessionUsage(target.project.root, target.task.sessionId) };
  });
  /** 「改动」面板里展开单个文件：与列表同一基准（HEAD），不要求该文件仍在 git status 里。 */
  ipcMain.handle('work:task-change-diff', async (_event, payload: Record<string, unknown>) => {
    const target = taskWorkspaceTarget(payload);
    if (!target || typeof payload.path !== 'string') return { ok: false, message: tMain('main.task.projectNotExist') };
    return gitFileDiff(target.project.root, payload.path);
  });
  /**
   * 「检查」面板：从磁盘上的 package.json 发现校验命令（根 + workspace 子包）。
   *
   * 只读 package.json，**不执行任何命令** —— 点击后由渲染层把 `pm run x` 填进终端，
   * 执行通道仍是用户自己的 shell（能看输出、能 Ctrl+C、能改一行再跑）。
   */
  ipcMain.handle('work:checks', async (_event, payload: Record<string, unknown>) => {
    const target = taskWorkspaceTarget(payload);
    if (!target) return { ok: false, groups: [], message: tMain('main.task.projectNotExist') };
    const root = target.project.root;
    const readManifest = (dir: string): string | null => {
      try { return readFileSync(path.join(root, dir, 'package.json'), 'utf8'); } catch { return null; }
    };
    const rootText = readManifest('');
    const lockfiles = CHECK_LOCKFILES.filter((name) => existsSync(path.join(root, name)));
    // 子包目录由根 package.json 的 workspaces 推导；上限 40 组，防止大 monorepo 把面板刷爆。
    const { literal, globs } = workspaceDirs(parsePackage(rootText)?.workspaces ?? []);
    const dirs: string[] = [...literal];
    for (const prefix of globs) {
      try {
        for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
          if (entry.isDirectory()) dirs.push(`${prefix}/${entry.name}`);
        }
      } catch { /* 通配前缀不存在：跳过，不是错误 */ }
    }
    const entries = [
      { dir: '', text: rootText, lockfiles },
      ...dirs.sort().slice(0, 40).map((dir) => ({ dir, text: readManifest(dir), lockfiles: [] })),
    ];
    const { packageManager, groups } = buildCheckGroups(entries);
    return { ok: true, packageManager, groups };
  });
  ipcMain.handle('work:pick-attachment', async () => {
    const result = await dialog.showOpenDialog(windowRef!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images & documents', extensions: ATTACHMENT_EXTENSIONS }],
    });
    return result.canceled ? [] : Promise.all(result.filePaths.map(readAttachment));
  });
  // 拖入文件由 preload 从 Electron File.path 取真实路径；解析只在主进程做，renderer 不碰 fs。
  ipcMain.handle('work:read-attachments', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return [];
    const files = paths.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item)).slice(0, 32);
    return Promise.all(files.map(readAttachment));
  });
  // 把模型 / 上下文等关键配置透出给 renderer,用于在 UI 上显示真实信息。
  // 注意:不返回 LLM_API_KEY 等敏感字段。
  ipcMain.handle('work:get-config', () => {
    const models = listModels();
    const active = models.find((item) => item.isActive) ?? null;
    const provider = active?.provider ?? (process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai');
    const promptCache = provider === 'anthropic'
      && (active?.promptCache ?? process.env.ANTHROPIC_PROMPT_CACHE !== 'false');
    return {
      model: process.env.LLM_MODEL ?? '',
      label: active?.label ?? process.env.LLM_MODEL ?? '',
      provider,
      promptCache,
      baseUrl: active?.baseURL || maskUrl(process.env.LLM_BASE_URL ?? '') || activePresetBaseURL(),
      contextWindow: active?.contextWindow ?? (Number(process.env.CONTEXT_WINDOW_TOKENS ?? 0) || null),
      // 语言优先取 process.env（运行中已生效的值），回退到 config 文件 ——
      // getConfig 可能在 loadMocodeConfig() 之前被调用（渲染层首屏就会问一次），
      // 那时 env 还没回填，只看 env 会拿到空串、首屏语言回落到默认。
      language: process.env.MOCODE_LANGUAGE ?? readUserConfig().MOCODE_LANGUAGE ?? '',
      theme: process.env.MOCODE_THEME ?? readUserConfig().MOCODE_THEME ?? '',
    };
  });
  // 写入界面语言偏好（MOCODE_LANGUAGE）到 ~/.mocode/config，与主题/模型等配置同源。
  // 主进程侧也读这个键来本地化系统提示，所以这里同步 process.env 让运行中即时生效。
  // 原生菜单是主进程资源、不随渲染层重绘，切语言后必须在这里重建一次。
  ipcMain.handle('work:set-language', (_event, lang: string) => {
    const allowed = ['zh-CN', 'en-US'];
    if (typeof lang !== 'string' || !allowed.includes(lang)) return { ok: false, message: tMain('main.lang.unsupported') };
    try { writeUserConfig({ MOCODE_LANGUAGE: lang }); }
    catch (error) { return { ok: false, message: tMain('main.lang.writeFail', { msg: (error as Error).message }) }; }
    process.env.MOCODE_LANGUAGE = lang;
    rebuildAppMenu();
    return { ok: true, language: lang };
  });
  ipcMain.handle('work:list-models', () => listModels());
  // 读单个预设的完整字段（含 apiKey）供「编辑」表单回填。
  // 为什么必须回传明文 key：表单里 key 是 password 输入框，若用掩码当初始值，
  // 用户只改「上下文窗口」也会把掩码串当成新 key 存回去 —— 静默毁掉配置。
  // apiKey 只在主进程↔本应用渲染层之间流转，不落日志、不进 modal 之外的地方。
  ipcMain.handle('work:get-model', (_event, name: string) => {
    if (typeof name !== 'string' || !PRESET_NAME_RE.test(name)) return { ok: false, message: tMain('main.preset.nameInvalid') };
    const preset = readPresetFile(name);
    if (!preset) return { ok: false, message: tMain('main.preset.readFail', { name }) };
    return { ok: true, preset: { ...preset }, reasoning: reasoningCapabilityForPreset(preset) };
  });
  ipcMain.handle('work:save-model', (_event, payload: Record<string, unknown>) => {
    const result = savePresetFromRenderer(payload ?? {});
    if (result.ok) { broadcastState(); return { ok: true, message: result.message, name: result.name }; }
    return { ok: false, message: result.message };
  });
  ipcMain.handle('work:delete-model', (_event, name: string) => {
    if (typeof name !== 'string' || !name) return { ok: false, message: tMain('main.preset.nameFrom') };
    const result = removePreset(name);
    if (result.ok) broadcastState();
    return result;
  });
  ipcMain.handle('work:switch-model', (_event, name: string) => {
    if (typeof name !== 'string' || !name) return { ok: false, message: tMain('main.switchModel.empty') };
    const result = switchModel(name);
    if (result.ok) broadcastState();
    return { ok: result.ok, message: result.message };
  });
  // 模型目录（models.dev）：浏览 + 刷新。快照与 mocode 终端共用 ~/.mocode/catalog.json，
  // 任何一边刷新，另一边都能直接读到最新目录。只返回可直发条目（协议判定同 core）。
  ipcMain.handle('work:catalog-load', async (_event, payload: { refresh?: boolean }) => {
    const refresh = (payload ?? {}).refresh === true;
    let providers: Record<string, import('./catalog.js').CatalogProviderInfo>;
    let source: import('./catalog.js').CatalogSource;
    let fetchedAt: string | undefined;
    if (refresh || !hasCatalogSnapshot()) {
      const result = await refreshCatalog();
      if (!result.ok) {
        return { ok: false, message: tMain('main.catalog.unavailable', { msg: result.message ?? '' }) };
      }
      providers = result.providers;
      source = result.source;
      fetchedAt = result.fetchedAt;
    } else {
      const snapshot = readCatalogSnapshot();
      if (!snapshot) return { ok: false, message: tMain('main.catalog.unavailable', { msg: catalogSnapshotPath() }) };
      providers = snapshot.providers;
      source = 'cache';
      fetchedAt = snapshot.fetchedAt;
    }
    const entries = flattenSupportedEntries(providers);
    return {
      ok: true,
      source,
      fetchedAt: fetchedAt ?? '',
      total: entries.length,
      providerCount: Object.keys(providers).length,
      entries,
    };
  });
  // 选中一个目录模型 → 返回模型表单的预填草稿。apiKeySeed 从主进程 env 里按
  // provider.env 声明的变量名探测（与 core 的 resolveApiKey 同语义），找不到给空串。
  ipcMain.handle('work:catalog-prefill', (_event, payload: { providerId?: unknown; modelId?: unknown }) => {
    const providerId = String(payload?.providerId ?? '');
    const modelId = String(payload?.modelId ?? '');
    if (!providerId || !modelId) return { ok: false, message: tMain('main.catalog.unknown'), envKeys: [], apiKeySeed: '' };
    const snapshot = readCatalogSnapshot();
    if (!snapshot) return { ok: false, message: tMain('main.catalog.unknown'), envKeys: [], apiKeySeed: '' };
    const result = buildCatalogPick(snapshot.providers, providerId, modelId);
    if (!result.ok) {
      return { ok: false, message: result.message === 'unsupported' ? tMain('main.catalog.unsupported') : tMain('main.catalog.unknown'), envKeys: result.envKeys, apiKeySeed: '' };
    }
    return result;
  });
  ipcMain.handle('work:get-settings', () => readSettings());
  ipcMain.handle('work:set-settings', (_event, patch: Record<string, unknown>) => {
    if (!patch || typeof patch !== 'object') return readSettings();
    if (isPetCharacter(patch.petCharacter)) {
      writeUserConfig({ MOCODE_PET_CHARACTER: patch.petCharacter });
      process.env.MOCODE_PET_CHARACTER = patch.petCharacter;
      desktopPet.setCharacter(patch.petCharacter);
    }
    if (typeof patch.desktopPet === 'boolean') {
      writeUserConfig({ MOCODE_DESKTOP_PET: String(patch.desktopPet) });
      process.env.MOCODE_DESKTOP_PET = String(patch.desktopPet);
      desktopPet.setEnabled(patch.desktopPet);
      desktopPet.update(state.tasks);
    }
    const configPatch: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      // 思考强度是字符串键，不走 SETTING_TOGGLES 那张布尔表（它决定的是「默认开还是关」）。
      if (key === 'effort') {
        if (typeof value !== 'string') continue;
        const effort = (EFFORT_VALUES as readonly string[]).includes(value) ? value : null;
        if (!effort) continue;
        configPatch.REASONING_EFFORT = effort;
        process.env.REASONING_EFFORT = effort;
        continue;
      }
      const def = SETTING_TOGGLES[key as SettingKey];
      if (!def || typeof value !== 'boolean') continue;
      configPatch[def.env] = value ? 'true' : 'false';
      process.env[def.env] = value ? 'true' : 'false';
    }
    if (Object.keys(configPatch).length) {
      try { writeUserConfig(configPatch); }
      catch (error) { console.error('[settings] failed to write ~/.mocode/config:', error); }
      // host 启动时固化了 env 快照 —— 与切模型同理，全员重启才能生效。
      restartAllAgents();
      broadcastState();
    }
    return readSettings();
  });
  // ── 语音输入（本地 ASR）──────────────────────────────────────
  // 模型不进安装包：用户在设置里显式开启后才下载到 userData。
  // 这里只做薄封装，下载/校验/推理细节全在 voice/asr.ts。
  ipcMain.handle('work:voice-status', () => ({
    ...voiceModelStatus(),
    downloading: isDownloading(),
  }));
  ipcMain.handle('work:voice-model-download', async () => {
    if (isDownloading()) return { ok: false, message: tMain('voice.errBusy'), status: voiceModelStatus() };
    try {
      const status = await downloadVoiceModel((progress: VoiceDownloadProgress) => {
        pushRenderer('work:voice-progress', progress);
      });
      // 下载完立刻预热：recognizer 构建要 1–2s（加载 onnxruntime + 226MB 权重），
      // 放在用户第一次按住麦克风时说这句话才建，第一句必然卡顿。
      warmUpRecognizer();
      return { ok: true, status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取消不是错误：UI 按 cancelled 收尾，别弹红色 toast。
      if (message === 'cancelled') return { ok: false, cancelled: true, status: voiceModelStatus() };
      return { ok: false, message, status: voiceModelStatus() };
    }
  });
  ipcMain.handle('work:voice-model-cancel', () => {
    cancelVoiceDownload();
    return { ok: true };
  });
  ipcMain.handle('work:voice-model-remove', () => {
    if (isDownloading()) cancelVoiceDownload();
    return { ok: true, status: removeVoiceModel() };
  });
  // 识别。renderer 传 16kHz 单声道 Float32（WebAudio 直接给的就是它）。
  // 同步解码放在 setImmediate 外面会卡住主进程消息循环 → 用 Promise 包一层不够，
  // 必须让出事件循环再跑，否则下载进度/窗口重绘会在识别的几百毫秒里冻住。
  ipcMain.handle('work:voice-transcribe', async (_event, payload: { samples?: Float32Array; sampleRate?: number }) => {
    const samples = payload?.samples;
    const sampleRate = Number(payload?.sampleRate ?? 16000);
    if (!(samples instanceof Float32Array) || samples.length === 0) {
      return { ok: false, message: tMain('voice.errNoAudio') };
    }
    const status = voiceModelStatus();
    if (!status.ready) return { ok: false, message: tMain('voice.errNoModel') };
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const text = transcribe(samples, Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16000);
      return { ok: true, text };
    } catch (error) {
      console.error('[voice] transcribe failed:', error);
      return { ok: false, message: tMain('voice.errTranscribe') };
    }
  });
  // ── Skill 市场 / 扩展管理 ──────────────────────────────────────
  // skill 热重载由 core 的 skillsScanSignature 处理，装完即生效，无需重启 host；
  // MCP 配置在 host 启动时固化，增删改后必须 restartAllAgents()。
  ipcMain.handle('work:skills-list', (_event, projectRoot?: string) => listInstalledSkills(typeof projectRoot === 'string' && projectRoot ? projectRoot : undefined));
  ipcMain.handle('work:skill-import-folder', () => importSkillsFromFolder());
  ipcMain.handle('work:skill-import-zip', () => importSkillsFromZip());
  ipcMain.handle('work:skill-import-git', (_event, url: string) => {
    if (typeof url !== 'string' || !url.trim()) return { ok: false, message: tMain('extensions.gitUrlRequired'), installed: [] };
    // 直接从 git URL 导入：克隆到市场缓存 → 扫描 → 安装（与市场共用同一条链路）
    return loadSkillMarket(url, true).then((loaded) => {
      if (!loaded.ok) return { ok: false, message: loaded.message ?? tMain('extensions.marketLoadFailed'), installed: [] };
      if (!loaded.skills.length) return { ok: false, message: tMain('extensions.noSkillsInRepo'), installed: [] };
      return installFromMarket(url, loaded.skills[0]!.relDir).then(async (first) => {
        // 仓库里不止一个 skill 时把其余的一并装上（显式给 URL = 用户想要整个仓库）
        const rest = loaded.skills.slice(1);
        if (!rest.length) return first;
        const results = [first];
        for (const skill of rest) results.push(await installFromMarket(url, skill.relDir));
        const ok = results.some((r) => r.ok);
        const installed = results.flatMap((r) => r.installed);
        return { ok, message: ok ? tMain('extensions.installedCount', { n: installed.length }) : first.message, installed };
      });
    });
  });
  ipcMain.handle('work:skills-market-load', (_event, payload: { url?: string; refresh?: boolean }) => {
    const url = typeof payload?.url === 'string' ? payload.url : '';
    return loadSkillMarket(url, payload?.refresh === true);
  });
  ipcMain.handle('work:skill-install-market', (_event, payload: { url?: string; relDir?: string }) => {
    const url = typeof payload?.url === 'string' ? payload.url : '';
    const relDir = typeof payload?.relDir === 'string' ? payload.relDir : '';
    return installFromMarket(url, relDir);
  });
  ipcMain.handle('work:skill-delete', (_event, dir: string, projectRoot?: string) => {
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tMain('extensions.invalidParam') };
    return deleteSkill(dir, typeof projectRoot === 'string' && projectRoot ? projectRoot : undefined);
  });
  ipcMain.handle('work:skill-open', (_event, dir: string) => {
    if (typeof dir === 'string' && dir) openSkillFolder(dir);
    return true;
  });
  // ── MCP 接入 ──────────────────────────────────────────────────
  ipcMain.handle('work:mcp-list', () => listMcpServers());
  ipcMain.handle('work:mcp-save', (_event, payload: { name?: unknown; originalName?: unknown; draft?: unknown }) => {
    const name = String(payload?.name ?? '');
    const originalName = typeof payload?.originalName === 'string' && payload.originalName ? payload.originalName : undefined;
    const draft = (payload?.draft ?? {}) as Parameters<typeof saveMcpServer>[1];
    const result = saveMcpServer(name, draft, originalName);
    if (result.ok) restartAllAgents(); // host 启动时固化 MCP 配置，改完必须重启才生效
    return result;
  });
  ipcMain.handle('work:mcp-delete', (_event, name: string) => {
    const result = deleteMcpServer(String(name ?? ''));
    if (result.ok) restartAllAgents();
    return result;
  });
  ipcMain.handle('work:mcp-toggle', (_event, name: string, disabled: boolean) => {
    const result = toggleMcpServer(String(name ?? ''), disabled === true);
    if (result.ok) restartAllAgents();
    return result;
  });
  ipcMain.handle('work:mcp-import-json', (_event, text: string) => {
    const result = importMcpJson(String(text ?? ''));
    if (result.ok) restartAllAgents();
    return result;
  });
  ipcMain.handle('work:mcp-config-path', () => mcpConfigPath());
  ipcMain.handle('work:list-branches', async () => {
    const project = selectedProject();
    const res = await runCommand(project.root, 'git', ['branch', '--format', '%(refname:short)']);
    if (!res.ok) return { ok: false, message: tMain('main.branches.fail', { msg: (res.stderr || tMain('git.unavailable')) }), current: project.branch, branches: [] };
    const branches = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { ok: true, message: '', current: project.branch, branches };
  });
  ipcMain.handle('work:switch-branch', async (_event, branch: string) => {
    if (typeof branch !== 'string' || !branch) return { ok: false, message: tMain('main.preset.nameFrom') };
    const project = selectedProject();
    const res = await runCommand(project.root, 'git', ['checkout', branch]);
    if (!res.ok) return { ok: false, message: tMain('main.branch.switchFail', { msg: (res.stderr || res.stdout) }) };
    const updated = { ...project, branch: await branchAt(project.root) };
    state.projects = state.projects.map((p) => (p.id === project.id ? updated : p));
    state.selectedProjectId = updated.id;
    saveState();
    broadcastState();
    return { ok: true, message: tMain('main.branch.switched', { branch: updated.branch }), branch: updated.branch };
  });
  ipcMain.on('work:set-theme', (_event, theme: 'light' | 'dark' | 'system') => applyThemeBackground(theme));
  // 渲染层只同步**符号色**（按钮图标的深浅）；底色恒为透明，由 CSS .titlebar 供给。
  // 历史：这里以前还会收 bg，于是「主进程硬编码 hex」和「渲染层实测 oklch 回传」两套颜色
  // 互相追 —— 任一条链路失效（旧构建里 canvas 读色对 oklch 返回 null）按钮区就停在硬编码值，
  // 深色主题下标题栏右端明显两块色。现在颜色只有一个来源，就没有能对不齐的地方。
  ipcMain.on('work:set-titlebar-overlay', (_event, colors: { bg?: string; symbol?: string }) => {
    if (process.platform !== 'win32' || !windowRef || windowRef.isDestroyed()) return;
    if (!colors?.symbol) return;
    try { windowRef.setTitleBarOverlay({ color: TRANSPARENT_OVERLAY, symbolColor: colors.symbol, height: 37 }); }
    catch { /* 某些平台/版本不支持动态 overlay，静默即可 */ }
  });
  ipcMain.on('work:show-menu', (event, menuId: string, clientX: number, clientY: number) => {
    if (!['file', 'edit', 'view', 'help'].includes(menuId) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const submenu = appMenu?.getMenuItemById(menuId)?.submenu;
    if (!targetWindow || !submenu) return;
    const bounds = targetWindow.getBounds();
    submenu.popup({ window: targetWindow, x: bounds.x + Math.round(clientX), y: bounds.y + Math.round(clientY) });
  });
  ipcMain.on('work:agent-send', (_event, value: Record<string, unknown>) => {
    const id = typeof value.id === 'string' ? value.id : randomUUID();
    const task = taskById(id);
    if (!task) { reportTaskError(id, tMain('main.task.notExist')); return; }
    // 停止指令落到「还没有 agent 实例」的任务上：就地收敛成已停止并回一条 run_aborted，
    // 不为一条「停止」冷启动一个 host，也不能什么都不做（界面会一直停在运行态）。
    if (value.type === 'cancel' && !agents.has(id)) {
      if (task.status === 'running' || task.status === 'waiting') {
        task.status = 'cancelled';
        saveState();
        broadcastState();
      }
      const aborted = { type: 'event', event: 'run_aborted', requestId: id, payload: {} };
      recordRecoveryEvent(id, aborted);
      pushRenderer('work:agent-event', aborted);
      return;
    }
    // 用户消息提交与 run 执行分开：运行中发送的消息先排队，置顶时间必须记在点击发送时，
    // 不能等稍后出队。此控制事件仅更新排序键，不转发给 host，也不改变任务运行状态。
    if (value.type === 'user_message') {
      task.updatedAt = new Date().toISOString();
      saveState();
      broadcastState();
      return;
    }
    if (value.type === 'run') {
      const regenerate = value.regenerate === true;
      const userIndex = Number(value.userIndex);
      if (regenerate && Number.isInteger(userIndex) && userIndex >= 0) {
        // host 协议只认识普通 run：先在主进程裁掉目标用户轮及其旧回答，再让 run 重新追加
        // 同一条用户消息。只裁 UI 日志会让旧 assistant/tool 留在 host，续跑还会重复 user。
        const rolled = rollbackSession(task, userIndex);
        if (!rolled.ok) { reportTaskError(id, rolled.message ?? tMain('main.rollback.noHistory')); return; }
        const previousAgent = agents.get(id);
        if (previousAgent) { previousAgent.stop(); agents.delete(id); }
        // UI 日志保留目标 user（renderer 没有删它），与磁盘会话的“删除后重发”殊途同归。
        taskRecovery(id).regenerate(userIndex);
      } else if (typeof value.prompt === 'string') {
        const attachments = Array.isArray(value.attachments)
          ? value.attachments.filter((item): item is RecoveryAttachment => !!item && typeof item.name === 'string' && (typeof item.dataUrl === 'string' || typeof item.text === 'string'))
          : [];
        taskRecovery(id).user(value.prompt, attachments);
      }
      task.status = 'running';
      // 上一次的失败原因就此作废，否则侧栏会挂着「上次运行未正常结束」而状态却是正在运行。
      task.lastError = undefined;
      saveState();
      broadcastState();
    }
    // 关键：这条指令绝不能因为「表里没有实例」被丢掉。run / compact 就地补实例（懒启动 host）；
    // 只有 approval 必须打到原来那个 host 上（那个 host 才有等待中的审批）。
    const agent = agents.get(id) ?? (value.type === 'approval' ? null : ensureAgent(task));
    if (!agent) { reportTaskError(id, tMain('main.task.notRunning')); return; }
    const { regenerate: _regenerate, userIndex: _userIndex, ...rest } = value;
    const command: Record<string, unknown> = { ...rest, id };
    void agent.send(command as HostCommand);
  });
  /**
   * 面板命令（会话 / 回滚 / 改动 / 用量 / 记忆 / 设置）。
   *
   * 与 run 的关键差别：requestId 是渲染层生成的 `panel-*`，**不是任务 id**。
   * 所以这里不回任何任务状态，只把命令转给当前任务的 host，由 host 用同一个 id 回
   * `*_report` 事件；渲染层按 id 配对自己的 pending 表。
   *
   * 路由目标跟随「当前选中的任务」：会话列表、回滚轮次、记忆库都挂在那个工作空间的
   * host 上，换任务就是换 workspace —— 这是唯一正确的归属。
   */
  // 一个工作空间可能含多个仓库（嵌套仓库/子模块/工作树）；面板先拿这份清单再按仓库操作。
  ipcMain.handle('work:git-repos', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project) return { ok: false, repos: [], message: tMain('main.task.projectNotExist') };
    return gitRepos(project.root);
  });
  ipcMain.handle('work:git-status', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project) return { ok: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? gitStatus(root) : { ok: false, message: tMain('main.task.projectNotExist') };
  });
  ipcMain.handle('work:git-diff', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project || typeof payload.path !== 'string' || typeof payload.staged !== 'boolean') return { ok: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? gitDiff(root, payload.path, payload.staged) : { ok: false, message: tMain('main.task.projectNotExist') };
  });
  ipcMain.handle('work:git-stage', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    const paths = payload.paths;
    if (!project || (paths !== undefined && (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string')))) return { ok: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? stageFiles(root, paths as string[] | undefined) : { ok: false, message: tMain('main.task.projectNotExist') };
  });
  ipcMain.handle('work:git-unstage', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    const paths = payload.paths;
    if (!project || (paths !== undefined && (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string')))) return { ok: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? unstageFiles(root, paths as string[] | undefined) : { ok: false, message: tMain('main.task.projectNotExist') };
  });
  ipcMain.handle('work:git-commit', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project || typeof payload.message !== 'string') return { ok: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? commitStaged(root, payload.message) : { ok: false, message: tMain('main.task.projectNotExist') };
  });
  /**
   * 历史视图（只读）：提交列表分页、某提交改动的文件、某提交里某个文件的内容 + diff。
   * 与其它 `work:git-*` 同一套目标解析 —— 仓库必须属于这个工作空间，渲染层不能借它读任意目录。
   */
  ipcMain.handle('work:git-log', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project) return { ok: false, commits: [], truncated: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    if (!root) return { ok: false, commits: [], truncated: false, message: tMain('main.task.projectNotExist') };
    const limit = Number.isFinite(Number(payload.limit)) ? Number(payload.limit) : undefined;
    const skip = Number.isFinite(Number(payload.skip)) ? Number(payload.skip) : undefined;
    return gitLog(root, { limit, skip });
  });
  ipcMain.handle('work:git-commit-files', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project || typeof payload.sha !== 'string') return { ok: false, files: [], message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? gitCommitFiles(root, payload.sha) : { ok: false, files: [], message: tMain('main.task.projectNotExist') };
  });
  ipcMain.handle('work:git-commit-file', async (_event, payload: Record<string, unknown>) => {
    const project = gitWorkspace(payload);
    if (!project || typeof payload.sha !== 'string' || typeof payload.path !== 'string') return { ok: false, message: tMain('main.task.projectNotExist') };
    const root = await repoFor(project, payload);
    return root ? gitCommitFile(root, payload.sha, payload.path) : { ok: false, message: tMain('main.task.projectNotExist') };
  });
  /**
   * 浏览器面板：视图是主进程的原生 WebContentsView（见 browser-host.ts）。
   * 渲染层只负责量出 stage 的矩形、画工具栏；页面本身不经过 DOM，
   * 因为它必须同时是 CDP 里的一个 page 目标，agent 才能接管。
   */
  ipcMain.handle('work:browser-show', (_event, payload: Record<string, unknown>) => {
    const bounds = payload?.bounds as Record<string, unknown> | undefined;
    if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(bounds[key])))) {
      return { ok: false, message: tMain('main.browser.badBounds') };
    }
    // projectId 必须是我们登记过的空间：不能让渲染层传任意字符串去新建分区。
    const rawProjectId = typeof payload.projectId === 'string' ? payload.projectId : '';
    const projectId = rawProjectId && state.projects.some((item) => item.id === rawProjectId) ? rawProjectId : undefined;
    browserHostFor().show(projectId, {
      x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height),
    });
    return { ok: true };
  });
  ipcMain.handle('work:browser-hide', () => { browserHost?.hide(); return { ok: true }; });
  ipcMain.handle('work:browser-navigate', (_event, url: string) => {
    if (typeof url !== 'string' || !validatePanelUrl(url)) {
      return { ok: false, message: tMain('main.browser.badUrl') };
    }
    return { ok: browserHostFor().navigate(url) };
  });
  ipcMain.handle('work:browser-command', (_event, command: string) => {
    if (command !== 'back' && command !== 'forward' && command !== 'reload') return { ok: false };
    return { ok: browserHostFor().command(command) };
  });
  /**
   * 终端面板：PTY 在主进程（node-pty 是原生模块，渲染进程不 require 它）。
   * projectId 必须是我们登记过的空间 —— 否则渲染层就能让主进程在任意目录起 shell。
   */
  const terminalProjectId = (payload: Record<string, unknown>): string | undefined => {
    const raw = typeof payload.projectId === 'string' ? payload.projectId : '';
    return raw && state.projects.some((item) => item.id === raw) ? raw : undefined;
  };
  ipcMain.handle('work:terminal-open', (_event, payload: Record<string, unknown>) => {
    const size = (payload ?? {}) as Record<string, unknown>;
    return terminalHostFor().open(terminalProjectId(size), Number(size.cols) || 80, Number(size.rows) || 24);
  });
  ipcMain.handle('work:terminal-write', (_event, payload: Record<string, unknown>) => {
    // 单次按键/粘贴串：字符串校验即可，长度上限防一次粘贴几 MB 卡死 ConPTY。
    const data = typeof payload?.data === 'string' ? payload.data : '';
    if (!data || data.length > 200_000) return { ok: false };
    return { ok: terminalHostFor().write(terminalProjectId(payload), data) };
  });
  ipcMain.handle('work:terminal-resize', (_event, payload: Record<string, unknown>) => ({
    ok: terminalHostFor().resize(terminalProjectId(payload), Number(payload?.cols) || 80, Number(payload?.rows) || 24),
  }));
  ipcMain.handle('work:terminal-close', (_event, payload: Record<string, unknown>) => ({
    ok: terminalHostFor().close(terminalProjectId(payload)),
  }));
  ipcMain.handle('work:clipboard-read', () => clipboard.readText());
  // 终端面板复制走这里：渲染层只有 clipboard-sanitized-write 权限，且写失败最常见的原因是
  // 「文档没有焦点」（实测 show 前的窗口 / 焦点在别的 webview 上都会报 Document is not focused）。
  // 主进程写剪贴板没有这两个限制，用户按了复制就一定会进剪贴板。
  ipcMain.handle('work:clipboard-write', (_event, text: unknown) => {
    if (typeof text !== 'string' || !text) return { ok: false };
    // 上限防渲染层一次塞几百 MB 进系统剪贴板。
    if (text.length > 1_000_000) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle('work:panel', async (_event, value: Record<string, unknown>) => {
    const id = typeof value.id === 'string' && value.id ? value.id : randomUUID();
    const type = typeof value.type === 'string' ? value.type : '';
    const supported = ['sessions', 'changes', 'usage', 'context_usage', 'memory', 'settings', 'commit_message', 'cancel_commit_message'];
    if (!supported.includes(type)) return { ok: false, id, message: tMain('main.panel.unsupported') };
    if (type === 'cancel_commit_message') {
      if (typeof value.targetId === 'string' && value.targetId) cancelPendingCommitMessage(value.targetId);
      return { ok: true, id, cancelled: true };
    }
    if (type === 'commit_message') {
      const project = gitWorkspace(value);
      if (!project) {
        pushRenderer('work:agent-event', { type: 'error', requestId: id, error: tMain('main.task.projectNotExist') });
        return { ok: false, id };
      }
      // 在读 diff 之前登记：取消/移除空间后，慢 Git 操作返回时不得再启动 host。
      const pending: PendingCommitMessage = { projectId: project.id, agent: null };
      pendingCommitMessages.set(id, pending);
      // 多仓库：diff 必须取点击生成时那个仓库的暂存区，不能一律取工作空间根。
      const repoRoot = await repoFor(project, value);
      if (!repoRoot) {
        pendingCommitMessages.delete(id);
        const message = tMain('main.task.projectNotExist');
        pushRenderer('work:agent-event', { type: 'error', requestId: id, error: message });
        return { ok: false, id, message };
      }
      // 只读取点击生成时的暂存区；工作区剩余修改绝不混入提示词。
      const draft = await stagedDiff(repoRoot);
      if (pendingCommitMessages.get(id) !== pending) return { ok: true, id, cancelled: true };
      if (!draft.ok) {
        pendingCommitMessages.delete(id);
        pushRenderer('work:agent-event', { type: 'error', requestId: id, error: draft.message ?? 'NO_STAGED_CHANGES' });
        return { ok: false, id };
      }
      const currentProject = gitWorkspace(value);
      if (!currentProject || currentProject.id !== project.id) {
        pendingCommitMessages.delete(id);
        const message = tMain('main.task.projectNotExist');
        pushRenderer('work:agent-event', { type: 'error', requestId: id, error: message });
        return { ok: false, id, message };
      }
      const requestedTask = typeof value.taskId === 'string' && value.taskId ? taskById(value.taskId) : undefined;
      const agent = requestedTask ? ensureAgent(requestedTask) : ensureProjectAgent(project);
      pending.agent = agent;
      const command = {
        type, id, diff: draft.diff, stat: draft.stat, files: draft.files, truncated: draft.truncated,
        language: value.language === 'en-US' ? 'en-US' : 'zh-CN',
        // 仓库与分支一并交给 host：一个工作空间可能同时有多个仓库/分支，
        // 提示词里不写明的话模型无法区分这条提交信息属于哪一批改动。
        ...(typeof value.repo === 'string' && value.repo ? { repo: value.repo } : {}),
        ...(draft.branch ? { branch: draft.branch } : {}),
      } as HostCommand;
      pending.sent = agent.send(command).catch(() => false);
      const sent = await pending.sent;
      if (pendingCommitMessages.get(id) !== pending) return { ok: true, id, cancelled: true };
      if (!sent) {
        pendingCommitMessages.delete(id);
        const message = tMain('main.host.commFailed');
        pushRenderer('work:agent-event', { type: 'error', requestId: id, error: message });
        return { ok: false, id, message };
      }
      return { ok: true, id };
    }
    // 全局用量与本机任何工作区/任务都无关：账本就是 ~/.mocode/usage-daily.jsonl。
    // 就地算完直接回执，不为了读一个文件去冷启动 host（≈8s），也让「没有选中任务」时照样能看总量。
    // 只有 session 口径仍走 host —— 它要读某条会话自己的 usage.jsonl，属于那个任务的工作区。
    if (type === 'usage' && value.scope !== 'session') {
      const requested = Number(value.days);
      const days = Number.isFinite(requested) ? Math.min(366, Math.max(1, Math.round(requested))) : 7;
      const summary = summarizeGlobalUsage(readGlobalUsage(), days);
      pushRenderer('work:agent-event', {
        type: 'event',
        event: 'usage_report',
        requestId: id,
        payload: {
          scope: 'global',
          days,
          summary,
          // 热力图窗口 == 统计窗口，与 host 侧 usageCommand 的载荷同形（panels.ts 只认这一份）。
          calendar: { fromDay: summary.fromDay, toDay: summary.toDay, days: summary.byDay },
        },
      });
      return { ok: true, id };
    }
    // 输入栏快照请求携带发起时的任务 id；快速切换任务时不能改发到新选中的 host。
    const requestedTaskId = type === 'context_usage' && typeof value.taskId === 'string' ? value.taskId : undefined;
    const task = taskById(requestedTaskId ?? state.selectedTaskId);
    if (!task) {
      pushRenderer('work:agent-event', { type: 'error', requestId: id, error: tMain('main.panel.noTask') });
      return { ok: false, id };
    }
    // 面板命令不需要「这个任务在跑」状态，但需要它的 host 活着：没实例就地拉起（懒启动）。
    const agent = agents.get(task.id) ?? ensureAgent(task);
    const { taskId: _taskId, ...rest } = value;
    const command: Record<string, unknown> = { ...rest, id };
    void agent.send(command as HostCommand);
    return { ok: true, id };
  });
}

/** 构建（或按当前语言重建）原生应用菜单。切语言后必须调一次 —— 菜单是主进程资源，不随渲染层重绘。 */
function rebuildAppMenu(): void {
  appMenu = Menu.buildFromTemplate([
    { id: 'file', label: tMain('menu.file'), submenu: [{ role: 'close', label: tMain('menu.closeWindow') }] },
    {
      id: 'edit', label: tMain('menu.edit'), submenu: [
        { role: 'undo', label: tMain('menu.undo') }, { role: 'redo', label: tMain('menu.redo') },
        { type: 'separator' },
        // 窗口菜单虽隐藏，原生 role 仍负责 Ctrl/Cmd+C/V 等标准编辑操作；缺失时菜单与快捷键都会失灵。
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { id: 'view', label: tMain('menu.view'), submenu: [{ role: 'reload', label: tMain('menu.reload') }, { role: 'toggleDevTools', label: tMain('menu.devTools') }] },
    { id: 'help', label: tMain('menu.help'), submenu: [{ label: 'MoCode Work', enabled: false }] },
  ]);
}

// Windows 上系统通知必须带 AppUserModelID 才会真的弹出来，否则 new Notification() 静默无效
// （「需要人工介入」的提醒就永远到不了用户眼前）。打包后用 electron-builder 的 appId，
// 与开始菜单快捷方式的 AUMID 一致；dev 下退到 electron.exe 自身路径。
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.mocode.work' : process.execPath);

// 单实例锁：第二个实例直接退出并把焦点还给已有窗口。不加的话，残留实例还握着
// %APPDATA%\mocode-work 的 GPU/disk 缓存锁，新实例启动时报一串
// 「Unable to move the cache: 拒绝访问 (0x5) / Gpu Cache Creation failed: -2」。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = windowRef ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  // 首屏之前先把界面语言/主题从 ~/.mocode/config 回填到 process.env：
  // 原生菜单在 whenReady 里就构建了，而 loadMocodeConfig() 要到第一个任务启动才跑 ——
  // 不提前回填的话，config 里写着 en-US 的用户每次重启都会先看到一屏中文菜单。
  for (const key of ['MOCODE_LANGUAGE', 'MOCODE_THEME'] as const) {
    if (process.env[key] !== undefined) continue;
    const value = readUserConfig()[key];
    if (value) process.env[key] = value;
  }
  rebuildAppMenu();
  // 隐藏菜单栏 ≠ 卸载应用菜单：后者会带走标准复制/粘贴快捷键与菜单行为。
  Menu.setApplicationMenu(appMenu);
  state = await loadState();
  // 存量数据修正：旧版接管历史会话时把 updatedAt 写成 now（真机上还成批写坏），
  // 于是「点开看一眼」的旧会话会长期霸占置顶区。启动时用会话文件的 mtime 对账一次。
  try { repairTaskSortKeys(); } catch { /* 修不了就按原数据渲染，排序本身已不再依赖这次修正 */ }
  // 存量清理：旧版「点 + 就落一条任务记录」会留下没人要的空草稿（侧栏显示成「新任务」）。
  // 除当前选中的那条外全部丢弃 —— 启动后用户看到的侧栏就是干净的。
  try { discardEmptyDrafts(state.selectedTaskId); } catch { /* 清理失败不该挡住启动 */ }
  // 启动时先让 .active 预设覆盖 config 裸键 —— 必须在 agent 启动之前，
  // 否则 host 会带着 config 里那个可能已过时的 LLM_MODEL 启动。
  applyActivePreset();
  // 应用启动即预热上次选中的任务：renderer 启动只 getState 渲染侧栏、不触发 select-task，
  // 不在这里预热的话，用户第一句话落到恢复的任务上时仍要现场冷启动 host（实测 ~8s，开 MCP 更久）。
  // 只预热 selectedTaskId 这一个：没有选中任务时第一句话会新建任务，
  // create-task handler 自己就会预热；猜「最近任务」去预热大概率白烧一个进程。
  const bootTask = state.selectedTaskId ? taskById(state.selectedTaskId) : undefined;
  if (bootTask) ensureAgent(bootTask);
  // MCP 配置兜底：用户没在 shell env / ~/.mocode/config 里指定 MCP_CONFIG_PATH 或
  // MCP_SERVERS 时，把 work-app 托管的 ~/.mocode/mcp.json 设为配置源 —— host 子进程
  // （core 的 readMcpServers）会从 MCP_CONFIG_PATH 读标准 { mcpServers } 格式。
  {
    const cfg = readUserConfig();
    if (!process.env.MCP_CONFIG_PATH && !cfg.MCP_CONFIG_PATH && !process.env.MCP_SERVERS && !cfg.MCP_SERVERS) {
      process.env.MCP_CONFIG_PATH = mcpConfigPath();
    }
  }
  installIpc();
  // 浏览器面板的 CDP 端点：必须在预热 agent 之前就绪，否则第一个任务起的 host 拿不到
  // MOCODE_BROWSER_CDP_URL，browser 工具就会自己再拉一个浏览器（两套登录态）。
  // 起不来只是面板降级（仍可浏览，agent 用独立浏览器），不该挡住启动。
  browserCdpUrl = await resolveBrowserCdpUrl();
  if (!browserCdpUrl) {
    pushRenderer('work:agent-event', {
      type: 'event', event: 'host_log',
      payload: { code: 'browser_cdp_unavailable', message: `[mocode-work] ${tMain('toast.browserCdpMissing')}` },
    });
  }
  // 启动即把终端访问过、且确实留有会话的工作空间并入侧栏「空间」——
  // 用户报的「终端会话在 work-app 里看不到」就出在这一步缺失上（此前侧栏只显示手动添加的项目）。
  // 放在 createWindow 之前：首屏 getState 拿到的就是合并后的空间列表，不会先闪一次空侧栏。
  try { await syncWorkspaceRegistry(true); } catch { /* 注册表是增强能力，读不了不能挡住启动 */ }
  createWindow();
  // 存量清理：历史上被 live_usage 撑大的恢复日志（真机 107MB / 25 万行，占 95%）就地瘦身。
  // fire-and-forget —— 维护动作绝不能挡住首屏，也不能和正在写的任务抢主线程。
  void compactRecoveryLogs(recoveryRoot()).then((n) => {
    if (n > 0) pushRenderer('work:agent-event', {
      type: 'event', event: 'host_log',
      payload: { message: `[mocode-work] compacted ${n} recovery log(s)` },
    });
  }).catch(() => { /* 清理失败不影响任何功能 */ });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  for (const agent of agents.values()) agent.stop();
  if (process.platform !== 'darwin') app.quit();
});
