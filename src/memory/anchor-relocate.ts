/**
 * R2.7 锚点重定位：文件搬家之后，把 `missing` 的锚点指到新地址。**只提议，确认后写**。
 *
 * ## 为什么需要它
 *
 * R2 的锚点一旦写入就固定了字面路径，而文件是会搬的。实测真实库：32 个锚点里 4 个
 * `missing`，其中 3 个是 `tests/agent-core.test.ts` → `tests/agent/agent-core.test.ts`，
 * 1 个是 `src/orchestrator/tail.ts` → `src/memory/tail.ts`。这些条目本身**没错**，
 * 错的只是地址；但 health 会把它们算进失效里，模型读到 `STALE-CODE` 也会怀疑内容。
 * 结果是「重锚一下就好」的事被读成「这条记忆过期了，该删」。
 *
 * ## 为什么是「提议」而不是自动改写
 *
 * 同名文件是普遍现象（`tail.ts`、`index.ts`、`config.ts`）。按 basename 自动重写会把
 * 一条讲 A 的记忆锚到 B 上，而锚错的代价比缺锚大得多：缺锚只是不校验，锚错是**假装校验过**。
 * 所以这里只给候选，写库必须用户 `/memory anchor relocate <n>` 显式确认——与 R2.6 回填同一形态。
 *
 * ## 判据（两道，缺一不可）
 *
 *  1. **basename 完全相同**——这是「同一个文件」的必要条件，不是充分条件；
 *  2. **旧路径的父目录名出现在新路径的目录段里**——`tests/agent-core.test.ts` 的父目录
 *     `tests` 仍在新路径里 → 强证据；`src/orchestrator/tail.ts` 的父目录 `orchestrator`
 *     不在 `src/memory/` 里 → 只有「同名」一条弱证据，不提议、单独列出让人看。
 *
 * 只在旧路径没有父目录（工作区根下的文件）时才退回「basename 唯一」判据。
 *
 * ## 不动 hash
 *
 * 重定位只换路径，**绝不**顺带接受新内容：`updateEntry` 的 `anchors` 是整体重建（hash 现算），
 * 拿它做重定位会把同一批锚点里真正 `stale` 的那些一起洗成 fresh，等于静默确认
 * 「这些记忆的内容就是现在这样」。所以写库走 `replaceAnchors`：原样保留其它锚点对象，
 * 只替换被搬走的那一条。
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';
import { buildAnchor, evaluateAnchor, resolveAnchorPath } from './anchor.js';
import { loadAll, replaceAnchors } from './store.js';

/**
 * 扫描时跳过的目录。
 *
 * `dist`/`dist-tests` 里是同一批源码的编译产物——不排除的话，一次 `npm run build` 之后
 * 每个 `src/x.ts` 都能匹配到 `dist/src/x.ts`，全是假候选（而且路径更深、看起来更"新"）。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-tests',
  'coverage',
  '.mocode',
  '.next',
  'build',
  'out',
  '.venv',
  '__pycache__',
]);

/** 目录遍历的文件数上限：候选是给人核对的清单，扫不完的深度没有价值。 */
export const RELOCATE_MAX_FILES = 40_000;
const RELOCATE_MAX_DEPTH = 12;
/** 一次最多列多少条提议。与 `/memory anchor` 回填同量级：一屏能核完。 */
export const RELOCATE_MAX_PROPOSALS = 20;

function workspaceRoot(root?: string): string {
  return root ?? getSandboxRoot() ?? process.cwd();
}

/** 工作区文件索引：相对路径（正斜杠）+ basename 倒排。 */
interface WorkspaceIndex {
  byBase: Map<string, string[]>;
  files: number;
  truncated: boolean;
}

function indexWorkspace(base: string): WorkspaceIndex {
  const byBase = new Map<string, string[]>();
  let files = 0;
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > RELOCATE_MAX_DEPTH) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (truncated) return;
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        walk(path.join(dir, d.name), relPath, depth + 1);
        continue;
      }
      // 只看真文件：符号链接的 isFile() 为 false，顺着它会跑出工作区。
      if (!d.isFile()) continue;
      if (files >= RELOCATE_MAX_FILES) {
        truncated = true;
        return;
      }
      files += 1;
      const seen = byBase.get(d.name);
      if (seen) seen.push(relPath);
      else byBase.set(d.name, [relPath]);
    }
  };
  walk(base, '', 0);
  return { byBase, files, truncated };
}

/** 锚点路径的目录段（不含文件名）。 */
function dirSegments(p: string): string[] {
  const parts = p.split('/');
  parts.pop();
  return parts.filter(Boolean);
}

export interface RelocateProposal {
  index: number;
  id: string;
  name: string;
  /** 写入时的旧路径（已不存在）。 */
  from: string;
  /** 工作区里找到的新路径。 */
  to: string;
  /** 锚点原本带的符号片段；新文件里不存在时会在写入阶段被拒。 */
  symbol?: string;
  /** 旧父目录名仍在新路径中出现 = 强证据。 */
  parentMatched: boolean;
}

export interface RelocateScan {
  proposals: RelocateProposal[];
  /** 同名文件不止一个，无法判断：列出前几个让人自己看。 */
  ambiguous: Array<{ id: string; from: string; candidates: string[] }>;
  /** 工作区里连同名文件都没有：多半是真删了，不是搬家。 */
  unresolved: Array<{ id: string; from: string }>;
  /**
   * 同名文件唯一、但旧父目录名不在新路径里。
   *
   * 单独分成一档而不是并进 proposals：`tail.ts` 这种名字搬家后换了语义的情况真实存在
   * （orchestrator 的 tail 与 memory 的 tail 是两个模块），自动提议会把记忆锚到错的实现上。
   */
  weak: Array<{ id: string; from: string; candidate: string }>;
  /** 扫描到的文件数与被截断标记，供「为什么没找到」的解释。 */
  files: number;
  truncated: boolean;
}

/**
 * 扫描所有 `missing` 的文件锚点，给出重定位提议。**只读**。
 *
 * 符号级 missing（文件还在、符号没了）刻意不处理：那不是搬家，改名后的符号与新语义
 * 无法从路径推断，只能人工改记忆。
 */
export function collectRelocationProposals(root?: string): RelocateScan {
  const base = workspaceRoot(root);
  const index = indexWorkspace(base);
  const scan: RelocateScan = {
    proposals: [],
    ambiguous: [],
    unresolved: [],
    weak: [],
    files: index.files,
    truncated: index.truncated,
  };

  for (const e of loadAll()) {
    if (e.status !== 'active' || !e.anchors || e.anchors.length === 0) continue;
    for (const anchor of e.anchors) {
      if ((anchor.kind ?? 'file') !== 'file') continue;
      const ev = evaluateAnchor(anchor, base);
      if (ev.status !== 'missing') continue;
      // 文件还在 → missing 来自符号片段，与路径无关。
      if (existsSync(resolveAnchorPath(anchor.path, base))) continue;

      const from = anchor.path;
      const baseName = path.posix.basename(from);
      const candidates = (index.byBase.get(baseName) ?? []).filter((p) => p !== from);
      if (candidates.length === 0) {
        scan.unresolved.push({ id: e.id, from });
        continue;
      }
      const parent = dirSegments(from).pop();
      const parentMatched = parent ? candidates.filter((p) => dirSegments(p).includes(parent)) : [];
      const pool = parent ? parentMatched : candidates;
      if (pool.length === 1) {
        if (scan.proposals.length >= RELOCATE_MAX_PROPOSALS) continue;
        scan.proposals.push({
          index: scan.proposals.length + 1,
          id: e.id,
          name: e.name,
          from,
          to: pool[0],
          ...(anchor.symbol ? { symbol: anchor.symbol } : {}),
          parentMatched: pool === parentMatched && parentMatched.length === 1,
        });
        continue;
      }
      if (pool.length === 0) {
        // 旧父目录名完全消失，只剩同名 —— 弱证据。
        scan.weak.push({ id: e.id, from, candidate: candidates[0] });
        continue;
      }
      scan.ambiguous.push({ id: e.id, from, candidates: pool.slice(0, 4) });
    }
  }
  return scan;
}

export interface RelocateApplyResult {
  saved: Array<{ id: string; from: string; to: string }>;
  /** 写入失败：路径在两次扫描之间消失、符号在新文件里找不到、或会与已有锚点重复。 */
  failed: Array<{ id: string; from: string; reason: string }>;
}

/**
 * 写入选中的提议。`picks` 是 **1 基序号**（与屏幕上列出的一致）。
 *
 * 其它锚点对象原样保留（含各自的 hash），只有被搬走的那一条重新构建——
 * 这是与 `updateEntry({anchors})` 的关键区别，见文件头。
 */
export function applyRelocations(
  proposals: readonly RelocateProposal[],
  picks: readonly number[] | 'all',
  root?: string,
): RelocateApplyResult {
  const base = workspaceRoot(root);
  const out: RelocateApplyResult = { saved: [], failed: [] };
  const wanted = proposals.filter((p) => picks === 'all' || picks.includes(p.index));
  for (const p of wanted) {
    const entry = loadAll().find((e) => e.id === p.id);
    if (!entry) {
      out.failed.push({ id: p.id, from: p.from, reason: '条目已消失' });
      continue;
    }
    const current = entry.anchors ?? [];
    const target = current.find((a) => (a.kind ?? 'file') === 'file' && a.path === p.from);
    if (!target) {
      out.failed.push({ id: p.id, from: p.from, reason: '锚点已不存在（可能已重定位过）' });
      continue;
    }
    if (current.some((a) => (a.kind ?? 'file') === 'file' && a.path === p.to)) {
      out.failed.push({ id: p.id, from: p.from, reason: `已锚定 ${p.to}，重定位会造成重复` });
      continue;
    }
    // 两次扫描之间文件可能又被删了；此时不写入，避免留下一条新的 missing。
    if (!existsSync(resolveAnchorPath(p.to, base))) {
      out.failed.push({ id: p.id, from: p.from, reason: `${p.to} 已不存在` });
      continue;
    }
    const rebuilt = buildAnchor({ kind: 'file', path: p.to, ...(p.symbol ? { symbol: p.symbol } : {}) }, base);
    if (!rebuilt.ok) {
      // 符号在新文件里找不到是常见情形（搬家常伴随rename），必须说出来而不是静默丢锚点。
      out.failed.push({ id: p.id, from: p.from, reason: `重锚 ${p.to} 失败：${rebuilt.reason}` });
      continue;
    }
    const next = current.map((a) => (a === target ? rebuilt.anchor : a));
    const r = replaceAnchors(p.id, next, 'anchor relocate');
    if (!r.ok) {
      out.failed.push({ id: p.id, from: p.from, reason: 'blocked' in r ? `写入被拦：${r.blocked}` : '条目已消失' });
      continue;
    }
    out.saved.push({ id: p.id, from: p.from, to: p.to });
  }
  return out;
}

/** 供命令层渲染的一行摘要。 */
export function describeRelocation(p: RelocateProposal): string {
  return `${p.from} → ${p.symbol ? `${p.to}#${p.symbol}` : p.to}`;
}
