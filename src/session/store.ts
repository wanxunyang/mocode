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
import { MAX_TRACE_BYTES, MAX_TRACE_ROTATIONS, MAX_COMPACTED_ARCHIVE_BYTES } from '../tools/constants.js';
import { loadArchivedSession, readArchiveIndex, retentionPaths } from './retention.js';
import {
  COMPACTED_DIRNAME,
  isCompactedAssetName,
  parseSegmentMeta,
  renderArchiveIndex,
  renderCompactedSegment,
  resultBlobFileName,
  RESULT_BLOB_FILE_RE,
  SEGMENT_FILE_RE,
  type CompactedSegmentMeta,
} from './compact-archive.js';
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
  /**
   * 归档 gz 内嵌的压缩归档资产(compacted/ 下的 seg/index/result blob,relPath → utf8)。
   * 仅在归档时由 retention 写入;活会话的 session.json 不带这字段。resume 时
   * SessionStore.load 据此把文件写回 <id>/compacted/。
   */
  compactedAssets?: Record<string, string>;
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

/** compacted/ 总量上限:MOCODE_MAX_COMPACTED_BYTES 覆盖(供测试/小盘),非法值回退默认。 */
function envMaxCompactedBytes(): number {
  const raw = process.env.MOCODE_MAX_COMPACTED_BYTES;
  if (!raw) return MAX_COMPACTED_ARCHIVE_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : MAX_COMPACTED_ARCHIVE_BYTES;
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
  /**
   * 已确保存在的会话目录缓存(2026-10-05)。
   *
   * `mkdirSync(recursive)` 单次 0.20ms —— 比 existsSync+statSync(合计 0.009ms)贵 20 倍,
   * 因为 recursive 模式要逐级向下 stat 每层路径。而 appendTrace 每 step 调 14 次
   * (step_start/end + model_start/end + 每工具 2 个),每轮 20 step ≈ 280 次全花在
   * 「确认目录已存在」上,一轮白烧 56ms。
   *
   * 缓存的是「已 mkdir 成功」这件事,不是路径存在性。**代价**:外部删掉目录后缓存会失真。
   * 兜底是三个写盘方法统一的「失败 → invalidateEnsuredDir → 重试一次」模式
   * (见 appendTrace / appendUsage / save),既保住性能又不丢数据。
   * 护栏见 tests/session-dir-cache.test.ts 的「外部删除后自愈」三例。
   */
  private ensuredDirs = new Set<string>();

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
    this.ensureDir(root);
    return root;
  }

  /**
   * 幂等建目录:同一路径只在首次真正 mkdir(见 ensuredDirs 的成本说明)。
   *
   * 缓存意味着「外部删掉目录后不自愈」,故所有写盘方法都用
   * {@link invalidateEnsuredDir} + 重试一次兜住(retention 归档后 rmSync、
   * 用户手工清理等)。单靠这里的 Set 不会自愈,必须配对那个重试。
   */
  private ensureDir(dir: string): void {
    if (this.ensuredDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }

  /** 让 ensureDir 下次真正 mkdir(用于 append 失败后的自愈重试)。 */
  private invalidateEnsuredDir(dir: string): void {
    this.ensuredDirs.delete(dir);
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
    const dir = path.join(this.sessionsRoot, id);
    const line = `${JSON.stringify(value)}\n`;
    const tracePath = path.join(dir, 'trace.jsonl');
    // env 覆盖仅供测试:MOCODE_MAX_TRACE_BYTES=200 可立刻触发轮转。
    const envMax = Number(process.env.MOCODE_MAX_TRACE_BYTES);
    const maxTraceBytes = Number.isFinite(envMax) && envMax >= 0 ? envMax : MAX_TRACE_BYTES;
    // 目录缓存可能因外部删除而失真(如 retention 归档后 rmSync):首次失败清缓存重试一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.ensureDir(dir); // 缓存:每 step 14 次调用,省 14×0.20ms
        // statSync 一次即可拿到「不存在 / 大小」两种答案,省掉 existsSync 那一跳
        // (两者合计仅 0.009ms,但顺手消掉一次 TOCTOU 窗口)。
        let size = 0;
        try {
          size = statSync(tracePath).size;
        } catch {
          size = 0;
        }
        if (size >= maxTraceBytes) {
          this.rotateTrace(dir, tracePath);
        }
        writeFileSync(tracePath, line, { encoding: 'utf8', flag: 'a' });
        return;
      } catch {
        this.invalidateEnsuredDir(dir);
        if (attempt === 1) {
          // Observability is best-effort and cannot block coding work.
          return;
        }
      }
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
    const dir = path.join(this.sessionsRoot, id);
    const line = `${JSON.stringify(value)}\n`;
    const file = path.join(dir, 'usage.jsonl');
    // 同 appendTrace:目录缓存失真时清缓存重试一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.ensureDir(dir); // 同appendTrace:每 step 1 次,省 0.20ms
        writeFileSync(file, line, { encoding: 'utf8', flag: 'a' });
        return;
      } catch {
        this.invalidateEnsuredDir(dir);
        if (attempt === 1) {
          // Metrics must never block coding work.
          return;
        }
      }
    }
  }

  /**
   * 压缩归档:把本次压缩丢弃的旧区消息渲染成 `compacted/seg-NNN.md`,
   * 并重建 `compacted/index.md`。best-effort——这是压缩的增值能力,不是用户数据主副本
   * (session.json 仍是主副本),任何失败静默降级,绝不阻塞压缩。
   *
   * 编号:扫描已有 seg-NNN.md 取 max+1(外部删除/重命名后仍单调)。
   * 淘汰:全部 seg 总量超 MAX_COMPACTED_ARCHIVE_BYTES 时,从最老段硬删并重建 index。
   * 目录缓存失真时与 appendTrace 同模式:清缓存重试一次。
   *
   * @returns 段相对路径(供摘要写指针);失败返 null。
   */
  archiveCompactedMessages(sessionId: string, messages: readonly ChatMessage[]): string | null {
    if (!sessionId || messages.length === 0) return null;
    const dir = path.join(this.sessionsRoot, sessionId, COMPACTED_DIRNAME);
    const budget = envMaxCompactedBytes();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.ensureDir(dir);
        const seq = this.nextSegmentSeq(dir);
        const { markdown, meta } = renderCompactedSegment(seq, messages);
        writeFileSync(path.join(dir, meta.file), markdown, 'utf8');
        this.pruneCompacted(dir, budget);
        // 新增了一个 seg,index 必须重建才能列全(prune 是否删旧段不影响这一点;
        // result blob 不走这里,故不需要每次写 blob 都重建)。
        this.rebuildCompactedIndex(sessionId, dir);
        return `.mocode/sessions/${sessionId}/${COMPACTED_DIRNAME}/${meta.file}`;
      } catch {
        this.invalidateEnsuredDir(dir);
        if (attempt === 1) return null;
      }
    }
    return null;
  }

  /**
   * push-time 截断兜底:工具完整结果在进 history 前被 capToolResultForHistory 裁掉时,
   * 把**完整原文**另存为 `compacted/result-<toolCallId>.txt`,供事后 grep/read_file 回捞。
   * best-effort,写失败静默(绝不阻塞工具回灌);纳入与段相同的总量预算淘汰。
   *
   * @returns 全文相对路径(供 history 截断内容留指针);失败返 null。
   */
  archiveToolResult(sessionId: string, toolCallId: string, fullOutput: string): string | null {
    if (!sessionId || !toolCallId || !fullOutput) return null;
    const dir = path.join(this.sessionsRoot, sessionId, COMPACTED_DIRNAME);
    const fileName = resultBlobFileName(toolCallId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.ensureDir(dir);
        writeFileSync(path.join(dir, fileName), fullOutput, 'utf8');
        this.pruneCompacted(dir, envMaxCompactedBytes());
        return `.mocode/sessions/${sessionId}/${COMPACTED_DIRNAME}/${fileName}`;
      } catch {
        this.invalidateEnsuredDir(dir);
        if (attempt === 1) return null;
      }
    }
    return null;
  }

  /**
   * resume 归档会话时,把 gz 内嵌的 compacted 资产(seg/index/截断原文 blob)写回磁盘,
   * 恢复历史回捞链。best-effort:任何坏条目跳过。防 zip-slip:只接受 compacted/ 下
   * 白名单单层文件名。
   */
  restoreCompactedAssets(id: string, record: SessionRecord): void {
    const assets = record.compactedAssets;
    if (!assets || typeof assets !== 'object') return;
    const dir = path.join(this.sessionsRoot, id, COMPACTED_DIRNAME);
    for (const [relPath, content] of Object.entries(assets)) {
      if (typeof content !== 'string') continue;
      const base = relPath.startsWith(`${COMPACTED_DIRNAME}/`) ? relPath.slice(COMPACTED_DIRNAME.length + 1) : null;
      if (!base || base.includes('/') || base.includes('\\') || !isCompactedAssetName(base)) continue;
      try {
        this.ensureDir(dir);
        writeFileSync(path.join(dir, base), content, 'utf8');
      } catch {
        this.invalidateEnsuredDir(dir);
      }
    }
  }

  /** 扫描 seg-NNN.md 取下一个编号;损坏文件名跳过。 */
  private nextSegmentSeq(dir: string): number {
    let max = 0;
    for (const name of this.listDirNames(dir)) {
      const m = SEGMENT_FILE_RE.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  /**
   * compacted/ 全目录(seg 段 + result blob)统一字节预算淘汰:
   * 超 MAX_COMPACTED_ARCHIVE_BYTES 时从最老文件(mtime,再按名)硬删。
   * 唯一豁免 = 编号最大的那个 seg(始终保住最近一代压缩的完整回捞入口);
   * index.md 不占删除候选(段变更后重建)。
   *
   * @returns 是否有 seg 被删(调用方据此重建 index)。
   */
  private pruneCompacted(dir: string, budget: number): boolean {
    if (!(budget > 0)) return false;
    const newestSeq = this.listDirNames(dir).reduce((max, name) => {
      const m = SEGMENT_FILE_RE.exec(name);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const candidates = this.listDirNames(dir)
      .filter((name) => SEGMENT_FILE_RE.test(name) || RESULT_BLOB_FILE_RE.test(name))
      .map((name) => {
        const m = SEGMENT_FILE_RE.exec(name);
        const st = statSync(path.join(dir, name));
        return { name, size: st.size, mtimeMs: st.mtimeMs, seq: m ? Number(m[1]) : null };
      })
      // 最老在前:blob 与跨类型文件按 mtime;同刻按名,保证确定性。
      .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));

    let total = candidates.reduce((s, e) => s + e.size, 0);
    let removedSeg = false;
    for (const e of candidates) {
      if (total <= budget) break;
      if (e.seq !== null && e.seq === newestSeq) continue; // 永不删最新段
      try {
        unlinkSync(path.join(dir, e.name));
      } catch {
        break; // 删不动就停止淘汰,避免死循环
      }
      total -= e.size;
      if (e.seq !== null) removedSeg = true;
    }
    return removedSeg;
  }

  /** 仅凭现存 seg 文件重建 index.md(段被外部增删后也一致)。 */
  private rebuildCompactedIndex(sessionId: string, dir: string): void {
    const metas: CompactedSegmentMeta[] = [];
    for (const name of this.listDirNames(dir)) {
      if (!SEGMENT_FILE_RE.test(name)) continue;
      try {
        const meta = parseSegmentMeta(readFileSync(path.join(dir, name), 'utf8'));
        if (meta) metas.push(meta);
      } catch {
        // 单个段损坏不拖垮索引。
      }
    }
    const relativeDir = `.mocode/sessions/${sessionId}/compacted`;
    writeFileSync(path.join(dir, 'index.md'), renderArchiveIndex(metas, relativeDir), 'utf8');
  }

  private listDirNames(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      return [];
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

  /**
   * 全量落盘会话(history + queryHistory + lastToolGroups),原子写(先 tmp 再 rename)。
   *
   * 与 appendTrace/appendUsage 的差别:**失败会抛给调用方**——这是用户数据,
   * 静默丢失不可接受(那两个是诊断数据,静默降级是对的)。目录缓存失真时会
   * 清缓存重试一次,仍失败则照旧抛出。
   */
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
    const dir = path.join(this.sessionsRoot, id);
    const tmpPath = path.join(dir, 'session.json.tmp');
    const record: SessionRecord = {
      ...meta,
      history,
      queryHistory: [...queryHistory],
      lastToolGroups: [...lastToolGroups],
    };
    // 目录缓存失真时清缓存重试一次(与 appendTrace 同理);仍失败则照旧抛给调用方
    // —— save 是用户数据落盘,失败必须可见(appendTrace/appendUsage 是诊断数据,静默)。
    for (let attempt = 0; ; attempt++) {
      try {
        this.ensureDir(dir);
        // 原子落盘:先写同目录 tmp 再 rename——全量重写(长会话可达数 MB)中途崩溃/断电
        // 不会留下半个 JSON 把整个会话写坏(对齐 memory/store.ts writeAtomic)。
        writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
        renameSync(tmpPath, currentPath);
        if (existsSync(legacyPath)) unlinkSync(legacyPath);
        return meta;
      } catch (error) {
        this.invalidateEnsuredDir(dir);
        if (attempt === 1) throw error;
      }
    }
  }

  load(id: string, opts?: { restoreAssets?: boolean }): SessionRecord | null {
    const currentPath = this.sessionPath(id);
    const legacyPath = path.join(this.sessionsRoot, `${id}.json`);
    const source = existsSync(currentPath) ? currentPath : legacyPath;
    // 活会话与 legacy 单文件都没有:回退从归档 gz 取回(30-90 天的会话仍可 resume)。
    if (!existsSync(source)) {
      const archived = loadArchivedSession(this.sessionsRoot, id);
      if (!archived) return null;
      // 仅 resume 显式要求时把 gz 内嵌的 compacted 资产写回磁盘(load 也被会话列表等
      // 只读路径调用,不能在那些场景产生写盘副作用)。
      if (opts?.restoreAssets) this.restoreCompactedAssets(id, archived);
      return archived;
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
