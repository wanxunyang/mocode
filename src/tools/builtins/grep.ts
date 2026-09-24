import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { IGNORE, MAX_RESULTS } from '../constants.js';
import { isProbablyBinary } from '../../attachments/image.js';

// 二进制文件探测统一走 attachments/image.ts 的 isProbablyBinary(与 read_file 同源同口径,
// 避免两处正则漂移):头部含 C0 控制字符即跳过。否则 grep 扫到 SQLite/压缩文件等会产出
// 「单行数 KB + 控制字符」的匹配行,这类行进 TUI 展开后被终端 auto-wrap,物理行与缓冲行
// 失配导致整屏错乱。
import { getSandboxRoot, isInsideRoot, jailResolve } from '../../sandbox/index.js';
import type { Tool } from '../types.js';

/** 单文件读取上限:超过即跳过(压缩产物 / 生成物 / 数据 dump)。
 *  逐文件全量 readFile 进内存是 grep 的固有成本,不设上限时一个 200MB 的 bundle
 *  就能把整轮 grep 拖死并撑爆内存。跳过的文件数会在结果尾部报出来,不静默吞。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 单条 body 行渲染上限(字符):minified JS / 单行 JSON 截断加 …,
 *  既防 TUI auto-wrap 错乱,也防一行吃掉整个 MAX_RESULTS 预算。 */
const MAX_BODY_LINE_CHARS = 400;

/** context 参数上限:邻居行是 ×(1+2C) 放大,给到 10 已远超「看清一段逻辑」的需要。 */
const MAX_CONTEXT_LINES = 10;

/** 超长行截断(保留头部:grep 的价值在行首标识与缩进)。 */
function clipLine(line: string): string {
  if (line.length <= MAX_BODY_LINE_CHARS) return line;
  return `${line.slice(0, MAX_BODY_LINE_CHARS)}…(+${line.length - MAX_BODY_LINE_CHARS} 字符)`;
}

/**
 * 把命中行号 + context 半径渲染成 body 行。
 *
 * 输出格式契约(context/encoders/search.ts 依赖前两个前缀做 Cold 折叠):
 *   `  L<n>: <原文>`   命中行(冒号)
 *   `  L<n>- <原文>`   上下文行(连字符,对齐 ripgrep 的 `:` / `-`)
 *   `  --`             不相邻分块之间的分隔(对齐 ripgrep)
 * 原文**不 trim**:缩进是代码结构信息,trim 掉后模型看不出嵌套层级,只能再发一次
 * read_file 去确认——那正是 context 参数要消灭的往返。
 */
function renderBodies(lines: string[], lineNos: number[], maxPerFile: number, context: number): string[] {
  const shown = lineNos.slice(0, maxPerFile);
  if (shown.length === 0) return [];
  const matched = new Set(shown);
  // 命中行 ± context 的并集,排序后按连续块渲染。
  const wanted = new Set<number>();
  for (const n of shown) {
    for (let i = n - context; i <= n + context; i++) {
      if (i >= 1 && i <= lines.length) wanted.add(i);
    }
  }
  const out: string[] = [];
  let previous = 0;
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (previous !== 0 && n !== previous + 1) out.push('  --');
    previous = n;
    out.push(`  L${n}${matched.has(n) ? ':' : '-'} ${clipLine(lines[n - 1])}`);
  }
  return out;
}

// ---------- grep ----------
export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regex (recursive, excludes node_modules/.git/dist).\n' +
    'Output: per-file header "<path>: N matches, lines [l1, l2, ...]" + matched lines with ORIGINAL INDENTATION kept.\n' +
    'Pass context=2..5 to get neighbouring lines inline (like ripgrep -C) — use it INSTEAD of following every hit with a read_file round-trip.\n' +
    'Still use read_file(offset=X, limit=Y) for a whole region or exact edit text — never reconstruct an edit_file old_string from grep output (long lines are clipped). ' +
    'For call chains across many files, prefer the codegraph skill.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
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
          'Output grows ~x(1+2*context) and counts against the same result budget, so keep it small.',
      },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const g = String(args.glob ?? '**/*');
    const maxPerFile = Math.min(Math.max(Number(args.max_per_file ?? 15), 1), 50);
    const contextRaw = Number(args.context ?? 0);
    const context = Number.isFinite(contextRaw) ? Math.min(Math.max(Math.trunc(contextRaw), 0), MAX_CONTEXT_LINES) : 0;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return `错误:非法正则 ${pattern}: ${e instanceof Error ? e.message : String(e)}`;
    }
    const cwd = getSandboxRoot() ?? process.cwd();
    // stats:true 让 fast-glob 顺手带回 size,免为体积闸门再付一次 stat 系统调用。
    const entries = (
      await fg(g, {
        cwd,
        onlyFiles: true,
        dot: true,
        ignore: IGNORE,
        stats: true,
        followSymbolicLinks: false, // 不跟随软链目录,防经软链扫到牢外文件
        throwErrorOnBrokenSymbolicLink: false,
      })
    ).filter((entry) => isInsideRoot(entry.path)); // 后置兜底:仅留牢内

    // 两段式输出:每个文件先收集全部命中行号,再决定哪些给 body 详情。
    // 关键点:行号列表(摘要)永远全给,body 配额用完即止 —— 这样 LLM 一眼看到
    // 「foo.ts 在 [12, 56, 134, 245] 命中」,可直接 read_file(offset=12, limit=60)。
    type FileHit = { path: string; lineNos: number[]; bodies: string[] };
    const hits: FileHit[] = [];
    let scanned = 0;
    let skippedTooLarge = 0;
    let truncated = false;

    for (const entry of entries) {
      const f = entry.path;
      // 体积闸门:压缩产物 / 数据 dump 读进来只会撑爆内存并产出无意义超长行。
      if (entry.stats && entry.stats.size > MAX_FILE_BYTES) {
        skippedTooLarge++;
        continue;
      }
      let content: string;
      try {
        // jailResolve:realpath 化,防「牢内文件软链→牢外」的内容泄露;越界/不可读均 catch 跳过
        content = await readFile(jailResolve(f), 'utf8');
      } catch {
        continue; // 跳过无法读的文件(二进制/权限/沙箱越界)
      }
      scanned++;
      // 二进制文件(如 .codegraph/codegraph.db 这类 SQLite)跳过:其「行」是数 KB 的
      // 序列化记录 + 控制字符,匹配行对 LLM 无意义,还会污染 TUI 展开渲染。
      if (isProbablyBinary(content)) continue;
      const lines = content.split(/\r?\n/);
      const lineNos: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) lineNos.push(i + 1);
      }
      if (lineNos.length === 0) continue;
      // 全局配额:行号列表总是计入,body 成本按「命中行数 ×(1+2×context)」计入 ——
      // context 是乘法放大,不按实际渲染量计就会让带 ±5 邻居的 grep 静默撑爆预算。
      const bodyCost = Math.min(lineNos.length, maxPerFile) * (1 + 2 * context);
      const totalCost = lineNos.length + bodyCost;
      if (hits.length >= MAX_RESULTS || totalCost > MAX_RESULTS * 4) {
        // 文件过多 / 配额爆:仅追加该文件行号列表,不再展开 body
        if (hits.length < MAX_RESULTS) {
          hits.push({ path: f, lineNos, bodies: [] });
        }
        truncated = true;
        continue;
      }
      hits.push({ path: f, lineNos, bodies: renderBodies(lines, lineNos, maxPerFile, context) });
    }

    const skippedNote = skippedTooLarge
      ? `,跳过 ${skippedTooLarge} 个超过 ${MAX_FILE_BYTES / 1024 / 1024}MiB 的文件`
      : '';
    if (hits.length === 0) return `无匹配(扫描了 ${scanned} 个文件${skippedNote})`;

    const out: string[] = [];
    let totalShown = 0;
    for (const h of hits) {
      out.push(`${h.path}: ${h.lineNos.length} 处匹配,行号 [${h.lineNos.join(', ')}]`);
      if (h.bodies.length > 0) {
        out.push(...h.bodies);
      } else {
        out.push(`  (body 已折叠,见上方行号列表 → read_file 精读)`);
      }
      totalShown += h.lineNos.length + h.bodies.length;
      if (totalShown >= MAX_RESULTS) {
        out.push(
          `...(结果达到 ${MAX_RESULTS} 条上限${
            context > 0 ? ',context 行同样计入;要更全就减小 context 或收窄 glob' : ''
          })`,
        );
        break;
      }
    }
    if (truncated) out.push(`...(仍有更多匹配文件未展示,缩小 glob 或收窄正则)`);
    if (skippedTooLarge) out.push(`...(跳过 ${skippedTooLarge} 个超过 ${MAX_FILE_BYTES / 1024 / 1024}MiB 的文件)`);
    return out.join('\n');
  },
};
