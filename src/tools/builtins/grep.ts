import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { MAX_RESULTS, IGNORE } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- grep ----------
export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regex, returning file:line: matched lines. Recursively searches the current directory by default (excluding node_modules/.git). Optional glob to restrict file types.' +
    ' Note: when understanding code architecture/call chains, if a .codegraph/ index exists, prefer the codegraph tool over piecing together via grep one file at a time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      glob: { type: 'string', description: 'Optional, restrict to a file glob, e.g. *.ts' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const g = String(args.glob ?? '**/*');
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return `错误:非法正则 ${pattern}: ${e instanceof Error ? e.message : String(e)}`;
    }
    const files = await fg(g, {
      cwd: process.cwd(),
      onlyFiles: true,
      dot: true,
      ignore: IGNORE,
    });
    const results: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (results.length >= MAX_RESULTS) break;
      let content: string;
      try {
        content = await readFile(resolve(f), 'utf8');
      } catch {
        continue; // 跳过无法读的文件(二进制/权限)
      }
      scanned++;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${f}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= MAX_RESULTS) break;
        }
      }
    }
    if (results.length === 0) return `无匹配(扫描了 ${scanned} 个文件)`;
    let out = results.join('\n');
    if (results.length >= MAX_RESULTS) out += `\n...(结果达到 ${MAX_RESULTS} 条上限)`;
    return out;
  },
};
