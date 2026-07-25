import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme } from 'electron';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.mocode', 'node_modules', 'dist', 'coverage', '.next', '.cache']);

/**
 * 复用 mocode 已配好的模型 / 沙箱 / 记忆 / 验证 / 主题等配置。
 * 与 src/config/index.ts 的 loadEnvFiles() 行为一致:
 *   候选(后者覆盖前者,优先级升序):<projectRoot>/.env(兼容旧用法,最低)
 *     → ~/.mocode/config(全局,/model 与 mocode config 写此)
 *     → <projectRoot>/.mocode/config(项目级覆盖,最高)。
 * shell 里 export 的同名键不被回填(/model 写文件的优先级语义与 REPL 一致)。
 * 只把 mocode 自己认识的键回填到 process.env,避免把无关 .env 字段塞进 host。
 */
const MOCODE_CONFIG_KEYS = [
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'CONTEXT_WINDOW_TOKENS', 'MAX_TOKENS',
  'COMPACT_THRESHOLD', 'LLM_STREAM_USAGE', 'AUTO_COMPACT', 'MOCODE_AUTO_VALIDATE',
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
  id: string; projectId: string; title: string; status: TaskStatus; createdAt: string; updatedAt: string;
  sessionId?: string; changedFiles: string[]; lastError?: string;
}
interface StoredState { version: 1; projects: Project[]; selectedProjectId: string; tasks: TaskRecord[]; selectedTaskId?: string; }
interface CommandResult { ok: boolean; stdout: string; stderr: string; }

let windowRef: BrowserWindow | null = null;
let appMenu: Menu | null = null;
let state: StoredState;
let agent: LocalAgent | null = null;
let activeTaskId: string | null = null;

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
  baseURL: string;       // 仅显示用(只返回 host,不泄漏完整 endpoint)
  contextWindow: number; // tokens
  isActive: boolean;
}

/** 扫描 ~/.mocode/models/*.json,返回所有模型描述 + 当前激活标记。 */
function listModels(): ModelDescriptor[] {
  const active = process.env.LLM_MODEL || readUserConfig().LLM_MODEL || '';
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
      const contextWindow = Number(raw.contextWindow ?? 0) || 0;
      out.push({ name, label: model, baseURL: maskUrl(baseURL), contextWindow, isActive: name === active });
    } catch { /* 跳过解析失败的文件 */ }
  }
  // 激活项置顶,其余按名称字典序
  out.sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name) : a.isActive ? -1 : 1));
  return out;
}

/**
 * 把指定模型切为当前激活:读目标 .json,把所有相关键写入 ~/.mocode/config 与 process.env。
 * 同时取消正在运行的任务(host 进程下一次 send 时会自动重启并加载新配置)。
 */
function switchModel(name: string): { ok: boolean; message: string; model?: ModelDescriptor } {
  const target = path.join(modelsDir(), `${name}.json`);
  if (!existsSync(target)) return { ok: false, message: `模型 ${name} 不存在` };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>; }
  catch { return { ok: false, message: `无法读取模型 ${name}` }; }
  const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL : '';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
  const model = typeof raw.model === 'string' ? raw.model : name;
  const contextWindow = Number(raw.contextWindow ?? 0) || 0;
  if (!baseURL || !model) return { ok: false, message: `模型 ${name} 缺少 baseURL / model 字段` };
  // 写文件(只覆盖 4 个相关键)
  const patch: Record<string, string> = {
    LLM_BASE_URL: baseURL,
    LLM_API_KEY: apiKey,
    LLM_MODEL: name,
  };
  if (contextWindow) patch.CONTEXT_WINDOW_TOKENS = String(contextWindow);
  try { writeUserConfig(patch); }
  catch (error) { return { ok: false, message: `写入配置失败: ${(error as Error).message}` }; }
  // 同步到 process.env,这样已经 start 过的 host 也会用新配置
  process.env.LLM_BASE_URL = baseURL;
  process.env.LLM_API_KEY = apiKey;
  process.env.LLM_MODEL = name;
  if (contextWindow) process.env.CONTEXT_WINDOW_TOKENS = String(contextWindow);
  // 取消正在跑的任务
  if (activeTaskId) { void agent?.send({ type: 'cancel', id: activeTaskId }); activeTaskId = null; }
  return { ok: true, message: `已切换到 ${name}`, model: { name, label: model, baseURL: maskUrl(baseURL), contextWindow, isActive: true } };
}

/**
 * 解析用来跑 Agent Host 的 node 可执行文件。
 *
 * 背景:Electron 自带的 node(ELECTRON_RUN_AS_NODE 模式)内嵌的 fetch/undici 在处理
 * OpenAI 兼容的流式响应(SSE chunked)时会提前抛 "Premature close" —— LLM 明明正常返回了
 * 文本,流却被 Electron 的网络栈判为异常断开,导致 host emit run_failed,任务永远跑不完一轮。
 *
 * 用系统 node(v18+)跑同一个 host 则完整跑通(已对照验证)。因此优先探测系统 node;
 * 找不到才 fallback 回 Electron 自带 node,并经 host_log 告知用户——后者可能遭遇流式中断。
 *
 * 探测顺序:env 覆盖 → which/where → 常见安装路径 → process.execPath(fallback)。
 * 缓存首次结果:resolveHostNode 在一个 app 生命周期内最多探测一次。
 */
let hostNodeCache: { exe: string; isElectron: boolean } | null = null;
function resolveHostNode(): { exe: string; isElectron: boolean } {
  if (hostNodeCache) return hostNodeCache;
  const tryPaths: string[] = [];
  if (process.env.MOCODE_HOST_NODE) tryPaths.push(process.env.MOCODE_HOST_NODE);
  tryPaths.push('node'); // PATH 上的 node(which/where)
  if (process.platform === 'win32') {
    tryPaths.push('C:\\Program Files\\nodejs\\node.exe', 'D:\\nodejs\\node.exe');
    const local = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node.exe');
    tryPaths.push(local);
    // WorkBuddy 托管的 Node.js（PATH 上不一定有，需要显式探测）
    const wbNodeDir = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
    try {
      if (existsSync(wbNodeDir)) {
        const versions = readdirSync(wbNodeDir).filter((d) => /^\d/.test(d)).sort().reverse();
        for (const v of versions) {
          const wbExe = path.join(wbNodeDir, v, 'node.exe');
          if (existsSync(wbExe)) tryPaths.push(wbExe);
        }
      }
    } catch { /* skip */ }
  } else {
    tryPaths.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }
  for (const candidate of tryPaths) {
    try {
      // 对 'node'(无路径)用 execFileSync -v 探测 PATH;对绝对路径直接 existsSync。
      if (candidate === 'node') {
        const version = execFileSync(candidate, ['-v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 4000 }).trim();
        if (/^v(\d+)\./.test(version) && Number(RegExp.$1) >= 18) {
          hostNodeCache = { exe: candidate, isElectron: false };
          return hostNodeCache;
        }
      } else if (existsSync(candidate)) {
        const version = execFileSync(candidate, ['-v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 4000 }).trim();
        if (/^v(\d+)\./.test(version) && Number(RegExp.$1) >= 18) {
          hostNodeCache = { exe: candidate, isElectron: false };
          return hostNodeCache;
        }
      }
    } catch { /* 该候选不可用,继续 */ }
  }
  hostNodeCache = { exe: process.execPath, isElectron: true };
  return hostNodeCache;
}

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
        if (role !== 'user' && role !== 'assistant' && role !== 'tool') return [];
        const text = contentText(message.content);
        if (text) return [{ role, text }];
        if (role !== 'assistant' || !Array.isArray(message.tool_calls)) return [];
        const names = message.tool_calls.map((call) => String((call as { function?: { name?: string } }).function?.name ?? 'tool'));
        return names.length ? [{ role: 'tool' as const, text: `调用工具：${names.join(', ')}` }] : [];
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
  private currentProject: Project | null = null;
  private starting: Promise<void> | null = null;
  // host 连续崩超过这个次数就不再自动重启,避免配置错误时刷屏 + 死循环
  private crashStreak = 0;
  private static MAX_CRASH_STREAK = 3;

  async start(project: Project): Promise<void> {
    this.currentProject = project;
    // 每次切换项目 / 启动 host 前,把 mocode 配置回填到 process.env(host 通过 {...process.env} 继承)。
    const { loaded, missing } = loadMocodeConfig(project.root);
    if (loaded.length) {
      pushRenderer('work:agent-event', { type: 'event', event: 'host_log', payload: { message: `[mocode-work] 已加载 mocode 配置: ${loaded.join(', ')}` } });
    }
    if (missing.length) {
      pushRenderer('work:agent-event', { type: 'event', event: 'host_log', payload: { message: `[mocode-work] mocode 配置缺少 ${missing.join(', ')}，请先在终端跑 mocode /model 配好模型再启动任务。` } });
    }

    this.stop();
    const hostFile = process.env.MOCODE_HOST_PATH ?? path.resolve(__dirname, '..', '..', '..', 'dist', 'host', 'stdio.js');
    if (!existsSync(hostFile)) {
      this.crashStreak = LocalAgent.MAX_CRASH_STREAK;
      return this.receive({ type: 'error', error: `Agent Host 未构建：${hostFile}` });
    }
    const hostNode = resolveHostNode();
    const hostEnv: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
    if (hostNode.isElectron) hostEnv.ELECTRON_RUN_AS_NODE = '1';
    pushRenderer('work:agent-event', { type: 'event', event: 'host_log', payload: { message: hostNode.isElectron ? `[mocode-work] 未找到系统 node，用 Electron 内置 node 跑 host —— 流式响应可能中途断开，建议安装 Node.js ≥18。` : `[mocode-work] 用系统 node 跑 host：${hostNode.exe}` } });
    const child = spawn(hostNode.exe, [hostFile], {
      cwd: project.root, windowsHide: true, env: hostEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.starting = new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => { if (settled) return; settled = true; resolve(); };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { this.read(chunk); settle(); });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (message: string) => this.receive({ type: 'event', event: 'host_log', payload: { message } }));
      child.once('exit', (code) => {
        this.receive({ type: 'event', event: 'host_exit', payload: { code } });
        this.child = null;
        settle();
        // host 崩了:如果项目还在,就静默拉一个,避免下次 send 又回 "尚未就绪"
        if (this.currentProject && this.crashStreak < LocalAgent.MAX_CRASH_STREAK) {
          this.crashStreak += 1;
          this.start(this.currentProject).catch(() => undefined);
        }
      });
    });
  }

  /** 等到 host 的 stdout 至少有首个 chunk(说明子进程已就绪并进入 readline 循环),或者已退出。 */
  async waitReady(): Promise<void> {
    if (this.starting) await this.starting;
  }

  async send(value: Record<string, unknown>): Promise<void> {
    if (!this.child?.stdin?.writable) {
      // host 没起 / 死了:有项目就拉一个,等就绪后再写
      if (this.currentProject) {
        if (this.crashStreak >= LocalAgent.MAX_CRASH_STREAK) {
          this.receive({ type: 'error', error: 'Agent Host 连续崩溃，已停止自动重启。请在终端确认 mocode 配置后重试。' });
          return;
        }
        await this.start(this.currentProject);
      } else {
        this.receive({ type: 'error', error: 'Agent Host 尚未就绪。' });
        return;
      }
    }
    await this.waitReady();
    if (!this.child?.stdin?.writable) {
      this.receive({ type: 'error', error: 'Agent Host 尚未就绪。' });
      return;
    }
    this.crashStreak = 0; // 成功写入 stdin 说明 host 还活着,重置崩溃计数
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.starting = null;
    this.buffer = '';
  }

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
  // 应用图标(白底圆角正方形 + 像素兔)。dev 模式下用于窗口/Dock;Windows 任务栏 / 打包后的 .exe
  // 图标是 electron-builder 资源,需要打包时配 win.icon 才能换,这里管不到。
  const appIconPath = path.join(__dirname, 'assets', 'icon.png');
  windowRef = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 620, title: 'Mocode Work', backgroundColor: '#ffffff', autoHideMenuBar: true,
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
  const project = state.projects.find((item) => item.id === task.projectId);
  return { task, history: project ? sessionHistory(project, task.sessionId) : [] };
}

function maskUrl(raw: string): string {
  if (!raw) return '';
  try { const url = new URL(raw); return `${url.protocol}//${url.host}`; } catch { return ''; }
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
  ipcMain.handle('work:delete-task', (_event, taskId: string) => {
    if (typeof taskId !== 'string' || !taskId) return null;
    const task = taskById(taskId);
    if (!task || task.projectId !== state.selectedProjectId) return null;
    if (task.id === activeTaskId) {
      void agent?.send({ type: 'cancel', id: task.id });
      activeTaskId = null;
    }
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    if (state.selectedTaskId === taskId) state.selectedTaskId = undefined;
    saveState(); broadcastState(); return state;
  });
  ipcMain.handle('work:clear-tasks', () => {
    const projectId = state.selectedProjectId;
    const selectedTaskId = state.selectedTaskId;
    state.tasks = state.tasks.filter((task) => task.projectId !== projectId || task.id === activeTaskId || task.status === 'running' || task.status === 'waiting');
    if (selectedTaskId && !state.tasks.some((task) => task.id === selectedTaskId)) state.selectedTaskId = undefined;
    saveState(); broadcastState(); return state;
  });
  // 重命名任务：保留其余字段，仅覆盖 title。用于侧栏双击重命名与「新建任务」弹窗的重命名模式。
  ipcMain.handle('work:rename-task', (_event, taskId: string, title: string) => {
    if (typeof taskId !== 'string' || !taskId || typeof title !== 'string') return null;
    const task = taskById(taskId);
    if (!task || task.projectId !== state.selectedProjectId) return null;
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
  // 把模型 / 上下文等关键配置透出给 renderer,用于在 UI 上显示真实信息。
  // 注意:不返回 LLM_API_KEY 等敏感字段。
  ipcMain.handle('work:get-config', () => {
    const models = listModels();
    const active = models.find((item) => item.isActive) ?? null;
    return {
      model: process.env.LLM_MODEL ?? '',
      label: active?.label ?? process.env.LLM_MODEL ?? '',
      baseUrl: active?.baseURL ?? maskUrl(process.env.LLM_BASE_URL ?? ''),
      contextWindow: active?.contextWindow ?? (Number(process.env.CONTEXT_WINDOW_TOKENS ?? 0) || null),
      language: process.env.MOCODE_LANGUAGE ?? '',
      theme: process.env.MOCODE_THEME ?? '',
    };
  });
  ipcMain.handle('work:list-models', () => listModels());
  ipcMain.handle('work:switch-model', (_event, name: string) => {
    if (typeof name !== 'string' || !name) return { ok: false, message: '模型名为空' };
    const result = switchModel(name);
    if (result.ok) broadcastState();
    return { ok: result.ok, message: result.message };
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
    if (value.type === 'run') { activeTaskId = id; const task = taskById(id); if (task) { task.status = 'running'; task.updatedAt = new Date().toISOString(); saveState(); broadcastState(); } }
    void agent?.send({ ...value, id });
  });
}

app.whenReady().then(async () => {
  appMenu = Menu.buildFromTemplate([
    { id: 'file', label: '文件', submenu: [{ role: 'close', label: '关闭窗口' }] },
    { id: 'edit', label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }] },
    { id: 'view', label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }] },
    { id: 'help', label: '帮助', submenu: [{ label: 'Mocode Work', enabled: false }] },
  ]);
  Menu.setApplicationMenu(null);
  state = await loadState(); agent = new LocalAgent(); installIpc(); createWindow(); await agent.start(selectedProject());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { agent?.stop(); if (process.platform !== 'darwin') app.quit(); });
