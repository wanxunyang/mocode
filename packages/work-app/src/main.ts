import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { truncateSessionAtUser, type RawSessionRecord } from './truncate-session.js';
import { tMain } from './i18n/main.js';
import {
  AgentHostClient,
  resolveMocodeHostLaunchSpec,
  type HostCommand,
  type HostEnvelope,
} from '@mocode/runtime/host';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.mocode', 'node_modules', 'dist', 'coverage', '.next', '.cache']);

/**
 * 复用 mocode 已配好的模型 / 沙箱 / 记忆 / 主题等配置。
 * 与 src/config/index.ts 的 loadEnvFiles() 行为一致:
 *   候选(后者覆盖前者,优先级升序):<projectRoot>/.env(兼容旧用法,最低)
 *     → ~/.mocode/config(全局,/model 与 mocode config 写此)
 *     → <projectRoot>/.mocode/config(项目级覆盖,最高)。
 * shell 里 export 的同名键不被回填(/model 写文件的优先级语义与 REPL 一致)。
 * 只把 mocode 自己认识的键回填到 process.env,避免把无关 .env 字段塞进 host。
 */
const MOCODE_CONFIG_KEYS = [
  'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'CONTEXT_WINDOW_TOKENS', 'MAX_TOKENS',
  'ANTHROPIC_PROMPT_CACHE', 'LLM_STREAM_USAGE', 'AUTO_COMPACT',
  'MOCODE_CONTEXT_OPTIMIZE', 'MOCODE_CONTEXT_RELPRUNE', 'MOCODE_LIFECYCLE',
  'MOCODE_BUDGET_SCHEDULER', 'AUTO_REFLECT', 'MEMORY_ENABLED', 'REFLECT_EVERY_N',
  'MAX_STEPS', 'MOCODE_SUBAGENT_ENABLED', 'SUB_AGENT_MAX_STEPS', 'SANDBOX_ROOT',
  'ANYSEARCH_API_KEY', 'ANYSEARCH_BASE_URL', 'MOCODE_MAX_IMAGE_BYTES',
  'MOCODE_PERMISSION', 'MOCODE_PERMISSION_NON_INTERACTIVE_ALLOW', 'MOCODE_THEME', 'MOCODE_LANGUAGE',
] as const;

function loadMocodeConfig(projectRoot?: string): { loaded: string[]; missing: string[] } {
  const candidates: string[] = [];
  if (projectRoot) candidates.push(path.join(projectRoot, '.env'));
  candidates.push(path.join(os.homedir(), '.mocode', 'config'));
  if (projectRoot) candidates.push(path.join(projectRoot, '.mocode', 'config'));
  const fromFiles: Record<string, string> = {};
  for (const p of candidates) {
    try { Object.assign(fromFiles, dotenv.parse(readFileSync(p, 'utf8'))); } catch { /* 文件不存在:跳过 */ }
  }
  const allowed = new Set<string>(MOCODE_CONFIG_KEYS);
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(fromFiles)) {
    if (!allowed.has(k)) continue;
    if (process.env[k] === undefined) { process.env[k] = v; loaded.push(k); }
  }
  const missing: string[] = [];
  if (!process.env.LLM_BASE_URL) missing.push('LLM_BASE_URL');
  if (!process.env.LLM_API_KEY) missing.push('LLM_API_KEY');
  return { loaded, missing };
}

type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface Project { id: string; name: string; root: string; branch: string; }
interface TaskRecord {
  // projectId 为空字符串 = 普通任务（不加入任何空间 / 项目文件夹），agent 在 scratch 目录运行
  id: string; projectId: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string;
  sessionId?: string; changedFiles: string[]; lastError?: string;
}
interface StoredState { version: 1; projects: Project[]; selectedProjectId: string; tasks: TaskRecord[]; selectedTaskId?: string; }
interface CommandResult { ok: boolean; stdout: string; stderr: string; }

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
function broadcastState(): void { pushRenderer('work:state', state); }

/** 读取 ~/.mocode/config 的所有键(不写 process.env,仅作查询)。 */
function readUserConfig(): Record<string, string> {
  try { return dotenv.parse(readFileSync(userConfigPath(), 'utf8')); } catch { return {}; }
}

/** 写入 ~/.mocode/config —— 保留文件中其它键,只覆盖传入的。 */
function writeUserConfig(patch: Record<string, string>): void {
  const existing = readUserConfig();
  const merged = { ...existing, ...patch };
  mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  // 保持稳定顺序:patch 中声明的键排在最前
  const ordered: string[] = [];
  for (const k of Object.keys(patch)) ordered.push(k);
  for (const k of Object.keys(existing)) if (!ordered.includes(k)) ordered.push(k);
  const text = `${ordered.map((k) => `${k}=${merged[k] ?? ''}`).join('\n')}\n`;
  writeFileSync(userConfigPath(), text, 'utf8');
}

interface ModelDescriptor {
  name: string;          // 文件名(去掉 .json),用户标识 / 写入 config 的 LLM_MODEL
  label: string;         // 实际 API 的 model 名
  provider: 'openai' | 'anthropic';
  promptCache: boolean;
  baseURL: string;       // 仅显示用(只返回 host,不泄漏完整 endpoint)
  providerHost: string;  // 归一化后的提供商标识(剥掉 api./www. 等前缀),renderer 按它分组
  contextWindow: number; // tokens
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
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
      const name = path.basename(file, '.json');
      const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL : '';
      const model = typeof raw.model === 'string' ? raw.model : name;
      const provider = raw.provider === 'anthropic' ? 'anthropic' : 'openai';
      const promptCache = provider === 'anthropic' && raw.anthropicPromptCache !== false;
      const contextWindow = Number(raw.contextWindow ?? 0) || 0;
      out.push({
        name,
        label: model,
        provider,
        promptCache,
        baseURL: maskUrl(baseURL),
        providerHost: providerHostOf(baseURL),
        contextWindow,
        // 激活身份只看 .active 指针(它是 mocode 唯一的真相源);指针缺失时才退回比对真实 model 名。
        // 绝不能拿 baseURL 反推激活项 —— 同一家提供商的多个预设主机名相同,会把整组都标成"当前"。
        isActive: activeName ? name === activeName : model === activeModel,
      });
    } catch { /* 跳过解析失败的文件 */ }
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
  try {
    const raw = JSON.parse(readFileSync(path.join(modelsDir(), `${name}.json`), 'utf8')) as Record<string, unknown>;
    if (typeof raw.baseURL === 'string' && raw.baseURL) process.env.LLM_BASE_URL = raw.baseURL;
    if (typeof raw.apiKey === 'string' && raw.apiKey) process.env.LLM_API_KEY = raw.apiKey;
    // 写真实 API model 名(预设里的 model 字段),不是预设文件名。
    if (typeof raw.model === 'string' && raw.model) process.env.LLM_MODEL = raw.model;
    if (raw.provider === 'anthropic' || raw.provider === 'openai') process.env.LLM_PROVIDER = raw.provider;
    const contextWindow = Number(raw.contextWindow ?? 0);
    if (contextWindow > 0) process.env.CONTEXT_WINDOW_TOKENS = String(contextWindow);
    const promptCache = raw.provider === 'anthropic' && raw.anthropicPromptCache !== false;
    process.env.ANTHROPIC_PROMPT_CACHE = promptCache ? 'true' : 'false';
  } catch { /* 预设文件损坏:保持 config 裸键,别让切换把整个应用拖垮 */ }
}

/**
 * 把指定模型切为当前激活:读目标 .json,把所有相关键写入 ~/.mocode/config 与 process.env。
 * 同时取消正在运行的任务 —— host 子进程持有自己的一份 config 快照,必须显式停掉它,
 * 下次 run 时 send() 会重建进程并读到新配置(见 LocalAgent.restart)。
 *
 * **关键**:LLM_MODEL 必须写预设里的真实 API model 名(如 deepseek-v4.1-flash),
 * 绝不能写预设文件名(deepseek-v4-1-flash)。两者拼写常常不同(点号 vs 连字符),
 * 写错会让 host 拿一个后端不存在的模型名去请求,得到
 * `404 The model ... does not exist`。真正"当前激活预设"的身份由 .active 指针文件承载。
 */
function switchModel(name: string): { ok: boolean; message: string; model?: ModelDescriptor } {
  const target = path.join(modelsDir(), `${name}.json`);
  if (!existsSync(target)) return { ok: false, message: tMain('main.switchModel.exists', { name }) };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>; }
  catch { return { ok: false, message: tMain('main.switchModel.cannotRead', { name }) }; }
  const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL : '';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
  const model = typeof raw.model === 'string' ? raw.model : name;
  const provider = raw.provider === 'anthropic' ? 'anthropic' : 'openai';
  const promptCache = provider === 'anthropic' && raw.anthropicPromptCache !== false;
  const contextWindow = Number(raw.contextWindow ?? 0) || 0;
  if (!baseURL || !model) return { ok: false, message: tMain('main.switchModel.missingFields', { name }) };
  const patch: Record<string, string> = {
    LLM_PROVIDER: provider,
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: apiKey,
    LLM_MODEL: model, // 真实 API model 名,不是预设文件名
    ANTHROPIC_PROMPT_CACHE: promptCache ? 'true' : 'false',
  };
  if (contextWindow) patch.CONTEXT_WINDOW_TOKENS = String(contextWindow);
  try { writeUserConfig(patch); }
  catch (error) { return { ok: false, message: tMain('main.switchModel.writeFail', { msg: (error as Error).message }) }; }
  // 同步 .active 指针,否则下次启动 config/index.ts 会用指针指向的旧预设覆盖刚写的键。
  try { writeFileSync(path.join(modelsDir(), '.active'), `${name}\n`, 'utf8'); }
  catch { /* 指针写失败不阻断切换 */ }
  process.env.LLM_PROVIDER = provider;
  process.env.LLM_BASE_URL = baseURL;
  process.env.LLM_API_KEY = apiKey;
  process.env.LLM_MODEL = model;
  process.env.ANTHROPIC_PROMPT_CACHE = promptCache ? 'true' : 'false';
  if (contextWindow) process.env.CONTEXT_WINDOW_TOKENS = String(contextWindow);
  // 切模型 = 换 host 的 config 快照：先停掉所有在跑的任务,再让全部 host 下次 send 时按新配置重启。
  restartAllAgents();
  return {
    ok: true,
    message: tMain('main.switchModel.saved', { name, provider, cache: promptCache ? ' · cache on' : '' }),
    model: { name, label: model, provider, promptCache, baseURL: maskUrl(baseURL), providerHost: providerHostOf(baseURL), contextWindow, isActive: true },
  };
}

/* ── 预设文件读写（新增 / 编辑 / 重命名 / 删除） ──────────────────────
 * 与 src/config/presets.ts 保持同语义：per-file JSON、name 只允许 [a-zA-Z0-9_-]{1,32}、
 * `.active` 指针指向的预设若被改名/删除要同步跟随，否则下次启动回退 config 裸键丢窗口。 */

/** 预设名规则与 core 的 config/presets.ts 一致（路径穿越防护的第一道）。 */
const PRESET_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** 磁盘上的完整预设（含 apiKey 明文）。只允许在主进程内流转，绝不整条发往 renderer。 */
interface PresetFile {
  name: string;
  provider: 'openai' | 'anthropic';
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  anthropicPromptCache: boolean;
}

/** 用户可编辑的字段。name 单独处理（改名走 renamePresetFile）。 */
interface PresetDraft {
  provider: 'openai' | 'anthropic';
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  anthropicPromptCache: boolean;
}

function presetPathFor(name: string): string {
  return path.join(modelsDir(), `${name}.json`);
}

/** 规范化一份草稿：校验必填项，把可选项归一到 core 读取时的形态。 */
function normalizeDraft(input: Partial<PresetDraft>): { ok: true; value: PresetDraft } | { ok: false; message: string } {
  const baseURL = String(input.baseURL ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  const model = String(input.model ?? '').trim();
  const window = Number(input.contextWindow ?? 0);
  const provider = input.provider === 'anthropic' ? 'anthropic' : 'openai';
  if (!baseURL) return { ok: false, message: tMain('modelForm.errorBaseUrl') };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(baseURL)) return { ok: false, message: tMain('modelForm.errorBaseUrl') };
  try { new URL(baseURL); } catch { return { ok: false, message: tMain('modelForm.errorBaseUrl') }; }
  if (!apiKey) return { ok: false, message: tMain('modelForm.errorApiKey') };
  if (!model) return { ok: false, message: tMain('modelForm.errorModel') };
  if (!Number.isFinite(window) || window <= 0) return { ok: false, message: tMain('modelForm.errorWindow') };
  return {
    ok: true,
    value: {
      provider,
      baseURL,
      apiKey,
      model,
      contextWindow: Math.floor(window),
      // core 的 parsePreset 只在 anthropic 下认这个键，openai 一律落 false。
      anthropicPromptCache: provider === 'anthropic' && input.anthropicPromptCache !== false,
    },
  };
}

/** 原子写预设（写 tmp 再 rename），与 core 的 savePreset 同策略。 */
function writePresetFile(name: string, draft: PresetDraft): void {
  mkdirSync(modelsDir(), { recursive: true });
  const dest = presetPathFor(name);
  const payload: PresetFile = { name, ...draft };
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, dest);
}

/** 读一个预设文件为草稿；文件缺失/损坏返回 null。 */
function readPresetFile(name: string): PresetFile | null {
  try {
    const raw = JSON.parse(readFileSync(presetPathFor(name), 'utf8')) as Record<string, unknown>;
    const draft = normalizeDraft({
      provider: raw.provider === 'anthropic' ? 'anthropic' : 'openai',
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : '',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      contextWindow: Number(raw.contextWindow ?? 0) || 0,
      anthropicPromptCache: raw.anthropicPromptCache !== false,
    });
    if (!draft.ok) return null;
    return { name, ...draft.value };
  } catch { return null; }
}

/** 把一个预设激活（写 config + .active + process.env），供新建/编辑后自动生效使用。 */
function activatePreset(name: string, draft: PresetDraft): void {
  const patch: Record<string, string> = {
    LLM_PROVIDER: draft.provider,
    LLM_BASE_URL: draft.baseURL,
    LLM_API_KEY: draft.apiKey,
    LLM_MODEL: draft.model,
    ANTHROPIC_PROMPT_CACHE: draft.anthropicPromptCache ? 'true' : 'false',
    CONTEXT_WINDOW_TOKENS: String(draft.contextWindow),
  };
  try { writeUserConfig(patch); } catch { /* 写 config 失败不阻断 .active */ }
  try { writeFileSync(path.join(modelsDir(), '.active'), `${name}\n`, 'utf8'); } catch { /* 指针写失败不阻断 */ }
  process.env.LLM_PROVIDER = draft.provider;
  process.env.LLM_BASE_URL = draft.baseURL;
  process.env.LLM_API_KEY = draft.apiKey;
  process.env.LLM_MODEL = draft.model;
  process.env.ANTHROPIC_PROMPT_CACHE = draft.anthropicPromptCache ? 'true' : 'false';
  process.env.CONTEXT_WINDOW_TOKENS = String(draft.contextWindow);
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
  const draft = normalizeDraft((input.draft ?? {}) as Partial<PresetDraft>);
  if (!draft.ok) return { ok: false, message: draft.message };

  const originalName = String(input.originalName ?? '').trim();
  const renaming = !!originalName && originalName !== name;
  if (renaming) {
    if (!PRESET_NAME_RE.test(originalName)) return { ok: false, message: tMain('main.preset.nameInvalid') };
    if (existsSync(presetPathFor(name))) return { ok: false, message: tMain('main.preset.alreadyExists', { name }) };
    if (!existsSync(presetPathFor(originalName))) return { ok: false, message: tMain('main.preset.notExist', { name: originalName }) };
  }
  try {
    writePresetFile(name, draft.value);
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
    activatePreset(name, draft.value);
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

/** 配置类变更（模型/行为开关）后统一走这里：停掉在跑任务，host 下次 send 时按新配置重启。 */
function restartAllAgents(): void {
  for (const [id, agent] of agents) {
    const task = taskById(id);
    // 只有真的在跑才值得发 cancel：host 还没起来时发 cancel 会顺带把预热好的进程换成新的，
    // 白搭一次冷启动（这正是「刚发指令就报 Agent 进程已停止」的常见来源）。
    if (task && (task.status === 'running' || task.status === 'waiting') && agent.isRunning) {
      void agent.send({ type: 'cancel', id });
    }
    agent.restart();
  }
}

/* ── 行为开关（设置浮层用，语义对齐 mocode 终端的斜杠命令） ──
 * 读取顺序：process.env（host 启动时的快照来源）→ ~/.mocode/config → mocode 默认值。
 * mocode 默认：AUTO_COMPACT 开（!== 'false'），其余显式 'true' 才开（=== 'true'）。 */
const SETTING_TOGGLES = {
  autoCompact: { env: 'AUTO_COMPACT', on: (v: string | undefined) => v !== 'false' },
  memory: { env: 'MEMORY_ENABLED', on: (v: string | undefined) => v === 'true' },
  subAgent: { env: 'MOCODE_SUBAGENT_ENABLED', on: (v: string | undefined) => v === 'true' },
  autoReflect: { env: 'AUTO_REFLECT', on: (v: string | undefined) => v === 'true' },
} as const;
type SettingKey = keyof typeof SETTING_TOGGLES;

function readSettings(): Record<SettingKey, boolean> {
  const config = readUserConfig();
  const out = {} as Record<SettingKey, boolean>;
  for (const [key, def] of Object.entries(SETTING_TOGGLES)) {
    const value = process.env[def.env] ?? config[def.env] ?? '';
    out[key as SettingKey] = def.on(value || undefined);
  }
  return out;
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

function normalizeState(value: unknown): StoredState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<StoredState>;
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) return null;
  const projects = raw.projects.filter((item): item is Project => !!item && typeof item.id === 'string' && typeof item.root === 'string')
    .map((item) => ({ ...item, name: item.name || path.basename(item.root), branch: typeof item.branch === 'string' ? item.branch : '' }));
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
  if (Array.isArray(value)) return value.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
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
  const candidates = [path.join(project.root, '.mocode', 'sessions', sessionId, 'session.json'), path.join(project.root, '.mocode', 'sessions', `${sessionId}.json`)];
  for (const candidate of candidates) {
    try {
      const record = JSON.parse(readFileSync(candidate, 'utf8')) as { history?: Array<Record<string, unknown>> };
      if (!Array.isArray(record.history)) continue;
      return flattenHistory(record.history);
    } catch { /* Try old session layout. */ }
  }
  return [];
}

type HistoryItem = { role: 'user' | 'assistant' | 'tool'; text: string; name?: string; arguments?: string };

function flattenHistory(messages: Array<Record<string, unknown>>): HistoryItem[] {
  const items: HistoryItem[] = [];
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    const role = message.role;
    if (role === 'user' || role === 'assistant') {
      const text = contentText(message.content);
      if (text) items.push({ role, text });
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
  if (!result.ok) return { available: false, message: result.stderr || tMain('main.pulls.unavailable') };
  try { return { available: true, items: JSON.parse(result.stdout || '[]') }; }
  catch { return { available: false, message: tMain('main.pulls.unreadable') }; }
}

/** 把仍在运行的任务就地收敛为 failed —— host 退出/启动失败时不会再有 run_completed 落盘，不收敛侧栏就永远转圈。 */
function failTask(taskId: string, message: string): void {
  const task = taskById(taskId);
  if (!task || (task.status !== 'running' && task.status !== 'waiting')) return;
  task.status = 'failed';
  task.lastError = message;
  task.updatedAt = new Date().toISOString();
  saveState();
  broadcastState();
}

function updateTaskFromAgent(envelope: HostEnvelope): void {
  const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : undefined;
  const task = taskById(requestId);
  if (!task) return;
  const event = envelope.event;
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
  if (event === 'run_started') { task.status = 'running'; if (typeof payload.sessionId === 'string') task.sessionId = payload.sessionId; }
  if (event === 'approval_requested') task.status = 'waiting';
  if (event === 'status') task.status = 'running';
  if (event === 'run_aborted') task.status = 'cancelled';
  if (event === 'run_failed') { task.status = 'failed'; task.lastError = String(payload.message ?? RUN_FAILED_MARKER); }
  if (event === 'run_completed') {
    task.changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles.filter((item): item is string => typeof item === 'string') : [];
    task.status = payload.terminationReason === 'aborted' ? 'cancelled' : payload.terminationReason === 'completed' ? 'completed' : 'failed';
  }
  task.updatedAt = new Date().toISOString();
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
  private crashStreak = 0;
  /** 最近一次启动失败的原因。start() 自己已经报过一次，send() 靠它避免同一条错误弹两遍。 */
  private lastStartError: string | null = null;
  /** 累计报过的错误条数：send() 用它判断「刚才那次 start() 到底报没报过」。 */
  private errorSeq = 0;
  private static MAX_CRASH_STREAK = 3;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.client.onEvent((envelope) => this.receive(envelope));
    this.client.onDiagnostic((message) =>
      this.receive({ type: 'event', event: 'host_log', payload: { message } }),
    );
    this.client.onExit(({ code, expected }) => {
      // 预期内的退出全是**我们自己**发起的（stop / 切模型重启 / 被新一次 start 打断）：
      // 这时任务要么马上会被重新拉起（重启后紧接着的那条 send），要么调用方已经自己收敛了状态
      // （删任务 / 回滚 / 退出应用，见各自的 handler）。以前一律 failTask + 发 host_exit，会把
      // 「重启后正常接着跑」的那一轮误报成「运行失败 / Agent 进程已停止」—— 用户看到的就是莫名的失败。
      if (expected) {
        pushRenderer('work:agent-event', { type: 'event', event: 'host_stopped', requestId: this.taskId, payload: { code } });
        return;
      }
      this.receive({ type: 'event', event: 'host_exit', payload: { code } });
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
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
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

  async send(value: HostCommand): Promise<void> {
    // 先等正在进行的 restart 收尾:client.stop() 只发了 kill,子进程尚未退出时
    // isRunning 仍为 true,若直接发会落到正在死掉的旧进程上(切换模型后最易踩)。
    if (this.restarting) await this.restarting;
    if (!this.client.isRunning) {
      const project = this.currentProject;
      if (!project) {
        this.fail(tMain('main.host.couldNotStart'));
        return;
      }
      if (this.crashStreak >= LocalAgent.MAX_CRASH_STREAK) {
        this.fail(tMain('main.host.continuousCrash'));
        return;
      }
      // 已经有一次 start 在飞（创建任务时的预热还没起完）→ **等它**，别再发一次：
      // 再发会让 AgentHostClient 顶掉生成号，把正在启动的那个 host 杀掉
      // —— 用户看到的就是莫名其妙的「Agent 进程已停止」，还白搭一次冷启动。
      if (this.starting) await this.starting.catch(() => undefined);
      if (!this.client.isRunning) {
        const reportedErrors = this.errorSeq;
        await this.start(project);
        if (!this.client.isRunning) {
          // start() 报过的具体原因就不再重复弹；没报过（并发早退等）也必须兜底一条。
          if (this.errorSeq === reportedErrors) {
            this.fail(this.lastStartError ?? tMain('main.host.couldNotStart'));
          }
          return;
        }
      }
    }
    if (this.starting) await this.starting.catch(() => undefined);
    if (!this.client.isRunning) {
      this.fail(tMain('main.host.couldNotStart'));
      return;
    }
    try {
      await this.client.send(value);
      this.crashStreak = 0;
    } catch (cause) {
      this.fail(tMain('main.host.sendFail', { raw: cause instanceof Error ? cause.message : String(cause) }));
    }
  }

  /** host 现在是否活着（正在跑）。用于判断「停止」有没有必要发出去。 */
  get isRunning(): boolean {
    return this.client.isRunning;
  }

  stop(): void {
    this.currentProject = null;
    this.starting = null;
    void this.client.stop();
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
    const stopping = this.client.stop();
    this.restarting = stopping.catch(() => undefined);
    void this.restarting.finally(() => {
      if (this.restarting === stopping) this.restarting = null;
    });
  }

  private receive(envelope: HostEnvelope): void {
    if (envelope.type === 'event') updateTaskFromAgent(envelope);
    if (envelope.type === 'error') {
      this.errorSeq += 1;
      // host 起不来 / send 失败（尚未就绪、连续崩溃、管道断开等）也必须收敛任务，
      // 否则任务停在 running 等一个永远不会来的 run_completed。
      failTask(this.taskId, envelope.error || tMain('main.host.commFailed'));
      // 一律补上 requestId(= 任务 id)：渲染层据此把失败归到正确的那条会话，
      // 而不是靠「当前正在看哪个任务」猜（切过任务就张冠李戴）。
      pushRenderer('work:agent-event', { ...envelope, requestId: envelope.requestId ?? this.taskId });
      return;
    }
    pushRenderer('work:agent-event', envelope);
  }
}

function createWindow(): void {
  // 应用图标(白底圆角正方形 + 像素兔)。dev 模式下用于窗口/Dock;Windows 任务栏 / 打包后的 .exe
  // 图标是 electron-builder 资源,需要打包时配 win.icon 才能换,这里管不到。
  const appIconPath = path.join(__dirname, 'assets', 'icon.png');
  windowRef = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 620, title: 'MoCode Work', backgroundColor: '#ffffff', autoHideMenuBar: true,
    ...(existsSync(appIconPath) ? { icon: appIconPath } : {}),
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#f7f8f7', symbolColor: '#202124', height: 38 },
    } : {}),
    webPreferences: { preload: path.join(__dirname, 'renderer', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  windowRef.setMenuBarVisibility(false);
  void windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 窗口关掉立刻清掉引用,免得 agent 后续 stdout 还往里塞 → "Object has been destroyed"。
  windowRef.on('closed', () => { if (windowRef) windowRef = null; });
}

/** 让窗口原生背景和 Windows 控制按钮跟随应用主题。 */
function applyThemeBackground(theme: 'light' | 'dark' | 'system'): void {
  nativeTheme.themeSource = theme;
  const isDark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark';
  const bg = isDark ? '#1b1c1f' : '#ffffff';
  windowRef?.setBackgroundColor(bg);
  if (process.platform === 'win32' && windowRef && !windowRef.isDestroyed()) {
    windowRef.setTitleBarOverlay({
      color: isDark ? '#202225' : '#f7f8f7',
      symbolColor: isDark ? '#f5f5f5' : '#202124',
      height: 38,
    });
  }
}

function currentTaskWorkspace(task: TaskRecord): Record<string, unknown> {
  const project = workspaceForTask(task);
  return { task, history: project ? sessionHistory(project, task.sessionId) : [] };
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
  if (existing) {
    // 被 stop() 过的实例（回滚 / 删任务 / 切模型）还留在表里但没有 cwd：就地重新绑定，
    // 否则下一次 send 会以「还没起来」失败。
    if (!existing.projectId && workspace) void existing.start(workspace);
    return existing;
  }
  const agent = new LocalAgent(task.id);
  agents.set(task.id, agent);
  if (workspace) void agent.start(workspace);
  return agent;
}

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
    state.selectedProjectId = project.id;
    // 打开新空间只切换浏览器上下文，不动任何任务的归属 ——
    // 归属变更走 work:set-task-project（chip / 任务菜单显式触发）。
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
    task.updatedAt = new Date().toISOString();
    if (target) state.selectedProjectId = target;
    saveState(); broadcastState();
    ensureAgent(task);
    return { ok: true, state, task };
  });
  ipcMain.handle('work:select-task', async (_event, taskId: string) => {
    const task = taskById(taskId); if (!task) return null;
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
    return { state, ...currentTaskWorkspace(task) };
  });
  // 回滚对话:截断会话到指定用户消息之前。
  // 落盘之后必须重启该任务的 host —— 它内存里还留着被回滚掉的历史,继续用同一个进程会
  // 在下一轮结束时把旧历史全量写回磁盘,回滚当场失效(这就是为什么这里不要走 online 通道)。
  ipcMain.handle('work:rollback', (_event, taskId: string, userIndex: number) => {
    if (typeof taskId !== 'string' || !taskId || typeof userIndex !== 'number') return { ok: false, message: tMain('main.rollback.invalidParam') };
    const task = taskById(taskId);
    if (!task) return { ok: false, message: tMain('main.task.projectNotExist') };
    const rolled = rollbackSession(task, userIndex);
    if (!rolled.ok) return rolled;
    const agent = agents.get(taskId);
    if (agent) { void agent.send({ type: 'cancel', id: taskId }); agent.stop(); agents.delete(taskId); }
    if (task.status === 'running' || task.status === 'waiting') task.status = 'cancelled';
    task.lastError = undefined;
    task.updatedAt = new Date().toISOString();
    saveState(); broadcastState();
    return { ok: true, state, ...currentTaskWorkspace(task) };
  });
  ipcMain.handle('work:delete-task', (_event, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) return null;
    // 任务 id 全局唯一，且「任务」「空间」两个分组都会展示任务 —— 不能再按 selectedProjectId 拦，
    // 否则在「任务」分组里删空间任务（或反之）会被静默拒绝。
    const task = taskById(taskId);
    if (!task) return null;
    const agent = agents.get(taskId);
    if (agent) { void agent.send({ type: 'cancel', id: taskId }); agent.stop(); agents.delete(taskId); }
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    if (state.selectedTaskId === taskId) state.selectedTaskId = undefined;
    saveState(); broadcastState(); return state;
  });
  ipcMain.handle('work:clear-tasks', (_event, projectId?: string) => {
    const targetProjectId = projectId ?? state.selectedProjectId;
    const selectedTaskId = state.selectedTaskId;
    const removed = state.tasks.filter((task) => task.projectId === targetProjectId && task.status !== 'running' && task.status !== 'waiting');
    for (const task of removed) { const agent = agents.get(task.id); if (agent) { agent.stop(); agents.delete(task.id); } }
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
    task.updatedAt = new Date().toISOString();
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
  // 在系统文件管理器中打开项目文件夹。
  ipcMain.handle('work:open-folder', (_event, projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return false;
    shell.openPath(project.root).catch(() => {});
    return true;
  });
  // 从空间列表中移除一个项目（不删除磁盘文件，仅从 UI 列表移除）。
  ipcMain.handle('work:remove-project', (_event, projectId: string) => {
    if (typeof projectId !== 'string' || !projectId) return null;
    const idx = state.projects.findIndex((item) => item.id === projectId);
    if (idx === -1) return null;
    const removed = state.projects.splice(idx, 1)[0];
    // 如果移除的是当前选中项目，切到第一个剩余项目
    if (state.selectedProjectId === projectId) {
      state.selectedProjectId = state.projects[0]?.id ?? '';
      state.selectedTaskId = undefined;
    }
    // 清理该项目的任务与其 agent 实例
    for (const task of state.tasks.filter((task) => task.projectId === projectId)) {
      const agent = agents.get(task.id);
      if (agent) { void agent.send({ type: 'cancel', id: task.id }); agent.stop(); agents.delete(task.id); }
    }
    state.tasks = state.tasks.filter((task) => task.projectId !== projectId);
    saveState(); broadcastState();
    return { state, removed: removed.name };
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
  ipcMain.handle('work:pull-requests', async () => pullRequests(selectedProject()));
  ipcMain.handle('work:pick-attachment', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    return result.canceled || !result.filePaths[0] ? null : attachmentFor(result.filePaths[0]);
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
    return { ok: true, preset: { ...preset } };
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
  ipcMain.handle('work:get-settings', () => readSettings());
  ipcMain.handle('work:set-settings', (_event, patch: Record<string, unknown>) => {
    if (!patch || typeof patch !== 'object') return readSettings();
    const configPatch: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
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
        task.updatedAt = new Date().toISOString();
        saveState();
        broadcastState();
      }
      pushRenderer('work:agent-event', { type: 'event', event: 'run_aborted', requestId: id, payload: {} });
      return;
    }
    if (value.type === 'run') {
      task.status = 'running';
      // 上一次的失败原因就此作废，否则侧栏会挂着「上次运行未正常结束」而状态却是正在运行。
      task.lastError = undefined;
      task.updatedAt = new Date().toISOString();
      saveState();
      broadcastState();
    }
    // 关键：这条指令绝不能因为「表里没有实例」被丢掉。run / compact 就地补实例（懒启动 host）；
    // 只有 approval 必须打到原来那个 host 上（那个 host 才有等待中的审批）。
    const agent = agents.get(id) ?? (value.type === 'approval' ? null : ensureAgent(task));
    if (!agent) { reportTaskError(id, tMain('main.task.notRunning')); return; }
    void agent.send({ ...value, id } as HostCommand);
  });
}

/** 构建（或按当前语言重建）原生应用菜单。切语言后必须调一次 —— 菜单是主进程资源，不随渲染层重绘。 */
function rebuildAppMenu(): void {
  appMenu = Menu.buildFromTemplate([
    { id: 'file', label: tMain('menu.file'), submenu: [{ role: 'close', label: tMain('menu.closeWindow') }] },
    { id: 'edit', label: tMain('menu.edit'), submenu: [{ role: 'undo', label: tMain('menu.undo') }, { role: 'redo', label: tMain('menu.redo') }] },
    { id: 'view', label: tMain('menu.view'), submenu: [{ role: 'reload', label: tMain('menu.reload') }, { role: 'toggleDevTools', label: tMain('menu.devTools') }] },
    { id: 'help', label: tMain('menu.help'), submenu: [{ label: 'MoCode Work', enabled: false }] },
  ]);
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
  Menu.setApplicationMenu(null);
  state = await loadState();
  // 启动时先让 .active 预设覆盖 config 裸键 —— 必须在 agent 启动之前，
  // 否则 host 会带着 config 里那个可能已过时的 LLM_MODEL 启动。
  applyActivePreset();
  installIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  for (const agent of agents.values()) agent.stop();
  if (process.platform !== 'darwin') app.quit();
});
