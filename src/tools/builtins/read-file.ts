import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentHash } from '../../changeset/index.js';
import { MAX_FILE_LINES } from '../constants.js';

/** 默认单次 read_file 拉取的行数。刻意压低,逼 LLM 分块读大文件,
 * 配合 description 中的 PAGINATION IS MANDATORY 引导。
 * 300 行 ≈ 一个屏幕的源码量,够定位一段逻辑而不至于吃光上下文。 */
const DEFAULT_READ_LIMIT = 300;
import type { Tool } from '../types.js';

// ---------- read_file ----------
export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read file content with line numbers. Read before editing.\n' +
    'For files >500 lines: grep first to locate regions, then call read_file multiple times ' +
    'with offset+limit (e.g. offset=350, limit=120). Do NOT read an entire large file in one call.\n' +
    'For architecture or call-chain questions, prefer loading the `codegraph` skill (use_skill) over reading files one at a time.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the working directory' },
      offset: { type: 'integer', description: 'Start line, 1-based (default 1).' },
      limit: {
        type: 'integer',
        description: 'Max lines to read (default 300, hard cap 2000). Keep ranges ~80-200.',
      },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = String(args.path);
    const offset = Number(args.offset ?? 1);
    // 无论 LLM 传多大,单次硬钳到 MAX_FILE_LINES,杜绝「绕过分页引导一把全拿」。
    const limit = Math.min(Number(args.limit ?? DEFAULT_READ_LIMIT), MAX_FILE_LINES);

    const data = await readFile(resolve(path), 'utf8');
    const artifactHeader = `[artifact source=read_file path=${path} hash=${contentHash(data)}]`;
    const lines = data.split(/\r?\n/);
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n');
    if (end < lines.length) {
      return artifactHeader + '\n' + body + `\n\n... (${lines.length - end} 行未显示,共 ${lines.length} 行)`;
    }
    return artifactHeader + '\n' + (body || '(空文件)');
  },
};
