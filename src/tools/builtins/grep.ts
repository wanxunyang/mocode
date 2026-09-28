import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { IGNORE, MAX_RESULTS } from '../constants.js';
import { isProbablyBinary } from '../../attachments/image.js';
import { getSandboxRoot, isInsideRoot, jailResolve } from '../../sandbox/index.js';
import { runRipgrep, type RgFileEvents, type RgLineEvent } from '../ripgrep-client.js';
import type { Tool, ToolOutcome } from '../types.js';

/**
 * grep 超时墙。
 *
 * ripgrep 正常仓库都是秒级,超时只发生在网络盘挂死这类病态场景——此时与其让 spinner
 * 无限期冻住,不如杀掉报错让模型换路径(收窄 glob)。比 run_command 默认 120s 更严:
 * 全库搜索不该有 rg 跑满 2 分钟还出不来的结果。
 */
export const GREP_TIMEOUT_MS = 120_000;

/** Node 兜底路径的单文件读取上限(ripgrep 流式读取不需要这个闸门,仅兜底用)。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 单条 body 行渲染上限(字符):minified JS / 单行 JSON 截断加 …,防 TUI auto-wrap 错乱。 */
const MAX_BODY_LINE_CHARS = 400;

/** context 参数上限:邻居行是 ×(1+2C) 放大,给到 10 已远超需要。 */
const MAX_CONTEXT_LINES = 10;

function clipLine(line: string): string {
  if (line.length <= MAX_BODY_LINE_CHARS) return line;
  return `${line.slice(0, MAX_BODY_LINE_CHARS)}…(+${line.length - MAX_BODY_LINE_CHARS} 字符)`;
}

/**
 * 把命中行 + context 行渲染成 body。输出格式契约(context/encoders/search 依赖前缀做折叠):
 *   `  L<n>: <原文>`   命中行(冒号)
 *   `  L<n>- <原文>`   上下文行(连字符)
 *   `  --`             不相邻分块之间的分隔
 * 原文不 trim:缩进是代码结构信息。
 */
function renderFileBodies(file: RgFileEvents, maxPerFile: number): string[] {
  const shown = file.matches.slice(0, maxPerFile);
  if (shown.length === 0) return [];
  const matched = new Set(shown.map((e) => e.line));
  const byLine = new Map<number, RgLineEvent>();
  for (const e of shown) byLine.set(e.line, e);
  for (const e of file.contexts) byLine.set(e.line, e);
  const out: string[] = [];
  let previous = 0;
  for (const n of [...byLine.keys()].sort((a, b) => a - b)) {
    if (previous !== 0 && n !== previous + 1) out.push('  --');
    previous = n;
    const event = byLine.get(n)!;
    out.push(`  L${n}${matched.has(n) ? ':' : '-'} ${clipLine(event.text)}`);
  }
  return out;
}

/** 把聚合后的文件事件渲染成工具输出(配额/截断口径与旧实现一致)。 */
function renderResults(files: RgFileEvents[], maxPerFile: number, context: number, truncated: boolean): string {
  type Hit = { file: RgFileEvents; bodies: string[] };
  const hits: Hit[] = [];
  let budgetTruncated = truncated;
  for (const file of files) {
    const bodyCost = Math.min(file.matches.length, maxPerFile) * (1 + 2 * context);
    const totalCost = file.matches.length + bodyCost;
    if (hits.length >= MAX_RESULTS || totalCost > MAX_RESULTS * 4) {
      if (hits.length < MAX_RESULTS) hits.push({ file, bodies: [] });
      budgetTruncated = true;
      continue;
    }
    hits.push({ file, bodies: renderFileBodies(file, maxPerFile) });
  }

  const out: string[] = [];
  let totalShown = 0;
  for (const h of hits) {
    out.push(`${h.file.path}: ${h.file.matches.length} 处匹配,行号 [${h.file.matches.map((e) => e.line).join(', ')}]`);
    if (h.bodies.length > 0) out.push(...h.bodies);
    else out.push('  (body 已折叠,见上方行号列表 → read_file 精读)');
    totalShown += h.file.matches.length + h.bodies.length;
    if (totalShown >= MAX_RESULTS) {
      out.push(
        `...(结果达到 ${MAX_RESULTS} 条上限${
          context > 0 ? ',context 行同样计入;要更全就减小 context 或收窄 glob' : ''
        })`,
      );
      break;
    }
  }
  if (budgetTruncated) out.push('...(仍有更多匹配未展示,缩小 glob 或收窄正则)');
  return out.join('\n');
}

/**
 * Node 兜底:rg 二进制不可用(可选依赖缺失且 PATH 无 rg)时走旧路径。
 * 与旧实现的唯一差异——每两个文件之间检查 abort 信号,使 Ctrl+C / 超时墙能即时打断。
 */
async function nodeFallback(
  pattern: string,
  glob: string,
  maxPerFile: number,
  context: number,
  signal: AbortSignal,
  externalSignal?: AbortSignal,
): Promise<ToolExecuteResult> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return `错误:非法正则 ${pattern}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const cwd = getSandboxRoot() ?? process.cwd();
  const entries = (
    await fg(glob, {
      cwd,
      onlyFiles: true,
      dot: true,
      ignore: IGNORE,
      stats: true,
      followSymbolicLinks: false,
      throwErrorOnBrokenSymbolicLink: false,
    })
  ).filter((entry) => isInsideRoot(entry.path)); // 后置兜底:仅留牢内

  const files: RgFileEvents[] = [];
  let scanned = 0;
  let skippedTooLarge = 0;
  const abortNote = (): ToolOutcome =>
    externalSignal?.aborted
      ? ({ status: 'aborted', code: 'ABORTED', output: '已中断' } as ToolOutcome)
      : {
          status: 'error',
          code: 'TIMEOUT',
          retryable: false,
          output: `错误:grep 超过 ${GREP_TIMEOUT_MS / 1000}s 超时墙已被中止(收窄 glob 后重试)`,
        };
  for (let fi = 0; fi < entries.length; fi++) {
    const entry = entries[fi];
    if ((fi & 31) === 0 && signal.aborted) return abortNote();
    if (entry.stats && entry.stats.size > MAX_FILE_BYTES) {
      skippedTooLarge++;
      continue;
    }
    let content: string;
    try {
      content = await readFile(jailResolve(entry.path), 'utf8');
    } catch {
      continue;
    }
    scanned++;
    if (isProbablyBinary(content)) continue;
    const lines = content.split(/\r?\n/);
    const matches: RgLineEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) matches.push({ line: i + 1, text: lines[i] });
    }
    if (matches.length > 0) files.push({ path: entry.path, matches, contexts: [] });
  }
  if (signal.aborted) return abortNote();

  if (files.length === 0) {
    const note = skippedTooLarge ? `,跳过 ${skippedTooLarge} 个超过 2MiB 的文件` : '';
    return `无匹配(扫描了 ${scanned} 个文件${note})`;
  }
  // 兜底路径无 context 事件来源(rg 缺失),context 参数退化为只给命中行。
  const out = renderResults(files, maxPerFile, 0, false);
  return skippedTooLarge ? `${out}\n...(跳过 ${skippedTooLarge} 个超过 2MiB 的文件)` : out;
}

type ToolExecuteResult = string | ToolOutcome;

// ---------- grep ----------
export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regex (recursive; powered by ripgrep: respects .gitignore, skips binaries).\n' +
    'Output: per-file header "<path>: N matches, lines [l1, l2, ...]" plus rendered lines with ORIGINAL INDENTATION kept.\n' +
    'Pass context=2..5 to include neighbouring lines inline (like ripgrep -C) instead of following each hit with a read_file round-trip. Hard wall 120s; narrow the glob if a tree contains network mounts. Use read_file when you need a whole region or exact edit text.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (ripgrep/Rust regex syntax)' },
      glob: { type: 'string', description: 'Optional, restrict to a file glob, e.g. *.ts' },
      max_per_file: {
        type: 'integer',
        description:
          'Max MATCHED lines rendered per file (default 15, cap 50); their context lines are extra. Line-number list is always full.',
      },
      context: {
        type: 'integer',
        description:
          'Neighbouring lines to include around each match, like ripgrep -C (default 0, max 10). ' +
          'Output grows ~x(1+2*context), so keep it small.',
      },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern);
    const glob = String(args.glob ?? '**/*');
    const maxPerFile = Math.min(Math.max(Number(args.max_per_file ?? 15), 1), 50);
    const contextRaw = Number(args.context ?? 0);
    const context = Number.isFinite(contextRaw) ? Math.min(Math.max(Math.trunc(contextRaw), 0), MAX_CONTEXT_LINES) : 0;

    // 组合外部 Ctrl+C 信号与超时墙:任一触发都中止 rg 子进程。
    const controller = new AbortController();
    const external = ctx?.signal;
    const onExternal = (): void => controller.abort();
    if (external) {
      if (external.aborted) onExternal();
      else external.addEventListener('abort', onExternal, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GREP_TIMEOUT_MS);

    try {
      const result = await runRipgrep({ pattern, glob, context }, controller.signal);
      switch (result.status) {
        case 'regex_error':
          return `错误:非法正则 ${pattern}: ${result.message}`;
        case 'no-match': {
          const trunc = result.truncated ? '\n...(输出截断,缩小 glob 或收窄正则后重试)' : '';
          return `无匹配(扫描了 ${result.scanned} 个文件)${trunc}`;
        }
        case 'ok':
          return renderResults(result.files, maxPerFile, context, result.truncated);
        case 'unavailable':
          return nodeFallback(pattern, glob, maxPerFile, context, controller.signal, external);
        case 'aborted':
          if (timedOut) {
            return {
              status: 'error',
              code: 'TIMEOUT',
              retryable: false,
              output: `错误:grep 超过 ${GREP_TIMEOUT_MS / 1000}s 超时墙已被中止(收窄 glob 或确认无网络盘挂载后重试)`,
            } satisfies ToolOutcome;
          }
          // 外部 Ctrl+C:返回中断串,tool-runtime 见 signal.aborted 会归一为 aborted。
          return '已中断';
      }
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    }
  },
};
