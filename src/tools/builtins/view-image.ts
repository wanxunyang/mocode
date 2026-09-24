import { loadImageAttachmentWithDownscale, MAX_INLINE_BYTES_DEFAULT } from '../../attachments/image.js';
import type { Tool, ToolOutcome } from '../types.js';

export const viewImageTool: Tool = {
  name: 'view_image',
  description:
    'View a local image as visual model input. Use this whenever the user refers to a screenshot, UI error, design mockup, Figma export, diagram, or other image file. Supports PNG, JPEG, GIF, and WebP up to 4 MiB; oversized PNGs are automatically downscaled so the call still succeeds.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Image path, relative to the working directory',
      },
      detail: {
        type: 'string',
        enum: ['auto', 'low', 'high'],
        description: 'Vision detail level (default: auto)',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args): Promise<ToolOutcome> {
    // 超限 PNG 自动降采样兜底(与 screenshot 同一 helper):高 DPI 截图常超 4 MiB,
    // 服务端缩一下就能成功,不该把「去找个压缩工具」的活推给模型。
    const loaded = await loadImageAttachmentWithDownscale(String(args.path ?? ''), {
      maxBytes: MAX_INLINE_BYTES_DEFAULT,
    });
    if (!loaded.ok) {
      return {
        status: 'error',
        code: loaded.reason.startsWith('outside sandbox') ? 'SANDBOX_DENIED' : 'EXECUTION_ERROR',
        retryable: false,
        output: `Unable to view image: ${loaded.reason}`,
      };
    }

    const detail = args.detail === 'low' || args.detail === 'high' ? args.detail : 'auto';
    const { att, downscaledFrom } = loaded;
    const resizedNote = downscaledFrom
      ? ` Original ${downscaledFrom.width}×${downscaledFrom.height} exceeded the inline limit; attached copy was downscaled to ${att.bytes} bytes.`
      : '';
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      output: `Viewed image "${att.name}" (${att.mime}, ${att.bytes} bytes).${resizedNote} Visual content is attached to the next model request.`,
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
