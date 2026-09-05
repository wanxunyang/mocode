import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, getActiveModel } from '../config/index.js';
import type { ChatMessage } from '../llm/index.js';
import { isToolRouteGroupName, type ToolRouteGroupName } from '../config/profiles.js';
import { truncateDisplay } from '../ui/render.js';

/**
 * 会话落盘:把 history 序列化到 <cwd>/.mocode/sessions/<id>.json,支持 --resume / /resume。
 * session = 「这次对话说了啥」;与 memory/(跨会话长期事实)区分。
 * 同步 fs(小文件,匹配 config 的同步风格);任何读/解析失败都返 null,不抛。
 */

export interface SessionMeta {
  id: string;
  createdAt: string;
  model: string;
  firstUser: string;
}
export interface SessionRecord extends SessionMeta {
  history: ChatMessage[];
  /** 用户实际确认提交的 query；可选以兼容旧 session 文件。 */
  queryHistory?: string[];
  /** 上一真实用户 turn 最终激活的工具簇；旧 session 缺失时回退 common-only。 */
  lastToolGroups?: ToolRouteGroupName[];
}

/** 会话目录(确保存在)。 */
export function sessionDir(): string {
  mkdirSync(config.sessionDir, { recursive: true });
  return config.sessionDir;
}

/** 新会话 id:YYYYMMDD-HHmmss(运行时 Date 可用)。 */
export function newSessionId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** id(YYYYMMDD-HHmmss)→ ISO 字符串,稳定可排序。解析失败回退原 id。 */
function idToIso(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return id;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function toText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function firstUserOf(history: ChatMessage[]): string {
  for (const m of history) {
    if (m.role === 'user') {
      const text = toText((m as any).content)
        .replace(/\n/g, ' ')
        .trim();
      return truncateDisplay(text, 40);
    }
  }
  return '';
}

function sessionPath(id: string): string {
  return path.join(config.sessionDir, id, 'session.json');
}

/** 保存会话到磁盘。全新且没有 query 的会话不创建文件；已有会话即使回滚为空也必须覆盖旧记录。 */
export function saveSession(
  history: ChatMessage[],
  id: string,
  queryHistory: readonly string[] = [],
  lastToolGroups: readonly ToolRouteGroupName[] = [],
): SessionMeta {
  const meta: SessionMeta = {
    id,
    createdAt: idToIso(id),
    model: getActiveModel(),
    firstUser:
      history.length > 1
        ? firstUserOf(history)
        : truncateDisplay((queryHistory[0] ?? '').replace(/\n/g, ' ').trim(), 40),
  };
  const currentPath = sessionPath(id);
  const legacyPath = path.join(config.sessionDir, `${id}.json`);
  if (history.length <= 1 && queryHistory.length === 0 && !existsSync(currentPath) && !existsSync(legacyPath)) {
    return meta;
  }
  const dir = path.join(config.sessionDir, id);
  mkdirSync(dir, { recursive: true });
  const record: SessionRecord = {
    ...meta,
    history,
    queryHistory: [...queryHistory],
    lastToolGroups: [...lastToolGroups],
  };
  writeFileSync(currentPath, JSON.stringify(record), 'utf8');
  // 一旦写入新式目录，删除旧式扁平副本，避免已回滚消息仍残留在磁盘。
  if (existsSync(legacyPath)) unlinkSync(legacyPath);
  return meta;
}

/** 加载会话;不存在 / 损坏返 null(不抛)。优先新式目录,回退旧式文件。 */
export function loadSession(id: string): SessionRecord | null {
  // 新式: .mocode/sessions/<id>/session.json
  const newPath = path.join(config.sessionDir, id, 'session.json');
  // 旧式: .mocode/sessions/<id>.json
  const oldPath = path.join(config.sessionDir, `${id}.json`);
  const p = existsSync(newPath) ? newPath : oldPath;
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const rec = JSON.parse(raw) as SessionRecord;
    if (!rec || !Array.isArray(rec.history)) return null;
    return {
      id: rec.id,
      createdAt: rec.createdAt ?? idToIso(rec.id ?? id),
      model: rec.model ?? '',
      firstUser: rec.firstUser ?? '',
      history: rec.history,
      queryHistory: Array.isArray(rec.queryHistory)
        ? rec.queryHistory.filter((query): query is string => typeof query === 'string')
        : undefined,
      lastToolGroups: Array.isArray(rec.lastToolGroups) ? rec.lastToolGroups.filter(isToolRouteGroupName) : undefined,
    };
  } catch {
    return null;
  }
}

/** 列出最近会话,按 createdAt 降序。损坏文件跳过。
 *  - limit?: 仅返回前 N 条。会话目录名是 YYYYMMDD-HHmmss,字典序=时间序;
 *    按目录名降序逐个解析，收集到 N 个有效会话就停止，避免 /resume 在
 *    sessions 目录堆了几百个子目录时全量 JSON.parse；同时不让只有笔记或
 *    快照、没有 session.json 的目录占掉最近 N 条的名额。
 *  - 不传 limit 时读全部(向后兼容,供裸 --resume 列全表用)。
 *  - 向后兼容:同时扫描旧式 <id>.json 文件(扁平结构),优先读新式目录。
 */
export function listSessions(limit?: number): SessionMeta[] {
  if (!existsSync(config.sessionDir)) return [];
  const entries = readdirSync(config.sessionDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name)) {
      ids.push(e.name);
    } else if (e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.snapshots.json')) {
      // 旧式扁平文件:兼容读取
      ids.push(e.name.replace(/\.json$/, ''));
    }
  }
  const all = ids.sort().reverse(); // 降序:最新在前
  const maxResults = typeof limit === 'number' ? Math.max(0, limit) : Infinity;
  const out: SessionMeta[] = [];
  for (const id of all) {
    if (out.length >= maxResults) break;
    try {
      // 优先新式目录,回退旧式文件
      const newPath = path.join(config.sessionDir, id, 'session.json');
      const oldPath = path.join(config.sessionDir, `${id}.json`);
      const p = existsSync(newPath) ? newPath : oldPath;
      const rec = JSON.parse(readFileSync(p, 'utf8')) as Partial<SessionRecord>;
      if (rec && typeof rec.id === 'string') {
        out.push({
          id: rec.id,
          createdAt: rec.createdAt ?? idToIso(rec.id),
          model: rec.model ?? '',
          firstUser: rec.firstUser ?? '',
        });
      }
    } catch {
      // 跳过损坏文件
    }
  }
  return out;
}
