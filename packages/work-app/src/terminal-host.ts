/**
 * 终端面板的主进程侧：一个真正的 PTY（node-pty），不是「把 agent 的输出镜像过来」。
 *
 * 为什么放在主进程而不是渲染层：node-pty 是原生模块，渲染进程开了 contextIsolation +
 * sandbox，拿不到 require，也不该拿到 —— 一个能 spawn 任意 shell 的渲染进程等于把
 * contextIsolation 的意义抹掉。所以 PTY 住主进程，渲染层只收发字符串。
 *
 * 与 agent 的关系（不新增工具）：
 *  - cwd 恒等于当前任务工作空间的根，和 agent 的 run_command 起点一致，
 *    用户手动复现 agent 跑过的命令不会落错目录；
 *  - 面板支持把终端里选中的输出「发给 agent」、把 agent 上一条 run_command 的命令
 *    回填到 PTY（都不执行，等用户按回车），联动靠 UI 桥接而不是新协议。
 *
 * 生命周期：每个空间一份会话（同一空间来回切面板不重开 shell），最多 MAX_SESSIONS 份，
 * 超出按最后使用时间淘汰；空间被移除 / 窗口关闭时整批回收。
 */

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
type PtyModule = typeof import('node-pty');
type Pty = ReturnType<PtyModule['spawn']>;

/** 每个空间一份 shell；超过这个数量就淘汰最久没用的（关掉它的进程）。 */
const MAX_SESSIONS = 4;
/** 回放缓冲：重新打开面板 / 渲染层重建时先把最近这么长的输出写回去，避免一片空白。 */
const REPLAY_LIMIT = 24 * 1024;
/** 单次写回渲染层的最大长度：一屏刷屏（如 cat 大文件）分片推送，别让一条 IPC 撑爆。 */
const CHUNK_LIMIT = 16 * 1024;

export interface TerminalOpenResult {
  ok: boolean;
  /** 实际启动的 shell（展示用，如 cmd.exe / /bin/bash）。 */
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** 新建会话 vs 复用已有会话：复用时不回放（xterm 里本来就有）。 */
  reused?: boolean;
  /** 被淘汰/重启前的最近输出，供渲染层补屏。 */
  replay?: string;
  message?: string;
}

interface Session {
  projectId: string;
  pty: Pty;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  replay: string;
  /** 最近一次使用时间，用于淘汰。 */
  usedAt: number;
  disposed: boolean;
}

/** 主进程侧的事件：`data` / `exit`，由 main.ts 转成 IPC 推给渲染层。 */
export class TerminalHost extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private disposed = false;

  constructor(
    /** 由调用方解析空间根目录（渲染层传 projectId，主进程负责校验）。 */
    private readonly resolveCwd: (projectId: string | undefined) => string | null,
  ) {
    super();
  }

  /** 打开或复用某个空间的 shell。cols/rows 来自渲染层实测的 xterm 尺寸。 */
  open(projectId: string | undefined, cols: number, rows: number): TerminalOpenResult {
    if (this.disposed) return { ok: false, message: 'terminal host disposed' };
    const key = projectId || '';
    const size = normalizeSize(cols, rows);
    const existing = this.sessions.get(key);
    if (existing && !existing.disposed) {
      existing.usedAt = Date.now();
      this.resize(key, size.cols, size.rows);
      // 复用时不回放：渲染层那份 xterm 里的内容还在，重复写会让屏幕出现重影。
      return { ok: true, shell: existing.shell, cwd: existing.cwd, cols: size.cols, rows: size.rows, reused: true };
    }
    const cwd = this.resolveCwd(projectId);
    if (!cwd) return { ok: false, message: 'workspace not found' };
    return this.spawnSession(key, cwd, size.cols, size.rows);
  }

  write(projectId: string | undefined, data: string): boolean {
    const session = this.sessions.get(projectId || '');
    if (!session || session.disposed) return false;
    session.usedAt = Date.now();
    try {
      session.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(projectId: string | undefined, cols: number, rows: number): boolean {
    const session = this.sessions.get(projectId || '');
    if (!session || session.disposed) return false;
    const size = normalizeSize(cols, rows);
    if (session.cols === size.cols && session.rows === size.rows) return true;
    session.cols = size.cols;
    session.rows = size.rows;
    try {
      session.pty.resize(size.cols, size.rows);
      return true;
    } catch {
      return false;
    }
  }

  /** 主动关掉某个空间的 shell（面板上的「重启」/ 空间被移除）。 */
  close(projectId: string | undefined): boolean {
    const key = projectId || '';
    const session = this.sessions.get(key);
    if (!session) return false;
    this.sessions.delete(key);
    this.kill(session);
    return true;
  }

  /** 应用退出 / 窗口销毁时整批回收。 */
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) this.kill(session);
    this.sessions.clear();
  }

  /** 当前存活的会话数（诊断用）。 */
  get size(): number {
    return this.sessions.size;
  }

  private spawnSession(key: string, cwd: string, cols: number, rows: number): TerminalOpenResult {
    let pty: PtyModule;
    try {
      pty = require('node-pty') as PtyModule;
    } catch (error) {
      return { ok: false, message: `node-pty unavailable: ${(error as Error)?.message ?? error}` };
    }
    const target = shellSpec();
    let session: Session;
    try {
      const proc = pty.spawn(target.file, target.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, ...target.env },
      });
      session = {
        projectId: key, pty: proc, shell: target.label, cwd, cols, rows, replay: '', usedAt: Date.now(), disposed: false,
      };
    } catch (error) {
      return { ok: false, message: `failed to start shell: ${(error as Error)?.message ?? error}` };
    }
    this.sessions.set(key, session);
    this.evictIfNeeded(key);

    session.pty.onData((chunk) => {
      // 回放缓冲按字符截断即可：终端输出本身就是逐段字符串，切在序列中间只会让回放少一个字。
      session.replay = (session.replay + chunk).slice(-REPLAY_LIMIT);
      for (let index = 0; index < chunk.length; index += CHUNK_LIMIT) {
        this.emit('data', { projectId: key, chunk: chunk.slice(index, index + CHUNK_LIMIT) });
      }
    });
    session.pty.onExit(({ exitCode }) => {
      session.disposed = true;
      this.sessions.delete(key);
      this.emit('exit', { projectId: key, exitCode });
    });
    return { ok: true, shell: session.shell, cwd, cols, rows, reused: false };
  }

  private evictIfNeeded(keep: string): void {
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest: Session | null = null;
      for (const session of this.sessions.values()) {
        if (session.projectId === keep) continue;
        if (!oldest || session.usedAt < oldest.usedAt) oldest = session;
      }
      if (!oldest) return;
      this.sessions.delete(oldest.projectId);
      this.kill(oldest);
    }
  }

  private kill(session: Session): void {
    session.disposed = true;
    try {
      session.pty.kill();
    } catch {
      /* 已经死了：ConPTY 在进程自行退出后再 kill 会抛，忽略 */
    }
  }
}

/** xterm 的 cols/rows 必须落在合理区间：0 列会让 ConPTY 直接崩。 */
function normalizeSize(cols: number, rows: number): { cols: number; rows: number } {
  const safeCols = Number.isFinite(cols) ? Math.min(Math.max(Math.trunc(cols), 2), 1000) : 80;
  const safeRows = Number.isFinite(rows) ? Math.min(Math.max(Math.trunc(rows), 1), 400) : 24;
  return { cols: safeCols, rows: safeRows };
}

/**
 * 启动哪个 shell。
 *
 * - Windows：优先 COMSPEC（cmd.exe），与 agent 的 run_command 默认 shell 一致；
 *   装了 Git Bash 也不自动换 —— 用户 shell 里 ssh/git 的凭据与别名在 bash 里才生效，
 *   但静默换解释器会让「和 agent 跑同一条命令」这件事失真。
 * - POSIX：$SHELL，退到 bash。
 * `-i` 让 bash 读 .bashrc：面板是交互终端，没有它 alias/提示符全丢。
 */
function shellSpec(): { file: string; args: string[]; label: string; env: Record<string, string> } {
  if (process.platform === 'win32') {
    const file = process.env.COMSPEC || 'cmd.exe';
    return { file, args: [], label: file, env: { TERM: 'xterm-256color' } };
  }
  const file = process.env.SHELL || '/bin/bash';
  const interactive = /(^|\/)(ba|z|k|fi)?sh$/.test(file) ? ['-i', '-l'] : [];
  return { file, args: interactive, label: file, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } };
}