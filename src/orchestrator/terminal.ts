// 独立终端窗口拉起器：把 worker 放到用户自己的终端里跑。
//
// 为什么需要它：supervisor 的对话 TUI 只有一块内容区，把 worker 的每一步都写进去会刷屏，
// 而人真正想看的是「那个 mocode 在某个工作区里到底在干什么」。于是 worker 开在自己的窗口里
// ——而且那个窗口跑的**就是 mocode 本体**（`supervise lane`，见 ./lane-repl.ts）。
//
// 关键约束：
//   - **窗口是独立进程，与 supervisor 无父子关系**：supervisor 退出不应该杀掉它（人可以继续
//     在那个窗口里对话）；supervisor 崩了也不影响它。
//   - **失败要够诚实**：没有 wt.exe、没有 DISPLAY、SSH 里跑——开不出窗口本身不是致命错误，
//     但必须返回 `{opened:false}` 让调用方如实说「没开成」，绝不能假装开了让人干等。
//   - **命令要能自举**：dev（tsx src/index.ts）与生产（dist/index.js）两种形态都要能起。

import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { buildEntryArgs } from '../jobs/launch.js';

export interface OpenTerminalOptions {
  /** 窗口标题（Windows/macOS 生效）。 */
  title: string;
  /** 传给 mocode 入口的内部参数，例如 `['supervise', 'lane', runId, '--lane', laneId]`。 */
  args: readonly string[];
  /** 新窗口的工作目录。 */
  cwd?: string;
  /** 只用于测试：注入 spawn 实现，避免真的弹窗。 */
  spawnImpl?: typeof spawn;
  /** 只用于测试：注入「把窗口压到任务栏」的实现，避免真的操作桌面窗口。 */
  minimizeImpl?: (title: string) => void;
}

export interface TerminalLaunchResult {
  /** 是否真的拉起了一个窗口。false = 不支持/失败（调用方不该当成错误）。 */
  opened: boolean;
  /** 用的是哪个终端程序（诊断用；未打开时为 undefined）。 */
  via?: string;
}

/** 把一组参数拼成一条可在 shell 里安全执行的行（osascript / `cmd start` 要字符串）。 */
export function quoteCommandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => {
      if (arg.length === 0) return '""';
      if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
      return `"${arg.replace(/"/g, '\\"')}"`;
    })
    .join(' ');
}

/**
 * 构造「重新跑一遍 mocode」的完整 argv（node 可执行 + 入口 + 内部参数）。
 *
 * **不要带 `process.execArgv`**：它会把调用方的运行参数原样传下去（`--test`、`--test-timeout`、
 * 调试端口…），新窗口会变成「跑测试」而不是「跑 tail」。dev/prod 形态的差异已经由
 * `buildEntryArgs` 处理（tsx loader vs 编译产物）。
 */
export function selfCommand(args: readonly string[]): string[] {
  return [process.execPath, ...buildEntryArgs([...args])];
}

/**
 * Windows：优先 `wt.exe`（Windows Terminal 支持标题与独立标签），失败退回 `cmd start`。
 *
 * 为什么不用 `start /b`：那是同控制台后台进程，没有窗口，等于没开。
 *
 * **必须先探测 `wt.exe` 是否真的存在。** `spawn` 找不到程序时不会同步抛错，它只是稍后
 * 发一个 `error` 事件——旧写法一律返回 `opened: true`，于是调用方以为窗口开了、干等 30s 的
 * `ready`，最后报一句「did not become ready」，人看到的是「什么都没发生」（真踩过）。
 */
let wtAvailable: boolean | undefined;

function probeWt(): boolean {
  if (wtAvailable !== undefined) return wtAvailable;
  try {
    const probe = spawnSync('wt.exe', ['--version'], { windowsHide: true, timeout: 8_000, stdio: 'ignore' });
    wtAvailable = probe.error === undefined && probe.status === 0;
  } catch {
    wtAvailable = false;
  }
  return wtAvailable;
}

/**
 * 把标题匹配的窗口压到任务栏（不隐藏、不关闭，任务栏仍可见）。
 *
 * 为什么必须用 Win32 而没法在拉起时指定：实测 Windows Terminal 完全无视 `STARTUPINFO`
 * 的窗口状态——`start /min`、`Start-Process -WindowStyle Minimized` 出来的窗口
 * `IsIconic` 都是 False，而 `-WindowStyle Hidden` 会让窗口干脆不可见（连任务栏都没有）。
 * 唯一有效的是拿到 HWND 后 `ShowWindow(SW_MINIMIZE)` + `SendMessage(WM_SYSCOMMAND,
 * SC_MINIMIZE)`，两者缺一 WT 都不缩（`ShowWindowAsync` 同样无效）。
 *
 * 代价是拉起的那一下必然抢一次焦点（约百毫秒），这是 WT 的行为，绕不过去。
 *
 * 用 `-EncodedCommand` 传脚本（base64 UTF-16LE）：省掉整条命令的引号地狱，
 * 标题走环境变量传递，永远不会被当成 PowerShell 代码执行。
 */
const MINIMIZE_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MocodeTaskbar {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static int Minimize(string title) {
    int hits = 0;
    EnumWindows((h, p) => {
      if (IsIconic(h)) return true;
      var t = new StringBuilder(512);
      GetWindowTextW(h, t, 512);
      if (t.ToString() != title) return true;
      ShowWindow(h, 6);
      SendMessage(h, 0x0112, new IntPtr(0xF020), IntPtr.Zero);
      hits++;
      return true;
    }, IntPtr.Zero);
    return hits;
  }
}
"@
$title = $env:MOCODE_MINIMIZE_TITLE
$deadline = (Get-Date).AddMilliseconds([int]$env:MOCODE_MINIMIZE_TIMEOUT_MS)
while ((Get-Date) -lt $deadline) {
  if ([MocodeTaskbar]::Minimize($title) -gt 0) { break }
  Start-Sleep -Milliseconds 50
}
`;

/** 窗口压缩到任务栏的超时；默认 8s（WT 冷启动 + 脚本自编译 Add-Type 都要时间）。 */
const MINIMIZE_TIMEOUT_MS = 8_000;

/**
 * 起一个后台 PowerShell 只做一件事：等到标题匹配的窗口出现并把它压到任务栏。
 *
 * 轮询放在 PowerShell 里而不是 Node 里，是为了只付出一次进程启动与一次 `Add-Type`
 * 编译成本；从 Node 里反复 spawn 探测会慢十倍且更容易错过窗口创建的时刻。
 *
 * **必须经 `cmd /c start /min` 分离，不能直接 `spawn(..., {detached: true})`。**
 * 实测后者会让 helper **静默死掉**：连脚本第一行写日志都没执行，窗口永远压不下去
 * （三种 detached 组合全失败、非 detached 全成功）。原因是 detached 会脱离父控制台，
 * 而 powershell 在这种无控制台状态下启动即退。借 `start` 由 cmd 提供一个新的（最小化）
 * 控制台，脚本才跑得起来。
 */
export function minimizeWindowByTitle(
  title: string,
  spawnImpl: typeof spawn = spawn,
  timeoutMs = MINIMIZE_TIMEOUT_MS,
): void {
  try {
    const encoded = Buffer.from(MINIMIZE_SCRIPT, 'utf16le').toString('base64');
    const child = spawnImpl(
      'cmd',
      [
        '/c',
        'start',
        '', // start 的第一个带引号参数是窗口标题，留空避免抢一个假标题
        '/min',
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encoded,
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        // 注意：这里故意**不设** detached —— 分离交给 `start` 做（见上面的注释）。
        env: {
          ...process.env,
          MOCODE_MINIMIZE_TITLE: title,
          MOCODE_MINIMIZE_TIMEOUT_MS: String(timeoutMs),
        },
      },
    );
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 压不下去就让它在前台：这不是功能失败，不该冒泡成一个错误。
  }
}

/** 是否把新窗口自动压到任务栏（`MOCODE_SUPERVISE_NO_MINIMIZE=1` 可关掉）。 */
export function autoMinimizeEnabled(): boolean {
  const raw = (process.env.MOCODE_SUPERVISE_NO_MINIMIZE ?? '').trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes');
}

function launchWindows(
  command: string[],
  title: string,
  cwd: string | undefined,
  spawnImpl: typeof spawn,
  minimizeImpl: ((title: string) => void) | undefined,
): TerminalLaunchResult {
  const safeCwd = cwd ?? process.cwd();
  // 注入了 spawnImpl 说明是测试：跳过探测（测试机不一定装了 wt.exe），直接按 wt 走。
  // 真实运行没有 wt.exe（旧系统 / 精简镜像）时退回 cmd start。
  if (spawnImpl !== spawn || probeWt()) {
    try {
      // 先挂 helper 再起窗口：helper 要 0.5–1s 编译 Add-Type，而窗口 ~100ms 就抢到焦点。
      // 让编译与窗口创建并行，能把「挡在屏幕上」的时间压到最短。
      if (minimizeImpl) minimizeImpl(title);
      else if (autoMinimizeEnabled()) minimizeWindowByTitle(title);

      const child = spawnImpl('wt.exe', ['-w', '-1', 'new-tab', '--title', title, '--', ...command], {
        cwd: safeCwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.on('error', () => undefined);
      child.unref();
      return { opened: true, via: 'wt' };
    } catch {
      // 继续尝试 cmd
    }
  }
  try {
    // `start` 的第一个带引号参数就是窗口标题（cmd 的怪癖）。这里给真标题，而不是空占位：
    // 压到任务栏的 helper 靠标题找窗口，标题为空就永远匹配不上。
    const child = spawnImpl('cmd', ['/c', 'start', title, '/D', safeCwd, ...command], {
      cwd: safeCwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
    if (minimizeImpl) minimizeImpl(title);
    else if (autoMinimizeEnabled()) minimizeWindowByTitle(title);
    return { opened: true, via: 'cmd-start' };
  } catch {
    return { opened: false };
  }
}

function launchMac(command: string[], cwd: string | undefined, spawnImpl: typeof spawn): TerminalLaunchResult {
  const line = quoteCommandLine(command);
  const script = `tell application "Terminal"
  activate
  do script ${JSON.stringify(`cd ${JSON.stringify(cwd ?? process.cwd())} && ${line}`)}
end tell`;
  try {
    const child = spawnImpl('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return { opened: true, via: 'Terminal.app' };
  } catch {
    return { opened: false };
  }
}

/**
 * Linux/其他 POSIX：按优先级试几个常见终端。
 * `-e` 后面接完整命令是 xterm/konsole 的通用写法；gnome-terminal 需要 `--`。
 */
function launchLinux(
  command: string[],
  title: string,
  cwd: string | undefined,
  spawnImpl: typeof spawn,
): TerminalLaunchResult {
  const cwdArgs = cwd ? ['cd ' + JSON.stringify(cwd) + ' &&'] : [];
  const line = [...cwdArgs, quoteCommandLine(command)].join(' ');
  const candidates: Array<{ bin: string; args: string[] }> = [
    { bin: 'x-terminal-emulator', args: ['-e', 'sh', '-c', line] },
    { bin: 'gnome-terminal', args: ['--title', title, '--', 'sh', '-c', line] },
    { bin: 'konsole', args: ['-e', 'sh', '-c', line] },
    { bin: 'xfce4-terminal', args: ['--title', title, '-e', `sh -c ${JSON.stringify(line)}`] },
    { bin: 'xterm', args: ['-T', title, '-e', 'sh', '-c', line] },
  ];
  for (const candidate of candidates) {
    try {
      const child = spawnImpl(candidate.bin, candidate.args, { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
      return { opened: true, via: candidate.bin };
    } catch {
      // 换下一个
    }
  }
  return { opened: false };
}

/**
 * 打开一个独立终端跑 `args`（`mocode supervise lane …`）。
 *
 * 永远不会 reject：环境不支持就返回 `{opened:false}`，调用方据此决定是否提示。
 */
export function openTerminalWindow(options: OpenTerminalOptions): TerminalLaunchResult {
  const spawnImpl = options.spawnImpl ?? spawn;
  const command = selfCommand(options.args);
  const platform = os.platform();
  if (platform === 'win32') return launchWindows(command, options.title, options.cwd, spawnImpl, options.minimizeImpl);
  if (platform === 'darwin') return launchMac(command, options.cwd, spawnImpl);
  return launchLinux(command, options.title, options.cwd, spawnImpl);
}

/** 是否允许自动开窗（用户可用环境变量关掉：CI / SSH / 只想要一个 TUI）。 */
export function terminalAutoOpenEnabled(): boolean {
  const raw = (process.env.MOCODE_SUPERVISE_NO_TERMINAL ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return false;
  return true;
}
