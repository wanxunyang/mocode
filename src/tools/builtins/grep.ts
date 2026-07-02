import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { MAX_RESULTS, IGNORE } from '../constants.js';
import { getSandboxRoot, isInsideRoot, jailResolve } from '../../sandbox/index.js';
import type { Tool } from '../types.js';

// ---------- grep ----------
export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regex, returning file:line: matched lines. Recursively searches cwd excluding node_modules/.git. Optional glob restricts file types.' +
    ' For architecture/call chains, prefer codegraph.',
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
    const cwd = getSandboxRoot() ?? process.cwd();
    const files = (
      await fg(g, {
        cwd,
        onlyFiles: true,
        dot: true,
        ignore: IGNORE,
        followSymbolicLinks: false, // 不跟随软链目录,防经软链扫到牢外文件
        throwErrorOnBrokenSymbolicLink: false,
      })
    ).filter((f) => isInsideRoot(f)); // 后置兜底:仅留牢内
    const results: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (results.length >= MAX_RESULTS) break;
      let content: string;
      try {
        // jailResolve:realpath 化,防「牢内文件软链→牢外」的内容泄露;越界/不可读均 catch 跳过
        content = await readFile(jailResolve(f), 'utf8');
      } catch {
        continue; // 跳过无法读的文件(二进制/权限/沙箱越界)
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
