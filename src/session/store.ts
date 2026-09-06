import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, getActiveModel } from '../config/index.js';
import { isToolRouteGroupName, type ToolRouteGroupName } from '../config/profiles.js';
import type { ChatMessage } from '../llm/index.js';
import { truncateDisplay } from '../ui/render.js';
import {
  getDefaultCurrentSessionId,
  setCurrentSessionId as setDefaultCurrentSessionId,
  withCurrentSessionIdProvider,
} from './state.js';

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

export interface SessionStoreOptions {
  /** 字符串会在构造时固定；provider 用于默认兼容 store 动态读取 config.sessionDir。 */
  sessionsRoot?: string | (() => string);
  workspaceRoot?: string;
  getModel?: () => string;
  getCurrentSessionId?: () => string | undefined;
  setCurrentSessionId?: (id: string | undefined) => void;
}

/** 新会话 id: 时间前缀保持可排序，毫秒与随机段避免同进程/跨进程碰撞。 */
function createTimestampId(): string {
  const d = new Date();
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds(),
  )}-${p(d.getMilliseconds(), 3)}-${randomUUID().slice(0, 8)}`;
}

/** 时间前缀 → ISO 字符串；兼容旧秒级 ID，解析失败回退原 id。 */
function idToIso(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3})-[a-f0-9]{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? `.${m[7]}` : ''}`;
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
  for (const message of history) {
    if (message.role !== 'user') continue;
    const text = toText((message as { content?: unknown }).content)
      .replace(/\n/g, ' ')
      .trim();
    return truncateDisplay(text, 40);
  }
  return '';
}

/**
 * Runtime-local session persistence and identity.
 *
 * Disk format remains compatible with the historical helpers: the current format is
 * `<sessionsRoot>/<id>/session.json`, with `<sessionsRoot>/<id>.json` as a read fallback.
 */
export class SessionStore {
  readonly workspaceRoot: string;

  private readonly sessionsRootProvider: () => string;
  private readonly getModel: () => string;
  private readonly currentSessionIdProvider?: () => string | undefined;
  private readonly currentSessionIdSetter?: (id: string | undefined) => void;
  private currentSessionId: string | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    if (typeof options.sessionsRoot === 'function') {
      const provider = options.sessionsRoot;
      this.sessionsRootProvider = () => path.resolve(provider());
    } else {
      const fixedRoot = path.resolve(options.sessionsRoot ?? config.sessionDir);
      this.sessionsRootProvider = () => fixedRoot;
    }
    this.getModel = options.getModel ?? getActiveModel;
    this.currentSessionIdProvider = options.getCurrentSessionId;
    this.currentSessionIdSetter = options.setCurrentSessionId;
  }

  get sessionsRoot(): string {
    return this.sessionsRootProvider();
  }

  sessionDir(): string {
    const root = this.sessionsRoot;
    mkdirSync(root, { recursive: true });
    return root;
  }

  createId(): string {
    return createTimestampId();
  }

  getCurrentSessionId(): string | undefined {
    return this.currentSessionIdProvider?.() ?? this.currentSessionId;
  }

  setCurrentSessionId(id: string | undefined): void {
    if (this.currentSessionIdSetter) this.currentSessionIdSetter(id);
    else this.currentSessionId = id;
  }

  sessionPath(id: string): string {
    return path.join(this.sessionsRoot, id, 'session.json');
  }

  artifactPath(id: string, filename: string): string {
    return path.join(this.sessionsRoot, id, filename);
  }

  appendTrace(id: string, value: unknown): void {
    try {
      const dir = path.join(this.sessionsRoot, id);
      mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify(value)}\n`;
      const tracePath = path.join(dir, 'trace.jsonl');
      writeFileSync(tracePath, line, { encoding: 'utf8', flag: 'a' });
    } catch {
      // Observability is best-effort and cannot block coding work.
    }
  }

  save(
    history: ChatMessage[],
    id: string,
    queryHistory: readonly string[] = [],
    lastToolGroups: readonly ToolRouteGroupName[] = [],
  ): SessionMeta {
    const meta: SessionMeta = {
      id,
      createdAt: idToIso(id),
      model: this.getModel(),
      firstUser:
        history.length > 1
          ? firstUserOf(history)
          : truncateDisplay((queryHistory[0] ?? '').replace(/\n/g, ' ').trim(), 40),
    };
    const currentPath = this.sessionPath(id);
    const legacyPath = path.join(this.sessionsRoot, `${id}.json`);
    if (history.length <= 1 && queryHistory.length === 0 && !existsSync(currentPath) && !existsSync(legacyPath)) {
      return meta;
    }
    mkdirSync(path.join(this.sessionsRoot, id), { recursive: true });
    const record: SessionRecord = {
      ...meta,
      history,
      queryHistory: [...queryHistory],
      lastToolGroups: [...lastToolGroups],
    };
    writeFileSync(currentPath, JSON.stringify(record), 'utf8');
    if (existsSync(legacyPath)) unlinkSync(legacyPath);
    return meta;
  }

  load(id: string): SessionRecord | null {
    const currentPath = this.sessionPath(id);
    const legacyPath = path.join(this.sessionsRoot, `${id}.json`);
    const source = existsSync(currentPath) ? currentPath : legacyPath;
    if (!existsSync(source)) return null;
    try {
      const rec = JSON.parse(readFileSync(source, 'utf8')) as SessionRecord;
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

  list(limit?: number): SessionMeta[] {
    const root = this.sessionsRoot;
    if (!existsSync(root)) return [];
    const entries = readdirSync(root, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d{8}-\d{6}(?:-\d{3}-[a-f0-9]{8})?$/.test(entry.name)) {
        ids.push(entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.snapshots.json')) {
        ids.push(entry.name.replace(/\.json$/, ''));
      }
    }
    const maxResults = typeof limit === 'number' ? Math.max(0, limit) : Infinity;
    const out: SessionMeta[] = [];
    for (const id of ids.sort().reverse()) {
      if (out.length >= maxResults) break;
      const currentPath = this.sessionPath(id);
      const legacyPath = path.join(root, `${id}.json`);
      const source = existsSync(currentPath) ? currentPath : legacyPath;
      try {
        const rec = JSON.parse(readFileSync(source, 'utf8')) as Partial<SessionRecord>;
        if (!rec || typeof rec.id !== 'string') continue;
        out.push({
          id: rec.id,
          createdAt: rec.createdAt ?? idToIso(rec.id),
          model: rec.model ?? '',
          firstUser: rec.firstUser ?? '',
        });
      } catch {
        // 跳过损坏文件。
      }
    }
    return out;
  }
}

/** 旧函数 API 的进程级兼容实例；session root 每次读取 config，保留测试和运行时切换语义。 */
export const defaultSessionStore = new SessionStore({
  sessionsRoot: () => config.sessionDir,
  workspaceRoot: process.cwd(),
  getModel: getActiveModel,
  getCurrentSessionId: getDefaultCurrentSessionId,
  setCurrentSessionId: (id) => setDefaultCurrentSessionId(id, process.cwd()),
});

const activeSessionStores = new AsyncLocalStorage<SessionStore>();

/** 当前异步 runtime 树使用的 session store；无 scope 时回退默认兼容实例。 */
export function getActiveSessionStore(): SessionStore {
  return activeSessionStores.getStore() ?? defaultSessionStore;
}

/** 让旧 session/trace 入口在异步 runtime 树内自动使用对应实例。 */
export function withSessionStore<T>(store: SessionStore, run: () => Promise<T>): Promise<T> {
  return activeSessionStores.run(store, () => withCurrentSessionIdProvider(() => store.getCurrentSessionId(), run));
}
