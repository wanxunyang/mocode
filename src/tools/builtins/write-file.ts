import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { verifyWrittenFile } from '../../verification/postconditions.js';
import type { Tool } from '../types.js';

// ---------- write_file ----------
export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a file; parent dirs created.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const path = String(args.path);
    const content = String(args.content);
    const full = resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    const postcondition = await verifyWrittenFile(full, content);
    if (postcondition.status === 'failed') {
      return {
        status: 'error',
        code: 'POSTCONDITION_FAILED',
        retryable: true,
        output: postcondition.diagnostics
          .map((item) => `[${item.code ?? 'V0_FAILED'}] ${item.file ?? path}: ${item.message}`)
          .join('\n'),
      };
    }
    return `已写入 ${path} (${content.length} 字符, sha256=${postcondition.actualHash})`;
  },
};
