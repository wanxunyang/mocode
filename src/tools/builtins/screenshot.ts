import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { loadImageAttachment, MAX_INLINE_BYTES_DEFAULT } from '../../attachments/image.js';
import { filterEnv, jailResolve } from '../../sandbox/index.js';
import type { Tool, ToolOutcome } from '../types.js';

type CaptureStatus = 'passed' | 'failed' | 'aborted' | 'spawn_error';
interface CaptureResult {
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

async function captureDesktop(
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

export const screenshotTool: Tool = {
  name: 'screenshot',
  description:
    'Capture the desktop and inspect it as visual model input. Use this to diagnose visible UI state, dialogs, rendering problems, or applications that cannot be understood from source files alone. The user must approve each capture because screenshots may contain sensitive information.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Optional output PNG path inside the workspace. Defaults to .mocode/screenshots/<timestamp>.png.',
      },
      target: {
        type: 'string',
        enum: ['primary', 'all'],
        description: 'Capture the primary display or the full virtual desktop (default: primary).',
      },
      detail: {
        type: 'string',
        enum: ['auto', 'low', 'high'],
        description: 'Vision detail level (default: high).',
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolOutcome> {
    const defaultName = `.mocode/screenshots/screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    let requestedPath = String(args.path ?? defaultName).trim();
    if (!requestedPath) requestedPath = defaultName;
    if (!extname(requestedPath)) requestedPath += '.png';
    if (extname(requestedPath).toLowerCase() !== '.png') {
      return {
        status: 'error',
        code: 'INVALID_ARGUMENTS',
        retryable: false,
        output: 'Screenshot output path must use the .png extension.',
      };
    }

    let outputPath: string;
    try {
      outputPath = jailResolve(requestedPath);
      await mkdir(dirname(outputPath), { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'denied', code: 'SANDBOX_DENIED', retryable: false, output: message };
    }

    const target = args.target === 'all' ? 'all' : 'primary';
    const capture = await captureDesktop(outputPath, target, ctx?.signal);
    if (capture.status !== 'passed') {
      if (capture.status === 'aborted') {
        return { status: 'aborted', code: 'ABORTED', retryable: false, output: capture.detail };
      }
      return {
        status: 'error',
        code: capture.status === 'failed' ? 'PROCESS_FAILED' : 'EXECUTION_ERROR',
        retryable: false,
        output: `Unable to capture screenshot: ${capture.detail}`,
      };
    }

    const loaded = await loadImageAttachment(outputPath, {
      maxBytes: MAX_INLINE_BYTES_DEFAULT,
    });
    if (!loaded.ok) {
      return {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        output: `Screenshot saved to ${requestedPath}, but it could not be attached: ${loaded.reason}`,
      };
    }

    const detail = args.detail === 'low' || args.detail === 'auto' ? args.detail : 'high';
    const { att } = loaded;
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      output: `Captured ${target} display to ${requestedPath} (${att.bytes} bytes). Visual content is attached to the next model request.`,
      modelAttachments: [
        {
          type: 'image',
          name: att.name,
          mime: att.mime,
          dataUrl: att.dataUrl,
          detail,
        },
      ],
    };
  },
};
