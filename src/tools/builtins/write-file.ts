import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Tool } from '../types.js';

// ---------- write_file ----------
export const writeFileTool: Tool = {
  name: 'write_file',
  description: '创建或覆盖文件,自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
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
