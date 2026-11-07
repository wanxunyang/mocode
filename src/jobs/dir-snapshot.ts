// 非 git 工作区的隔离执行支持：目录副本、目录索引快照、索引差分与 unified diff。
//
// git 仓库有 worktree + tree 对象，非 git 目录什么都没有。这里给出等价物：
//   - createDirCopy：把工作区复制成一份可随意改动的副本（默认排除 node_modules/.git/.mocode 的运行时目录）；
//   - snapshotDirectory：把「文件 → size/mtime」索引落成 JSON，作为一次 attempt 的基线；
//   - diffSnapshots：两次索引的差集（新增/删除/修改），作为 changedFiles 与契约校验的输入；
//   - diffRoots：对指定文件生成 unified diff（供 lane.diff / attempt.diff）。
//
// 设计取舍：索引只存 size+mtimeMs 而不是内容哈希——快照要能在大目录上秒级完成，
// 内容比较留给真正需要 diff 的那几个文件。mtime 相同时的漏判由「大小变化 + diff 阶段
// 内容比较」兜底；代价是同一毫秒内的原地覆盖可能被漏掉，非 git 目录接受此限制。

import fs from 'node:fs';
import path from 'node:path';

/** 整目录跳过的目录名（无论在哪个层级）。 */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

/** 只在工作区根下跳过的相对路径（大小写按平台处理）。 */
const SKIPPED_RELATIVE = ['.mocode/orchestrations', '.mocode/worktrees', '.mocode/lanes'];

export interface DirEntry {
  size: number;
  mtimeMs: number;
}

export interface DirSnapshot {
  version: 1;
  root: string;
  createdAt: string;
  entries: Record<string, DirEntry>;
}

export interface DirSnapshotOptions {
  /** 额外排除的相对路径（POSIX 分隔符）。 */
  excludes?: readonly string[];
  /** 额外忽略谓词（返回 true 表示跳过该相对路径）；改动审计用它剔除 agent 自身写出的状态。 */
  ignore?: (rel: string) => boolean;
}

/**
 * `.mocode` 下由项目自己维护、值得审计的路径。
 * 其余 `.mocode/**` 全是 mocode 的运行时状态（会话、编排账本、记忆、统计、便签…）。
 */
const MOCODE_KEPT_PREFIXES = ['.mocode/config', '.mocode/skills', '.mocode/agents-draft.md'];

/**
 * 是否属于 mocode 自身的运行时状态。
 *
 * 用来区分「Worker 改了用户代码」和「Worker 只是让 mocode 写了自己的记忆/统计」：
 * 后者不能算成任务改动，否则 `read_only` 任务会被自己的运行时文件误判为「改了文件」而失败。
 */
export function isMocodeRuntimeState(rel: string): boolean {
  const normalized = normalizeRel(rel).toLowerCase();
  if (normalized !== '.mocode' && !normalized.startsWith('.mocode/')) return false;
  return !MOCODE_KEPT_PREFIXES.some((kept) => normalized === kept || normalized.startsWith(`${kept}/`));
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

function skipRelative(rel: string, extra: readonly string[], ignore?: (rel: string) => boolean): boolean {
  const normalized = normalizeRel(rel);
  if (ignore?.(normalized)) return true;
  const lower = normalized.toLowerCase();
  for (const dir of SKIPPED_DIRS) {
    if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;
    // 任意层级的 node_modules 都要排除（monorepo）。
    if (normalized.includes(`/${dir}/`) || normalized.endsWith(`/${dir}`)) return true;
  }
  for (const rule of [...SKIPPED_RELATIVE, ...extra]) {
    const target = rule.toLowerCase();
    if (lower === target || lower.startsWith(`${target}/`)) return true;
  }
  return false;
}

/**
 * 扫描目录得到索引快照。符号链接按零字节文件记录（不跟随，避免环与越界）。
 * 任何不可读条目都被跳过：快照是增强能力，不能因为一个坏文件让整次派活失败。
 */
export function snapshotDirectory(root: string, options: DirSnapshotOptions = {}): DirSnapshot {
  const absolute = path.resolve(root);
  const entries: Record<string, DirEntry> = {};
  const extra = options.excludes ?? [];
  const walk = (dir: string, relBase: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (skipRelative(rel, extra, options.ignore)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      try {
        const stat = fs.lstatSync(full);
        entries[rel] = { size: entry.isSymbolicLink() ? 0 : stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        // 并发删除等情况直接忽略。
      }
    }
  };
  walk(absolute, '');
  return { version: 1, root: absolute, createdAt: new Date().toISOString(), entries };
}

export function writeSnapshot(file: string, snapshot: DirSnapshot): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
  return file;
}

export function readSnapshot(file: string): DirSnapshot {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as DirSnapshot;
  if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new Error(`Unsupported directory snapshot: ${file}`);
  }
  return parsed;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
  /** 三者合并并排序，可直接作为 changedFiles。 */
  changed: string[];
}

export function diffSnapshots(before: DirSnapshot, after: DirSnapshot): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [rel, entry] of Object.entries(after.entries)) {
    const previous = before.entries[rel];
    if (!previous) added.push(rel);
    else if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) modified.push(rel);
  }
  for (const rel of Object.keys(before.entries)) {
    if (!after.entries[rel]) removed.push(rel);
  }
  const changed = [...new Set([...added, ...removed, ...modified])].sort();
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), changed };
}

/** 估算某个路径（文件或目录）的字节数，跳过与快照相同的排除规则。 */
export function pathBytes(root: string, options: DirSnapshotOptions = {}): number {
  const absolute = path.resolve(root);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  const extra = options.excludes ?? [];
  let total = 0;
  const walk = (dir: string, relBase: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (skipRelative(rel, extra, options.ignore)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else {
        try {
          total += fs.lstatSync(full).size;
        } catch {
          // 忽略
        }
      }
    }
  };
  walk(absolute, '');
  return total;
}

export class LaneCopyTooLargeError extends Error {
  constructor(
    readonly source: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `workspace copy would be ${Math.round(bytes / 1024 / 1024)}MB, over the ${Math.round(limit / 1024 / 1024)}MB budget ` +
        `(source: ${source}). Raise MOCODE_LANE_COPY_MAX_MB, pass --allow-inplace, or use a read-only task.`,
    );
    this.name = 'LaneCopyTooLargeError';
  }
}

export const DEFAULT_LANE_COPY_MAX_MB = 512;

export function laneCopyLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.MOCODE_LANE_COPY_MAX_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LANE_COPY_MAX_MB;
  return megabytes * 1024 * 1024;
}

/**
 * 复制目录。超预算时抛 LaneCopyTooLargeError，绝不降级为原地写——
 * 原地写是用户决定（`--allow-inplace`），系统不能自己替他选。
 */
export function createDirCopy(
  source: string,
  target: string,
  options: DirSnapshotOptions & { maxBytes?: number } = {},
): string {
  const from = path.resolve(source);
  const to = path.resolve(target);
  if (from === to) throw new Error('Refusing to copy a directory onto itself.');
  const limit = options.maxBytes ?? laneCopyLimitBytes();
  const bytes = pathBytes(from, options);
  if (limit > 0 && bytes > limit) throw new LaneCopyTooLargeError(from, bytes, limit);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (src) => {
      if (path.resolve(src) === to) return false;
      const rel = normalizeRel(path.relative(from, src));
      if (!rel) return true;
      // .mocode 下只排除运行时产物，保留 sessions/config 以便 Worker 有上下文。
      return !skipRelative(rel, options.excludes ?? []);
    },
  });
  return to;
}

// ── unified diff ─────────────────────────────────────────────────────────────

const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.split('\n');
}

interface DiffOp {
  kind: ' ' | '-' | '+';
  line: string;
}

/** LCS-based 行级 diff。超过规模上限时退化为「整文件替换」，避免 O(n*m) 卡死。 */
function lineOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...before.map((line): DiffOp => ({ kind: '-', line })),
      ...after.map((line): DiffOp => ({ kind: '+', line })),
    ];
  }
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: ' ', line: before[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: '-', line: before[i++] });
    } else {
      ops.push({ kind: '+', line: after[j++] });
    }
  }
  while (i < n) ops.push({ kind: '-', line: before[i++] });
  while (j < m) ops.push({ kind: '+', line: after[j++] });
  return ops;
}

/** 生成单个文件的 unified diff（含 3 行上下文）。无差异返回空串。 */
export function unifiedDiff(beforeText: string, afterText: string, label: string, context = 3): string {
  if (beforeText === afterText) return '';
  const ops = lineOps(splitLines(beforeText), splitLines(afterText));
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return '';
  // 合并相邻改动，避免同一段被切成一堆小 hunk。
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last && index - last[1] <= context * 2) last[1] = index;
    else hunks.push([index, index]);
  }
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  for (const [start, end] of hunks) {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length - 1, end + context);
    const slice = ops.slice(from, to + 1);
    const beforeCount = slice.filter((op) => op.kind !== '+').length;
    const afterCount = slice.filter((op) => op.kind !== '-').length;
    const beforeStart = ops.slice(0, from).filter((op) => op.kind !== '+').length + 1;
    const afterStart = ops.slice(0, from).filter((op) => op.kind !== '-').length + 1;
    out.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.line}`);
  }
  return `${out.join('\n')}\n`;
}

function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

function readTextOrNull(file: string): string | null {
  try {
    const buffer = fs.readFileSync(file);
    return isBinary(buffer) ? null : buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** 把相对路径列表转换为 unified diff。二进制/不可读文件以一行说明代替内容。 */
export function diffRoots(
  beforeRoot: string,
  afterRoot: string,
  files: readonly string[],
  options: DirSnapshotOptions = {},
): string {
  const chunks: string[] = [];
  for (const rel of [...files].sort()) {
    if (skipRelative(rel, options.excludes ?? [], options.ignore)) continue;
    const beforePath = path.join(beforeRoot, rel);
    const afterPath = path.join(afterRoot, rel);
    const beforeExists = fs.existsSync(beforePath);
    const afterExists = fs.existsSync(afterPath);
    const before = beforeExists ? readTextOrNull(beforePath) : '';
    const after = afterExists ? readTextOrNull(afterPath) : '';
    if (before === null || after === null) {
      chunks.push(`--- a/${rel}\n+++ b/${rel}\n@@ binary @@\n(binary file changed)\n`);
      continue;
    }
    const diff = unifiedDiff(before, after, rel);
    if (diff) chunks.push(diff);
  }
  return chunks.join('');
}
