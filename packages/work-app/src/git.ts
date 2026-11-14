import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

/** porcelain v2 的文件项：同一文件部分暂存时会分别出现在 staged / changes。 */
export interface GitFile {
  path: string;
  previousPath?: string;
  code: string;
  conflict?: boolean;
}

export interface GitStatus {
  ok: boolean;
  isRepo: boolean;
  root: string;
  branch: string;
  hasHead: boolean;
  staged: GitFile[];
  changes: GitFile[];
  conflicted: boolean;
  /** HEAD 处于 detached 状态时 branch 为空，改用 head 的短 sha 展示。 */
  detached?: boolean;
  /** HEAD 的短 sha；空仓库无此值。 */
  head?: string;
  /** 上游分支（如 origin/main）；未设置 upstream 时缺省。 */
  upstream?: string;
  ahead?: number;
  behind?: number;
  message?: string;
}

/** 工作空间里发现的一个 Git 仓库（自身 / 嵌套仓库 / 子模块 / 工作树）。 */
export interface GitRepoRef {
  root: string;
  /** 面板上显示的名字：嵌套仓库用相对路径，工作树用目录名。 */
  name: string;
  /** 相对工作空间的路径；工作空间自身为空串。 */
  relative: string;
  kind: 'workspace' | 'nested' | 'submodule' | 'worktree';
}

export interface GitRepoStatus extends GitRepoRef {
  status: GitStatus;
}

export interface GitDiffResult {
  ok: boolean;
  content?: string;
  truncated?: boolean;
  message?: string;
}

export interface GitMutationResult {
  ok: boolean;
  status?: GitStatus;
  commit?: string;
  message?: string;
}

export interface StagedDiff {
  ok: boolean;
  stat: string;
  diff: string;
  truncated: boolean;
  files: string[];
  /** 取 diff 时的仓库根；AI 生成据此说明改动属于哪个仓库。 */
  root?: string;
  /** 当前分支名；detached 时是短 sha。 */
  branch?: string;
  message?: string;
}

interface GitResult { ok: boolean; code: number; stdout: string; stderr: string }

const DIFF_PREVIEW_LIMIT = 200_000;
const AI_DIFF_LIMIT = 120_000;
const MAX_PATHS = 2_000;
const queues = new Map<string, Promise<void>>();

function runGit(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    // UI 传入的是 porcelain 中的确切文件名，不是用户输入的 glob pathspec。
    // 放在 git 与 -c/subcommand 之前，add/reset/rm/diff 共用字面路径语义。
    execFile('git', ['--literal-pathspecs', ...args], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException).code)
        : error ? -1 : 0;
      resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function errorText(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || 'Git command failed.';
}

function emptyStatus(root: string, message?: string): GitStatus {
  return { ok: false, isRepo: false, root: path.resolve(root), branch: '', hasHead: false, staged: [], changes: [], conflicted: false, ...(message ? { message } : {}) };
}

/** 解析 NUL 分隔的 porcelain v2；路径里允许空格、中文、换行和 leading dash。 */
export function parseGitStatus(root: string, stdout: string): GitStatus {
  const fields = stdout.split('\0');
  const staged: GitFile[] = [];
  const changes: GitFile[] = [];
  let branch = '';
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let hasHead = false;
  let conflicted = false;
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index]!;
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      hasHead = oid !== '(initial)';
      // detached 时 branch.head 是字面量 (detached)，只能靠短 sha 标识这个 HEAD。
      if (hasHead) head = oid.slice(0, 8);
    }
    if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    if (record.startsWith('# branch.ab ')) {
      const [aheadRaw, behindRaw] = record.slice(12).split(' ');
      const aheadValue = Number(aheadRaw?.replace('+', ''));
      const behindValue = Number(behindRaw?.replace('-', ''));
      if (Number.isFinite(aheadValue)) ahead = aheadValue;
      if (Number.isFinite(behindValue)) behind = behindValue;
    }
    if (record === '!' || record.startsWith('! ')) continue;
    if (record.startsWith('? ')) {
      changes.push({ path: record.slice(2), code: '?' });
      continue;
    }
    const kind = record[0];
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    // 前 N 个元数据字段都不含空格；余下部分完整保留为路径。
    const metadataCount = kind === '1' ? 8 : kind === '2' ? 9 : 10;
    let start = 0;
    for (let part = 0; part < metadataCount; part++) {
      const space = record.indexOf(' ', start);
      if (space < 0) { start = -1; break; }
      start = space + 1;
    }
    if (start < 0) continue;
    const filePath = record.slice(start);
    // rename 的旧路径是紧随其后的独立 NUL 记录。无论是否已暂存都必须消费，
    // 否则继续修改同一个文件时，旧路径会被当成下一条 porcelain 记录、令游标错位。
    const previousPath = kind === '2' ? fields[++index] : undefined;
    const xy = record.slice(2, 4);
    const conflict = kind === 'u';
    conflicted ||= conflict;
    if (conflict) changes.push({ path: filePath, code: 'U', conflict: true });
    else {
      if (xy[0] !== '.') staged.push({ path: filePath, code: xy[0]!, ...(previousPath ? { previousPath } : {}) });
      if (xy[1] !== '.') changes.push({ path: filePath, code: xy[1]!, ...(previousPath ? { previousPath } : {}) });
    }
  }
  // detached 时 branch 留空：字面量 'HEAD' 会让用户以为存在同名分支，面板改用短 sha。
  const detached = branch === '(detached)';
  return {
    ok: true, isRepo: true, root: path.resolve(root), branch: detached ? '' : branch, hasHead,
    staged, changes, conflicted,
    ...(detached ? { detached: true } : {}),
    ...(head ? { head } : {}),
    ...(upstream ? { upstream } : {}),
    ...(upstream && ahead !== undefined ? { ahead } : {}),
    ...(upstream && behind !== undefined ? { behind } : {}),
  };
}

export async function gitStatus(root: string): Promise<GitStatus> {
  // 工作空间可能是仓库子目录；porcelain 的路径以仓库根为基准，后续操作必须统一用该根。
  const top = await runGit(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout.trim()) return emptyStatus(root, errorText(top));
  const repoRoot = path.resolve(top.stdout.trim());
  const result = await runGit(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  return result.ok ? parseGitStatus(repoRoot, result.stdout) : emptyStatus(repoRoot, errorText(result));
}

/** 工作空间主仓库根（工作空间是仓库子目录时也返回仓库根）；不是仓库返回 null。 */
export async function repoTopLevel(workspaceRoot: string): Promise<string | null> {
  const top = await runGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
  return top.ok && top.stdout.trim() ? path.resolve(top.stdout.trim()) : null;
}

/* ── 多仓库发现 ──────────────────────────────────────────
 * 一个工作空间可能同时包含：主仓库、子目录里独立的嵌套仓库（含 mocode 自己开的
 * sub-agent 工作树）、gitlink 子模块、`git worktree` 工作树。VS Code 的面板就是按
 * 「仓库」分组的，这里沿用同一口径：发现仓库 → 每个仓库各自一份 status。
 */

/** 扫描深度与仓库数上限：嵌套仓库发现必须有限，否则大 vendored 目录会拖死面板。 */
const REPO_SCAN_MAX_DEPTH = 5;
const REPO_SCAN_MAX_REPOS = 20;
/** 不进入的目录：依赖/构建产物/运行时目录，里面几乎不会有用户要管理的仓库。 */
const REPO_SCAN_SKIP = new Set([
  'node_modules', '.git', '.mocode', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.idea',
]);

function hasGitEntry(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

/** 在 dir 之下（不含 dir 自身）按层扫描独立仓库；命中即停止深入该分支。 */
function scanNestedRepos(dir: string, exclude: Set<string>): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (queue.length && found.length < REPO_SCAN_MAX_REPOS) {
    const current = queue.shift()!;
    let entries: Dirent[];
    try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || REPO_SCAN_SKIP.has(entry.name)) continue;
      const child = path.join(current.dir, entry.name);
      if (hasGitEntry(child)) {
        const resolved = path.resolve(child);
        if (!exclude.has(resolved.toLowerCase())) found.push(resolved);
        continue;
      }
      if (current.depth + 1 < REPO_SCAN_MAX_DEPTH) queue.push({ dir: child, depth: current.depth + 1 });
    }
  }
  return found;
}

/** `git worktree list --porcelain` 的路径列表（含主工作树）。 */
async function listWorktrees(mainRoot: string): Promise<string[]> {
  const result = await runGit(mainRoot, ['worktree', 'list', '--porcelain']);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice(9).trim()))
    .filter((item) => item.length > 0);
}

/** 主仓库 index 里的 gitlink（mode 160000）路径，即子模块。 */
async function listSubmodules(mainRoot: string): Promise<string[]> {
  const result = await runGit(mainRoot, ['ls-files', '-s', '-z']);
  if (!result.ok) return [];
  const paths: string[] = [];
  for (const record of result.stdout.split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    paths.push(path.resolve(mainRoot, record.slice(tab + 1)));
  }
  return paths;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function repoRef(root: string, kind: GitRepoRef['kind'], workspaceRoot: string): GitRepoRef {
  const resolved = path.resolve(root);
  const relative = path.relative(workspaceRoot, resolved);
  const usable = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return {
    root: resolved,
    relative: usable ? relative.split(path.sep).join('/') : '',
    name: usable ? relative.split(path.sep).join('/') : path.basename(resolved),
    kind,
  };
}

/**
 * 发现工作空间里的全部 Git 仓库，并各自取一份 status。
 * 没有主仓库时（例如一个普通目录下放了几个仓库）仍然返回扫描结果，面板据此直接列出它们。
 */
export async function gitRepos(workspaceRoot: string): Promise<{ ok: boolean; repos: GitRepoStatus[]; message?: string }> {
  const workspace = path.resolve(workspaceRoot);
  const mainRoot = await repoTopLevel(workspace);
  const refs: GitRepoRef[] = [];
  const seen = new Set<string>();
  const track = (root: string, kind: GitRepoRef['kind']): void => {
    const resolved = path.resolve(root);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || refs.length >= REPO_SCAN_MAX_REPOS) return;
    seen.add(key);
    refs.push(repoRef(resolved, kind, workspace));
  };

  const submodules = mainRoot ? await listSubmodules(mainRoot) : [];
  const submoduleSet = new Set(submodules.map((item) => (process.platform === 'win32' ? item.toLowerCase() : item)));

  if (mainRoot) track(mainRoot, 'workspace');
  for (const submodule of submodules) if (existsSync(submodule)) track(submodule, 'submodule');
  if (mainRoot) {
    for (const worktree of await listWorktrees(mainRoot)) {
      if (mainRoot && worktree === mainRoot) continue;
      // 工作树可能落在工作空间之外（mocode 的 sub-agent 工作树在仓库根的 .mocode 下），
      // 但只要它属于同一个仓库就仍然可管理。
      if (inside(workspace, worktree) || inside(mainRoot, worktree)) track(worktree, 'worktree');
    }
  }
  const exclude = new Set([...seen, ...(mainRoot ? [process.platform === 'win32' ? mainRoot.toLowerCase() : mainRoot] : [])]);
  for (const nested of scanNestedRepos(workspace, exclude)) {
    const key = process.platform === 'win32' ? nested.toLowerCase() : nested;
    track(nested, submoduleSet.has(key) ? 'submodule' : 'nested');
  }

  if (!refs.length) return { ok: false, repos: [], message: mainRoot ? undefined : 'NOT_REPOSITORY' };

  // status 逐个取但并发受限：仓库数量有上限，仍然不希望一次拉起 20 个 git 进程。
  const repos: GitRepoStatus[] = [];
  const queue = [...refs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const ref = queue.shift();
      if (!ref) return;
      repos.push({ ...ref, status: await gitStatus(ref.root) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
  // 保持发现顺序（主仓库在首位），避免并发导致面板分组跳动。
  const order = new Map(refs.map((ref, index) => [ref.root, index]));
  repos.sort((a, b) => (order.get(a.root) ?? 0) - (order.get(b.root) ?? 0));
  return { ok: true, repos };
}

/**
 * 校验渲染层传来的仓库根：必须位于工作空间或它所属的主仓库之内，且本身是个仓库。
 * 渲染层不能借这个入口操作任意目录。
 */
export async function validateRepoRoot(workspaceRoot: string, requested: string): Promise<string | null> {
  const workspace = path.resolve(workspaceRoot);
  const resolved = path.resolve(requested);
  if (resolved === workspace) return resolved;
  const mainRoot = await repoTopLevel(workspace);
  // 允许的目标：工作空间之内，或主仓库之内（mocode 的 sub-agent 工作树落在仓库根的 .mocode 下）。
  // 工作空间自身不是仓库时也允许它的嵌套仓库，否则「一个普通目录里放几个仓库」无从管理。
  if (!inside(workspace, resolved) && !(mainRoot && inside(mainRoot, resolved))) return null;
  if (!hasGitEntry(resolved) && resolved !== mainRoot) return null;
  return resolved;
}

function assertSafePaths(root: string, paths: string[], status: GitStatus, staged: boolean): void {
  if (!status.isRepo) throw new Error('NOT_REPOSITORY');
  if (!paths.length) return; // 空仓库/干净工作区的「全部」操作是幂等 no-op。
  if (paths.length > MAX_PATHS || new Set(paths).size !== paths.length) throw new Error('INVALID_PATHS');
  const allowed = new Set((staged ? status.staged : status.changes).map((file) => file.path));
  for (const file of paths) {
    const normalized = path.posix.normalize(file);
    const relative = path.relative(root, path.resolve(root, file));
    if (!allowed.has(file) || file.includes('\0') || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)
      || normalized === '..' || normalized.startsWith('../') || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('PATH_NOT_CHANGED');
    }
  }
}

/** 同一仓库的写操作排队，避免双击或多个面板同时改 index。 */
async function serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tracked = current.then(() => undefined, () => undefined);
  queues.set(key, tracked);
  try { return await current; }
  finally { if (queues.get(key) === tracked) queues.delete(key); }
}

async function mutate(root: string, operation: () => Promise<GitResult>): Promise<GitMutationResult> {
  try {
    const result = await serialized(root, operation);
    if (!result.ok) return { ok: false, message: errorText(result) };
    return { ok: true, status: await gitStatus(root) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function stageFiles(root: string, paths?: string[]): Promise<GitMutationResult> {
  return mutate(root, async () => {
    const status = await gitStatus(root);
    const targets = paths ?? status.changes.map((file) => file.path);
    assertSafePaths(status.root, targets, status, false);
    // git add 会把 UU 变成普通暂存项，不能把它当作用户已确认解决冲突。
    if (status.conflicted) throw new Error('UNRESOLVED_CONFLICTS');
    if (!targets.length) return { ok: true, code: 0, stdout: '', stderr: '' };
    return runGit(status.root, ['add', '-A', '--', ...targets]);
  });
}

export function unstageFiles(root: string, paths?: string[]): Promise<GitMutationResult> {
  return mutate(root, async () => {
    const status = await gitStatus(root);
    const targets = paths ?? status.staged.map((file) => file.path);
    assertSafePaths(status.root, targets, status, true);
    if (!targets.length) return { ok: true, code: 0, stdout: '', stderr: '' };
    const expanded = [...targets];
    for (const file of status.staged) {
      if (targets.includes(file.path) && file.previousPath && !expanded.includes(file.previousPath)) expanded.push(file.previousPath);
    }
    // 无 HEAD 时不能 reset HEAD；rm --cached 只移除索引，工作区文件原样保留。
    return runGit(status.root, status.hasHead ? ['reset', '-q', 'HEAD', '--', ...expanded] : ['rm', '--cached', '-r', '-q', '--', ...expanded]);
  });
}

function bounded(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

/** 未跟踪文件用 /dev/null 作为旧侧；no-index 不修改 index，退出码 1 只表示有差异。 */
async function untrackedDiff(root: string, file: string, limit: number): Promise<GitDiffResult> {
  const absolute = path.resolve(root, file);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, message: 'INVALID_PATH' };
  // 相对路径交给 Git 处理，避免 Windows 把绝对路径拼进 diff 文件名；NUL 是 Windows 的空设备。
  const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = await runGit(root, ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', emptyFile, file]);
  if (!result.ok && result.code !== 1) return { ok: false, message: errorText(result) };
  const slice = bounded(result.stdout, limit);
  return { ok: true, content: slice.text, truncated: slice.truncated };
}

export async function gitDiff(root: string, file: string, staged: boolean): Promise<GitDiffResult> {
  const status = await gitStatus(root);
  const known = staged ? status.staged : status.changes;
  try { assertSafePaths(status.root, [file], status, staged); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!staged && known.some((entry) => entry.path === file && entry.code === '?')) return untrackedDiff(status.root, file, DIFF_PREVIEW_LIMIT);
  const args = ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv'];
  if (staged) args.push('--cached');
  // 重命名后同一工作区继续修改时，旧路径也需要纳入 diff 才能完整展示。
  const entry = known.find((item) => item.path === file);
  args.push('--', file);
  if (entry?.previousPath) args.push(entry.previousPath);
  const result = await runGit(status.root, args);
  if (!result.ok) return { ok: false, message: errorText(result) };
  const slice = bounded(result.stdout, DIFF_PREVIEW_LIMIT);
  return { ok: true, content: slice.text || (entry?.conflict ? 'Unresolved merge conflict.' : 'No textual diff (binary file or mode-only change).'), truncated: slice.truncated };
}

export async function stagedDiff(root: string): Promise<StagedDiff> {
  const status = await gitStatus(root);
  if (!status.isRepo) return { ok: false, stat: '', diff: '', truncated: false, files: [], message: status.message };
  // 仓库/分支随 diff 一起回传：AI 生成必须知道这批暂存改动属于哪个仓库、哪个分支，
  // 否则同一工作空间下的嵌套仓库/工作树会串成同一条提交信息。
  const where = { root: status.root, ...(status.branch || status.head ? { branch: status.branch || status.head } : {}) };
  if (!status.staged.length) return { ok: false, stat: '', diff: '', truncated: false, files: [], ...where, message: 'NO_STAGED_CHANGES' };
  const [stat, diff] = await Promise.all([
    runGit(status.root, ['-c', 'core.quotepath=false', 'diff', '--cached', '--stat']),
    runGit(status.root, ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-ext-diff', '--no-textconv']),
  ]);
  if (!stat.ok || !diff.ok) return { ok: false, stat: '', diff: '', truncated: false, files: [], ...where, message: errorText(diff.ok ? stat : diff) };
  const slice = bounded(diff.stdout, AI_DIFF_LIMIT);
  return { ok: true, stat: stat.stdout.trim(), diff: slice.text, truncated: slice.truncated, files: status.staged.map((file) => file.path), ...where };
}

/**
 * 任意工作区内文件相对 HEAD 的 diff（任务改动面板用）。
 *
 * 与 `gitDiff` 的三点差别，都是为了「这个文件被 agent 改成什么样了」这个问题：
 *  1. 不要求该文件仍在 `git status` 里 —— agent 改完可能自己提交了，也可能用户随后又动了它；
 *  2. 基准取 HEAD（`git diff HEAD`），把已暂存与未暂存合在一起看，而不是只给其中一半；
 *  3. 未跟踪文件走 `--no-index`（与 /dev/null 比），否则新文件会显示成「无差异」。
 */
export async function gitFileDiff(workspaceRoot: string, file: string): Promise<GitDiffResult> {
  const top = await repoTopLevel(workspaceRoot);
  if (!top) return { ok: false, message: 'NOT_REPOSITORY' };
  // `file` 是**相对工作空间**的路径（任务记录里的口径）；仓库根可能是工作空间的祖先，
  // 所以先落到绝对路径，再换算成相对仓库根的 pathspec。
  const absolute = path.resolve(workspaceRoot, file);
  const raw = path.relative(top, absolute);
  if (!raw || raw.startsWith('..') || path.isAbsolute(raw) || raw.includes('\0')) {
    return { ok: false, message: 'INVALID_PATH' };
  }
  // git 的 pathspec 用正斜杠；任务记下的 changedFiles 由 path.relative 得到，Windows 上是反斜杠。
  const relative = raw.split(path.sep).join('/');
  const tracked = await runGit(top, ['ls-files', '--error-unmatch', '--', relative]);
  if (!tracked.ok) {
    if (!existsSync(absolute)) return { ok: true, content: '' };
    return untrackedDiff(top, relative, DIFF_PREVIEW_LIMIT);
  }
  const head = await runGit(top, ['rev-parse', '--verify', 'HEAD']);
  const args = ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv'];
  // 空仓库（还没有 HEAD）没有比较基准，退到「工作区 vs 索引」。
  if (head.ok && head.stdout.trim()) args.push('HEAD');
  args.push('--', relative);
  const result = await runGit(top, args);
  if (!result.ok) return { ok: false, message: errorText(result) };
  const slice = bounded(result.stdout, DIFF_PREVIEW_LIMIT);
  return { ok: true, content: slice.text, truncated: slice.truncated };
}

/** 一个文件相对 HEAD 的增删行数；`untracked` 表示它还没进版本库（新增侧按整份文件算）。 */
export interface GitFileStat {
  path: string;
  added: number;
  removed: number;
  untracked: boolean;
}

/** 单次调用能处理的文件数上限：再多会把 pathspec 拼成一个超长的命令行。 */
const STAT_PATHS_LIMIT = 200;

/**
 * 批量取增删行数（本任务改动面板的列表用）。
 *
 * 一次 `git diff --numstat` 拿全部文件，而不是每文件一次 `gitFileDiff` ——
 * 50 个文件就是 50 次 git 进程，面板打开会卡到秒级。
 * 未跟踪文件不在 numstat 里，单独用 `ls-files --others` 认出来并按行数计入新增。
 */
export async function gitFileStats(workspaceRoot: string, files: readonly string[]): Promise<{ ok: boolean; stats: GitFileStat[]; message?: string }> {
  const top = await repoTopLevel(workspaceRoot);
  if (!top) return { ok: false, stats: [], message: 'NOT_REPOSITORY' };
  const normalized: Array<{ given: string; relative: string; absolute: string }> = [];
  for (const file of files) {
    const absolute = path.resolve(workspaceRoot, file);
    const raw = path.relative(top, absolute);
    if (!raw || raw.startsWith('..') || path.isAbsolute(raw) || raw.includes('\0')) continue;
    normalized.push({ given: file, relative: raw.split(path.sep).join('/'), absolute });
    if (normalized.length >= STAT_PATHS_LIMIT) break;
  }
  if (!normalized.length) return { ok: true, stats: [] };
  const paths = normalized.map((item) => item.relative);
  const head = await runGit(top, ['rev-parse', '--verify', 'HEAD']);
  const diffArgs = ['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-ext-diff', '--no-textconv'];
  // 与 gitFileDiff 同一基准：有 HEAD 就比 HEAD（已暂存 + 未暂存一起），没有就比索引。
  if (head.ok && head.stdout.trim()) diffArgs.push('HEAD');
  diffArgs.push('--', ...paths);
  const [numstat, untracked] = await Promise.all([
    runGit(top, diffArgs),
    runGit(top, ['ls-files', '--others', '--exclude-standard', '--', ...paths]),
  ]);
  const byPath = new Map<string, GitFileStat>();
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [addedRaw, removedRaw, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      if (!filePath) continue;
      // 二进制文件的两列是 `-`，按 0 计而不是 NaN。
      const added = Number(addedRaw);
      const removed = Number(removedRaw);
      byPath.set(filePath, {
        path: filePath,
        added: Number.isFinite(added) ? added : 0,
        removed: Number.isFinite(removed) ? removed : 0,
        untracked: false,
      });
    }
  }
  const untrackedSet = new Set(untracked.ok ? untracked.stdout.split('\n').filter(Boolean) : []);
  const stats: GitFileStat[] = [];
  for (const item of normalized) {
    const known = byPath.get(item.relative);
    if (known) { stats.push({ ...known, path: item.given }); continue; }
    if (untrackedSet.has(item.relative)) {
      // 未跟踪 = 整份文件都是新增；读不到（超大/二进制）就只报 0，不假装知道行数。
      let added = 0;
      try { added = readFileSync(item.absolute, 'utf8').split('\n').length; } catch { added = 0; }
      stats.push({ path: item.given, added, removed: 0, untracked: true });
      continue;
    }
    // 既不在 numstat 也不在 untracked：文件已被删除或不在磁盘上，照样列出来让用户知道。
    stats.push({ path: item.given, added: 0, removed: 0, untracked: false });
  }
  // 顺序以调用方传入的为准（任务记录的写入顺序），不按 git 输出重排。
  // 路径统一成正斜杠：任务记录里的 changedFiles 由 path.relative 得到，Windows 上是反斜杠，
  // 而界面里其它所有路径（文件树、源代码管理）都是正斜杠 —— 展示层不该有两种写法。
  return { ok: true, stats: stats.map((item) => ({ ...item, path: item.path.replaceAll('\\', '/') })) };
}

export function commitStaged(root: string, message: string): Promise<GitMutationResult> {
  const commitMessage = message.trim();
  if (!commitMessage) return Promise.resolve({ ok: false, message: 'EMPTY_COMMIT_MESSAGE' });
  if (commitMessage.length > 10_000) return Promise.resolve({ ok: false, message: 'COMMIT_MESSAGE_TOO_LONG' });
  return mutate(root, async () => {
    const status = await gitStatus(root);
    if (!status.isRepo) return { ok: false, code: -1, stdout: '', stderr: status.message ?? 'NOT_REPOSITORY' };
    if (status.conflicted) return { ok: false, code: -1, stdout: '', stderr: 'UNRESOLVED_CONFLICTS' };
    if (!status.staged.length) return { ok: false, code: -1, stdout: '', stderr: 'NO_STAGED_CHANGES' };
    return runGit(status.root, ['commit', '-m', commitMessage]);
  }).then(async (result) => {
    if (!result.ok) return result;
    const commit = await runGit(root, ['log', '-1', '--oneline']);
    return { ...result, ...(commit.ok ? { commit: commit.stdout.trim() } : {}) };
  });
}
