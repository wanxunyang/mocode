/**
 * R2.6 存量记忆的锚点回填:**只提议,不自动写**。
 *
 * ## 为什么现在做
 *
 * R2(代码锚点)在真实库上完全休眠:23 条 global + 72 条 project 里,有锚点的**一条也没有**。
 * 不是实现错了,而是只有新写入才会产锚点,而老条目再也不会被重写一遍——于是 R2 的
 * `STALE-CODE` 标记、R2.4 的 `read_file` 回注、R3.6 的锚点弱 trigger 三条通道全部空转。
 *
 * ## 为什么是「提议」而不是「自动回填」
 *
 * 设计文档的开放问题 12 曾倾向「不回填」,理由是「这条记忆讲的是哪个符号机器判断不了,
 * 强行回填只会制造大量 stale 噪音」。这个判断对**符号**成立,对**路径**不成立:
 * body 里写着的 `src/memory/store.ts` 是用户当时亲眼看到的路径,把它变成锚点不是猜测。
 * 但路径正确 ≠ 这条记忆**只**关于这个文件(可能只是顺带提到),所以写库必须由用户
 * `/memory anchor <n>` 显式确认——与 R9.1 播种同一形态。
 *
 * ## 确定性抽取的边界
 *
 * 只抽「看起来是文件路径、且该文件此刻**真的存在于工作区**」的字面量:
 *
 *  - **要求存在**:不存在就锚不住任何东西,写进去只会是一条永远 missing 的噪音;
 *  - **只收白名单扩展名**:`2.01`(相机固件)和 `3.5.0`(App 版本)也是「点 + 数字」,
 *    不设扩展名白名单会把它们当路径;
 *  - **跳过 URL 与 node_modules**:URL 有独立的 `kind:'url'`(且恒 unknown,对这条通道
 *    没价值);node_modules 里的路径会随 `npm i` 整体消失。
 *
 * 单条最多 4 个:候选是给人看的清单,一屏 8 个路径没人会挨个核对;真正的锚点上限
 * 仍是 `MAX_ANCHORS`(8),用户确认后按提议顺序取前 8 个。
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSandboxRoot } from '../sandbox/root.js';
import { toAnchorPath, type AnchorInput } from './anchor.js';
import { loadAll, updateEntry, type MemoryEntry } from './store.js';

/** 一次最多列多少条候选(条目数)。与 `SEED_MAX_CANDIDATES` 同量级:一屏能核对完。 */
export const ANCHOR_BACKFILL_MAX_ENTRIES = 24;

/** 单条记忆最多提议几个路径。 */
export const ANCHOR_BACKFILL_MAX_PATHS = 4;

/**
 * 认作「代码/文档文件」的扩展名白名单。
 *
 * 白名单而不是黑名单:路径的正则天然会撞上版本号(`2.01`、`4.00`)和域名(`typesafe.ai`),
 * 只有枚举扩展名才能把它们挡在外面,而漏掉某个少见扩展名的代价只是"这条候选不出现"。
 */
const FILE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'md',
  'mdx',
  'txt',
  'html',
  'css',
  'scss',
  'less',
  'sql',
  'vue',
  'svelte',
]);

/** 分隔符:空白 + 常见中英文标点。刻意不切 `/` `\\` `.` `:` `-`(它们都在路径内部)。 */
const TOKEN_SPLIT = /[\s()（）「」『』【】[\]"'`<>，。、；;,|]+/;

/** 去掉 token 两端的包裹字符(反引号、引号已在 split 里切掉,这里兜住残留)。 */
function trimToken(tok: string): string {
  return tok
    .replace(/^[.,;:!?]+/, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/^~(?=[/\\])/, '~');
}

/** 该 token 是否像一个文件路径(只看形状,不碰磁盘)。 */
export function looksLikePath(tok: string): boolean {
  if (!tok || tok.length > 200) return false;
  if (/^https?:\/\//i.test(tok) || tok.includes('://')) return false;
  // 域名:最后一段不像扩展名(类型是字母但整串含 @ 或形如 a.b.c 且每段都短)——交给扩展名白名单处理。
  const m = /\.([A-Za-z][A-Za-z0-9]*)$/.exec(tok);
  if (!m) return false;
  if (!FILE_EXT.has(m[1].toLowerCase())) return false;
  // 路径里必须有分隔符,或整串就是个纯文件名(如 AGENTS.md / SKILL.md)。
  // 纯文件名交给存在性检查决定:能解析到工作区根下真实文件才算数。
  if (/[\s]/.test(tok)) return false;
  return true;
}

/**
 * 从一个 token 解析出**工作区内**的真实文件,返回锚点路径;不在工作区/不存在 → null。
 *
 * 返回 `toAnchorPath` 归一后的形式(工作区内为相对路径):锚点要能跨机器、跨 clone 路径
 * 仍然有效,存绝对路径会让同一条记忆换台电脑就永远 missing。
 */
function resolveExistingFile(tok: string, root: string): string | null {
  if (!looksLikePath(tok)) return null;
  if (tok.includes('node_modules')) return null;
  const abs = path.isAbsolute(tok) ? tok : path.resolve(root, tok);
  // 必须落在工作区内:工作区外的绝对路径(用户自己的相机手册、别的项目)机器判断不了
  // 归属,提议它等于让用户替我们猜。
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return toAnchorPath(abs, root);
}

/** 从一条记忆的 name/summary/body 里抽候选路径(去重、保序)。 */
export function extractAnchorPaths(entry: Pick<MemoryEntry, 'name' | 'summary' | 'body'>, root: string): string[] {
  const text = `${entry.name}\n${entry.summary}\n${entry.body}`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(TOKEN_SPLIT)) {
    const tok = trimToken(raw);
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    const p = resolveExistingFile(tok, root);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= ANCHOR_BACKFILL_MAX_PATHS) break;
  }
  return out;
}

/** 一条候选:条目 + 提议的锚点路径。 */
export interface AnchorCandidate {
  index: number;
  id: string;
  name: string;
  summary: string;
  paths: string[];
}

/** 扫描结果附带的诊断:为什么有些条目没进候选。 */
export interface AnchorScan {
  candidates: AnchorCandidate[];
  /** 已有锚点、因此跳过的条目数。 */
  alreadyAnchored: number;
  /** 没有可解析路径的 active 条目数。 */
  noPath: number;
  /** 被条目数上限截掉的条数。 */
  truncated: number;
}

/**
 * 扫描 active 条目,产出「可回填锚点」的候选。**只读**。
 *
 * 已有锚点的条目直接跳过,不做「补一条」:锚点集是整体替换语义(`UpdatePatch.anchors`),
 * 混着补会让用户无法核对最后到底锚了什么。
 */
export function collectAnchorCandidates(root?: string): AnchorScan {
  const base = root ?? getSandboxRoot() ?? process.cwd();
  const all = loadAll().filter((e) => e.status === 'active' && e.type !== 'episode');
  const candidates: AnchorCandidate[] = [];
  let alreadyAnchored = 0;
  let noPath = 0;
  for (const e of all) {
    if (e.anchors && e.anchors.length > 0) {
      alreadyAnchored += 1;
      continue;
    }
    const paths = extractAnchorPaths(e, base);
    if (paths.length === 0) {
      noPath += 1;
      continue;
    }
    candidates.push({
      index: candidates.length + 1, // 1 基,只在最终列表里定格(截断前不编号)
      id: e.id,
      name: e.name,
      summary: e.summary,
      paths,
    });
  }
  const truncated = Math.max(0, candidates.length - ANCHOR_BACKFILL_MAX_ENTRIES);
  const kept = candidates.slice(0, ANCHOR_BACKFILL_MAX_ENTRIES);
  // 截断后重编序号:用户看到的第一行就该是 1。
  kept.forEach((c, i) => {
    c.index = i + 1;
  });
  return { candidates: kept, alreadyAnchored, noPath, truncated };
}

/** 写入结果。三分法:写入 / 条目已消失 / 路径此刻已不可用。 */
export interface AnchorApplyResult {
  saved: Array<{ index: number; id: string; paths: string[] }>;
  missing: Array<{ index: number; id: string }>;
  /** 提议里有路径在写入时已解析不出来(两次扫描之间文件被删/改名)。 */
  lost: Array<{ index: number; id: string; paths: string[] }>;
}

/**
 * 把选中的候选写成真锚点。
 *
 * `picks` 是 **1 基序号**(与屏幕上列出的一致)。走 `updateEntry` 而不是直接改 JSONL:
 * hash 必须由 `buildAnchor` 现算,手写的 hash 只要错一个字符就是永久 stale。
 *
 * 逐条重新校验路径存在性——扫描与确认之间可能隔了很久(用户看完列表先去改别的),
 * 期间文件可能被删。此时**不写入任何一条**:半套锚点会让这条记忆判定为 stale,
 * 而它其实什么都没变。
 */
export function applyAnchorCandidates(
  candidates: readonly AnchorCandidate[],
  picks: readonly number[] | 'all',
  root?: string,
): AnchorApplyResult {
  const base = root ?? getSandboxRoot() ?? process.cwd();
  const out: AnchorApplyResult = { saved: [], missing: [], lost: [] };
  const wanted = candidates.filter((c) => picks === 'all' || picks.includes(c.index));
  for (const c of wanted) {
    const stillThere = c.paths.filter((p) => existsSync(path.resolve(base, p)));
    if (stillThere.length === 0) {
      out.lost.push({ index: c.index, id: c.id, paths: c.paths });
      continue;
    }
    const anchors: AnchorInput[] = stillThere.map((p) => ({ kind: 'file', path: p }));
    const r = updateEntry(c.id, { anchors, reason: 'anchor backfill' });
    if (!r.ok) {
      out.missing.push({ index: c.index, id: c.id });
      continue;
    }
    out.saved.push({ index: c.index, id: c.id, paths: stillThere });
  }
  return out;
}
