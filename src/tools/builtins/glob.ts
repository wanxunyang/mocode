import fg from 'fast-glob';
import { IGNORE } from '../constants.js';
import { getSandboxRoot, isInsideRoot } from '../../sandbox/index.js';
import type { Tool } from '../types.js';

// ---------- glob ----------
export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. **/*.ts). Auto-excludes node_modules/.git.' +
    ' For architecture or call chains, prefer loading the `codegraph` skill (use_skill).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts or src/**/*.json' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const cwd = getSandboxRoot() ?? process.cwd();
    const files = (
      await fg(pattern, {
        cwd,
        onlyFiles: true,
        dot: true,
        ignore: IGNORE,
        followSymbolicLinks: false, // 不跟随软链目录,防经软链列出牢外文件
        throwErrorOnBrokenSymbolicLink: false,
      })
    ).filter((f) => isInsideRoot(f)); // 后置兜底:仅留牢内
    if (files.length === 0) return '无匹配文件';
    const shown = files.slice(0, 200);
    let out = shown.join('\n');
    if (files.length > 200) out += `\n... (共 ${files.length} 个,仅显示前 200)`;
    return out;
  },
};
