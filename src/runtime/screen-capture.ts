/**
 * 跨平台桌面截图捕获:从 tools/builtins/screenshot.ts 抽出的可复用底层。
 * screenshot 工具与 computer 工具的闭环重截屏共用同一份平台逻辑,零重复。
 * 只做「抓屏 → 写 PNG 文件」,不做缩放/坐标/回灌(那是 screen-pipeline 的职责)。
 *
 * DPI 正确性(computer use 的点击精度命门):
 * PowerShell 默认以 DPI UNAWARE 启动,此时 `Screen.PrimaryScreen.Bounds` 与 `CopyFromScreen`
 * 返回的都是**逻辑像素**(150% 缩放下 2560×1440 的屏只有 1707×960),而 `SetCursorPos` 始终
 * 按**物理像素**解释坐标 —— 两者差一个缩放比,表现为「所有点击都落在从左上角算起的 2/3 处,
 * 越往右下偏得越多」。因此这里做两件事:
 *  1. 抓屏前显式声明 PER_MONITOR_AWARE_V2(失败回落 SYSTEM_AWARE),让 Bounds 与抓到的图都是物理像素;
 *  2. 额外用 EnumDisplaySettings 读取**不受 DPI 虚拟化影响**的物理分辨率并回传(geometry),
 *     调用方据此校准坐标。即使 1 在老系统上失败,2 仍能兜底。
 */
import { spawn } from 'node:child_process';
import { filterEnv } from '../sandbox/index.js';

export type CaptureStatus = 'passed' | 'failed' | 'aborted' | 'spawn_error';

/** 抓屏几何信息。Windows 提供;其它平台缺省(调用方按 shotW/physW 相等处理)。 */
export interface CaptureGeometry {
  /** 实际抓到的位图宽高(可能仍是逻辑像素,取决于 DPI awareness 是否设置成功)。 */
  shotW: number;
  shotH: number;
  /** 主屏真实物理分辨率(EnumDisplaySettings,不受 DPI 虚拟化影响)。 */
  physW: number;
  physH: number;
  /** 主屏在虚拟桌面坐标系中的原点(多屏时用于坐标偏移;主屏通常为 0,0)。 */
  originX: number;
  originY: number;
}

export interface CaptureResult {
  status: CaptureStatus;
  detail: string;
  geometry?: CaptureGeometry;
}

function parseGeometry(stdout: string): CaptureGeometry | undefined {
  const line = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (!line || !line.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const shotW = num(o.shotW);
    const shotH = num(o.shotH);
    const physW = num(o.physW);
    const physH = num(o.physH);
    if (shotW === undefined || shotH === undefined || physW === undefined || physH === undefined) return undefined;
    return {
      shotW,
      shotH,
      physW,
      physH,
      originX: num(o.originX) ?? 0,
      originY: num(o.originY) ?? 0,
    };
  } catch {
    return undefined;
  }
}

function runCaptureProcess(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  collectStdout = false,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    let finished = false;
    const finish = (result: CaptureResult): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      child.kill();
      finish({ status: 'aborted', detail: 'Screenshot capture was aborted.' });
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    if (collectStdout) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-4000);
      });
    }
    child.on('error', (error) => finish({ status: 'spawn_error', detail: error.message }));
    child.on('close', (code) => {
      const status: CaptureStatus = code === 0 ? 'passed' : 'failed';
      const detail = stderr.trim() || `Capture process exited with code ${code ?? 'null'}.`;
      const geometry = collectStdout ? parseGeometry(stdout) : undefined;
      finish(geometry ? { status, detail, geometry } : { status, detail });
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const WINDOWS_CAPTURE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  // ── DPI 感知:必须在读取任何屏幕信息之前声明 ──
  'try {',
  '  Add-Type -TypeDefinition @"',
  '  using System;',
  '  using System.Runtime.InteropServices;',
  '  public class MoCap {',
  '    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
  '    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);',
  '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]',
  '    public struct DEVMODE {',
  '      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;',
  '      public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;',
  '      public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation;',
  '      public int dmDisplayFixedOutput; public short dmColor; public short dmDuplex; public short dmYResolution;',
  '      public short dmTTOption; public short dmCollate;',
  '      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;',
  '      public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;',
  '      public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;',
  '      public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;',
  '      public int dmPanningWidth; public int dmPanningHeight;',
  '    }',
  '  }',
  // 注意:here-string 的结束符 "@ 必须在行首,不能有任何前导空格,否则 PowerShell 解析失败。
  '"@ | Out-Null',
  '  if (-not [MoCap]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][MoCap]::SetProcessDPIAware() }',
  '} catch { }',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "$bounds = if ($env:MOCODE_SCREENSHOT_TARGET -eq 'all') { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }",
  '$bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)',
  '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
  'try {',
  '  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)',
  '  $bitmap.Save($env:MOCODE_SCREENSHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)',
  '} finally {',
  '  $graphics.Dispose()',
  '  $bitmap.Dispose()',
  '}',
  // ── 物理分辨率兜底:EnumDisplaySettings 不受 DPI 虚拟化影响 ──
  '$physW = $bounds.Width',
  '$physH = $bounds.Height',
  'try {',
  '  $dm = New-Object MoCap+DEVMODE',
  '  $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)',
  '  if ([MoCap]::EnumDisplaySettings([System.Windows.Forms.Screen]::PrimaryScreen.DeviceName, -1, [ref]$dm)) {',
  '    if ($dm.dmPelsWidth -gt 0) { $physW = $dm.dmPelsWidth }',
  '    if ($dm.dmPelsHeight -gt 0) { $physH = $dm.dmPelsHeight }',
  '  }',
  '} catch { }',
  'try {',
  '  [Console]::Out.WriteLine((@{ shotW = $bounds.Width; shotH = $bounds.Height; physW = $physW; physH = $physH; originX = $bounds.X; originY = $bounds.Y } | ConvertTo-Json -Compress))',
  '} catch { }',
].join('\n');

/** 抓屏并写入 outputPath。target=primary 主屏,all 整个虚拟桌面。 */
export async function captureDesktop(
  outputPath: string,
  target: 'primary' | 'all',
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const env = {
    ...filterEnv(process.env),
    MOCODE_SCREENSHOT_PATH: outputPath,
    MOCODE_SCREENSHOT_TARGET: target,
  };
  if (process.platform === 'win32') {
    // 优先走常驻进程(Add-Type / GDI+ 初始化只付一次,实测能省掉 710ms 里的大头)。
    // 常驻路径任何异常都回落到一次性 spawn —— 这是原有行为,保证不会有功能倒退。
    try {
      const { getCaptureService } = await import('./screen-capture-service.js');
      const svc = getCaptureService();
      if (svc?.available) return await svc.capture(outputPath, target, signal);
    } catch {
      // 常驻路径失败 → 回落到一次性 spawn(下面继续)。
    }
    return runCaptureProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_CAPTURE_SCRIPT],
      env,
      signal,
      true,
    );
  }
  if (process.platform === 'darwin') {
    const args = ['-x', ...(target === 'primary' ? ['-m'] : []), outputPath];
    return runCaptureProcess('/usr/sbin/screencapture', args, env, signal);
  }

  const candidates: Array<[string, string[]]> = [
    ['gnome-screenshot', ['-f', outputPath]],
    ['grim', [outputPath]],
    ['scrot', [outputPath]],
    ['import', ['-window', 'root', outputPath]],
  ];
  const failures: string[] = [];
  for (const [program, args] of candidates) {
    const result = await runCaptureProcess(program, args, env, signal);
    if (result.status === 'passed' || result.status === 'aborted') return result;
    failures.push(`${program}: ${result.detail}`);
  }
  return {
    status: 'failed',
    detail: `No supported Linux screenshot command succeeded. ${failures.join(' | ')}`,
  };
}
