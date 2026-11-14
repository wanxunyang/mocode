import { execFile } from 'node:child_process';
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
  message?: string;
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
  let hasHead = false;
  let conflicted = false;
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index]!;
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    if (record.startsWith('# branch.oid ')) hasHead = record.slice(13) !== '(initial)';
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
  return { ok: true, isRepo: true, root: path.resolve(root), branch: branch === '(detached)' ? 'HEAD' : branch, hasHead, staged, changes, conflicted };
}

export async function gitStatus(root: string): Promise<GitStatus> {
  // 工作空间可能是仓库子目录；porcelain 的路径以仓库根为基准，后续操作必须统一用该根。
  const top = await runGit(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout.trim()) return emptyStatus(root, errorText(top));
  const repoRoot = path.resolve(top.stdout.trim());
  const result = await runGit(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  return result.ok ? parseGitStatus(repoRoot, result.stdout) : emptyStatus(repoRoot, errorText(result));
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
  if (!status.staged.length) return { ok: false, stat: '', diff: '', truncated: false, files: [], message: 'NO_STAGED_CHANGES' };
  const [stat, diff] = await Promise.all([
    runGit(status.root, ['-c', 'core.quotepath=false', 'diff', '--cached', '--stat']),
    runGit(status.root, ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-ext-diff', '--no-textconv']),
  ]);
  if (!stat.ok || !diff.ok) return { ok: false, stat: '', diff: '', truncated: false, files: [], message: errorText(diff.ok ? stat : diff) };
  const slice = bounded(diff.stdout, AI_DIFF_LIMIT);
  return { ok: true, stat: stat.stdout.trim(), diff: slice.text, truncated: slice.truncated, files: status.staged.map((file) => file.path) };
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
