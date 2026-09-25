// Session retention / GC: 老会话的分层生命周期治理。
//
// 此前 memory 有 decay/GC(30/90 天)而 session 没有——.mocode/sessions/ 只增不减
// (实测 23MB+)。本模块对齐 memory 的节奏:
//   ① archive:  超过 archiveAfterDays 未活动的会话,整份 SessionRecord gzip 到
//                archive/<id>.json.gz,摘要+meta 落入 archive/index.jsonl,然后删原目录。
//   ② purge:    archive 中的 .gz 超过 purgeAfterDays,删 gz;index 行保留(meta+摘要),
//                仅标 purgedAt——老资料仍可检索,只是不可再整段恢复。
//
// 纯本地、确定性、零 LLM 成本。当前活跃会话(currentSessionId)永不归档。
// 所有写盘走 tmp+rename(整文件读改写),与 memory/store.ts 同一原子模型。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { ChatMessage } from '../llm/index.js';
import type { SessionRecord } from './store.js';
import { TextSearchIndex } from '../context/text-search.js';
import { config } from '../config/index.js';
import { runReflection, snapshotTranscript } from '../memory/index.js';

/** 摘要消息头(与 compact.ts SUMMARY_MARKER 同值;本地复制避免拉入 compact 的重依赖图)。 */
const SUMMARY_MARKER = '# 会话摘要';
const DAY_MS = 86_400_000;

export interface RetentionPolicy {
  /** 多少天未活动(session.json mtime)即归档。 */
  archiveAfterDays: number;
  /** 归档后多少天即清除 gz 正文。 */
  purgeAfterDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  // env 覆盖仅供测试/调参:MOCODE_ARCHIVE_AFTER_DAYS=0 可立刻触发归档,不必真等 30 天。
  archiveAfterDays: envNumber('MOCODE_ARCHIVE_AFTER_DAYS', 30),
  purgeAfterDays: envNumber('MOCODE_PURGE_AFTER_DAYS', 90),
};

export type RetentionAction = 'archive' | 'purge';

export interface RetentionItem {
  id: string;
  /** 距今天数(归档看会话目录 mtime;purge 看 gz mtime)。 */
  ageDays: number;
  action: RetentionAction;
  firstUser: string;
  sizeBytes: number;
}

/** 读数字 env;允许显式 0(测试要立刻触发),非法/缺省回退默认。 */
function envNumber(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export interface RetentionPlan {
  items: RetentionItem[];
  /** 释放字节估算(归档=会话目录大小;purge=gz 大小)。 */
  bytesReclaimable: number;
}

export interface RetentionResult {
  archived: number;
  purged: number;
  bytesReclaimed: number;
}

/** archive 索引行:归档后这是老会话唯一始终保留的可检索记录。 */
export interface ArchiveIndexEntry {
  id: string;
  createdAt: string;
  model: string;
  firstUser: string;
  /** 归档时从 history[1] 提取的会话摘要原文(可能为空)。 */
  summary: string;
  archivedAt: string;
  /** gz 正文被清除的时间;存在即表示仅可检索、不可恢复。 */
  purgedAt?: string;
}

export interface RetentionStorePaths {
  sessionsRoot: string;
  archiveDir: string;
  indexPath: string;
  /** 上次「自动」GC 时间戳闸门文件(与手动 /session gc 无关)。 */
  lastAutoGcPath: string;
}

export function retentionPaths(sessionsRoot: string): RetentionStorePaths {
  const archiveDir = path.join(sessionsRoot, 'archive');
  return {
    sessionsRoot,
    archiveDir,
    indexPath: path.join(archiveDir, 'index.jsonl'),
    lastAutoGcPath: path.join(archiveDir, '.last-auto-gc'),
  };
}

/** 两次自动 GC 的最小间隔(限频,避免每次启动都跑)。 */
export const AUTO_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 读上次自动 GC 时间戳;无文件/损坏返回 null。 */
export function readLastAutoGc(sessionsRoot: string): number | null {
  try {
    const v = Number(readFileSync(retentionPaths(sessionsRoot).lastAutoGcPath, 'utf8').trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 写自动 GC 时间戳(tmp+rename 虽非必需,保持与其它落盘一致的原子性)。 */
export function writeLastAutoGc(sessionsRoot: string, ts: number = Date.now()): void {
  const p = retentionPaths(sessionsRoot).lastAutoGcPath;
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', String(ts));
  renameSync(p + '.tmp', p);
}

/** 是否该跑自动 GC:距上次 ≥ interval(或从未跑过)。env MOCODE_AUTO_GC=false 可关闭。 */
export function shouldAutoGc(sessionsRoot: string, now: number = Date.now()): boolean {
  if (process.env.MOCODE_AUTO_GC === 'false') return false;
  const last = readLastAutoGc(sessionsRoot);
  return last === null || now - last >= AUTO_GC_INTERVAL_MS;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
    } catch {
      // 统计尽力而为。
    }
  }
  return total;
}

/** 从 SessionRecord 提取会话摘要(role:system 且以标记开头的消息),无则空串。 */
function extractSummary(record: SessionRecord): string {
  for (const m of record.history as ChatMessage[]) {
    if (m.role !== 'system') continue;
    const c = (m as { content?: unknown }).content;
    if (typeof c === 'string' && c.startsWith(SUMMARY_MARKER)) return c;
  }
  return '';
}

// ── index.jsonl 读写 ─────────────────────────────────────────────────────
export function readArchiveIndex(indexPath: string): ArchiveIndexEntry[] {
  if (!existsSync(indexPath)) return [];
  const out: ArchiveIndexEntry[] = [];
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ArchiveIndexEntry;
      if (e && typeof e.id === 'string') out.push(e);
    } catch {
      // 跳过损坏行。
    }
  }
  return out;
}

/** 整文件原子写:tmp+rename。 */
function writeArchiveIndex(indexPath: string, entries: ArchiveIndexEntry[]): void {
  const tmp = indexPath + '.tmp';
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  renameSync(tmp, indexPath);
}

/** upsert 一条索引(按 id 覆盖)。 */
export function upsertArchiveIndex(indexPath: string, entry: ArchiveIndexEntry): void {
  const entries = readArchiveIndex(indexPath).filter((e) => e.id !== entry.id);
  entries.push(entry);
  entries.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  writeArchiveIndex(indexPath, entries);
}

// ── 计划(不落盘)──────────────────────────────────────────────────────────
/**
 * 生成 retention 计划。
 * @param excludeCurrentId 当前活跃会话 id,永不归档。
 */
export function planRetention(
  sessionsRoot: string,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now(),
  excludeCurrentId?: string,
): RetentionPlan {
  const items: RetentionItem[] = [];
  const paths = retentionPaths(sessionsRoot);

  // ① 待归档的活会话目录
  if (existsSync(sessionsRoot)) {
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'archive') continue;
      if (!/^\d{8}-\d{6}/.test(entry.name)) continue;
      if (entry.name === excludeCurrentId) continue;
      const dir = path.join(sessionsRoot, entry.name);
      const sessionPath = path.join(dir, 'session.json');
      if (!existsSync(sessionPath)) continue;
      // Date.now() 截断毫秒而 mtimeMs 带小数:新写入文件 age 可能微负,
      // clamp 到 0 避免阈值 0(=立即归档)下把刚写入的会话误判为未超龄跳过。
      const ageDays = Math.max(0, now - statSync(sessionPath).mtimeMs) / DAY_MS;
      if (ageDays < policy.archiveAfterDays) continue;
      let firstUser = '';
      try {
        const rec = JSON.parse(readFileSync(sessionPath, 'utf8')) as Partial<SessionRecord>;
        firstUser = rec.firstUser ?? '';
      } catch {
        // 损坏文件仍可归档,firstUser 留空。
      }
      items.push({ id: entry.name, ageDays, action: 'archive', firstUser, sizeBytes: dirSize(dir) });
    }
  }

  // ② 待 purge 的归档 gz
  if (existsSync(paths.archiveDir)) {
    for (const entry of readdirSync(paths.archiveDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json.gz')) continue;
      const id = entry.name.replace(/\.json\.gz$/, '');
      const full = path.join(paths.archiveDir, entry.name);
      const ageDays = Math.max(0, now - statSync(full).mtimeMs) / DAY_MS;
      if (ageDays < policy.purgeAfterDays) continue;
      const idx = readArchiveIndex(paths.indexPath).find((e) => e.id === id);
      items.push({ id, ageDays, action: 'purge', firstUser: idx?.firstUser ?? '', sizeBytes: statSync(full).size });
    }
  }

  items.sort((a, b) => (a.id < b.id ? 1 : -1));
  return { items, bytesReclaimable: items.reduce((s, i) => s + i.sizeBytes, 0) };
}

// ── 执行 ─────────────────────────────────────────────────────────────────
/** 归档单个会话:读 session.json → gzip → 写 index → 删原目录。失败抛错由调用方统一处理。 */
function archiveSession(sessionsRoot: string, id: string, now: number): void {
  const paths = retentionPaths(sessionsRoot);
  const dir = path.join(sessionsRoot, id);
  const sessionPath = path.join(dir, 'session.json');
  const record = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionRecord;
  mkdirSync(paths.archiveDir, { recursive: true });
  const gzPath = path.join(paths.archiveDir, `${id}.json.gz`);
  writeFileSync(gzPath + '.tmp', gzipSync(readFileSync(sessionPath)));
  renameSync(gzPath + '.tmp', gzPath);
  upsertArchiveIndex(paths.indexPath, {
    id: record.id,
    createdAt: record.createdAt,
    model: record.model,
    firstUser: record.firstUser,
    summary: extractSummary(record),
    archivedAt: new Date(now).toISOString(),
  });
  rmSync(dir, { recursive: true, force: true });
}

/** purge 单个归档:删 gz,index 行保留并标 purgedAt。 */
function purgeArchived(sessionsRoot: string, id: string, now: number): void {
  const paths = retentionPaths(sessionsRoot);
  const gzPath = path.join(paths.archiveDir, `${id}.json.gz`);
  if (existsSync(gzPath)) unlinkSync(gzPath);
  const entries = readArchiveIndex(paths.indexPath);
  const e = entries.find((x) => x.id === id);
  if (e && !e.purgedAt) {
    e.purgedAt = new Date(now).toISOString();
    writeArchiveIndex(paths.indexPath, entries);
  }
}

/** 值得跑巩固的最短 history 长度;过短会话没有可沉淀的内容。 */
const MIN_MESSAGES_TO_REFLECT = 6;
/** 后台巩固单次超时:比 runReflection 默认 60s 更短,避免后台静默挂一串慢请求。 */
const CONSOLIDATE_TIMEOUT_MS = 20000;

/**
 * 按计划执行归档/清除。**核心动作(归档/删正文)同步秒完并立即返回**。
 *
 * 记忆巩固(P2-9)是增强而非归档前提:先读出待归档会话转录、完成归档,
 * 再把 reflection 放到**后台非阻塞**执行——gc 不再让用户干等 LLM。
 * 记忆关闭(config.memoryEnabled=false)时完全跳过,不花一分钱。
 */
export async function runRetention(
  sessionsRoot: string,
  plan: RetentionPlan,
  now: number = Date.now(),
): Promise<RetentionResult> {
  let archived = 0;
  let purged = 0;
  let bytesReclaimed = 0;
  const pendingTranscripts: string[] = [];
  for (const item of plan.items) {
    if (item.action === 'archive') {
      if (config.memoryEnabled) {
        const transcript = readTranscript(sessionsRoot, item.id);
        if (transcript) pendingTranscripts.push(transcript);
      }
      archiveSession(sessionsRoot, item.id, now);
      archived++;
    } else {
      purgeArchived(sessionsRoot, item.id, now);
      purged++;
    }
    bytesReclaimed += item.sizeBytes;
  }
  // 后台巩固:不 await、不阻塞返回。单项失败已在 runReflection 内部兜底。
  for (const transcript of pendingTranscripts) {
    void runReflection(transcript, AbortSignal.timeout(CONSOLIDATE_TIMEOUT_MS));
  }
  return { archived, purged, bytesReclaimed };
}

/** 读会话转录快照;history 过短或读取失败返回 null(跳过巩固)。 */
function readTranscript(sessionsRoot: string, id: string): string | null {
  try {
    const sessionPath = path.join(sessionsRoot, id, 'session.json');
    const record = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionRecord;
    const history = record.history as ChatMessage[];
    if (!Array.isArray(history) || history.length < MIN_MESSAGES_TO_REFLECT) return null;
    return snapshotTranscript(history, 20);
  } catch {
    return null;
  }
}

export interface ArchiveSearchHit extends ArchiveIndexEntry {
  score: number;
}

/**
 * 跨会话搜索归档索引(episodic 层):BM25 over firstUser + summary。
 * 已 purge 的会话同样可命中——meta+摘要永久保留,只是不可整段恢复。
 */
export function searchArchiveIndex(sessionsRoot: string, query: string, limit = 10): ArchiveSearchHit[] {
  const entries = readArchiveIndex(retentionPaths(sessionsRoot).indexPath);
  if (entries.length === 0 || !query.trim()) return [];
  const index = new TextSearchIndex(
    entries.map((e) => ({
      id: e.id,
      fields: [
        { text: e.firstUser, weight: 3 },
        { text: e.summary, weight: 1 },
      ],
    })),
  );
  const byId = new Map(entries.map((e) => [e.id, e]));
  const hits: ArchiveSearchHit[] = [];
  for (const h of index.search(query, limit)) {
    const e = byId.get(h.id);
    if (e) hits.push({ ...e, score: h.score });
  }
  return hits;
}

/** 读回一个已归档(未 purge)的完整 SessionRecord;已 purge/不存在返 null。 */
export function loadArchivedSession(sessionsRoot: string, id: string): SessionRecord | null {
  const gzPath = path.join(retentionPaths(sessionsRoot).archiveDir, `${id}.json.gz`);
  if (!existsSync(gzPath)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(gzPath)).toString('utf8')) as SessionRecord;
  } catch {
    return null;
  }
}
