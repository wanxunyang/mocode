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

/** 跑 codegraph CLI 子进程,返回合并 stdout+stderr(带退出码),超时 60s。
 *  signal 透传(用户 Ctrl+C)→ 即时杀子进程,不等 60s 超时。 */
function runCodegraph(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((done) => {
    const isWin = process.platform === 'win32';
    // win32 必须走 cmd.exe /c:Node 自 CVE-2024-27980 修复后,shell:false 直接 spawn
    // .cmd/.bat 会抛 EINVAL;cmd.exe 是真二进制,直接 spawn 安全(与 run_command 同约定)。
    const child = isWin
      ? spawn('cmd.exe', ['/c', 'codegraph', ...args], { cwd: process.cwd() })
      : spawn('codegraph', args, { cwd: process.cwd() });
    let out = '';
    let finished = false;
    const finish = (s: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
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
    // abort(用户 Ctrl+C,经 executeTool ctx.signal 透传)→ 杀子进程 + 返[已中断]
    const onAbort = (): void => {
      child.kill();
      finish(`[已中断]\n${out.trim()}`);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export const codegraphTool: Tool = {
  name: 'codegraph',
  description:
    'FIRST CHOICE for understanding/locating code, tracing call chains, or assessing the impact of changes — use this before read_file/grep when a .codegraph/ index exists.' +
    ' Returns symbol source + call paths in one shot — more accurate and economical than piecing together read_file/grep.' +
    ' When to use: starting any code exploration; locating a symbol; understanding how a feature works; seeing what calls a function or what a change affects.' +
    ' When NOT to use: no .codegraph/ index (build it first with `codegraph init`); reading a file you just edited; editing a single known small file — in those cases go straight to read_file/edit_file; or the symbol/area was already retrieved earlier in this session — reuse that result instead of calling again.' +
    ' Fallback: if codegraph misses or the result is incomplete, then use read_file/grep/glob to fill the gaps.',
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
  async execute(args, ctx) {
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
    return runCodegraph(cliArgs, ctx?.signal);
  },
};
