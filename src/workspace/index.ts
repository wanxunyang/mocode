/**
 * 工作区(workspace)切换的**唯一入口**:进程级单例的集中改写。
 *
 * 为什么需要这个模块:
 * 「当前工作区」在 mocode 里不是一个变量,而是散落在几处进程级单例上的状态——
 *   1. `process.cwd()`:memory 存储、skill 扫描、AGENTS.md、rollback 默认实例都直接读它;
 *   2. sandboxRoot(sandbox/root.ts):文件操作边界(jail / 工具 cwd / run_command cwd / 权限判定);
 *   3. `config.sessionDir`:会话落盘目录(启动时按 cwd 算好的固定值)。
 * 只改其中任意一个都会留下「半个工作区」——比如只 setSandboxRoot 不 chdir,
 * 文件读写走新目录而 memory / skill / AGENTS.md 还读旧目录。所以这里一次性改全部三处,
 * 且顺序固定(先 chdir 后改 config,避免中途失败留下不一致)。
 *
 * 依赖方向:本模块只依赖 config 与 sandbox/root 两个叶子,不 import session/repl/agent,
 * 避免出现环;session store 反过来**读**本模块(见 session/store.ts 的 workspaceRoot provider)。
 *
 * 未覆盖(有意):项目级 `.env` / `.mocode/config` 只在启动时加载一次,切换后不重新加载
 * ——否则切个目录就可能把模型/baseURL 换掉,比不重载更危险。命令层会提示「如需生效请重启」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config/index.js';
import { getSandboxRoot, setSandboxRoot } from '../sandbox/root.js';

/** 当前工作区根(绝对路径)。沙箱根优先,未初始化回退 process.cwd()。 */
export function getWorkspaceRoot(): string {
  return getSandboxRoot() ?? process.cwd();
}

export type WorkspaceResolveError =
  /** 未传路径(不应出现,由命令层拦)。 */
  | 'empty'
  /** 路径不存在。 */
  | 'missing'
  /** 存在但不是目录。 */
  | 'not-dir'
  /** `/cd -` 但没有上一个工作区。 */
  | 'no-previous';

export type WorkspaceTarget =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly error: WorkspaceResolveError; readonly root: string };

/**
 * 上一个工作区根,供 `/cd -` 来回切换。模块级单例(一个进程只有一个 REPL 主循环),
 * 与 sandboxRoot 同生命周期;切换失败时不更新,保证 `-` 永远指向一个真实去过的目录。
 */
let previousRoot: string | null = null;

/** 展开 `~`(仅前缀,仅 POSIX/Windows 通用形式);其余原样返回。 */
function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * 解析切换目标:支持 `~`、相对路径(相对当前工作区根)、`-`(上一个工作区)。
 * 只做解析与存在性校验,**不改任何状态**——调用方据此决定提示文案。
 */
export function resolveWorkspaceTarget(input: string): WorkspaceTarget {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'empty', root: '' };
  if (raw === '-') {
    if (!previousRoot) return { ok: false, error: 'no-previous', root: '' };
    if (!isDirectory(previousRoot)) return { ok: false, error: 'missing', root: previousRoot };
    return { ok: true, root: previousRoot };
  }
  // 相对路径按当前工作区根解析(而非 cwd):--sandbox-root 启动时两者可能不同,
  // 用户在 TUI 里看到的"当前目录"就是工作区根,相对路径必须与之对齐。
  const root = path.resolve(getWorkspaceRoot(), expandHome(raw));
  if (!fs.existsSync(root)) return { ok: false, error: 'missing', root };
  if (!isDirectory(root)) return { ok: false, error: 'not-dir', root };
  return { ok: true, root };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface WorkspaceSwitchResult {
  /** 切换前的工作区根(提示与 `/cd -` 用)。 */
  readonly previous: string;
  /** 切换后的工作区根(绝对路径,已 resolve)。 */
  readonly root: string;
}

/**
 * 切换工作区:chdir + 沙箱根 + 会话目录,三处一起改。
 *
 * 返回切换前后路径供命令层提示。调用方(命令层)负责保存旧会话、开新会话、重画 banner。
 */
export function switchWorkspaceRoot(root: string): WorkspaceSwitchResult {
  const previous = getWorkspaceRoot();
  const abs = path.resolve(root);
  // ① chdir 让所有直接读 process.cwd() 的消费者(memory / skill / AGENTS.md / rollback 默认实例)跟随;
  // ② setSandboxRoot 移动文件操作边界(jail、glob/grep/run_command 的 cwd、权限判定);
  // ③ sessionDir 是启动时按 cwd 算死的固定值,必须显式改写,否则会话仍落进旧工作区。
  process.chdir(abs);
  setSandboxRoot(abs);
  config.sessionDir = path.join(abs, '.mocode', 'sessions');
  previousRoot = previous;
  return { previous, root: abs };
}
