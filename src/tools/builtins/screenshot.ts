import { mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { loadImageAttachmentWithDownscale, MAX_INLINE_BYTES_DEFAULT } from '../../attachments/image.js';
import { jailResolve } from '../../sandbox/index.js';
// 平台捕获逻辑已抽到 runtime/screen-capture.ts(computer 工具闭环共用),本文件只做薄封装。
import { captureDesktop } from '../../runtime/screen-capture.js';
import type { Tool, ToolOutcome } from '../types.js';

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

    // 共享 helper:超内联上限时自动把 PNG 降采样到 DOWNSCALE_MAX_EDGE 再回灌,不让工具失败。
    // 高分屏(尤其 DPI aware 后抓到物理分辨率)的 PNG 常超 4 MiB;原图仍留在磁盘上。
    const loaded = await loadImageAttachmentWithDownscale(outputPath, {
      maxBytes: MAX_INLINE_BYTES_DEFAULT,
    });
    const detail = args.detail === 'low' || args.detail === 'auto' ? args.detail : 'high';

    if (!loaded.ok) {
      return {
        status: 'error',
        code: 'EXECUTION_ERROR',
        retryable: false,
        output: `Screenshot saved to ${requestedPath}, but it could not be attached: ${loaded.reason}`,
      };
    }

    const { att, downscaledFrom } = loaded;
    const resizedNote = downscaledFrom
      ? ` (${downscaledFrom.width}×${downscaledFrom.height}; exceeded the inline limit, so the attached copy was resized)`
      : '';
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      output: `Captured ${target} display to ${requestedPath} (${att.bytes} bytes)${resizedNote}. Visual content is attached to the next model request.`,
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
