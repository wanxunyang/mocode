import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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
    return `已写入 ${path} (${content.length} 字符)`;
  },
};
