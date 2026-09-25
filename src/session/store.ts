import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { MAX_TRACE_BYTES, MAX_TRACE_ROTATIONS } from '../tools/constants.js';
import { loadArchivedSession, readArchiveIndex, retentionPaths } from './retention.js';
import { config, getActiveModel } from '../config/index.js';
import { getWorkspaceRoot } from '../workspace/index.js';
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
  /** 来自归档索引(正文在 archive/<id>.json.gz);仍可按 id resume。purge 后不可恢复故不列出。 */
  archived?: boolean;
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
  /** 会话归属的工作区根。字符串会在构造时固定；provider 让默认实例跟随 /cd 切换。 */
  workspaceRoot?: string | (() => string);
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
  /**
   * 会话归属的工作区根。**动态**:默认实例用 provider 读 workspace root,
   * 这样 /cd 切换工作区后不必重建 store(重建会丢 currentSessionId 等进程级绑定)。
   */
  get workspaceRoot(): string {
    return this.workspaceRootProvider();
  }

  private readonly workspaceRootProvider: () => string;
  private readonly sessionsRootProvider: () => string;
  private readonly getModel: () => string;
  private readonly currentSessionIdProvider?: () => string | undefined;
  private readonly currentSessionIdSetter?: (id: string | undefined) => void;
  private currentSessionId: string | undefined;

  constructor(options: SessionStoreOptions = {}) {
    if (typeof options.workspaceRoot === 'function') {
      const provider = options.workspaceRoot;
      this.workspaceRootProvider = () => path.resolve(provider());
    } else {
      const fixedWorkspace = path.resolve(options.workspaceRoot ?? process.cwd());
      this.workspaceRootProvider = () => fixedWorkspace;
    }
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

  /**
   * 追加一条 trace 事件;当前 trace.jsonl 已达 MAX_TRACE_BYTES 时先轮转:
   * 旧内容 gzip 成 trace.1.jsonl.gz,既有轮转依次后移(只留最近 MAX_TRACE_ROTATIONS 份),
   * 然后清空当前文件。纯诊断数据,任何失败静默降级为普通追加。
   */
  appendTrace(id: string, value: unknown): void {
    try {
      const dir = path.join(this.sessionsRoot, id);
      mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify(value)}\n`;
      const tracePath = path.join(dir, 'trace.jsonl');
      // env 覆盖仅供测试:MOCODE_MAX_TRACE_BYTES=200 可立刻触发轮转。
      const envMax = Number(process.env.MOCODE_MAX_TRACE_BYTES);
      const maxTraceBytes = Number.isFinite(envMax) && envMax >= 0 ? envMax : MAX_TRACE_BYTES;
      const size = existsSync(tracePath) ? statSync(tracePath).size : 0;
      if (size >= maxTraceBytes) {
        this.rotateTrace(dir, tracePath);
      }
      writeFileSync(tracePath, line, { encoding: 'utf8', flag: 'a' });
    } catch {
      // Observability is best-effort and cannot block coding work.
    }
  }

  private rotateTrace(dir: string, tracePath: string): void {
    const rotPath = (n: number): string => path.join(dir, `trace.${n}.jsonl.gz`);
    // 最老的一份硬删;其余从老到新依次后移,腾出 trace.1。
    try {
      if (existsSync(rotPath(MAX_TRACE_ROTATIONS))) unlinkSync(rotPath(MAX_TRACE_ROTATIONS));
    } catch {
      // 删失败不致命,rename 覆盖亦可。
    }
    for (let n = MAX_TRACE_ROTATIONS - 1; n >= 1; n--) {
      const from = rotPath(n);
      if (!existsSync(from)) continue;
      try {
        renameSync(from, rotPath(n + 1));
      } catch {
        // Windows 下目标存在时 rename 可能失败:尝试删目标再移。
        try {
          unlinkSync(rotPath(n + 1));
          renameSync(from, rotPath(n + 1));
        } catch {
          // 放弃这份轮转,保留新 gz 更重要。
        }
      }
    }
    const content = readFileSync(tracePath);
    writeFileSync(rotPath(1), gzipSync(content));
    writeFileSync(tracePath, '');
  }

  /**
   * 追加一条 per-step 用量记录到 <id>/usage.jsonl(#token-efficiency P1)。
   * 与 appendTrace 同策略:纯诊断,失败静默,不做轮转(长会话的量级远小于 trace)。
   */
  appendUsage(id: string, value: unknown): void {
    try {
      const dir = path.join(this.sessionsRoot, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'usage.jsonl'), `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
    } catch {
      // Metrics must never block coding work.
    }
  }

  /** 读取 <id>/usage.jsonl 全部记录;文件不存在或损坏行跳过。 */
  readUsage(id: string): unknown[] {
    const file = path.join(this.sessionsRoot, id, 'usage.jsonl');
    if (!existsSync(file)) return [];
    const out: unknown[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // 跳过损坏行。
      }
    }
    return out;
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
    // 原子落盘:先写同目录 tmp 再 rename——全量重写(长会话可达数 MB)中途崩溃/断电
    // 不会留下半个 JSON 把整个会话写坏(对齐 memory/store.ts writeAtomic)。
    const tmpPath = path.join(this.sessionsRoot, id, 'session.json.tmp');
    writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    renameSync(tmpPath, currentPath);
    if (existsSync(legacyPath)) unlinkSync(legacyPath);
    return meta;
  }

  load(id: string): SessionRecord | null {
    const currentPath = this.sessionPath(id);
    const legacyPath = path.join(this.sessionsRoot, `${id}.json`);
    let source = existsSync(currentPath) ? currentPath : legacyPath;
    // 活会话与 legacy 单文件都没有:回退从归档 gz 取回(30-90 天的会话仍可 resume)。
    if (!existsSync(source)) {
      const archived = loadArchivedSession(this.sessionsRoot, id);
      return archived ?? null;
    }
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

    // 归档(未 purge)会话并入列表:正文在 archive/<id>.json.gz,仍可按 id resume。
    // 与 live 去重(理论上不会重叠),按时间统一降序后再截 limit。
    const liveIds = new Set(out.map((m) => m.id));
    for (const e of readArchiveIndex(retentionPaths(root).indexPath)) {
      if (e.purgedAt || liveIds.has(e.id)) continue;
      out.push({
        id: e.id,
        createdAt: e.createdAt ?? idToIso(e.id),
        model: e.model ?? '',
        firstUser: e.firstUser ?? '',
        archived: true,
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return Number.isFinite(maxResults) ? out.slice(0, maxResults) : out;
  }
}

/** 旧函数 API 的进程级兼容实例；session root 每次读取 config，保留测试和运行时切换语义。 */
export const defaultSessionStore = new SessionStore({
  sessionsRoot: () => config.sessionDir,
  // 动态读工作区根:/cd 切走后本实例仍归属新工作区(见 src/workspace/index.ts)。
  workspaceRoot: () => getWorkspaceRoot(),
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
