/**
 * 常驻抓屏进程(Windows)。
 *
 * 为什么要有这个:实测一次全屏抓屏 710-737ms,其中绝大部分是 PowerShell 冷启动 +
 * `Add-Type` 加载 System.Windows.Forms / System.Drawing(GDI+ 初始化)。这一步每个动作都要
 * 付一次,而它跟「抓哪块屏」毫无关系 —— 典型的可以摊薄的固定成本。
 *
 * 协议与 `input-injector.ts` 完全同构(stdin 收 NDJSON 动作 / stdout 回 NDJSON 结果),
 * 就是为了复用同一套心智模型:Add-Type 只做一次,之后每次抓屏只是一次管道往返。
 *
 * 生命周期(见 `idle-guard.ts`):惰性启动 → 每次调用续期 → 空闲 3 分钟回收 → /cu off 与
 * REPL 退出强制回收。**不因为 /cu on 就启动** —— /cu 是写进 config 的持久开关,若 on 即起进程,
 * 那么每次开 mocode 都会白起一个 PowerShell。
 *
 * 降级:常驻路径任何一步失败都 kill 掉进程并回落一次性 spawn;连续 2 次失败则本会话内
 * 彻底禁用常驻路径(失败模式通常是环境级的,重试没有意义,反而每次多付一次启动成本)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { filterEnv } from '../sandbox/index.js';
import { IdleGuard, envInt } from './idle-guard.js';
import type { CaptureGeometry, CaptureResult } from './screen-capture.js';

const OP_TIMEOUT_MS = 15000;
const DEFAULT_IDLE_MS = 3 * 60 * 1000;
const BROKEN_AFTER = 2;

const PS_CAPTURE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  // ── 以下三行只在进程启动时执行一次,这是常驻化的全部收益来源 ──
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MoCap {',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]',
  '  public struct DEVMODE {',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;',
  '    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;',
  '    public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation;',
  '    public int dmDisplayFixedOutput; public short dmColor; public short dmDuplex; public short dmYResolution;',
  '    public short dmTTOption; public short dmCollate;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;',
  '    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;',
  '    public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;',
  '    public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;',
  '    public int dmPanningWidth; public int dmPanningHeight;',
  '  }',
  '}',
  // here-string 结束符必须在行首,不能有任何前导空格(PowerShell 解析要求)。
  '"@ | Out-Null',
  'try { if (-not [MoCap]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][MoCap]::SetProcessDPIAware() } } catch { }',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  $resp = @{ id = 0; ok = $false; detail = "" }',
  '  try {',
  '    $req = $line | ConvertFrom-Json',
  '    $resp.id = $req.id',
  '    $bounds = if ($req.target -eq "all") { [System.Windows.Forms.SystemInformation]::VirtualScreen } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }',
  '    $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)',
  '    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
  '    try {',
  '      $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)',
  '      $bitmap.Save($req.path, [System.Drawing.Imaging.ImageFormat]::Png)',
  '    } finally {',
  '      $graphics.Dispose()',
  '      $bitmap.Dispose()',
  '    }',
  '    $physW = $bounds.Width',
  '    $physH = $bounds.Height',
  '    try {',
  '      $dm = New-Object MoCap+DEVMODE',
  '      $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)',
  '      if ([MoCap]::EnumDisplaySettings([System.Windows.Forms.Screen]::PrimaryScreen.DeviceName, -1, [ref]$dm)) {',
  '        if ($dm.dmPelsWidth -gt 0) { $physW = $dm.dmPelsWidth }',
  '        if ($dm.dmPelsHeight -gt 0) { $physH = $dm.dmPelsHeight }',
  '      }',
  '    } catch { }',
  '    $resp.ok = $true',
  '    $resp.shotW = $bounds.Width',
  '    $resp.shotH = $bounds.Height',
  '    $resp.physW = $physW',
  '    $resp.physH = $physH',
  '    $resp.originX = $bounds.X',
  '    $resp.originY = $bounds.Y',
  '  } catch {',
  '    $resp.ok = $false',
  '    $resp.detail = $_.Exception.Message',
  '  }',
  '  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

interface PendingOp {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class ResidentCaptureService {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingOp>();
  private stdoutBuf = '';
  private lastError = '';
  private failures = 0;
  private idle: IdleGuard;

  constructor(idleMs: number) {
    this.idle = new IdleGuard(idleMs, () => {
      void this.dispose();
    });
  }

  /** 常驻路径是否可用(进程未崩、未被熔断)。 */
  get available(): boolean {
    return this.failures < BROKEN_AFTER;
  }

  private ensureProcess(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_CAPTURE_SCRIPT],
      { env: filterEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.stdoutBuf = '';
    this.lastError = '';
    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.lastError = (this.lastError + chunk.toString('utf8')).slice(-2000);
    });
    this.child.on('exit', () =>
      this.failAll(new Error(`capture service exited${this.lastError ? `: ${this.lastError.trim()}` : ''}`)),
    );
    this.child.on('error', (err) => this.failAll(err));
    return this.child;
  }

  private onStdout(text: string): void {
    this.stdoutBuf += text;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非协议行(Add-Type 警告等)
      }
      const id = typeof msg.id === 'number' ? msg.id : -1;
      const op = this.pending.get(id);
      if (!op) continue;
      this.pending.delete(id);
      clearTimeout(op.timer);
      op.resolve(msg);
    }
  }

  private failAll(error: Error): void {
    for (const [, op] of this.pending) {
      clearTimeout(op.timer);
      op.reject(error);
    }
    this.pending.clear();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* 已退出 */
      }
      this.child = null;
    }
  }

  private num(msg: Record<string, unknown>, key: string): number | undefined {
    const v = msg[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  async capture(outputPath: string, target: 'primary' | 'all', signal?: AbortSignal): Promise<CaptureResult> {
    if (!this.available) throw new Error('resident capture service disabled after repeated failures');
    const child = this.ensureProcess();
    const id = this.nextId++;
    try {
      const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.failAll(new Error(`capture timed out after ${OP_TIMEOUT_MS}ms`));
          reject(new Error(`capture timed out after ${OP_TIMEOUT_MS}ms`));
        }, OP_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        const onAbort = (): void => {
          this.pending.delete(id);
          clearTimeout(timer);
          // abort 通常是用户 Ctrl+C,进程状态未知 —— 直接回收,下次重建。
          this.failAll(new Error('aborted'));
          reject(new Error('Screenshot capture was aborted.'));
        };
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          child.stdin?.write(`${JSON.stringify({ id, op: 'capture', path: outputPath, target })}\n`, 'utf8');
        } catch (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      if (resp.ok !== true) {
        throw new Error(String(resp.detail ?? 'unknown capture error'));
      }
      const shotW = this.num(resp, 'shotW');
      const shotH = this.num(resp, 'shotH');
      const physW = this.num(resp, 'physW');
      const physH = this.num(resp, 'physH');
      const geometry: CaptureGeometry | undefined =
        shotW && shotH && physW && physH
          ? {
              shotW,
              shotH,
              physW,
              physH,
              originX: this.num(resp, 'originX') ?? 0,
              originY: this.num(resp, 'originY') ?? 0,
            }
          : undefined;
      this.failures = 0;
      this.idle.touch();
      return geometry ? { status: 'passed', detail: 'ok', geometry } : { status: 'passed', detail: 'ok' };
    } catch (error) {
      // 任何失败都回收进程:不能把一个状态未知的常驻进程留到下一次调用。
      this.failures += 1;
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.idle.stop();
    this.failAll(new Error('capture service disposed'));
  }
}

let singleton: ResidentCaptureService | null = null;

/** 取常驻抓屏服务(惰性构造,此时还不 spawn;第一次 capture 才真正起进程)。 */
export function getCaptureService(): ResidentCaptureService | null {
  if (process.platform !== 'win32') return null;
  singleton ??= new ResidentCaptureService(envInt('MOCODE_CU_CAPTURE_IDLE_MS', DEFAULT_IDLE_MS));
  return singleton;
}

/** 回收常驻抓屏进程(/cu off / REPL 退出 / 空闲超时)。幂等。 */
export async function disposeCaptureService(): Promise<void> {
  if (singleton) {
    await singleton.dispose();
    singleton = null;
  }
}
