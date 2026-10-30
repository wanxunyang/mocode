// anchor.ts —— R2 代码锚点通道:让记忆知道自己讨论的那段代码有没有变过。
//
// 问题:一条「`tool-dispatcher.ts` 的 resultEvent 是 history 回灌的唯一汇聚点」的记忆,
// 在三个月后代码重构过两轮之后依然会被原样注入,而且**看起来完全可信**。R14 解决的是
// 「记忆派生于另一条记忆 → 源失效要标记」,但代码本身的变化没有任何通道告诉它。
//
// 做法:写入时记录 (path, symbol?, contentHash),召回时重读文件重算 hash 比对。
// 一致 → fresh;不一致或文件/符号消失 → stale。**只降级不删除**——代码变了不等于
// 结论错了(可能只是加了一行日志),删掉等于把可能仍正确的知识扔掉。
//
// 哈希口径必须与 read_file 的 artifact hash **完全一致**(同一个 contentHash 函数),
// 否则永远对不上。为此把哈希实现下沉到 changeset/hash.ts(叶模块),本文件直接用它。
//
// 叶子依赖:node:fs / node:path / sandbox/root(共享叶子)/ changeset/hash(叶子)。
// 不依赖 store.ts(反向依赖会成环:store 要用本模块在写入时算 hash)。

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { contentHash, type ContentHash } from '../changeset/hash.js';
import { getSandboxRoot } from '../sandbox/root.js';

/** 单条记忆最多锚定的文件数。与 MAX_DERIVED_FROM 同量级:锚点太多则「任一失效即 stale」。 */
export const MAX_ANCHORS = 8;

/** 超过此体积不做锚点校验(回 'unknown' 而不是 'stale',避免大文件把读取成本炸掉)。 */
const MAX_ANCHOR_FILE_BYTES = 4 * 1024 * 1024;

/** 符号片段最长行数,防止一个类把整个文件都算进来。 */
const MAX_SYMBOL_FRAGMENT_LINES = 400;

/**
 * 一条代码锚点。
 *
 * `path` 一律存**工作区相对路径 + 正斜杠**,这样同一条记忆在另一台机器、另一个 clone
 * 路径下仍然有效(global 记忆尤其需要)。工作区外的文件退回绝对路径(全局记忆可以锚定
 * 任意位置,如 `~/.mocode/config`)。
 */
export interface MemoryAnchor {
  path: string;
  /** 可选符号名:有则只锚定该符号的片段,避免「文件里别的函数改了」造成误报。 */
  symbol?: string;
  /** 原始内容哈希,**与 read_file artifact hash 同口径**。 */
  contentHash: ContentHash;
  /**
   * R2.5 抗格式化哈希:剥离注释与空白后再算。
   *
   * 只在 raw hash 不相等时用于兜底判断——仅仅跑了 prettier / 调整缩进 / 加注释
   * 不应该让一条记忆变成 stale,否则一次 `npm run format` 就能把整库记忆标脏。
   * 可选:历史条目无此字段时退化为「raw 不等即 stale」(更保守,宁可多报)。
   */
  normHash?: string;
}

/** 调用方(memory_save / memory_update / 反思)提供的锚点意图,hash 由本模块现算。 */
export interface AnchorInput {
  path: string;
  symbol?: string;
}

export type AnchorStatus = 'fresh' | 'stale' | 'missing' | 'unknown';

export interface AnchorEvaluation {
  anchor: MemoryAnchor;
  status: AnchorStatus;
  /** 人类可读原因(进工具输出)。 */
  detail?: string;
}

/** 一条记忆全部锚点的判定汇总。 */
export interface EntryAnchorState {
  /** 至少一个锚点 stale/missing。unknown 不算 stale(证据不足,不冤枉)。 */
  stale: boolean;
  /** 内容已变的路径。 */
  changed: string[];
  /** 文件或符号已消失的路径。 */
  missing: string[];
}

export const NOT_ANCHOR_STALE: EntryAnchorState = { stale: false, changed: [], missing: [] };

// ── 路径归一 ──────────────────────────────────────────────────────────────

/** 工作区根:沙箱根优先(子 agent 有隔离 overlay),否则 cwd。 */
function workspaceRoot(root?: string): string {
  return root ?? getSandboxRoot() ?? process.cwd();
}

/** 绝对路径 → 锚点路径(工作区内用相对路径,区外用绝对路径;统一正斜杠)。 */
export function toAnchorPath(file: string, root?: string): string {
  const base = workspaceRoot(root);
  const abs = path.resolve(base, file);
  const rel = path.relative(base, abs);
  const outside = !rel || rel.startsWith('..') || path.isAbsolute(rel);
  return (outside ? abs : rel).split(path.sep).join('/');
}

/** 锚点路径 → 绝对路径。 */
export function resolveAnchorPath(anchorPath: string, root?: string): string {
  if (path.isAbsolute(anchorPath)) return anchorPath;
  return path.resolve(workspaceRoot(root), anchorPath);
}

// ── 归一化(抗格式化)─────────────────────────────────────────────────────

/** Markdown 系扩展名:这些文件里行首 `#` 是标题,不是注释。 */
const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

/**
 * 剥离注释与空白,得到「排版无关」的文本(R2.5)。
 *
 * 只剥**行首**的 `//` 与 `#` 注释,不做行内的:`"http://x"` 里的 `//` 会让整行剩余
 * 内容被误删,而误删的方向是**假 fresh**(内容变了却判一致),比假 stale 危险得多。
 * 块注释同理保留(跨行字符串里出现 `/*` 极罕见,收益大于风险)。
 *
 * `path` 决定 `#` 行算不算注释:Python/shell 里它是注释,而 **Markdown 里它是标题**。
 * 无脑剥掉会让「只改了文档标题、正文没动」被判成 fresh——又是一次假 fresh,
 * 与上面行内 `//` 同属一类错误。没有 path 时按注释处理(旧行为)。
 */
export function normalizeForHash(text: string, path?: string): string {
  let out = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
  if (!path || !MARKDOWN_PATH.test(path)) out = out.replace(/^[ \t]*#.*$/gm, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

// ── 符号片段 ──────────────────────────────────────────────────────────────

const DECL_KEYWORDS = 'function|class|interface|type|const|let|var|def|fn|struct|enum|impl|trait';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 该行是否声明了 `symbol`。 */
function declaresSymbol(line: string, symbol: string): boolean {
  const sym = escapeRegExp(symbol);
  return (
    new RegExp(`\\b(?:${DECL_KEYWORDS})\\s+${sym}\\b`).test(line) ||
    // 方法/属性定义:`  foo(args) {`、`foo = (...) =>`、`foo(` 顶格或缩进
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:get|set\\s+)?${sym}\\s*[(=:<]`).test(line)
  );
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/**
 * 抽取符号片段:从声明行起,到「大括号配平回到 0」或「同缩进的下一个声明」为止。
 *
 * 这是**启发式**,不是解析器:它只需要稳定地圈出一段「改了这个符号就会变」的文本,
 * 不需要语法正确。找不到符号返 null(调用方据此拒绝写入锚点,而不是存一条永远
 * unknown 的锚点)。
 */
export function extractSymbolFragment(text: string, symbol: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => declaresSymbol(l, symbol));
  if (start < 0) return null;
  const baseIndent = indentOf(lines[start]);
  let depth = 0;
  let sawBrace = false;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && depth === 0 && sawBrace) {
      end = i;
      break;
    }
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        sawBrace = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (depth < 0) depth = 0;
    // 无大括号的语言(python 等):同缩进的下一个声明即结束。
    if (i > start && !sawBrace && line.trim() && indentOf(line) <= baseIndent && declaresSymbol(line, symbol)) {
      end = i;
      break;
    }
    // 单语句声明(`const MAX = 8;` / `type X = ...;` / `const f = () => 1;`):
    // 到分号即止。缺这一步会让片段一路长到文件末尾——同文件里后面任何一处改动
    // 都会把这条记忆判成 stale,而那正是 R2.5 要压的误报。
    if (!sawBrace && line.trim().endsWith(';')) {
      end = i + 1;
      break;
    }
    if (i - start + 1 >= MAX_SYMBOL_FRAGMENT_LINES) {
      end = i + 1;
      break;
    }
  }
  const fragment = lines.slice(start, end).join('\n');
  return fragment.trim() ? fragment : null;
}

// ── 读取与判定(带 mtime 缓存)─────────────────────────────────────────────

interface CachedFile {
  stamp: string;
  text: string | null; // null = 读失败/不存在
  oversized: boolean;
}

const fileCache = new Map<string, CachedFile>();
const CACHE_MAX = 256;

function readCached(abs: string): CachedFile {
  let stamp = '0:0';
  let size = 0;
  try {
    const s = statSync(abs);
    if (!s.isFile()) return { stamp: 'notfile', text: null, oversized: false };
    stamp = `${s.mtimeMs}:${s.size}`;
    size = s.size;
  } catch {
    const cached = fileCache.get(abs);
    // 文件消失:必须让缓存失效,否则「刚删的文件」会一直判 fresh。
    if (cached && cached.stamp === '0:0') return cached;
    fileCache.delete(abs);
    return { stamp: '0:0', text: null, oversized: false };
  }
  const hit = fileCache.get(abs);
  if (hit && hit.stamp === stamp) return hit;
  let text: string | null = null;
  let oversized = false;
  if (size > MAX_ANCHOR_FILE_BYTES) oversized = true;
  else {
    try {
      // 与 read_file 同口径:UTF-8 解码后的字符串(不是原始字节)。
      text = readFileSync(abs).toString('utf8');
    } catch {
      text = null;
    }
  }
  const entry: CachedFile = { stamp, text, oversized };
  if (fileCache.size >= CACHE_MAX) fileCache.clear();
  fileCache.set(abs, entry);
  return entry;
}

/** 测试专用:清掉文件缓存。 */
export function __resetAnchorCacheForTests(): void {
  fileCache.clear();
}

/** 对一段文本算 (raw, norm) 两个哈希。`path` 只影响 norm 口径(见 normalizeForHash)。 */
function hashPair(text: string, path?: string): { contentHash: ContentHash; normHash: string } {
  return { contentHash: contentHash(text), normHash: contentHash(normalizeForHash(text, path)) };
}

/**
 * 把调用方的意图落成真锚点(写入时调用)。文件不存在 / 符号找不到 → 失败,
 * 由调用方决定是报错还是静默丢弃。**不存未知 hash**:一条锚不住任何东西的锚点
 * 只会在将来制造噪音。
 */
export type BuildAnchorResult = { ok: true; anchor: MemoryAnchor } | { ok: false; reason: string };

export function buildAnchor(input: AnchorInput, root?: string): BuildAnchorResult {
  const rawPath = String(input.path ?? '').trim();
  if (!rawPath) return { ok: false, reason: 'path 为空' };
  const symbol = input.symbol?.trim() || undefined;
  const abs = resolveAnchorPath(rawPath, root);
  const file = readCached(abs);
  if (file.oversized) return { ok: false, reason: '文件过大,不做锚点' };
  if (file.text === null) return { ok: false, reason: '文件不存在或不可读' };
  const target = symbol ? extractSymbolFragment(file.text, symbol) : file.text;
  if (target === null) return { ok: false, reason: `文件里找不到符号 ${symbol}` };
  const anchorPath = toAnchorPath(rawPath, root);
  return {
    ok: true,
    anchor: {
      path: anchorPath,
      ...(symbol ? { symbol } : {}),
      ...hashPair(target, anchorPath),
    },
  };
}

/** 批量构建:丢弃失败项、按 path+symbol 去重、封顶 MAX_ANCHORS。 */
export function buildAnchors(inputs: readonly AnchorInput[] | undefined, root?: string): MemoryAnchor[] {
  if (!inputs || inputs.length === 0) return [];
  const out: MemoryAnchor[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const r = buildAnchor(input, root);
    if (!r.ok) continue;
    const key = `${r.anchor.path}\u0000${r.anchor.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.anchor);
    if (out.length >= MAX_ANCHORS) break;
  }
  return out;
}

/** 判定单个锚点的现状。 */
export function evaluateAnchor(anchor: MemoryAnchor, root?: string): AnchorEvaluation {
  const abs = resolveAnchorPath(anchor.path, root);
  const file = readCached(abs);
  if (file.oversized) return { anchor, status: 'unknown', detail: '文件过大,未校验' };
  if (file.text === null) return { anchor, status: 'missing', detail: '文件已不存在' };
  const target = anchor.symbol ? extractSymbolFragment(file.text, anchor.symbol) : file.text;
  if (target === null) return { anchor, status: 'missing', detail: `符号 ${anchor.symbol} 已不存在` };
  if (contentHash(target) === anchor.contentHash) return { anchor, status: 'fresh' };
  // 抗格式化兜底:只改了排版/注释不算过期。
  if (anchor.normHash && contentHash(normalizeForHash(target, anchor.path)) === anchor.normHash)
    return { anchor, status: 'fresh', detail: '仅排版/注释变化' };
  return { anchor, status: 'stale', detail: '内容已变更' };
}

/** 判定一条记忆的全部锚点。 */
export function evaluateAnchors(anchors: readonly MemoryAnchor[] | undefined, root?: string): EntryAnchorState {
  if (!anchors || anchors.length === 0) return NOT_ANCHOR_STALE;
  const changed: string[] = [];
  const missing: string[] = [];
  for (const anchor of anchors) {
    const r = evaluateAnchor(anchor, root);
    const label = anchor.symbol ? `${anchor.path}#${anchor.symbol}` : anchor.path;
    if (r.status === 'stale') changed.push(label);
    else if (r.status === 'missing') missing.push(label);
  }
  return { stale: changed.length > 0 || missing.length > 0, changed, missing };
}

/** 供工具输出用的一行摘要(无失效时返空串)。 */
export function describeAnchorState(state: EntryAnchorState): string {
  if (!state.stale) return '';
  const parts: string[] = [];
  if (state.changed.length > 0) parts.push(`代码已变更: ${state.changed.join(', ')}`);
  if (state.missing.length > 0) parts.push(`代码已消失: ${state.missing.join(', ')}`);
  return parts.join('; ');
}

/**
 * 用**调用方已读到的文本**判定锚点,不再碰磁盘(R2.4 的「零额外 IO」)。
 *
 * `read_file` 此刻手里正握着文件内容,让它调 `evaluateAnchors` 会多一次 stat + 一次
 * 读取同一个小文件;语义上也更准确——要判定的是「模型刚看到的这份内容」和记忆是否一致,
 * 而不是「我这次去读到的内容」(两次读之间文件可能变化)。
 *
 * `anchorPath` 是**必须给的语义边界**(缺省时保留旧的全量行为,仅供单锚点调用):
 * 一条记忆可以锚定多个文件,而调用方手里只有其中一个文件的文本。若把其它文件的锚点也
 * 拿这份文本去判,它们必然「符号找不到」→ 判 missing → 整条记忆被当成过期——
 * 一条健康的记忆因此永远不会出现在回注里。所以只判 path 相同的锚点。
 */
export function evaluateAnchorsAgainst(
  anchors: readonly MemoryAnchor[] | undefined,
  text: string,
  anchorPath?: string,
): EntryAnchorState {
  if (!anchors || anchors.length === 0) return NOT_ANCHOR_STALE;
  const scoped = anchorPath ? anchors.filter((a) => a.path === anchorPath) : anchors;
  if (scoped.length === 0) return NOT_ANCHOR_STALE;
  const changed: string[] = [];
  const missing: string[] = [];
  for (const anchor of scoped) {
    const target = anchor.symbol ? extractSymbolFragment(text, anchor.symbol) : text;
    const label = anchor.symbol ? `${anchor.path}#${anchor.symbol}` : anchor.path;
    if (target === null) {
      // 符号不在**这个文件**里(调用方已按 path 过滤):文件在、符号没了(重命名/删除),
      // 按 missing 处理。
      missing.push(label);
      continue;
    }
    if (contentHash(target) === anchor.contentHash) continue;
    if (anchor.normHash && contentHash(normalizeForHash(target, anchor.path)) === anchor.normHash) continue;
    changed.push(label);
  }
  return { stale: changed.length > 0 || missing.length > 0, changed, missing };
}

/** 该条目是否锚定了给定文件(供 read_file 反向查找)。 */
export function anchorsFile(anchors: readonly MemoryAnchor[] | undefined, anchorPath: string): boolean {
  if (!anchors || anchors.length === 0) return false;
  return anchors.some((a) => a.path === anchorPath);
}
