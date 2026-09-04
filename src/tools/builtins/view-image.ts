import { loadImageAttachment, MAX_INLINE_BYTES_DEFAULT } from '../../attachments/image.js';
import type { Tool, ToolOutcome } from '../types.js';

export const viewImageTool: Tool = {
  name: 'view_image',
  description:
    'View a local image as visual model input. Use this whenever the user refers to a screenshot, UI error, design mockup, Figma export, diagram, or other image file. Supports PNG, JPEG, GIF, and WebP up to 4 MiB.',
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
    const loaded = await loadImageAttachment(String(args.path ?? ''), {
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
    const { att } = loaded;
    return {
      status: 'success',
      code: 'OK',
      retryable: false,
      output: `Viewed image "${att.name}" (${att.mime}, ${att.bytes} bytes). Visual content is attached to the next model request.`,
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
