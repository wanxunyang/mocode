import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_FILE_LINES } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- read_file ----------
export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read file content, returning text with line numbers. Read before editing code. Optional offset (start line, 1-based, default 1) and limit (number of lines, default 2000).' +
    ' Note: when understanding code architecture/call chains, if a .codegraph/ index exists, prefer the codegraph tool over piecing together via read_file one file at a time.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the working directory' },
      offset: { type: 'integer', description: 'Start line (1-based), default 1' },
      limit: { type: 'integer', description: 'Max number of lines to read, default 2000' },
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
