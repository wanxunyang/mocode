/**
 * 扩展管理（Skill 市场 + MCP 接入）主进程侧。
 *
 * Skill 侧：与 core 的 src/skills/discover.ts 同格式 —— 每个 skill 是一个含
 * SKILL.md（顶部 YAML frontmatter，兼容 Agent Skills 开放标准 / Claude Code）的目录。
 * 安装目标是 ~/.mocode/skills/<name>/，mocode 终端与 work-app 的 host 子进程都会
 * 从这里发现（user 级、免门禁）；只读展示 ~/.claude/skills 与项目级 <root>/.mocode/skills。
 * 「市场」= 浅克隆公开 git 仓库到本地缓存 → 扫描其中所有含 SKILL.md 的目录 →
 * 按需拷贝安装。不依赖 GitHub API，任何 git 托管平台都可用。
 *
 * MCP 侧：维护 ~/.mocode/mcp.json（标准 { "mcpServers": { ... } } 格式，与
 * Claude Desktop / Cursor 等主流工具互导）。host 子进程通过 MCP_CONFIG_PATH
 * 环境变量读到它（main.ts 在启动时兜底注入），格式约束与 core 的
 * src/mcp/config.ts 对齐：stdio 需要 command，远程需要 http(s) URL。
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// ── 路径 ──────────────────────────────────────────────────────────

export function userSkillsDir(): string {
  return path.join(os.homedir(), '.mocode', 'skills');
}

export function claudeSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

export function projectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, '.mocode', 'skills');
}

export function mcpConfigPath(): string {
  return path.join(os.homedir(), '.mocode', 'mcp.json');
}

/** 市场仓库的本地缓存根（浅克隆放这里，安装时直接从缓存拷贝）。放 userData，不污染 ~/.mocode。 */
function marketCacheRoot(): string {
  return path.join(app.getPath('userData'), 'skill-market');
}

// ── frontmatter 解析（core parseFrontmatter 的精简移植：标量 / 行内数组 / 块序列）──

type FrontmatterValue = string | string[];

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

function splitList(s: string): string[] {
  return s.replace(/^\[|\]$/g, '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export function parseSkillFrontmatter(content: string): Record<string, FrontmatterValue> {
  const meta: Record<string, FrontmatterValue> = {};
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '---') return meta;
  i++;
  const fm: string[] = [];
  let closed = false;
  while (i < lines.length) {
    if (lines[i].trim() === '---') { closed = true; break; }
    fm.push(lines[i]);
    i++;
  }
  if (!closed) return meta;
  const isItem = (l: string): boolean => l.trim() === '-' || l.trim().startsWith('- ');
  for (let k = 0; k < fm.length; k++) {
    const line = fm[k]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!value && k + 1 < fm.length && isItem(fm[k + 1]!)) {
      const arr: string[] = [];
      let j = k + 1;
      while (j < fm.length && isItem(fm[j]!)) { arr.push(fm[j]!.trim().slice(2).trim()); j++; }
      meta[key] = arr;
      k = j - 1;
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) { meta[key] = splitList(value.slice(1, -1)); continue; }
    meta[key] = unquote(value);
  }
  return meta;
}

function scalar(meta: Record<string, FrontmatterValue>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === 'string' ? v : undefined;
}

// ── Skill 列表（已安装） ─────────────────────────────────────────

export interface SkillItemView {
  name: string;
  description: string;
  version?: string;
  dir: string;
  /** user = ~/.mocode/skills（可删）；claude = ~/.claude/skills（只读展示）；project = 当前空间项目级（可删）。 */
  origin: 'user' | 'claude' | 'project';
  modelInvocable: boolean;
  allowedTools?: string[];
}

function readSkillDir(skillDir: string, origin: SkillItemView['origin']): SkillItemView | null {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  try {
    const meta = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'));
    const description = (scalar(meta, 'description') ?? '').trim();
    if (!description) return null; // 与 core 一致：description 是触发机制，缺失则不登记
    const allowed = meta['allowed-tools'];
    return {
      name: (scalar(meta, 'name') ?? path.basename(skillDir)).trim(),
      description,
      version: scalar(meta, 'version')?.trim() || undefined,
      dir: skillDir,
      origin,
      modelInvocable: scalar(meta, 'disable-model-invocation')?.toLowerCase() !== 'true',
      allowedTools: Array.isArray(allowed) ? allowed : undefined,
    };
  } catch {
    return null;
  }
}

/** 扫描三个来源目录，列出全部已安装 skill（同名按优先级 project > user > claude 去重）。 */
export function listInstalledSkills(projectRoot?: string): SkillItemView[] {
  const byName = new Map<string, SkillItemView>();
  const sources: Array<{ dir: string; origin: SkillItemView['origin'] }> = [
    { dir: claudeSkillsDir(), origin: 'claude' },
    { dir: userSkillsDir(), origin: 'user' },
  ];
  if (projectRoot) sources.push({ dir: projectSkillsDir(projectRoot), origin: 'project' });
  for (const { dir, origin } of sources) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { continue; /* 目录不存在：跳过 */ }
    for (const name of entries) {
      const skill = readSkillDir(path.join(dir, name), origin);
      if (skill) byName.set(skill.name, skill); // 后扫描的覆盖先扫描的（project 优先级最高）
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Skill 导入 ────────────────────────────────────────────────────

export interface ImportResult {
  ok: boolean;
  message?: string;
  installed: Array<{ name: string; dir: string; updated: boolean }>;
}

const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-tests', 'target', 'coverage', '.next', '.cache', '.github']);

/** 在 sourceRoot 里找所有「含 SKILL.md 的最浅目录」（命中即止，不再下钻）。 */
function findSkillDirs(sourceRoot: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  let entries;
  try { entries = readdirSync(sourceRoot, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) { out.push(sourceRoot); return out; }
  for (const entry of entries) {
    if (!entry.isDirectory() || SCAN_SKIP_DIRS.has(entry.name)) continue;
    findSkillDirs(path.join(sourceRoot, entry.name), depth + 1, out);
  }
  return out;
}

/** 目录名 → 合法安装目录名（跨平台安全字符）。 */
function sanitizeDirName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 64);
  return cleaned || 'skill';
}

/** 把一个含 SKILL.md 的目录安装到 ~/.mocode/skills/（同名覆盖 = 更新）。 */
function installSkillDir(sourceDir: string): { ok: boolean; message?: string; item?: { name: string; dir: string; updated: boolean } } {
  let meta: Record<string, FrontmatterValue>;
  try { meta = parseSkillFrontmatter(readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8')); }
  catch (error) { return { ok: false, message: path.basename(sourceDir) + ': ' + (error as Error).message }; }
  const description = (scalar(meta, 'description') ?? '').trim();
  if (!description) return { ok: false, message: `${path.basename(sourceDir)}: SKILL.md 缺少 description，无法登记` };
  const name = (scalar(meta, 'name') ?? path.basename(sourceDir)).trim();
  const dirName = sanitizeDirName(path.basename(sourceDir));
  const dest = path.join(userSkillsDir(), dirName);
  const updated = existsSync(dest); // 必须在拷贝前判定：cpSync 之后目标必然存在
  try {
    mkdirSync(userSkillsDir(), { recursive: true });
    cpSync(sourceDir, dest, { recursive: true, force: true, errorOnExist: false });
  } catch (error) {
    return { ok: false, message: `${dirName}: 拷贝失败 — ${(error as Error).message}` };
  }
  return { ok: true, item: { name, dir: dest, updated } };
}

function installFromRoots(roots: string[]): ImportResult {
  const installed: ImportResult['installed'] = [];
  const failures: string[] = [];
  for (const root of roots) {
    for (const skillDir of findSkillDirs(root)) {
      const result = installSkillDir(skillDir);
      if (result.ok && result.item) installed.push(result.item);
      else if (result.message) failures.push(result.message);
    }
  }
  if (!installed.length && failures.length) return { ok: false, message: failures.join('\n'), installed: [] };
  const parts: string[] = [];
  if (installed.length) parts.push(`已安装 ${installed.length} 个 skill（${installed.filter((i) => i.updated).length} 个为更新）`);
  if (failures.length) parts.push(`失败 ${failures.length} 个：\n${failures.join('\n')}`);
  return { ok: installed.length > 0, message: parts.join('；'), installed };
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

/** 从本地文件夹导入：选中的目录本身是 skill、或其子目录里含 skill，全部安装。 */
export async function importSkillsFromFolder(): Promise<ImportResult> {
  const picked = await dialog.showOpenDialog(mainWindow()!, { properties: ['openDirectory', 'createDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, message: 'cancelled', installed: [] };
  return installFromRoots([picked.filePaths[0]!]);
}

function execFileP(executable: string, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1_024 * 1_024 }, (error, _stdout, stderr) => {
      resolve({ ok: !error, stderr: String(stderr ?? '').trim() });
    });
  });
}

/** 跨平台解压 zip：win32 用系统自带 bsdtar，失败再退 PowerShell；macOS 用 ditto；Linux 用 unzip。 */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  if (process.platform === 'darwin') {
    const r = await execFileP('ditto', ['-x', '-k', zipPath, dest]);
    if (!r.ok) throw new Error(r.stderr || 'ditto 解压失败');
    return;
  }
  if (process.platform === 'win32') {
    const tar = await execFileP('tar', ['-xf', zipPath, '-C', dest]);
    if (tar.ok) return;
    const ps = await execFileP('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath.replace(/'/g, "''")}" -DestinationPath "${dest.replace(/'/g, "''")}" -Force`], 180_000);
    if (!ps.ok) throw new Error(ps.stderr || '解压失败（tar 与 PowerShell 均不可用）');
    return;
  }
  const r = await execFileP('unzip', ['-o', zipPath, '-d', dest]);
  if (!r.ok) throw new Error(r.stderr || 'unzip 解压失败');
}

/** 从 zip 包导入。 */
export async function importSkillsFromZip(): Promise<ImportResult> {
  const picked = await dialog.showOpenDialog(mainWindow()!, {
    properties: ['openFile'],
    filters: [{ name: 'Skill 包', extensions: ['zip'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, message: 'cancelled', installed: [] };
  const tmp = path.join(os.tmpdir(), `mocode-skill-${randomUUID()}`);
  try {
    mkdirSync(tmp, { recursive: true });
    await extractZip(picked.filePaths[0]!, tmp);
    return installFromRoots([tmp]);
  } catch (error) {
    return { ok: false, message: (error as Error).message, installed: [] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function isGitUrl(url: string): boolean {
  return /^https?:\/\/\S+/i.test(url) || /^git@[\w.-]+:[\w./-]+$/.test(url);
}

/** 市场仓库缓存目录名：URL 归一成安全 slug。 */
function repoSlug(url: string): string {
  return url.replace(/[^\w.-]+/g, '_').slice(0, 100);
}

/** 浅克隆仓库到市场缓存；refresh=true 时丢弃旧缓存重新克隆。 */
async function ensureRepoCache(url: string, refresh: boolean): Promise<string> {
  if (!isGitUrl(url)) throw new Error('不是有效的 git 仓库地址（支持 https:// 或 git@ 形式）');
  const dest = path.join(marketCacheRoot(), repoSlug(url));
  if (refresh && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    const r = await execFileP('git', ['clone', '--depth', '1', url, dest], 180_000);
    if (!r.ok) throw new Error(r.stderr || 'git clone 失败');
  }
  return dest;
}

/** 加载市场源：克隆（或读缓存）后扫描其中全部 skill，返回可安装候选。 */
export async function loadSkillMarket(url: string, refresh: boolean): Promise<{ ok: boolean; message?: string; skills: Array<{ name: string; description: string; version?: string; relDir: string }> }> {
  try {
    const cacheDir = await ensureRepoCache(url.trim(), refresh);
    const skills = findSkillDirs(cacheDir).map((dir) => {
      let meta: Record<string, FrontmatterValue> = {};
      try { meta = parseSkillFrontmatter(readFileSync(path.join(dir, 'SKILL.md'), 'utf8')); } catch { /* 解析失败给空描述 */ }
      return {
        name: (scalar(meta, 'name') ?? path.basename(dir)).trim(),
        description: (scalar(meta, 'description') ?? '').trim(),
        version: scalar(meta, 'version')?.trim() || undefined,
        relDir: path.relative(cacheDir, dir),
      };
    }).filter((s) => s.description);
    return { ok: true, skills };
  } catch (error) {
    return { ok: false, message: (error as Error).message, skills: [] };
  }
}

/** 从市场缓存安装指定 skill（relDir 相对仓库根）。 */
export async function installFromMarket(url: string, relDir: string): Promise<ImportResult> {
  const cacheDir = path.join(marketCacheRoot(), repoSlug(url.trim()));
  const sourceDir = path.resolve(cacheDir, relDir);
  // 路径安全：relDir 不得逃出缓存目录
  if (!sourceDir.startsWith(path.resolve(cacheDir) + path.sep)) return { ok: false, message: '非法路径', installed: [] };
  if (!existsSync(path.join(sourceDir, 'SKILL.md'))) return { ok: false, message: '缓存中找不到该 skill（试试刷新市场）', installed: [] };
  const result = installSkillDir(sourceDir);
  return result.ok && result.item
    ? { ok: true, installed: [result.item] }
    : { ok: false, message: result.message, installed: [] };
}

/** 删除已安装 skill：只允许删 ~/.mocode/skills 与项目级目录下的内容。 */
export function deleteSkill(dir: string, projectRoot?: string): { ok: boolean; message?: string } {
  const resolved = path.resolve(dir);
  const allowedRoots = [path.resolve(userSkillsDir())];
  if (projectRoot) allowedRoots.push(path.resolve(projectSkillsDir(projectRoot)));
  if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep))) {
    return { ok: false, message: '该目录不在可管理的 skill 目录内' };
  }
  try { rmSync(resolved, { recursive: true, force: true }); }
  catch (error) { return { ok: false, message: (error as Error).message }; }
  return { ok: true };
}

export function openSkillFolder(dir: string): void {
  void shell.openPath(path.resolve(dir));
}

// ── MCP 接入 ──────────────────────────────────────────────────────

export interface McpServerView {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  disabled: boolean;
}

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function readMcpFile(): Record<string, Record<string, unknown>> {
  try {
    const raw = JSON.parse(readFileSync(mcpConfigPath(), 'utf8')) as Record<string, unknown>;
    const map = raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : raw;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(map)) {
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) out[name] = spec as Record<string, unknown>;
    }
    return out;
  } catch { return {}; }
}

function writeMcpFile(servers: Record<string, Record<string, unknown>>): void {
  mkdirSync(path.dirname(mcpConfigPath()), { recursive: true });
  const dest = mcpConfigPath();
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf8');
  renameSync(tmp, dest);
}

export function listMcpServers(): McpServerView[] {
  const raw = readMcpFile();
  return Object.entries(raw).map(([name, spec]) => {
    const transport: McpServerView['transport'] = spec.transport === 'sse'
      ? 'sse'
      : spec.transport === 'streamable-http' || spec.transport === 'http'
        ? 'streamable-http'
        : typeof spec.command === 'string' ? 'stdio' : 'streamable-http';
    return {
      name,
      transport,
      command: typeof spec.command === 'string' ? spec.command : undefined,
      args: Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: stringRecord(spec.env),
      url: typeof spec.url === 'string' ? spec.url : undefined,
      headers: stringRecord(spec.headers),
      requestTimeoutMs: typeof spec.requestTimeoutMs === 'number' ? spec.requestTimeoutMs : undefined,
      disabled: spec.disabled === true,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** 每行一条的 textarea → Record（KEY=VALUE / KEY: VALUE）。 */
function parseKeyValueLines(text: string, separator: 'equals' | 'colon'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(separator === 'equals' ? '=' : ':');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

export interface McpDraft {
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  argsText?: string;
  envText?: string;
  url?: string;
  headersText?: string;
  requestTimeoutMs?: number;
}

/** 校验并落盘一个 MCP server（originalName 存在 = 改名保存）。 */
export function saveMcpServer(name: string, draft: McpDraft, originalName?: string): { ok: boolean; message: string } {
  const trimmed = name.trim();
  if (!MCP_NAME_RE.test(trimmed)) return { ok: false, message: '名称只允许字母数字与 . _ -，1~64 位' };
  const servers = readMcpFile();
  const renaming = !!originalName && originalName !== trimmed;
  // 编辑（originalName === trimmed 或改名）放行；只有「新增撞名」才拦。
  if (!originalName && servers[trimmed]) return { ok: false, message: `已存在同名 server：${trimmed}` };
  const spec: Record<string, unknown> = { transport: draft.transport };
  if (draft.transport === 'stdio') {
    const command = (draft.command ?? '').trim();
    if (!command) return { ok: false, message: 'stdio 类型必须填写启动命令' };
    spec.command = command;
    const args = (draft.argsText ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (args.length) spec.args = args;
    const env = parseKeyValueLines(draft.envText ?? '', 'equals');
    if (Object.keys(env).length) spec.env = env;
  } else {
    const url = (draft.url ?? '').trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('只允许 http/https');
      spec.url = parsed.toString();
    } catch (error) { return { ok: false, message: `URL 无效：${(error as Error).message}` }; }
    const headers = parseKeyValueLines(draft.headersText ?? '', 'colon');
    if (Object.keys(headers).length) spec.headers = headers;
  }
  const timeout = Number(draft.requestTimeoutMs ?? 0);
  if (Number.isFinite(timeout) && timeout > 0) spec.requestTimeoutMs = Math.floor(timeout);
  // 保留被编辑条目原有的 disabled 状态（编辑 ≠ 改启用状态，启用开关是独立操作）
  if (originalName && servers[originalName]?.disabled === true) spec.disabled = true;
  if (renaming) delete servers[originalName!];
  servers[trimmed] = spec;
  try { writeMcpFile(servers); }
  catch (error) { return { ok: false, message: `写入失败：${(error as Error).message}` }; }
  return { ok: true, message: renaming ? `已重命名并保存：${trimmed}` : `已保存：${trimmed}` };
}

export function deleteMcpServer(name: string): { ok: boolean; message: string } {
  const servers = readMcpFile();
  if (!servers[name]) return { ok: false, message: `不存在：${name}` };
  delete servers[name];
  try { writeMcpFile(servers); }
  catch (error) { return { ok: false, message: `写入失败：${(error as Error).message}` }; }
  return { ok: true, message: `已删除：${name}` };
}

export function toggleMcpServer(name: string, disabled: boolean): { ok: boolean; message: string } {
  const servers = readMcpFile();
  if (!servers[name]) return { ok: false, message: `不存在：${name}` };
  if (disabled) servers[name]!.disabled = true;
  else delete servers[name]!.disabled;
  try { writeMcpFile(servers); }
  catch (error) { return { ok: false, message: `写入失败：${(error as Error).message}` }; }
  return { ok: true, message: `${name} 已${disabled ? '停用' : '启用'}` };
}

export interface McpImportResult { ok: boolean; message: string }

/** 导入标准格式的 MCP 配置 JSON：支持 { mcpServers: {...} }、裸 server map、带 name 的数组。 */
export function importMcpJson(text: string): McpImportResult {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (error) { return { ok: false, message: `JSON 解析失败：${(error as Error).message}` }; }
  let root: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const wrapped = (raw as Record<string, unknown>).mcpServers;
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) root = wrapped;
  }
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(root)) {
    for (const item of root) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
        entries.push([(item as Record<string, unknown>).name as string, item as Record<string, unknown>]);
      }
    }
  } else if (root && typeof root === 'object') {
    for (const [name, spec] of Object.entries(root as Record<string, unknown>)) {
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) entries.push([name, spec as Record<string, unknown>]);
    }
  }
  if (!entries.length) return { ok: false, message: '没有找到可导入的 MCP server 条目' };
  const servers = readMcpFile();
  let added = 0;
  const skipped: string[] = [];
  for (const [name, spec] of entries) {
    if (!MCP_NAME_RE.test(name) || (typeof spec.command !== 'string' && typeof spec.url !== 'string')) {
      skipped.push(name);
      continue;
    }
    servers[name] = spec;
    added++;
  }
  try { writeMcpFile(servers); }
  catch (error) { return { ok: false, message: `写入失败：${(error as Error).message}` }; }
  const parts = [`已导入 ${added} 个 server`];
  if (skipped.length) parts.push(`跳过 ${skipped.length} 个（名称非法或缺少 command/url）：${skipped.join(', ')}`);
  return { ok: added > 0, message: parts.join('；') };
}
