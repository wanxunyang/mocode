import fg from 'fast-glob';
import { IGNORE } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- glob ----------
export const globTool: Tool = {
  name: 'glob',
  description:
    'Find file paths matching a glob pattern (e.g. **/*.ts). Returns a list of matches (auto-excludes node_modules / .git).' +
    ' Note: when understanding code architecture/call chains, if a .codegraph/ index exists, prefer the codegraph tool over piecing together via glob one file at a time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts or src/**/*.json' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const files = await fg(pattern, {
      cwd: process.cwd(),
      onlyFiles: true,
      dot: true,
      ignore: IGNORE,
    });
    if (files.length === 0) return '无匹配文件';
    const shown = files.slice(0, 200);
    let out = shown.join('\n');
    if (files.length > 200) out += `\n... (共 ${files.length} 个,仅显示前 200)`;
    return out;
  },
};
