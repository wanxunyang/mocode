// shell 选择器:run_command / dev_server 共用的「命令 → spawn 规格」映射。
//
// 为什么存在:两处硬编码(win32 → cmd.exe,其余 → bash)让 Windows 上的模型只能用 cmd 语法,
// 而 LLM 的训练分布压倒性偏 POSIX/pwsh——`&&` 链、`$VAR`、单引号转义在 cmd 里语义不同甚至报错;
// 非交互 cmd 还有 `timeout /t` 直接失败这类暗坑。给模型一个显式 shell 参数,把选择权交出去。
//
// 默认 shell 的选择是**保守**的(刻意):
// - Windows 默认仍是 cmd.exe,与改动前逐字节一致 —— 不静默翻转所有 Windows 用户的默认解释器,
//   现有 prompt / skill / codegraph 的 .cmd 调用都假设 cmd,翻默认是产品级破坏性变更,须显式拍板。
// - 想用 bash/powershell:逐调用传 shell 参数,或设全局 MOCODE_SHELL=bash|powershell|cmd。
//
// Windows 的 Git Bash 探测(Git Bash 优先于 PATH 上的裸 bash,排除 WSL):
// - WSL 的 System32\bash.exe 也在 PATH 上,但它进的是 Linux 发行版:路径 /mnt/f/…、工具链、
//   甚至被安全策略拦截(wsl.exe 黑名单)都与 Windows 原生预期不符,绝不能当 bash 解析结果。
// - 只认 Git for Windows 风格的 bash.exe(常见安装路径 + PATH 上非 System32 的命中)。
// - 仅在**显式请求 shell=bash** 时才探测(懒求值 + 缓存):cmd 默认路径不付这个同步 IO 成本。

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ShellKind = 'cmd' | 'powershell' | 'bash';

export const SHELL_KINDS: readonly ShellKind[] = ['cmd', 'powershell', 'bash'] as const;

export interface ShellSpawnSpec {
  file: string;
  args: string[];
  /** cmd.exe 专用:防止 Node 重新引号化参数,让 `node -e "..."` 退化成字符串字面量。 */
  windowsVerbatimArguments: boolean;
}

const IS_WINDOWS = process.platform === 'win32';

/** Git for Windows 的常见固定安装位(不依赖 PATH 顺序)。 */
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
];

/** PATH 命中里要排除的目录片段:WSL bash 住在 System32,语义完全不同;
 *  WindowsApps 目录下是 wsl 存根的应用执行别名,同样不能当 bash 解析。 */
const WSL_BASH_HINTS = ['system32', 'sysnative', 'windowsapps'];

function findWindowsBash(): string | null {
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // PATH 探测:手工拆分而不是 where.exe —— 需要看到完整路径才能排除 System32(WSL)。
  // 先看 PATH 上的 git.exe(Git for Windows 的 <root>\cmd\git.exe):由 git 根反推
  // <root>\bin\bash.exe。自定义安装位(如 D:\Git)不在上面的候选表里,但 git 在 PATH 上
  // 是极普遍形态 —— 从 git 推 bash 比枚举安装目录鲁棒得多。
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    if (WSL_BASH_HINTS.some((hint) => dir.toLowerCase().includes(hint))) continue;
    if (!existsSync(join(dir, 'git.exe'))) continue;
    const gitRoot = resolve(dir, '..');
    for (const candidate of [join(gitRoot, 'bin', 'bash.exe'), join(gitRoot, 'usr', 'bin', 'bash.exe')]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  // 兜底:PATH 上直接出现的 bash.exe(排除 System32/WindowsApps 后,多为与 git 同目录布局)。
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    if (WSL_BASH_HINTS.some((hint) => dir.toLowerCase().includes(hint))) continue;
    const candidate = join(dir, 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cachedWindowsBash: string | null | undefined;

/** Windows 上的 Git Bash 可执行文件路径;探不到返回 null。结果缓存。 */
export function windowsGitBash(): string | null {
  if (!IS_WINDOWS) return null;
  if (cachedWindowsBash === undefined) cachedWindowsBash = findWindowsBash();
  return cachedWindowsBash;
}

/** 测试/嵌入方显式重置探测缓存(例如单测里想模拟两种环境)。 */
export function resetShellDetectionCache(): void {
  cachedWindowsBash = undefined;
}

/**
 * 平台默认 shell(**保守**,刻意不翻转既有行为):
 * - Windows:cmd.exe(与改动前逐字节一致)。MOCODE_SHELL 显式指定可整体切换。
 *   —— 不自动探到 Git Bash 就当默认:那会给所有 Windows 用户做静默的破坏性解释器变更,
 *   现有 prompt/skill/codegraph 的 .cmd 调用都假设 cmd,翻默认须产品级显式拍板。
 *   想用 bash 的用户:逐调用传 shell=bash(此时才懒探测 Git Bash 路径),或设 MOCODE_SHELL=bash。
 * - 其余平台:bash(与旧硬编码一致);MOCODE_SHELL 只在落到真实 shell(bash/powershell)时生效,
 *   cmd 在 Unix 无意义,忽略。
 */
export function defaultShellKind(): ShellKind {
  const forced = parseShellKind(process.env.MOCODE_SHELL);
  if (IS_WINDOWS) return forced ?? 'cmd';
  return forced === 'bash' || forced === 'powershell' ? forced : 'bash';
}

/** 解析模型/用户传入的 shell 值;大小写无关,别名 sh→bash、pwsh/powershell.exe→powershell。非法值返回 null。 */
export function parseShellKind(raw: unknown): ShellKind | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'cmd' || value === 'cmd.exe') return 'cmd';
  if (value === 'bash' || value === 'sh') return 'bash';
  if (value === 'powershell' || value === 'pwsh' || value === 'powershell.exe' || value === 'pwsh.exe') {
    return 'powershell';
  }
  return null;
}

/**
 * 把 shell 种类 + 单行命令映射成 spawn 规格。
 *
 * bash on Windows:优先用探测到的 Git Bash 绝对路径;调用方显式 shell=bash 而探测失败时
 * 仍按裸 'bash' spawn(交给 PATH 解析,包括 WSL——用户显式选择就尊重,失败会由
 * spawn error 显式报出,不静默换 shell)。
 */
export function shellSpawnSpec(kind: ShellKind, command: string): ShellSpawnSpec {
  switch (kind) {
    case 'cmd':
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command], windowsVerbatimArguments: true };
    case 'powershell':
      // -NoProfile:不执行用户 profile,启动快且行为可复现;-NonInteractive:禁交互提示;
      // -Command:单行命令串(与 cmd /c 心智一致)。
      return {
        file: IS_WINDOWS ? 'powershell.exe' : 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
        windowsVerbatimArguments: false,
      };
    case 'bash': {
      const bashPath = IS_WINDOWS ? (windowsGitBash() ?? 'bash') : 'bash';
      return { file: bashPath, args: ['-c', command], windowsVerbatimArguments: false };
    }
  }
}

/** 平台默认 shell 的可执行文件名(用于系统提示里的 PLATFORM_NOTE 措辞)。 */
export function defaultShellLabel(): string {
  const kind = defaultShellKind();
  if (kind === 'bash') return IS_WINDOWS ? 'Git Bash (POSIX)' : 'bash';
  if (kind === 'powershell') return 'PowerShell';
  return 'cmd.exe';
}

/** 供 run_command / dev_server 的 description 复用的 shell 参数说明(单一事实源,防漂移)。
 *  默认值不在文案里烘焙静态答案:真实默认由 defaultShellKind()(运行时读 env)决定,
 *  shell.ts 模块求值时 config 链路未必已把 ~/.mocode/config 回填进 env,静态串会与
 *  系统提示(MOCODE_SHELL 分支)自相矛盾。改为 getter,取用时才求值。
 *  平台默认:Windows=cmd、其余=bash;MOCODE_SHELL 可翻转。 */
export const shellParamDescription = (): string =>
  'Shell to run the command in: cmd | powershell | bash (default: ' +
  defaultShellLabel() +
  '). Pick the shell whose syntax the command is written in; do not mix (e.g. no %VAR% in bash, no $VAR in cmd).';

/** 兼容旧引用:初始化即求值的快照(不追踪 MOCODE_SHELL 翻转;新代码用 shellParamDescription())。 */
export const SHELL_PARAM_DESCRIPTION = shellParamDescription();
