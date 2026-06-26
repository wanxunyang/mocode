import fg from 'fast-glob';
import { IGNORE } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- glob ----------
export const globTool: Tool = {
  name: 'glob',
  description:
    '按 glob 模式查找文件路径(如 **/*.ts)。返回匹配列表(自动排除 node_modules / .git)。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式,如 **/*.ts 或 src/**/*.json' },
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
