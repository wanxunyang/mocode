import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_FILE_LINES } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- read_file ----------
export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取文件内容,返回带行号的文本。改代码前先读。可选 offset(起始行,1-based,默认1)和 limit(行数,默认2000)。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径,相对工作目录' },
      offset: { type: 'integer', description: '起始行号(1-based),默认1' },
      limit: { type: 'integer', description: '最大读取行数,默认2000' },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = String(args.path);
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? MAX_FILE_LINES);
    const data = await readFile(resolve(path), 'utf8');
    const lines = data.split(/\r?\n/);
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n');
    if (end < lines.length) {
      return body + `\n\n... (${lines.length - end} 行未显示,共 ${lines.length} 行)`;
    }
    return body || '(空文件)';
  },
};
