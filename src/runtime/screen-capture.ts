/**
 * 跨平台桌面截图捕获:从 tools/builtins/screenshot.ts 抽出的可复用底层。
 * screenshot 工具与 computer 工具的闭环重截屏共用同一份平台逻辑,零重复。
 * 只做「抓屏 → 写 PNG 文件」,不做缩放/坐标/回灌(那是 screen-pipeline 的职责)。
 */
import { spawn } from 'node:child_process';
import { filterEnv } from '../sandbox/index.js';

export type CaptureStatus = 'passed' | 'failed' | 'aborted' | 'spawn_error';
export interface CaptureResult {
  status: CaptureStatus;
  detail: string;
}

function runCaptureProcess(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
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
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => finish({ status: 'spawn_error', detail: error.message }));
    child.on('close', (code) =>
      finish({
        status: code === 0 ? 'passed' : 'failed',
        detail: stderr.trim() || `Capture process exited with code ${code ?? 'null'}.`,
      }),
    );
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const WINDOWS_CAPTURE_SCRIPT = [
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
    return runCaptureProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_CAPTURE_SCRIPT],
      env,
      signal,
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
