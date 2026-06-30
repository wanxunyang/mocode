import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MAX_OUTPUT } from '../constants.js';
import type { Tool } from '../types.js';

// ---------- codegraph ----------
// 已建代码索引(.codegraph/)的仓库里,理解/定位代码、查调用链、看改动影响面时
// 的首选工具。比逐文件 read_file/grep 拼凑更准更省。
// 检查 .codegraph/ 是否存在:不存在则提示建索引,不盲目调 CLI(避免报错噪音)。

/** 同步判断当前 cwd 是否已建 codegraph 索引。 */
function hasCodegraphIndex(): boolean {
  return existsSync(path.join(process.cwd(), '.codegraph'));
}

/** 跑 codegraph CLI 子进程,返回合并 stdout+stderr(带退出码),超时 60s。 */
function runCodegraph(args: string[]): Promise<string> {
  return new Promise((done) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'codegraph.cmd' : 'codegraph';
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      shell: false,
    });
    let out = '';
    let finished = false;
    const finish = (s: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(s);
    };
    const onChunk = (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) =>
      finish(
        `codegraph 执行失败(可能未安装或不在 PATH): ${e.message}\n` +
          '安装: npm i -g @colbymchenry/codegraph'
      )
    );
    child.on('close', (code) => {
      let r = out.trim();
      if (out.length >= MAX_OUTPUT) r += '\n...(输出已截断)';
      finish(`[退出码 ${code}]\n${r || '(无输出)'}`);
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(`[超时,已终止]\n${out.trim()}`);
    }, 60000);
  });
}

export const codegraphTool: Tool = {
  name: 'codegraph',
  description:
    'Preferred tool for understanding/locating code, tracing call chains, and assessing the impact of changes in repos with a code index (.codegraph/).' +
    ' Returns relevant symbol source + call paths in one shot — more accurate and economical than piecing together via read_file/grep.' +
    ' Returns a hint when .codegraph/ is absent (build it first with `codegraph init`).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['explore', 'node'],
        description:
          "explore=fetch relevant source + call paths by question/symbol (use when understanding a feature/architecture);" +
          "node=look up a single symbol's source + callers/callees, or read a file + dependencies (use when locating a specific symbol)",
      },
      query: {
        type: 'string',
        description:
          'explore: the question or symbol name to investigate (e.g. "runAgent" or "how history is compacted").' +
          'node: symbol name (e.g. runAgent) or file path (used with file mode)',
      },
      file: {
        type: 'string',
        description: 'node only: treat query as a file path to read (file mode), or disambiguate to a specific file',
      },
      offset: {
        type: 'integer',
        description: 'node file mode only: start line (1-based)',
      },
      limit: {
        type: 'integer',
        description: 'node file mode only: max number of lines',
      },
    },
    required: ['action', 'query'],
  },
  async execute(args) {
    if (!hasCodegraphIndex()) {
      return (
        '当前目录无 .codegraph/ 索引。codegraph 工具不可用。\n' +
        '建索引:运行 `codegraph init`(需要 codegraph CLI:`npm i -g @colbymchenry/codegraph`)。\n' +
        '在此之前,可改用 read_file / grep / glob 探索代码。'
      );
    }
    const action = String(args.action);
    const query = String(args.query);
    const cliArgs: string[] = [];
    if (action === 'explore') {
      // explore 接 <query...> 多 token,拆分后逐个 push
      cliArgs.push('explore', ...query.split(/\s+/).filter(Boolean));
    } else if (action === 'node') {
      cliArgs.push('node', query);
      const file = args.file ? String(args.file) : '';
      if (file) cliArgs.push('--file', file);
      if (args.offset !== undefined) cliArgs.push('--offset', String(args.offset));
      if (args.limit !== undefined) cliArgs.push('--limit', String(args.limit));
    } else {
      return `错误:未知 action "${action}",可选 explore 或 node。`;
    }
    return runCodegraph(cliArgs);
  },
};
